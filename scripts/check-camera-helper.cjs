'use strict';

// Account-free integration smoke. Intended for Docker --network none; only
// loopback HTTP, generated camera metadata and generated video are used.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Worker } = require('node:worker_threads');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { Camera, DeviceType, P2PConnectionType, VideoCodec } = require('eufy-security-client');
const { HelperServer } = require('../helper/service.cjs');
const CameraHelperClient = require('../lib/helpers/camera-helper-client.helper');
const CameraP2PSession = require('../lib/helpers/camera-p2p-session.helper');
const FfmpegResolver = require('../lib/helpers/ffmpeg-binary.helper');

const SECRET = 'c'.repeat(64);
const ACCOUNT_SENTINEL = 'SYNTHETIC_ACCOUNT_TOKEN_MUST_STAY_IN_HOMEY';
const BASE = 'FIXTURE_HOMEBASE';
const workers = [], adapters = [], helpers = [], clients = [], processes = new Set(), sources = new Map();
const diagnostics = [];
const controlServers = new Set();
const mediaControllers = new Set();
let workspace, binary, sourceMode = 'worker', blockedClient = false, helper, client, settings, pausedDsk;

const defer = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, label, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (!await condition()) { if (Date.now() >= deadline) throw Error(label); await sleep(20); }
}
async function bounded(promise, label, timeout = 12000) {
    let timer;
    try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error(label)), timeout); })]); }
    finally { clearTimeout(timer); }
}

function tracked(command, args, label) {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    processes.add(proc);
    const diagnostic = { label, stderr: '' }; diagnostics.push(diagnostic);
    proc.stderr.on('data', chunk => { diagnostic.stderr = (diagnostic.stderr + chunk.toString()).slice(-1400); });
    proc.once('close', () => processes.delete(proc));
    proc.on('error', () => {}); proc.stdin.on('error', () => {});
    return proc;
}
async function closeProcess(proc) {
    if (proc.exitCode != null || proc.signalCode != null) return;
    let timer;
    try { await bounded(new Promise(resolve => {
        proc.once('close', resolve); proc.once('error', resolve); proc.kill('SIGTERM');
        timer = setTimeout(() => proc.kill('SIGKILL'), 750);
    }), 'A fixture process did not terminate.', 3000); } finally { clearTimeout(timer); }
}

class ObservedWorker extends Worker {
    constructor(filename, options) {
        const gateway = sourceMode === 'gateway';
        const sdkBuild = path.dirname(require.resolve('eufy-security-client'));
        super(`const {parentPort}=require('node:worker_threads');
            const dgram=require('node:dgram'),create=dgram.createSocket;
            dgram.createSocket=function(...args){const socket=create.apply(this,args);
                socket.once('listening',()=>parentPort.postMessage({type:'fixture-bound'}));return socket;};
            if(${JSON.stringify(gateway)}){
                const {P2PClientProtocol}=require(${JSON.stringify(path.join(sdkBuild, 'p2p/session.js'))});
                const {P2PDataType,CommandType,EncryptionType}=require(${JSON.stringify(path.join(sdkBuild, 'p2p/types.js'))});
                P2PClientProtocol.prototype.connect=function(){
                    this.sendQueuedMessage=()=>parentPort.postMessage({type:'fixture-gateway',ready:this.encryption===EncryptionType.LEVEL_1&&Buffer.isBuffer(this.p2pKey)&&this.p2pKey.length>0});
                    const data=Buffer.alloc(20);data.writeUInt16LE(7,0);
                    this.handleData({dataType:P2PDataType.CONTROL,commandId:CommandType.CMD_GATEWAYINFO,
                        signCode:0,type:0,seqNo:0,channel:255,bytesToRead:data.length,data});return Promise.resolve();};
            }
            require(${JSON.stringify(filename)});`, { ...options, eval: true });
        this.bound = false; this.gatewayReady = false;
        this.on('message', message => { if (message?.type === 'fixture-bound') this.bound = true;
            if (message?.type === 'fixture-gateway') this.gatewayReady = message.ready === true; });
        workers.push(this);
    }
}

const starts = new Map();
function syntheticSource(params) {
    const serial = params.homeyDevice.EufyDevice.getSerial();
    let source;
    return {
        async start() {
            starts.set(serial, (starts.get(serial) || 0) + 1);
            const hevc = params.homeyDevice.EufyDevice.getRawDevice().fixture_codec === VideoCodec.H265;
            const encoding = hevc
                ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1:wpp=0:log-level=error:keyint=10:min-keyint=10:scenecut=0:repeat-headers=1']
                : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0'];
            const proc = tracked(binary, ['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i',
                `testsrc2=size=${hevc ? '640x360' : '160x120'}:rate=10`, '-an', ...encoding, '-threads', '1', '-t', '45',
                '-f', hevc ? 'hevc' : 'h264', 'pipe:1'], 'generated video');
            source = { proc, audio: new PassThrough() }; sources.set(serial, source);
            await params.onStream(proc.stdout, source.audio, { videoCodec: hevc ? VideoCodec.H265 : VideoCodec.H264, videoFPS: 10 });
        },
        async close() {
            if (!source) return { stopConfirmed: true };
            source.audio.destroy(); await closeProcess(source.proc);
            if (sources.get(serial) === source) sources.delete(serial);
            return { stopConfirmed: true };
        },
    };
}

async function createHelper(port = 0) {
    const instance = new HelperServer({ secret: SECRET, host: '127.0.0.1', port, mediaDir: workspace,
        ffmpeg: binary, startTimeoutMs: 15000,
        createP2PSession: params => {
            if (sourceMode === 'media') return syntheticSource(params);
            const adapter = new CameraP2PSession({ ...params, WorkerClass: ObservedWorker,
                startupTimeoutMs: 15000, shutdownTimeoutMs: 100, terminationTimeoutMs: 3000 });
            adapters.push(adapter); return adapter;
        },
        spawn: (command, args) => tracked(command, args, args.includes('image2pipe') ? 'snapshot decoder' : 'MPEG-TS relay') });
    const address = await instance.listen(); helpers.push(instance);
    return { instance, origin: `http://127.0.0.1:${address.port}`, port: address.port };
}

const apiCalls = [];
const api = {
    isConnected: () => true,
    async request(request) {
        assert.equal(request.endpoint, 'v1/app/equipment/get_dsk_keys');
        assert.deepEqual(request.data.station_sns, [BASE]);
        apiCalls.push('dsk');
        if (pausedDsk) { const waiting = pausedDsk; waiting.seen.resolve(); return waiting.reply.promise; }
        return dskResponse();
    },
    async getCipher(id, user) {
        assert.equal(id, 7); assert.equal(user, 'FIXTURE_ADMIN'); apiCalls.push('cipher');
        return { private_key: 'fixture-invalid-private-key', auth_token: ACCOUNT_SENTINEL };
    },
    async getVoices() { return {}; },
    async getPublicKey(station, kind) { assert.equal(station, BASE); assert.equal(kind, 2); return undefined; },
};
function dskResponse() {
    return { status: 200, data: { code: 0, auth_token: ACCOUNT_SENTINEL, data: { dsk_keys: [
        { station_sn: BASE, dsk_key: 'synthetic-dsk', expiration: Math.floor(Date.now() / 1000) + 3600 }
    ] } } };
}
const accountClient = new EventEmitter();
accountClient.getApi = () => api;
accountClient.isConnected = () => true;
accountClient.getConfig = () => ({ stationIPAddresses: { [BASE]: '127.0.0.1' }, deviceConfig: { simultaneousDetections: true } });
accountClient.startStationLivestream = () => { throw Error('The fixture changed the shared Station.'); };
accountClient.stopStationLivestream = () => { throw Error('The fixture changed the shared Station.'); };

function camera(label, codec = VideoCodec.H264) {
    const serial = `FIXTURE_CAMERA_${label}`;
    const raw = { device_sn: serial, station_sn: BASE, device_channel: label.charCodeAt(0) - 65,
        device_type: DeviceType.CAMERA2, device_name: label, main_sw_version: '4.0.0.0', params: [], fixture_codec: codec };
    const rawStation = { station_sn: BASE, device_type: DeviceType.HB3, station_name: 'Synthetic HomeBase',
        p2p_did: 'FIXTURE_DID', app_conn: '', main_sw_version: '3.3.0.0', params: [],
        member: { admin_user_id: 'FIXTURE_ADMIN' }, access_token: ACCOUNT_SENTINEL, devices: [raw] };
    const deviceId = randomUUID();
    return { EufyDevice: new Camera(api, raw, {}),
        EufyStation: { getRawStation: () => rawStation, getConnectionType: () => P2PConnectionType.ONLY_LOCAL },
        getId: () => deviceId, allowed: true };
}
const homey = { settings: { get: name => settings.get(name) }, app: { eufyClient: accountClient } };
function createClient() {
    const instance = new CameraHelperClient({ homey,
        assertCamera: hd => { if (!hd.allowed) throw Error('Synthetic privacy mode.'); },
        requestTimeoutMs: 10000, readyTimeoutMs: 18000, eventsTimeoutMs: 25000, renewIntervalMs: 250,
        retryDelays: [30, 60, 100, 200],
        fetch: (url, options) => {
            if (blockedClient) return Promise.reject(Error('Synthetic helper restart.'));
            assert.ok(!String(options?.body || '').includes(ACCOUNT_SENTINEL), 'The client sent an account token to the helper.');
            return fetch(url, options);
        } });
    clients.push(instance); return instance;
}

function jpegDimensions(bytes) {
    assert.ok(bytes.length > 100 && bytes.readUInt16BE(0) === 0xffd8 && bytes.readUInt16BE(bytes.length - 2) === 0xffd9, 'A useful JPEG was not decoded.');
    let offset = 2;
    while (offset + 8 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const marker = bytes[offset + 1]; offset += 2;
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
        offset += length;
    }
    throw Error('The JPEG did not report dimensions.');
}
async function decodedFrame(url) {
    const proc = tracked(binary, ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '10000000',
        '-analyzeduration', '1000000', '-probesize', '262144', '-c:v', 'h264', '-i', url,
        '-frames:v', '1', '-an', '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], 'HTTP H264 decoder');
    const chunks = []; let size = 0;
    proc.stdout.on('data', bytes => { size += bytes.length; if (size > 1024 * 1024) proc.kill('SIGTERM'); else chunks.push(bytes); });
    await bounded(new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', code => code === 0 ? resolve() : reject(Error('Generated HTTP stream did not decode.'))); }), 'HTTP decoder timed out.');
    return jpegDimensions(Buffer.concat(chunks));
}

async function holdViewer(url) {
    const controller = new AbortController(); mediaControllers.add(controller);
    const response = await fetch(url, { signal: controller.signal });
    assert.equal(response.status, 200, 'An active fixture viewer could not open its media lease.');
    const reader = response.body.getReader();
    const draining = (async () => { while (!(await reader.read()).done) { /* Retain a real HTTP viewer. */ } })();
    draining.catch(() => {});
    return async () => { controller.abort(); await draining.catch(() => {}); mediaControllers.delete(controller); };
}

async function workerLifecycle() {
    const a = camera('A'), b = camera('B');
    const pa = client.videoUrl(a); pa.catch(() => {});
    const pb = client.videoUrl(b); pb.catch(() => {});
    await until(() => workers.length === 2 && workers.every(worker => worker.bound), 'Real SDK workers did not bind through the production HTTP RPC client.');
    await client.stop(a.EufyDevice.getSerial());
    assert.equal(workers[0].threadId, -1); assert.ok(workers[1].threadId > 0, 'Stopping one SDK source terminated its peer.');
    await client.stop(b.EufyDevice.getSerial());
    await Promise.allSettled([pa, pb]);
    assert.equal(workers[1].threadId, -1);

    sourceMode = 'gateway';
    const c = camera('C'), pc = client.videoUrl(c); pc.catch(() => {});
    await until(() => workers.at(-1).gatewayReady, 'Actual SDK gateway-info getCipher handling did not complete over HTTP RPC.');
    assert.ok(apiCalls.includes('cipher'));
    await client.stop(c.EufyDevice.getSerial()); await Promise.allSettled([pc]);
    assert.equal(workers.at(-1).threadId, -1);

    sourceMode = 'worker'; pausedDsk = { seen: defer(), reply: defer() };
    const d = camera('D'), pd = client.videoUrl(d); pd.catch(() => {});
    await bounded(pausedDsk.seen.promise, 'Pending cloud RPC was not observed.');
    d.allowed = false;
    await client.stop(d.EufyDevice.getSerial());
    assert.equal(workers.at(-1).threadId, -1, 'Privacy cancellation returned before the owned worker exited.');
    pausedDsk.reply.resolve(dskResponse()); pausedDsk = null;
    await Promise.allSettled([pd]); await sleep(30);
    assert.equal(helper.records.size, 0); assert.equal(client.sourceCount(), 0);
    assert.ok(workers.every(worker => worker.threadId === -1), 'A late RPC revived an owned SDK worker.');
}

async function mediaAndUpdates(port) {
    sourceMode = 'media';
    const a = camera('M'), b = camera('N'), hevc = camera('O', VideoCodec.H265);
    const [aUrl, bUrl, hevcUrl] = await Promise.all([client.videoUrl(a), client.videoUrl(b), client.videoUrl(hevc)]);
    // These update/snapshot checks need continuing viewers; the separate idle
    // case below intentionally removes its final HTTP viewer and awaits410.
    const viewers = await Promise.all([aUrl, bUrl, hevcUrl].map(holdViewer));
    const frames = await Promise.all([decodedFrame(aUrl), decodedFrame(aUrl), decodedFrame(bUrl), decodedFrame(hevcUrl)]);
    assert.deepEqual(frames.slice(0, 3), Array(3).fill({ width: 160, height: 120 }));
    assert.deepEqual(frames[3], { width: 640, height: 360 });
    const snapshots = await Promise.all([client.snapshot(a), client.snapshot(a), client.snapshot(hevc)]);
    assert.deepEqual(jpegDimensions(snapshots[0]), { width: 160, height: 120 });
    assert.deepEqual(snapshots[0], snapshots[1], 'Concurrent snapshots did not share a single capture.');
    assert.deepEqual(jpegDimensions(snapshots[2]), { width: 640, height: 360 });
    for (const hd of [a, b, hevc]) assert.equal(starts.get(hd.EufyDevice.getSerial()), 1);
    await client.stop(a.EufyDevice.getSerial());
    assert.equal((await fetch(aUrl)).status, 404);
    assert.equal(helper.records.size, 2); await decodedFrame(bUrl);

    // Recreate the Homey-side client: a new epoch cannot use old sessions, but
    // the persistent device capability is unchanged after explicit restoration.
    await Promise.all(viewers.map(close => close())); await client.dispose(); client = createClient();
    const restored = await client.videoUrl(a); assert.equal(restored, aUrl);
    await decodedFrame(restored);
    const oldInstance = helper.instance, oldSession = client.entries.get(a.EufyDevice.getSerial()).id;
    blockedClient = true; await helper.close();
    const restarted = await createHelper(port); helper = restarted.instance;
    assert.notEqual(helper.instance, oldInstance);
    assert.equal((await fetch(aUrl)).status, 404, 'A persistent URL resurrected a source without a new lease.');
    assert.equal(helper.records.size, 0);
    blockedClient = false;
    await until(() => client.entries.get(a.EufyDevice.getSerial())?.ready && helper.records.size === 1,
        'The production client did not restore its desired camera after a helper restart.');
    assert.notEqual(client.entries.get(a.EufyDevice.getSerial()).id, oldSession);
    assert.equal(await client.videoUrl(a), aUrl); await decodedFrame(aUrl);
    a.allowed = false; await client.stop(a.EufyDevice.getSerial());
    assert.equal((await fetch(aUrl)).status, 404); assert.equal(helper.records.size, 0);
    a.allowed = true;
    return { a, aUrl };
}

async function incompatibleUpgradeRollback({ a, aUrl }, workingOrigin) {
    await client.dispose();
    let unexpectedMutation = 0;
    const future = http.createServer((request, response) => {
        if (request.headers.authorization !== `Bearer ${SECRET}`) { response.writeHead(401); response.end(); return; }
        if (request.method !== 'GET' || request.url !== '/v1/health') unexpectedMutation++;
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ protocol: 2, version: '0.2.0', sdk: '4.2.6', instance: randomUUID() }));
    });
    controlServers.add(future);
    await new Promise((resolve, reject) => { future.once('error', reject); future.listen(0, '127.0.0.1', resolve); });
    settings.set('camera_helper_connection', { protocol: 1, url: `http://127.0.0.1:${future.address().port}`, token: SECRET });
    client = createClient();
    await assert.rejects(client.videoUrl(a), /helper is unavailable/i);
    await client.dispose();
    assert.equal(unexpectedMutation, 0, 'an incompatible helper received a camera request before version validation');
    assert.equal(helper.records.size, 0);
    settings.set('camera_helper_connection', { protocol: 1, url: workingOrigin, token: SECRET });
    client = createClient();
    assert.equal(await client.videoUrl(a), aUrl, 'rolling back a rejected protocol upgrade changed the saved camera URL');
    await decodedFrame(aUrl);
    await client.stop(a.EufyDevice.getSerial());
    await new Promise(resolve => { future.close(resolve); future.closeAllConnections?.(); });
    controlServers.delete(future);
}

async function idleReleaseAndExplicitReopen() {
    const hd = camera('P'), serial = hd.EufyDevice.getSerial();
    const url = await client.videoUrl(hd);
    await decodedFrame(url); // Closing this HTTP viewer is the only stop signal.
    const count = starts.get(serial);
    await until(() => helper.records.size === 0 && client.sourceCount() === 0,
        'Closing Live View did not release its server lease and client capacity.', 12000);
    assert.equal((await fetch(url)).status, 410);
    await sleep(400);
    assert.equal(starts.get(serial), count, 'The client automatically recreated an idle-retired camera.');
    assert.equal(helper.records.size, 0);
    assert.equal(await client.videoUrl(hd), url, 'Explicitly reopening changed the stable camera capability.');
    await decodedFrame(url);
    await client.stop(serial);
    assert.equal(helper.records.size, 0); assert.equal(client.sourceCount(), 0);
}

async function main() {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-helper-smoke-'));
    const resolver = new FfmpegResolver(homey);
    for (const candidate of [process.env.FFMPEG_PATH, '/usr/bin/ffmpeg', resolver.getBundledPath()].filter(Boolean)) {
        if (spawnSync(candidate, ['-version'], { timeout: 5000, stdio: 'ignore' }).status === 0) { binary = candidate; break; }
    }
    assert.ok(binary, 'A preinstalled FFmpeg binary is required; this smoke never downloads dependencies.');
    const started = await createHelper(); helper = started.instance;
    settings = new Map([['camera_helper_devices', true], ['camera_helper_connection', { protocol: 1, url: started.origin, token: SECRET }]]);
    client = createClient();
    await workerLifecycle();
    const restored = await mediaAndUpdates(started.port);
    await incompatibleUpgradeRollback(restored, started.origin);
    await idleReleaseAndExplicitReopen();
    await client.dispose();
    assert.equal(helper.records.size, 0);
    await helper.close();
    assert.ok(workers.every(worker => worker.threadId === -1));
    assert.equal(sources.size, 0);
    console.log('Camera helper integration verified: actual Homey client/protocol, real SDK workers and owned UDP cleanup, cipher RPC/fallback, late privacy cancellation, isolated same-HomeBase feeds, real H264/HEVC HTTP decoding and snapshots, app-client recreation, persistent-link helper restart recovery, incompatible-upgrade rollback, HTTP-viewer idle retirement without auto-recreation, explicit same-camera reopening, and final resource cleanup.');
}

async function cleanup() {
    blockedClient = false;
    for (const controller of mediaControllers) controller.abort();
    await Promise.allSettled(clients.map(item => bounded(item.dispose(), 'Client cleanup deadline.', 4000)));
    await Promise.allSettled(helpers.map(item => bounded(item.close(), 'Helper cleanup deadline.', 6000)));
    await Promise.allSettled(workers.filter(worker => worker.threadId !== -1).map(worker => worker.terminate()));
    await Promise.allSettled([...processes].map(proc => closeProcess(proc)));
    await Promise.allSettled([...controlServers].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); })));
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
}
const deadline = setTimeout(() => { console.error('Camera helper integration exceeded its 65-second deadline.'); cleanup().finally(() => process.exit(1)); }, 65000);
main().catch(error => {
    process.exitCode = 1; console.error(`Camera helper integration failed: ${error.message}`);
    for (const item of diagnostics) if (item.stderr) console.error(`[${item.label}] ${item.stderr.replace(/\/v1\/media\/[a-f0-9]{48}\.ts/g, '/v1/media/[redacted].ts')}`);
}).finally(async () => { await cleanup(); clearTimeout(deadline); });
