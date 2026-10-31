'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const nodeTest = require('node:test');

const test = (name, fn) => nodeTest(name, { timeout: 7000 }, fn);
const OWNER = 'com.eufylife.security';
const SECRET = 'b'.repeat(64);
const SDK_VERSION = '4.2.6';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    return { promise, resolve, reject };
}

const turn = () => new Promise(setImmediate);

class Camera {
    constructor(api, raw) { this.api = api; this.raw = raw; }
    static async getInstance(api, raw) { return new Camera(api, raw); }
    initialize() {}
    getSerial() { return this.raw.device_sn; }
    getStationSerial() { return this.raw.station_sn; }
    getChannel() { return this.raw.device_channel; }
    getRawDevice() { return this.raw; }
    hasCommand(name) { return name === 'deviceStartLivestream'; }
    hasProperty(name) { return name === 'enabled'; }
    getPropertyValue(name) { return name === 'enabled' ? true : undefined; }
}

const sdk = {
    Camera,
    CommandName: { DeviceStartLivestream: 'deviceStartLivestream' },
    PropertyName: { DeviceEnabled: 'enabled', DeviceRTSPStream: 'rtspStream', DeviceRTSPStreamUrl: 'rtspStreamUrl' },
    VideoCodec: { H264: 0, H265: 1 },
};

function metadata(label = 'A') {
    const station = 'FIXTURE_HOMEBASE';
    const device = `FIXTURE_CAMERA_${label}`;
    return {
        rawStation: { station_sn: station, device_type: 18, station_name: 'Synthetic HomeBase',
            p2p_did: 'FIXTURE_DID', app_conn: '', main_sw_version: '3.3.0.0', params: [],
            member: { admin_user_id: 'FIXTURE_ADMIN' } },
        rawDevice: { device_sn: device, station_sn: station, device_channel: label.charCodeAt(0) - 65,
            device_type: 1, device_name: `Synthetic ${label}`, params: [], main_sw_version: '4.0.0.0' },
        deviceConstructor: 'Camera', connectionType: 1, ipAddress: '127.0.0.1',
        config: { deviceConfig: { simultaneousDetections: true }, enableEmbeddedPKCS1Support: false },
        connected: true,
    };
}

// This fixture replaces heavy media work, while the production server still
// owns authentication, epochs, HTTP routes, capabilities, leases and cleanup.
class FixtureManager {
    constructor(homey, options, fixture) {
        this.homey = homey;
        this.options = options;
        this.fixture = fixture;
        this.sessions = new Map();
        this.stopping = new Map();
        this.starts = [];
        this.stops = [];
        this.disposed = false;
    }
    async registerVideo() {}
    async getSession(hd) {
        const serial = hd.EufyDevice.getSerial();
        if (this.sessions.has(serial)) return this.sessions.get(serial);
        const session = { serial, hd, ready: deferred(), bytes: 188, startedAt: this.fixture.now(), state: 'connecting' };
        this.sessions.set(serial, session);
        this.starts.push(serial);
        if (this.fixture.autoReady) {
            session.state = 'streaming';
            session.firstFrameAt = this.fixture.now();
            session.ready.resolve();
        }
        return session;
    }
    getStatus(serial) {
        const session = this.sessions.get(serial);
        return session ? { state: session.state, bytes: session.bytes, startedAt: session.startedAt,
            firstFrameAt: session.firstFrameAt } : { state: 'stopped', bytes: 0 };
    }
    sourceCount() { return new Set([...this.sessions.keys(), ...this.stopping.keys()]).size; }
    async stopStream(serial) {
        if (serial == null) return Promise.all([...this.sessions.keys()].map(id => this.stopStream(id)));
        if (this.stopping.has(serial)) return this.stopping.get(serial);
        const session = this.sessions.get(serial);
        if (!session) return;
        this.stops.push(serial);
        const stopped = (async () => {
            const gate = this.fixture.closeGates.get(serial);
            if (gate) await gate.promise;
            session.ready.reject(Error('Synthetic source cancelled.'));
            this.sessions.delete(serial);
        })();
        this.stopping.set(serial, stopped);
        try { await stopped; } finally { this.stopping.delete(serial); }
    }
    async dispose() {
        await Promise.all([...this.sessions.keys()].map(id => this.stopStream(id)));
        await Promise.all(this.stopping.values());
        this.disposed = true;
    }
    async serve(request, response) {
        this.fixture.mediaRequests.push(request.url);
        const capability = /^\/live\/([a-f0-9]{48})\.ts$/.exec(request.url)?.[1];
        const session = [...this.sessions.values()].find(candidate => candidate.hd.helperRecord.cap === capability);
        if (session) await session.ready.promise;
        const bytes = Buffer.alloc(188);
        bytes[0] = 0x47;
        response.writeHead(200, { 'Content-Type': 'video/MP2T' });
        if (this.fixture.keepMediaOpen) response.write(bytes);
        else response.end(bytes);
    }
    async requestSnapshot(hd) {
        if (this.fixture.snapshotGate) await this.fixture.snapshotGate.promise;
        await fs.writeFile(path.join(this.fixture.workspace, `${hd.EufyDevice.getSerial()}_snapshot.jpg`),
            this.fixture.snapshotBytes || Buffer.from([0xff, 0xd8, 0, 0, 0xff, 0xd9]));
        return true;
    }
}

async function fixture(t, options = {}) {
    const { HelperServer } = require('../helper/service.cjs');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-helper-service-test-'));
    const fixture = { now: options.now || (() => Date.now()), autoReady: options.autoReady !== false,
        closeGates: new Map(), managers: [], mediaRequests: [], servers: [], workspace,
        keepMediaOpen: options.keepMediaOpen === true, snapshotGate: options.snapshotGate, snapshotBytes: options.snapshotBytes };
    t.after(async () => {
        for (const gate of fixture.closeGates.values()) gate.resolve();
        await Promise.allSettled(fixture.servers.map(server => server.close()));
        await fs.rm(workspace, { recursive: true, force: true });
    });
    const makeServer = async (extra = {}) => {
        const helper = new HelperServer({ secret: SECRET, port: 0, host: '127.0.0.1', mediaDir: workspace,
            now: fixture.now, leaseMs: options.leaseMs || 75000, startTimeoutMs: 1000, rpcTimeoutMs: 1000,
            runtime: { sdk, ManagerClass: FixtureManager },
            managerFactory: (homey, config) => {
                const manager = new FixtureManager(homey, config, fixture);
                fixture.managers.push(manager);
                return manager;
            },
            ...extra });
        const address = await helper.listen();
        fixture.servers.push(helper);
        return { helper, origin: `http://127.0.0.1:${address.port}` };
    };
    const running = await makeServer(options.serverOptions);
    Object.assign(fixture, running, { makeServer, epoch: randomUUID(), owner: OWNER });
    fixture.request = async (method, route, body, extra = {}) => {
        const response = await fetch(`${extra.origin || fixture.origin}${route}`, {
            method, headers: { Authorization: `Bearer ${SECRET}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(extra.headers || {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000),
        });
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); } catch { /* Media/error responses need not be JSON. */ }
        return { status: response.status, json, text, headers: response.headers };
    };
    fixture.connect = (body = {}, extra) => fixture.request('POST', '/v1/connect', {
        owner: fixture.owner, epoch: fixture.epoch, protocol: 1, sdk: SDK_VERSION, ...body,
    }, extra);
    fixture.open = async (label = 'A', body = {}, extra) => {
        const response = await fixture.request('POST', '/v1/sessions', {
            owner: fixture.owner, epoch: fixture.epoch, requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata(label), ...body,
        }, extra);
        assert.ok(response.status >= 200 && response.status < 300, `Session creation failed (${response.status}).`);
        assert.match(response.json.id, /^[0-9a-f-]{36}$/);
        assert.match(response.json.mediaUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1\/media\/[0-9a-f]{48}\.ts$/);
        return response.json;
    };
    if (options.connect !== false) assert.equal((await fixture.connect()).status, 200);
    return fixture;
}

async function eventReader(t, fixture, id) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${fixture.origin}/v1/sessions/${id}/events`, {
        headers: { Authorization: `Bearer ${SECRET}` }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
    const reader = response.body.getReader();
    let buffered = '';
    t.after(() => { clearTimeout(deadline); controller.abort(); });
    return {
        close() { controller.abort(); },
        async next() {
            while (true) {
                const at = buffered.indexOf('\n');
                if (at >= 0) {
                    const line = buffered.slice(0, at).trim(); buffered = buffered.slice(at + 1);
                    if (line) return JSON.parse(line);
                    continue;
                }
                const result = await reader.read();
                if (result.done) throw Error('The synthetic RPC event stream ended.');
                buffered += Buffer.from(result.value).toString('utf8');
            }
        },
    };
}

test('P2P progress produces only fixed safe diagnostic events while its lease is current', async t => {
    const entries = [];
    let callbacks;
    const f = await fixture(t, { autoReady: false, serverOptions: {
        onDiagnostic: entry => entries.push(entry),
        createP2PSession: params => { callbacks = params; return { async start() {}, async close() {} }; },
    } });
    const opened = await f.open();
    const record = f.helper.records.get(opened.id), manager = f.managers.at(-1);
    await record.startPromise;
    manager.options.createP2PSession({ homeyDevice: record.hd, onStream() {}, onStop() {}, onError() {} });
    assert.equal(record.p2pPhase, null);
    const phases = ['device-create', 'device-init', 'station-create', 'station-init', 'connect', 'start', 'stream'];
    const expected = ['p2p.device_create', 'p2p.device_init', 'p2p.station_create', 'p2p.station_init', 'p2p.connecting', 'p2p.start_video', 'p2p.receiving_video'];
    for (const phase of phases) callbacks.onPhase(phase, { token: SECRET, station: record.serial });
    assert.equal(record.p2pPhase, 'stream');
    assert.deepEqual(entries.filter(entry => expected.includes(entry.event)).map(entry => entry.event), expected);
    assert.ok(entries.every(entry => Object.isFrozen(entry) && Object.keys(entry).sort().join(',') === 'event,message'));
    const count = entries.length;
    for (const phase of ['stream', '__proto__', 'connect\nPRIVATE_SECRET', null, 4, [], { phase: 'connect', token: SECRET }]) callbacks.onPhase(phase);
    assert.equal(entries.length, count); assert.equal(record.p2pPhase, 'stream');
    assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_SECRET|FIXTURE_|\/v1\/media/);
    assert.equal(JSON.stringify(entries).includes(SECRET), false);

    manager.sessions.get(record.serial).ready.resolve(); await turn();
    assert.equal(entries.filter(entry => entry.event === 'source.ready').length, 1);
    assert.equal(Object.hasOwn((await f.request('GET', `/v1/sessions/${record.id}/status`)).json, 'p2pPhase'), false);
    assert.equal((await f.request('DELETE', `/v1/sessions/${record.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
    const closedCount = entries.length;
    for (const phase of phases) callbacks.onPhase(phase);
    assert.equal(entries.length, closedCount, 'closed leases must not emit late progress');
});

test('startup timeout keeps the last safe P2P phase without duplicating failure diagnostics', async t => {
    const entries = [];
    let callbacks;
    const f = await fixture(t, { autoReady: false, serverOptions: {
        onDiagnostic: entry => entries.push(entry),
        createP2PSession: params => { callbacks = params; return { async start() {}, async close() {} }; },
    } });
    const opened = await f.open();
    const record = f.helper.records.get(opened.id), manager = f.managers.at(-1);
    await record.startPromise;
    const source = manager.sessions.get(record.serial);
    manager.options.createP2PSession({ homeyDevice: record.hd, onStream() {}, onStop() {}, onError: error => source.ready.reject(error) });
    callbacks.onPhase('connect');
    callbacks.onError(Object.assign(Error('The camera did not deliver independent video in time.'), { mediaPublic: true, metadata: SECRET }));
    await turn();
    assert.equal(record.p2pPhase, 'connect');
    assert.deepEqual(entries.slice(-3).map(entry => entry.event), ['p2p.connecting', 'media.input_0', 'source.start_timeout']);
    assert.equal(entries.filter(entry => entry.event === 'source.start_timeout').length, 1);
    const count = entries.length;
    callbacks.onPhase('start'); callbacks.onCodecCorrection(0, 1); callbacks.onError(Error(SECRET));
    assert.equal(entries.length, count, 'a failed source must not report later progress or duplicate failures');
    assert.equal(JSON.stringify(entries).includes(SECRET), false);
});

test('T8423 codec diagnostics accept only the two enum directions and log once per current lease', async t => {
    const entries = [], callbacks = [];
    const f = await fixture(t, { serverOptions: {
        onDiagnostic: entry => entries.push(entry),
        createP2PSession: params => { callbacks.push(params); return { async start() {}, async close() {} }; },
    } });
    const opened = await f.open();
    const record = f.helper.records.get(opened.id), manager = f.managers.at(-1);
    await record.startPromise;
    const parameters = { homeyDevice: record.hd, onStream() {}, onStop() {}, onError() {} };
    manager.options.createP2PSession(parameters);
    const first = callbacks[0];
    const initialCount = entries.length;
    for (const args of [[], [0], [true, 1], [0, false], [0, 0], [1, 1], ['0', 1], [0, '1'], [0, 2],
        [null, 1], [0, { token: SECRET }], [0, 1, SECRET]]) first.onCodecCorrection(...args);
    assert.equal(entries.length, initialCount, 'unexpected callback arguments must not produce a diagnostic');
    first.onCodecCorrection(0, 1); first.onCodecCorrection(0, 1);
    assert.deepEqual(entries.filter(entry => entry.event === 'p2p.codec_h264_to_hevc'), [{
        event: 'p2p.codec_h264_to_hevc', message: 'The T8423 video input was identified as HEVC instead of declared H.264.',
    }]);
    assert.equal(record.codecCorrectionReported, true);
    manager.options.createP2PSession(parameters);
    callbacks[1].onCodecCorrection(1, 0);
    assert.equal(entries.filter(entry => entry.event.startsWith('p2p.codec_')).length, 1, 'another source within the lease must not repeat the marker');
    assert.doesNotMatch(JSON.stringify(entries), /FIXTURE_|\/v1\/media/);
    assert.equal(JSON.stringify(entries).includes(SECRET), false);

    assert.equal((await f.request('DELETE', `/v1/sessions/${record.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
    const closedCount = entries.length;
    first.onCodecCorrection(0, 1); callbacks[1].onCodecCorrection(1, 0);
    assert.equal(entries.length, closedCount);

    const reverse = await f.open('B'), reverseRecord = f.helper.records.get(reverse.id);
    await reverseRecord.startPromise;
    manager.options.createP2PSession({ ...parameters, homeyDevice: reverseRecord.hd });
    callbacks[2].onCodecCorrection(1, 0);
    assert.deepEqual(entries.filter(entry => entry.event === 'p2p.codec_hevc_to_h264'), [{
        event: 'p2p.codec_hevc_to_h264', message: 'The T8423 video input was identified as H.264 instead of declared HEVC.',
    }]);
    const unused = await f.open('C'), unusedRecord = f.helper.records.get(unused.id);
    await unusedRecord.startPromise;
    manager.options.createP2PSession({ ...parameters, homeyDevice: unusedRecord.hd });
    assert.equal((await f.request('DELETE', `/v1/sessions/${unused.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
    const beforeLateFirstCorrection = entries.length;
    callbacks[3].onCodecCorrection(0, 1);
    assert.equal(entries.length, beforeLateFirstCorrection, 'a closed lease must also ignore its first correction callback');
});

test('owned media stderr uses bounded split-safe fixed categories without leaking input text', async t => {
    const entries = [], processes = [];
    const f = await fixture(t, { serverOptions: {
        onDiagnostic: entry => entries.push(entry),
        spawn: () => { const proc = new EventEmitter(); proc.stderr = new EventEmitter(); proc.exitCode = 0; processes.push(proc); return proc; },
    } });
    const opened = await f.open(), record = f.helper.records.get(opened.id), manager = f.managers.at(-1);
    const create = () => f.helper.context.run(record, () => manager.options.spawn('/synthetic/ffmpeg', ['-mpegts_flags', 'resend_headers', 'pipe:1']));
    const proc = create();
    proc.stderr.emit('data', Buffer.from(`rtsp://private-user:${SECRET}@camera/path [h264] non-exis`));
    proc.stderr.emit('data', Buffer.from('ting PPS 0 referenced\n'));
    const oversized = Buffer.alloc(1024 * 1024, 120);
    Buffer.from('Invalid NAL unit').copy(oversized, 4093);
    Buffer.from('Output file does not contain any stream').copy(oversized, oversized.length - 80);
    proc.stderr.emit('data', oversized);
    const categories = ['media.codec_missing_parameter_sets', 'media.invalid_bitstream', 'media.no_streams'];
    assert.deepEqual(entries.filter(entry => categories.includes(entry.event)).map(entry => entry.event), categories);
    proc.stderr.emit('data', Buffer.from('SPS unavailable\nInvalid data found\nno video streams found\n'));
    const other = create(); other.stderr.emit('data', Buffer.from('VPS 0 does not exist\n'));
    assert.equal(entries.filter(entry => categories.includes(entry.event)).length, 3, 'each category is bounded per lease across processes');
    assert.equal(entries.filter(entry => entry.event === 'media.started').length, 1);
    assert.ok(entries.every(entry => Object.keys(entry).sort().join(',') === 'event,message'));
    assert.doesNotMatch(JSON.stringify(entries), /rtsp:|private-user|FIXTURE_|referenced|Invalid NAL|Output file/);
    assert.equal(JSON.stringify(entries).includes(SECRET), false);
    proc.emit('close', 0);
    assert.equal(proc.stderr.listenerCount('data'), 0);
    const detached = entries.length;
    proc.stderr.emit('data', Buffer.from('Invalid bitstream'));
    assert.equal(entries.length, detached);
    other.emit('close', 0);

    const unused = await f.open('B'), unusedRecord = f.helper.records.get(unused.id);
    const late = f.helper.context.run(unusedRecord, () => manager.options.spawn('/synthetic/ffmpeg', []));
    assert.equal((await f.request('DELETE', `/v1/sessions/${unused.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
    const closed = entries.length;
    late.stderr.emit('data', Buffer.from('non-existing PPS\nInvalid data found\nno video streams found\n'));
    assert.equal(entries.length, closed, 'closed leases must not classify late stderr');
    late.emit('close', 0);
});

test('media input and mux-spawn markers are first-only and ignore snapshots or closed leases', async t => {
    const entries = [], callbacks = [];
    const f = await fixture(t, { serverOptions: {
        onDiagnostic: entry => entries.push(entry),
        createP2PSession: params => { callbacks.push(params); return { async start() {}, async close() {} }; },
        spawn: () => { const proc = new EventEmitter(); proc.stderr = new EventEmitter(); proc.exitCode = 0; return proc; },
    } });
    const opened = await f.open(), record = f.helper.records.get(opened.id), manager = f.managers.at(-1);
    const parameters = { homeyDevice: record.hd, onStream(video) { video.resume(); }, onStop() {}, onError() {} };
    manager.options.createP2PSession(parameters);
    const video = new PassThrough();
    callbacks[0].onStream(video, null, {});
    assert.equal(entries.filter(entry => entry.event === 'media.input_bytes').length, 0);
    video.write(Buffer.from(SECRET)); video.write(Buffer.from('more synthetic bytes'));
    assert.equal(entries.filter(entry => entry.event === 'media.input_bytes').length, 1);
    assert.equal(JSON.stringify(entries).includes(SECRET), false);
    const snapshot = f.helper.context.run(record, () => manager.options.spawn('/synthetic/ffmpeg', ['-frames:v', '1', '-f', 'image2pipe']));
    assert.equal(entries.filter(entry => entry.event === 'media.started').length, 0);
    const mux = f.helper.context.run(record, () => manager.options.spawn('/synthetic/ffmpeg', ['-mpegts_flags', 'resend_headers']));
    const another = f.helper.context.run(record, () => manager.options.spawn('/synthetic/ffmpeg', ['-mpegts_flags', 'resend_headers']));
    assert.equal(entries.filter(entry => entry.event === 'media.started').length, 1);
    snapshot.emit('close', 0); mux.emit('close', 0); another.emit('close', 0); video.destroy();

    const idle = await f.open('B'), idleRecord = f.helper.records.get(idle.id);
    manager.options.createP2PSession({ ...parameters, homeyDevice: idleRecord.hd });
    const pending = new PassThrough(); callbacks[1].onStream(pending, null, {});
    assert.equal((await f.request('DELETE', `/v1/sessions/${idle.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
    const beforeLateBytes = entries.length;
    pending.write(Buffer.from(SECRET)); pending.destroy();
    assert.equal(entries.length, beforeLateBytes);
});

test('startup timeouts emit one fixed parent-input bucket at the exact byte boundaries', async t => {
    const cases = [[0, 'media.input_0'], [1, 'media.input_under_32kib'], [32767, 'media.input_under_32kib'],
        [32768, 'media.input_under_256kib'], [262143, 'media.input_under_256kib'], [262144, 'media.input_at_least_256kib']];
    for (const [amount, bucket] of cases) await t.test(String(amount), async subtest => {
        const entries = [];
        let callbacks;
        const f = await fixture(subtest, { autoReady: false, serverOptions: {
            onDiagnostic: entry => entries.push(entry),
            createP2PSession: params => { callbacks = params; return { async start() {}, async close() {} }; },
        } });
        const opened = await f.open(), record = f.helper.records.get(opened.id), manager = f.managers.at(-1);
        await record.startPromise;
        const source = manager.sessions.get(record.serial), video = new PassThrough();
        subtest.after(() => video.destroy());
        manager.options.createP2PSession({ homeyDevice: record.hd, onStream(input) { input.resume(); }, onStop() {}, onError: error => source.ready.reject(error) });
        callbacks.onStream(video, null, {});
        if (amount) { video.write(Buffer.alloc(1)); if (amount > 1) video.write(Buffer.alloc(amount - 1)); }
        assert.equal(record.mediaInput.bytes, amount);
        assert.equal(entries.some(entry => entry.event === bucket), false, 'buckets are emitted only for a timeout');
        const timeout = Object.assign(Error('The camera did not deliver independent video in time.'), { mediaPublic: true });
        callbacks.onError(timeout); await turn();
        assert.deepEqual(entries.filter(entry => entry.event.startsWith('media.input_') && entry.event !== 'media.input_bytes').map(entry => entry.event), [bucket]);
        assert.equal(entries.filter(entry => entry.event === 'source.start_timeout').length, 1);
        callbacks.onError(timeout); video.write(Buffer.alloc(10));
        assert.equal(record.mediaInput.bytes, amount, 'late input after failure must not alter the deadline measurement');
        assert.equal((await f.request('DELETE', `/v1/sessions/${record.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
        const closedCount = entries.length;
        video.write(Buffer.alloc(10)); callbacks.onError(timeout);
        assert.equal(entries.length, closedCount);
        assert.ok(entries.every(entry => Object.keys(entry).sort().join(',') === 'event,message'));
    });
});

test('parent input counters saturate safely and reset for a replacement source without counting stale input', async t => {
    const entries = [], callbacks = [];
    const f = await fixture(t, { autoReady: false, serverOptions: {
        onDiagnostic: entry => entries.push(entry),
        createP2PSession: params => { callbacks.push(params); return { async start() {}, async close() {} }; },
    } });
    const opened = await f.open(), record = f.helper.records.get(opened.id), manager = f.managers.at(-1);
    await record.startPromise;
    const source = manager.sessions.get(record.serial);
    const parameters = { homeyDevice: record.hd, onStream(input) { input.resume(); }, onStop() {}, onError: error => source.ready.reject(error) };
    manager.options.createP2PSession(parameters);
    const first = new PassThrough(), second = new PassThrough();
    t.after(() => { first.destroy(); second.destroy(); });
    callbacks[0].onStream(first, null, {}); first.write(Buffer.alloc(10));
    const oldInput = record.mediaInput;
    manager.options.createP2PSession(parameters);
    assert.equal(record.mediaInput.bytes, 0);
    first.write(Buffer.alloc(20));
    assert.equal(oldInput.bytes, 10); assert.equal(record.mediaInput.bytes, 0);
    callbacks[1].onStream(second, null, {});
    record.mediaInput.bytes = Number.MAX_SAFE_INTEGER - 4;
    second.write(Buffer.alloc(16)); second.write(Buffer.alloc(16));
    assert.equal(record.mediaInput.bytes, Number.MAX_SAFE_INTEGER); assert.equal(Number.isSafeInteger(record.mediaInput.bytes), true);
    callbacks[1].onError(Object.assign(Error('The camera did not deliver independent video in time.'), { mediaPublic: true }));
    await turn();
    assert.equal(entries.filter(entry => entry.event === 'media.input_at_least_256kib').length, 1);
    assert.equal(JSON.stringify(entries).includes(String(Number.MAX_SAFE_INTEGER)), false, 'exact counters remain internal');
});

test('helper health and control endpoints require the persistent bearer secret', async t => {
    const f = await fixture(t, { connect: false });
    const unauthorized = await f.request('GET', '/v1/health', undefined, { headers: { Authorization: '' } });
    assert.equal(unauthorized.status, 401);
    const wrongSecret = await f.request('POST', '/v1/connect', { owner: OWNER, epoch: f.epoch, protocol: 1, sdk: SDK_VERSION },
        { headers: { Authorization: `Bearer ${'a'.repeat(64)}` } });
    assert.equal(wrongSecret.status, 401);
    assert.equal(f.managers.reduce((count, manager) => count + manager.starts.length, 0), 0);
    assert.ok(!unauthorized.text.includes(SECRET));
    const health = await f.request('GET', '/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.protocol, 1);
    assert.equal(health.json.sdk, SDK_VERSION);
    assert.match(health.json.instance, /^[0-9a-f-]{36}$/);
});

test('incompatible protocol or SDK fails before reserving any camera', async t => {
    const f = await fixture(t, { connect: false });
    assert.ok((await f.connect({ protocol: 2 })).status >= 400);
    assert.ok((await f.connect({ sdk: '4.3.0' })).status >= 400);
    assert.equal(f.helper.records.size, 0);
    assert.equal(f.managers.reduce((count, manager) => count + manager.starts.length, 0), 0);
    assert.equal((await f.connect()).status, 200, 'a rejected upgrade must leave the supported version usable');
    await f.open();
});

test('a media capability cannot create a camera without a current validated lease', async t => {
    const f = await fixture(t);
    const session = await f.open();
    const route = new URL(session.mediaUrl).pathname;
    const active = await fetch(session.mediaUrl, { signal: AbortSignal.timeout(2000) });
    assert.equal(active.status, 200);
    await active.arrayBuffer();
    const removed = await f.request('DELETE', `/v1/sessions/${session.id}`, { owner: OWNER, epoch: f.epoch });
    assert.equal(removed.status, 200);
    const stale = await fetch(`${f.origin}${route}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(stale.status, 404);
    await stale.arrayBuffer();
    assert.equal(f.helper.records.size, 0);
});

test('recreating the helper with the same secret preserves links but never resurrects a lease', async t => {
    const f = await fixture(t);
    const deviceId = randomUUID();
    const oldHealth = (await f.request('GET', '/v1/health')).json;
    const old = await f.open('A', { deviceId });
    const oldRoute = new URL(old.mediaUrl).pathname;
    await f.helper.close();
    const replacement = await f.makeServer();
    f.helper = replacement.helper;
    f.origin = replacement.origin;
    f.epoch = randomUUID();
    const health = (await f.request('GET', '/v1/health')).json;
    assert.notEqual(health.instance, oldHealth.instance);
    assert.equal((await f.request('GET', oldRoute)).status, 404);
    assert.equal((await f.request('GET', `/v1/sessions/${old.id}/status`)).status, 404);
    assert.equal((await f.connect()).status, 200);
    const reopened = await f.open('A', { deviceId });
    assert.notEqual(reopened.id, old.id);
    assert.equal(new URL(reopened.mediaUrl).pathname, oldRoute, 'persistent links must not encode the transient instance or epoch');
    assert.equal((await f.request('GET', oldRoute)).status, 200);
});

test('stopping one camera leaves a same-HomeBase peer and its media lease intact', async t => {
    const f = await fixture(t);
    const a = await f.open('A');
    const b = await f.open('B');
    assert.equal((await f.request('DELETE', `/v1/sessions/${a.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
    assert.equal((await f.request('GET', `/v1/sessions/${b.id}/status`)).status, 200);
    assert.equal((await f.request('GET', new URL(b.mediaUrl).pathname)).status, 200);
    assert.equal((await f.request('GET', new URL(a.mediaUrl).pathname)).status, 404);
    assert.ok(f.managers.at(-1).sessions.has('FIXTURE_CAMERA_B'));
    assert.ok(!f.managers.at(-1).stops.includes('FIXTURE_CAMERA_B'));
});

test('lease expiry revokes media access and closes the source until explicit restoration', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, leaseMs: 100 });
    const session = await f.open();
    now += 101;
    await f.helper.prune();
    assert.equal((await f.request('GET', `/v1/sessions/${session.id}/status`)).status, 404);
    assert.equal((await f.request('GET', new URL(session.mediaUrl).pathname)).status, 404);
    assert.equal(f.helper.records.size, 0);
    assert.ok(f.managers.at(-1).stops.includes('FIXTURE_CAMERA_A'));
    await turn();
    assert.equal(f.managers.at(-1).starts.length, 1, 'expiry must not start its own reconnect loop');
});

test('an expired app epoch cannot renew or revive a session after reconnect', async t => {
    const f = await fixture(t);
    const oldEpoch = f.epoch;
    const old = await f.open();
    f.epoch = randomUUID();
    assert.equal((await f.connect()).status, 200);
    assert.equal((await f.request('POST', `/v1/sessions/${old.id}/renew`, { owner: OWNER, epoch: oldEpoch })).status, 404);
    assert.equal((await f.request('GET', new URL(old.mediaUrl).pathname)).status, 404);
    const staleOpen = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: oldEpoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('B') });
    assert.ok(staleOpen.status >= 400);
    assert.equal(f.helper.records.size, 0);
    await f.open('B');
});

test('the four-source cap counts cameras still connecting', async t => {
    const f = await fixture(t, { autoReady: false });
    for (const label of ['A', 'B', 'C', 'D']) await f.open(label);
    const fifth = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('E') });
    assert.ok(fifth.status >= 400, 'a fifth pending source escaped the capacity bound');
    assert.equal(f.helper.records.size, 4);
    assert.equal(f.managers.at(-1).starts.length, 4);
});

test('cancelling before session creation leaves a tombstone that blocks a delayed POST', async t => {
    const f = await fixture(t);
    const requestId = randomUUID();
    const deviceId = randomUUID();
    const cancelled = await f.request('DELETE', `/v1/requests/${requestId}`, { owner: OWNER, epoch: f.epoch, deviceId });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.cancelled, true);
    const delayed = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId, deviceId, metadata: metadata('A') });
    assert.equal(delayed.status, 409);
    assert.equal(f.helper.records.size, 0);
    assert.equal(f.managers.at(-1).starts.length, 0);
    await f.open('A', { deviceId });
});

test('retrying an uncertain creation request is idempotent and cannot allocate twice', async t => {
    const f = await fixture(t);
    const requestId = randomUUID();
    const deviceId = randomUUID();
    const first = await f.open('A', { requestId, deviceId });
    const replayed = await f.open('A', { requestId, deviceId });
    assert.deepEqual(replayed, first);
    assert.equal(f.managers.at(-1).starts.length, 1);
    assert.equal(f.helper.records.size, 1);
    const mismatched = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId, deviceId: randomUUID(), metadata: metadata('B') });
    assert.equal(mismatched.status, 409);
    assert.equal(f.managers.at(-1).starts.length, 1);
});

test('request cancellation revokes an uncertain source while preserving a peer', async t => {
    const f = await fixture(t);
    const requestId = randomUUID();
    const deviceId = randomUUID();
    const unknownToCaller = await f.open('A', { requestId, deviceId });
    const peer = await f.open('B');
    const cancelled = await f.request('DELETE', `/v1/requests/${requestId}`, { owner: OWNER, epoch: f.epoch, deviceId });
    assert.equal(cancelled.status, 200);
    assert.equal((await f.request('GET', `/v1/sessions/${unknownToCaller.id}/status`)).status, 404);
    assert.equal((await f.request('GET', new URL(unknownToCaller.mediaUrl).pathname)).status, 404);
    assert.equal((await f.request('GET', `/v1/sessions/${peer.id}/status`)).status, 200);
    assert.ok(!f.managers.at(-1).stops.includes('FIXTURE_CAMERA_B'));
});

test('source capacity remains reserved until cancellation confirms cleanup', async t => {
    const f = await fixture(t);
    const requestId = randomUUID();
    const deviceId = randomUUID();
    const first = await f.open('A', { requestId, deviceId });
    for (const label of ['B', 'C', 'D']) await f.open(label);
    const gate = deferred();
    f.closeGates.set('FIXTURE_CAMERA_A', gate);
    let cancellationFinished = false;
    const cancelling = f.request('DELETE', `/v1/requests/${requestId}`, { owner: OWNER, epoch: f.epoch, deviceId })
        .then(result => { cancellationFinished = true; return result; });
    for (let index = 0; index < 10 && !f.managers.at(-1).stops.includes('FIXTURE_CAMERA_A'); index++) await turn();
    assert.equal(cancellationFinished, false);
    assert.equal((await f.request('GET', new URL(first.mediaUrl).pathname)).status, 404,
        'closing must revoke the public capability before waiting for heavy cleanup');
    let fifthFinished = false;
    const fifth = f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('E') })
        .then(result => { fifthFinished = true; return result; });
    for (let index = 0; index < 10; index++) await turn();
    assert.equal(fifthFinished, false, 'new allocation must await confirmation that the old source closed');
    assert.equal(f.managers.at(-1).starts.length, 4);
    gate.resolve();
    assert.equal((await cancelling).status, 200);
    assert.equal((await fifth).status, 200);
    assert.equal(f.managers.at(-1).starts.length, 5);
});

test('account-token metadata and malformed JSON are rejected before source allocation', async t => {
    const f = await fixture(t);
    for (const name of ['access_token', 'refreshToken', 'auth_token', 'apiKey', 'password']) {
        const value = metadata(); value.rawStation[name] = 'ACCOUNT_SECRET_SENTINEL';
        const response = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
            requestId: randomUUID(), deviceId: randomUUID(), metadata: value });
        assert.equal(response.status, 400);
        assert.ok(!response.text.includes('ACCOUNT_SECRET_SENTINEL'));
    }
    const malformed = await fetch(`${f.origin}/v1/sessions`, { method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: '{', signal: AbortSignal.timeout(2000) });
    assert.equal(malformed.status, 400); await malformed.text();
    assert.equal(f.helper.records.size, 0);
    assert.equal(f.managers.at(-1).starts.length, 0);
    await f.open();
});

test('only the lease camera and original station owner may issue SDK cloud requests', async t => {
    const f = await fixture(t);
    const session = await f.open();
    const record = f.helper.records.get(session.id);
    const api = record.hd.rpcClient.getApi();
    await assert.rejects(api.getCipher(7, 'OTHER_ADMIN'));
    await assert.rejects(api.getCipher(65536, 'FIXTURE_ADMIN'));
    await assert.rejects(api.getPublicKey('OTHER_HOMEBASE', 2));
    await assert.rejects(api.getVoices('OTHER_CAMERA'));
    await assert.rejects(api.request({ method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys',
        data: { station_sns: ['OTHER_HOMEBASE'], invalid_dsks: { OTHER_HOMEBASE: '' }, transaction: '1700000000000' } }));
    assert.equal(record.pending.size, 0);
    assert.equal(record.rpcId, 0, 'forbidden requests must not produce replayable RPC events');
    const events = await eventReader(t, f, session.id);
    const call = api.getCipher(7, 'FIXTURE_ADMIN'); call.catch(() => {});
    const packet = await events.next();
    assert.deepEqual({ method: packet.method, args: packet.args }, { method: 'getCipher', args: [7, 'FIXTURE_ADMIN'] });
    assert.equal((await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: packet.id })).status, 200);
    assert.equal(await call, undefined, 'the ID-only response is the protocol representation of undefined');
});

test('RPC event reconnection replays the same pending ID and rejects stale replies after cancellation', async t => {
    const f = await fixture(t);
    const session = await f.open();
    const record = f.helper.records.get(session.id);
    const pending = record.hd.rpcClient.getApi().getCipher(7, 'FIXTURE_ADMIN'); pending.catch(() => {});
    const firstStream = await eventReader(t, f, session.id);
    const first = await firstStream.next(); firstStream.close();
    const secondStream = await eventReader(t, f, session.id);
    assert.deepEqual(await secondStream.next(), first);
    assert.equal(record.pending.size, 1);
    assert.equal((await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: first.id + 100, value: {} })).status, 404);
    assert.equal(record.pending.size, 1);
    await f.request('DELETE', `/v1/sessions/${session.id}`, { owner: OWNER, epoch: f.epoch });
    await assert.rejects(pending);
    const late = await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: first.id, value: { private_key: 'STALE_FIXTURE' } });
    assert.equal(late.status, 404);
    assert.equal(record.pending.size, 0);
    assert.equal(f.helper.records.size, 0);
});

test('the helper permits at most four pending RPCs and releases them all on privacy cancellation', async t => {
    const f = await fixture(t);
    const session = await f.open();
    const record = f.helper.records.get(session.id), api = record.hd.rpcClient.getApi();
    const calls = Array.from({ length: 4 }, (_, index) => api.getCipher(index, 'FIXTURE_ADMIN'));
    for (const call of calls) call.catch(() => {});
    await assert.rejects(api.getCipher(4, 'FIXTURE_ADMIN'));
    assert.equal(record.pending.size, 4);
    await f.request('DELETE', `/v1/sessions/${session.id}`, { owner: OWNER, epoch: f.epoch });
    assert.ok((await Promise.allSettled(calls)).every(result => result.status === 'rejected'));
    assert.equal(record.pending.size, 0);
});

test('RPC rate windows reset only after a minute with no pending calls, preserving monotonic IDs', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    const session = await f.open();
    const record = f.helper.records.get(session.id), api = record.hd.rpcClient.getApi();
    const events = await eventReader(t, f, session.id);
    const held = api.getCipher(0, 'FIXTURE_ADMIN'); held.catch(() => {});
    const heldPacket = await events.next();
    now += 60000;
    let last = heldPacket.id;
    for (let index = 1; index < 32; index++) {
        const call = api.getCipher(index, 'FIXTURE_ADMIN'); call.catch(() => {});
        const packet = await events.next();
        assert.ok(packet.id > last); last = packet.id;
        assert.equal((await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: packet.id })).status, 200);
        assert.equal(await call, undefined);
    }
    await assert.rejects(api.getCipher(32, 'FIXTURE_ADMIN'));
    assert.equal(record.pending.size, 1, 'a minute alone must not reset the window while an old call remains pending');
    assert.equal(record.rpcId, last);
    await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: heldPacket.id }); await held;
    const renewed = api.getCipher(33, 'FIXTURE_ADMIN'); renewed.catch(() => {});
    const packet = await events.next();
    assert.ok(packet.id > last, 'new windows must not reuse an old cached reply ID');
    await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: packet.id }); await renewed;
});

test('bounded cancellation tombstones cannot be evicted to revive an earlier delayed request', async t => {
    const f = await fixture(t);
    const first = { requestId: randomUUID(), deviceId: randomUUID() };
    for (let index = 0; index < 128; index++) {
        const binding = index === 0 ? first : { requestId: randomUUID(), deviceId: randomUUID() };
        const response = await f.request('DELETE', `/v1/requests/${binding.requestId}`, { owner: OWNER, epoch: f.epoch, deviceId: binding.deviceId });
        assert.equal(response.status, 200);
    }
    const extra = await f.request('DELETE', `/v1/requests/${randomUUID()}`, { owner: OWNER, epoch: f.epoch, deviceId: randomUUID() });
    assert.equal(extra.status, 429);
    const delayed = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        ...first, metadata: metadata('A') });
    assert.equal(delayed.status, 409);
    assert.equal(f.helper.records.size, 0);
    assert.equal(f.managers.at(-1).starts.length, 0);
});

test('epoch replacement closes every old source even if one cleanup fails', async t => {
    const f = await fixture(t);
    const previousEpoch = f.epoch;
    const first = await f.open('A');
    const peer = await f.open('B');
    const failed = deferred(); failed.reject(Error('Synthetic cleanup failure.'));
    f.closeGates.set('FIXTURE_CAMERA_A', failed);
    f.epoch = randomUUID();
    assert.equal((await f.connect()).status, 503);
    assert.ok(f.managers.at(-1).stops.includes('FIXTURE_CAMERA_B'), 'one cleanup failure prevented peer disposal');
    assert.ok(f.helper.records.has(first.id), 'unconfirmed cleanup must retain its capacity reservation');
    assert.ok(!f.helper.records.has(peer.id));
    assert.equal((await f.request('GET', new URL(first.mediaUrl).pathname)).status, 404);
    f.closeGates.delete('FIXTURE_CAMERA_A');
    assert.equal((await f.request('DELETE', `/v1/sessions/${first.id}`, { owner: OWNER, epoch: previousEpoch })).status, 200);
    assert.equal(f.helper.records.size, 0);
});

test('lease pruning disposes every expired source while retaining only failed cleanup reservations', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, leaseMs: 100 });
    const first = await f.open('A');
    const peer = await f.open('B');
    const failed = deferred(); failed.reject(Error('Synthetic cleanup failure.'));
    f.closeGates.set('FIXTURE_CAMERA_A', failed);
    now += 101;
    await assert.rejects(f.helper.prune());
    assert.ok(f.managers.at(-1).stops.includes('FIXTURE_CAMERA_B'));
    assert.ok(f.helper.records.has(first.id));
    assert.ok(!f.helper.records.has(peer.id));
    f.closeGates.delete('FIXTURE_CAMERA_A');
    assert.equal((await f.request('DELETE', `/v1/sessions/${first.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
    assert.equal(f.helper.records.size, 0);
});

async function viewed(f, session) {
    const response = await fetch(session.mediaUrl, { signal: AbortSignal.timeout(4000) });
    assert.equal(response.status, 200);
    return response;
}
async function closedViewer(f, session, response) {
    await response.body.cancel();
    for (let index = 0; index < 20 && f.helper.records.get(session.id)?.viewers.size; index++) await turn();
    assert.equal(f.helper.records.get(session.id)?.viewers.size, 0);
}

test('shared stream limits are authenticated, epoch-bound, and support a number or No limit', async t => {
    const f = await fixture(t);
    const health = await f.request('GET', '/v1/health');
    assert.equal(health.json.capabilities.streamLimitSettings, true);
    const body = maxStreams => ({ owner: OWNER, epoch: f.epoch, maxStreams });
    assert.equal((await f.request('PUT', '/v1/limits', body(6), { headers: { Authorization: 'Bearer invalid' } })).status, 401);
    assert.equal(f.helper.maxSessions, 4);
    for (const value of [0, -1, 1.5, '6', false, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
        assert.equal((await f.request('PUT', '/v1/limits', body(value))).status, 400);
    }
    assert.equal((await f.request('PUT', '/v1/limits', { ...body(6), token: SECRET })).status, 400);
    assert.equal((await f.request('PUT', '/v1/limits', { ...body(6), epoch: randomUUID() })).status, 409);
    assert.equal(f.helper.maxSessions, 4);
    assert.deepEqual((await f.request('PUT', '/v1/limits', body(6))).json, { maxStreams: 6 });
    assert.equal(f.managers.at(-1).options.getStreamLimit(), 6);
    assert.deepEqual((await f.request('PUT', '/v1/limits', body(null))).json, { maxStreams: null });
    assert.equal(f.managers.at(-1).options.getStreamLimit(), null);
    assert.equal((await f.request('PUT', '/v1/limits', body(Number.MAX_SAFE_INTEGER))).status, 200);
    assert.equal(f.helper.maxSessions, Number.MAX_SAFE_INTEGER);
});

test('raising, lowering, and removing the limit preserves admitted sources and governs new requests', async t => {
    const f = await fixture(t, { autoReady: false });
    const setLimit = maxStreams => f.request('PUT', '/v1/limits', { owner: OWNER, epoch: f.epoch, maxStreams });
    await setLimit(6);
    const sessions = [];
    for (const label of ['A', 'B', 'C', 'D', 'E', 'F']) sessions.push(await f.open(label));
    assert.equal(f.helper.records.size, 6);
    const extra = () => f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('G') });
    assert.equal((await extra()).status, 429);
    await setLimit(2);
    assert.equal(f.helper.records.size, 6);
    assert.equal(f.managers.at(-1).stops.length, 0);
    assert.equal((await extra()).status, 429);
    const first = f.helper.records.get(sessions[0].id);
    const duplicate = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: first.requestId, deviceId: first.deviceId, metadata: metadata('A') });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.json.id, first.id);
    await setLimit(null);
    assert.equal((await extra()).status, 200);
    assert.equal(f.helper.records.size, 7);
});

test('a repeated owner connection preserves its limit and a new epoch resets it for negotiation', async t => {
    const f = await fixture(t);
    await f.request('PUT', '/v1/limits', { owner: OWNER, epoch: f.epoch, maxStreams: null });
    await f.open('A');
    await f.connect();
    assert.equal(f.helper.maxSessions, null);
    assert.equal(f.helper.records.size, 1);
    const oldEpoch = f.epoch;
    f.epoch = randomUUID();
    await f.connect();
    assert.equal(f.helper.maxSessions, 4);
    assert.equal(f.helper.records.size, 0);
    assert.equal((await f.request('PUT', '/v1/limits', { owner: OWNER, epoch: oldEpoch, maxStreams: null })).status, 409);
    assert.equal((await f.request('PUT', '/v1/limits', { owner: OWNER, epoch: f.epoch, maxStreams: 7 })).status, 200);
    assert.equal(f.helper.maxSessions, 7);
});

test('No limit has no hidden active-request ceiling and mass closure retains all unexpired proof', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    await f.request('PUT', '/v1/limits', { owner: OWNER, epoch: f.epoch, maxStreams: null });
    const sessions = [];
    for (let index = 0; index < 130; index++) {
        const data = metadata(`CAM${index}`); data.rawDevice.device_channel = index;
        sessions.push(await f.open(`CAM${index}`, { metadata: data }));
    }
    assert.equal(f.helper.records.size, 130);
    assert.equal(f.helper.requests.size, 130);
    now += 75000;
    await f.helper.prune();
    assert.equal(f.helper.records.size, 0);
    assert.equal(f.managers.at(-1).sourceCount(), 0);
    assert.equal(f.helper.idleRetired.size, 130);
    for (const session of [sessions[0], sessions[129]]) {
        assert.equal((await f.request('GET', `/v1/sessions/${session.id}/status`)).status, 410);
    }
    const next = () => f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('NEXT') });
    assert.equal((await next()).status, 429, 'detached-request backpressure remains bounded after mass closure');
    now += 120001; await f.helper.prune();
    assert.equal(f.helper.idleRetired.size, 0);
    assert.equal((await next()).status, 200);
});

test('a rejected request without a later cancel expires instead of permanently blocking admission', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, serverOptions: { maxRequests: 1, requestTtlMs: 100 } });
    await f.request('PUT', '/v1/limits', { owner: OWNER, epoch: f.epoch, maxStreams: 1 });
    const first = await f.open('A');
    const extra = () => f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('B') });
    assert.equal((await extra()).status, 429);
    await f.request('PUT', '/v1/limits', { owner: OWNER, epoch: f.epoch, maxStreams: null });
    assert.equal((await extra()).status, 429, 'the abandoned request initially consumes the detached-request allowance');
    now += 101; await f.helper.prune();
    assert.ok(f.helper.records.has(first.id), 'request cleanup must not expire an attached active request');
    assert.equal((await extra()).status, 200);
});

test('four closed viewers retire their leases and allow a fifth camera without renewing the old sources', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    const sessions = [];
    for (const label of ['A', 'B', 'C', 'D']) {
        const session = await f.open(label); sessions.push(session);
        const response = await viewed(f, session); await response.arrayBuffer();
    }
    now += 5001; await f.helper.prune();
    assert.equal(f.helper.records.size, 0);
    for (const session of sessions) {
        assert.equal((await f.request('GET', `/v1/sessions/${session.id}/status`)).status, 410);
        assert.equal((await f.request('POST', `/v1/sessions/${session.id}/renew`, { owner: OWNER, epoch: f.epoch })).status, 410);
        assert.equal((await f.request('GET', new URL(session.mediaUrl).pathname)).status, 410);
    }
    assert.equal(f.managers.at(-1).starts.length, 4);
    await f.open('E');
    assert.equal(f.managers.at(-1).starts.length, 5);
});

test('a fresh same-camera lease takes precedence over the retired stable media capability', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    const deviceId = randomUUID(), old = await f.open('A', { deviceId });
    await (await viewed(f, old)).arrayBuffer();
    now += 5001; await f.helper.prune();
    for (const action of ['status', 'events', 'ready']) assert.equal((await f.request('GET', `/v1/sessions/${old.id}/${action}`)).status, 410);
    assert.equal((await f.request('POST', `/v1/sessions/${old.id}/rpc`, { id: 1, value: {} })).status, 410);
    const reopened = await f.open('A', { deviceId });
    assert.notEqual(reopened.id, old.id); assert.equal(reopened.mediaUrl, old.mediaUrl);
    assert.equal((await f.request('GET', new URL(old.mediaUrl).pathname)).status, 200);
    assert.equal((await f.request('GET', `/v1/sessions/${old.id}/status`)).status, 410);
    assert.equal(f.helper.records.size, 1);
});

test('an active peer and a temporary HTTP reconnect remain protected through the idle grace', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, keepMediaOpen: true });
    const a = await f.open('A'), b = await f.open('B');
    const first = await viewed(f, a), peer = await viewed(f, b);
    await closedViewer(f, a, first);
    now += 4000;
    const reconnected = await viewed(f, a);
    now += 6000; await f.helper.prune();
    assert.equal(f.helper.records.size, 2);
    await closedViewer(f, a, reconnected);
    now += 4999; await f.helper.prune();
    assert.equal(f.helper.records.size, 2);
    now += 1; await f.helper.prune();
    assert.ok(!f.helper.records.has(a.id)); assert.ok(f.helper.records.has(b.id));
    assert.ok(!f.managers.at(-1).stops.includes('FIXTURE_CAMERA_B'));
    await closedViewer(f, b, peer);
});

test('a still-starting source has a bounded first-view deadline while pending media HTTP is protected', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, autoReady: false });
    const pending = await f.open('A');
    now += 30000; await f.helper.prune();
    assert.ok(f.helper.records.has(pending.id), 'initial camera startup was retired before the first-view deadline');
    const response = fetch(pending.mediaUrl, { signal: AbortSignal.timeout(4000) }); response.catch(() => {});
    for (let index = 0; index < 20 && !f.helper.records.get(pending.id).viewers.size; index++) await turn();
    assert.equal(f.helper.records.get(pending.id).viewers.size, 1);
    now += 30000;
    await f.request('POST', `/v1/sessions/${pending.id}/renew`, { owner: OWNER, epoch: f.epoch });
    now += 20000; await f.helper.prune();
    assert.ok(f.helper.records.has(pending.id), 'a pending HTTP viewer was mistaken for an abandoned callback');
    f.managers.at(-1).sessions.get('FIXTURE_CAMERA_A').ready.resolve();
    const ready = await response; assert.equal(ready.status, 200); await ready.arrayBuffer();
    now += 5001; await f.helper.prune();
    assert.equal((await f.request('GET', `/v1/sessions/${pending.id}/status`)).status, 410);
});

test('ready callbacks that never receive a first HTTP viewer retire after 75 seconds despite renewal', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    const abandoned = await f.open();
    now += 60000; await f.request('POST', `/v1/sessions/${abandoned.id}/renew`, { owner: OWNER, epoch: f.epoch });
    now += 14999; await f.helper.prune(); assert.ok(f.helper.records.has(abandoned.id));
    now += 1; await f.helper.prune();
    assert.equal((await f.request('GET', `/v1/sessions/${abandoned.id}/status`)).status, 410);
    assert.equal(f.helper.records.size, 0);
});

test('active snapshot capture prevents first-view retirement until capture completes', async t => {
    let now = 1000;
    const snapshotGate = deferred();
    const f = await fixture(t, { now: () => now, snapshotGate });
    const session = await f.open();
    const response = fetch(`${f.origin}/v1/sessions/${session.id}/snapshot`, {
        headers: { Authorization: `Bearer ${SECRET}` }, signal: AbortSignal.timeout(4000) }); response.catch(() => {});
    for (let index = 0; index < 20 && !f.helper.records.get(session.id).snapshots; index++) await turn();
    assert.equal(f.helper.records.get(session.id).snapshots, 1);
    now += 60000; await f.request('POST', `/v1/sessions/${session.id}/renew`, { owner: OWNER, epoch: f.epoch });
    now += 20000; await f.helper.prune(); assert.ok(f.helper.records.has(session.id));
    snapshotGate.resolve();
    const captured = await response; assert.equal(captured.status, 200); await captured.arrayBuffer();
    await f.helper.prune();
    assert.equal((await f.request('GET', `/v1/sessions/${session.id}/status`)).status, 410);
});

test('a backpressured snapshot remains protected until HTTP delivery finishes', async t => {
    let now = 1000;
    const jpeg = Buffer.alloc(8 * 1024 * 1024);
    jpeg.writeUInt16BE(0xffd8, 0); jpeg.writeUInt16BE(0xffd9, jpeg.length - 2);
    const f = await fixture(t, { now: () => now, snapshotBytes: jpeg });
    const session = await f.open(), route = `/v1/sessions/${session.id}/snapshot`;
    const received = deferred(); let outgoing;
    const observe = (request, response) => { if (request.url === route) outgoing = response; };
    f.helper.server.on('request', observe);
    const request = http.get(`${f.origin}${route}`, { headers: { Authorization: `Bearer ${SECRET}` } }, received.resolve);
    request.on('error', received.reject);
    t.after(() => { request.destroy(); f.helper.server.removeListener('request', observe); });
    const response = await received.promise;
    t.after(() => response.destroy());
    // No reader consumes the IncomingMessage yet. This full-size JPEG cannot
    // finish writing through the loopback socket while its receiver is paused.
    assert.equal(outgoing.writableEnded, true);
    assert.equal(outgoing.writableFinished, false);
    const record = f.helper.records.get(session.id);
    assert.equal(record.snapshots, 1);
    now += 60000; await f.request('POST', `/v1/sessions/${session.id}/renew`, { owner: OWNER, epoch: f.epoch });
    now += 20000; await f.helper.prune();
    assert.ok(f.helper.records.has(session.id), 'a snapshot delivering JPEG bytes was retired');
    let bytes = 0;
    await new Promise((resolve, reject) => { response.on('data', chunk => { bytes += chunk.length; });
        response.once('end', resolve); response.once('error', reject); response.resume(); });
    assert.equal(bytes, jpeg.length);
    for (let index = 0; index < 20 && record.snapshots; index++) await turn();
    assert.equal(record.snapshots, 0);
    // A subsequent close event must not release the same snapshot twice.
    outgoing.emit('close'); assert.equal(record.snapshots, 0);
    await f.helper.prune();
    assert.equal((await f.request('GET', `/v1/sessions/${session.id}/status`)).status, 410);
});

test('idle retirement returns terminal status only after confirmed cleanup and retains failed capacity', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    const a = await f.open('A'); await (await viewed(f, a)).arrayBuffer();
    for (const label of ['B', 'C', 'D']) await f.open(label);
    const gate = deferred(); f.closeGates.set('FIXTURE_CAMERA_A', gate);
    now += 5001;
    const retiring = f.helper.prune(); retiring.catch(() => {});
    for (let index = 0; index < 20 && !f.helper.records.get(a.id).closing; index++) await turn();
    let statusSettled = false;
    const status = f.request('GET', `/v1/sessions/${a.id}/status`).then(value => { statusSettled = true; return value; });
    for (let index = 0; index < 10; index++) await turn();
    assert.equal(statusSettled, false, 'the client received retirement proof while cleanup remained uncertain');
    gate.reject(Error('Synthetic worker cleanup failure.')); await assert.rejects(retiring);
    assert.equal((await status).status, 503);
    assert.equal(f.helper.records.size, 4);
    const fifth = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('E') });
    assert.equal(fifth.status, 429);
    f.closeGates.delete('FIXTURE_CAMERA_A'); await f.helper.prune();
    assert.equal((await f.request('GET', `/v1/sessions/${a.id}/status`)).status, 410);
    await f.open('E');
});

test('retired lease tombstones share the bounded request registry and never evict unexpired proof', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, serverOptions: { maxRequests: 2, requestTtlMs: 100 } });
    const a = await f.open('A'), b = await f.open('B');
    await (await viewed(f, a)).arrayBuffer(); await (await viewed(f, b)).arrayBuffer();
    now += 5001; await f.helper.prune(); assert.equal(f.helper.idleRetired.size, 2);
    const full = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('C') });
    assert.equal(full.status, 429);
    assert.equal((await f.request('GET', `/v1/sessions/${a.id}/status`)).status, 410);
    now += 101; await f.helper.prune();
    assert.equal(f.helper.idleRetired.size, 0); await f.open('C');
});

test('idle retirement proof remains valid for 120 seconds after delayed cleanup is confirmed', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    const session = await f.open(); await (await viewed(f, session)).arrayBuffer();
    const gate = deferred(); f.closeGates.set('FIXTURE_CAMERA_A', gate);
    now += 5001;
    const retiring = f.helper.prune(); retiring.catch(() => {});
    for (let index = 0; index < 20 && !f.helper.records.get(session.id).closing; index++) await turn();
    gate.reject(Error('Synthetic delayed cleanup.')); await assert.rejects(retiring);
    now += 120001;
    assert.ok(f.helper.records.has(session.id), 'failed cleanup lost its source reservation');
    f.closeGates.delete('FIXTURE_CAMERA_A'); await f.helper.prune();
    assert.equal((await f.request('GET', `/v1/sessions/${session.id}/status`)).status, 410);
    now += 119999;
    assert.equal((await f.request('GET', `/v1/sessions/${session.id}/status`)).status, 410);
    now += 1;
    assert.equal((await f.request('GET', `/v1/sessions/${session.id}/status`)).status, 404);
});

test('recovery cancellation receives terminal idle proof rather than permission to create another source', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    const requestId = randomUUID(), deviceId = randomUUID();
    const session = await f.open('A', { requestId, deviceId });
    await (await viewed(f, session)).arrayBuffer();
    now += 5001; await f.helper.prune();
    const recovery = await f.request('DELETE', `/v1/requests/${requestId}`, { owner: OWNER, epoch: f.epoch, deviceId });
    assert.equal(recovery.status, 410);
    const wrongBinding = await f.request('DELETE', `/v1/requests/${requestId}`, { owner: OWNER, epoch: f.epoch, deviceId: randomUUID() });
    assert.equal(wrongBinding.status, 409);
    assert.equal(f.managers.at(-1).starts.length, 1);
    assert.equal(f.helper.records.size, 0);
    await f.open('A', { deviceId });
});

test('joining an in-progress idle close also returns terminal proof after cleanup', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    const requestId = randomUUID(), deviceId = randomUUID();
    const session = await f.open('A', { requestId, deviceId }); await (await viewed(f, session)).arrayBuffer();
    const gate = deferred(); f.closeGates.set('FIXTURE_CAMERA_A', gate);
    now += 5001;
    const retiring = f.helper.prune(); retiring.catch(() => {});
    for (let index = 0; index < 20 && !f.helper.records.get(session.id).idleRetiring; index++) await turn();
    const joining = f.helper.cancel(requestId, { owner: OWNER, epoch: f.epoch, deviceId }); joining.catch(() => {});
    gate.resolve(); await retiring;
    await assert.rejects(joining, error => error.status === 410);
    assert.equal(f.helper.records.size, 0);
});

test('idle retirement rechecks viewers and snapshots after waiting in the mutation queue', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, keepMediaOpen: true });
    const session = await f.open('A'), response = await viewed(f, session);
    await closedViewer(f, session, response);
    const gate = deferred(); const blocking = f.helper.mutate(() => gate.promise);
    now += 5001; const queued = f.helper.prune();
    const reconnected = await viewed(f, session);
    gate.resolve(); await blocking; await queued;
    assert.ok(f.helper.records.has(session.id), 'a viewer arriving while retirement was queued was ignored');

    const captureGate = deferred(); f.snapshotGate = captureGate;
    const snapshotSession = await f.open('B');
    now += 60000; await f.request('POST', `/v1/sessions/${snapshotSession.id}/renew`, { owner: OWNER, epoch: f.epoch });
    now += 15000;
    const queueGate = deferred(); const otherBlocking = f.helper.mutate(() => queueGate.promise);
    const snapshotPrune = f.helper.prune();
    const capture = fetch(`${f.origin}/v1/sessions/${snapshotSession.id}/snapshot`, {
        headers: { Authorization: `Bearer ${SECRET}` }, signal: AbortSignal.timeout(4000) }); capture.catch(() => {});
    for (let index = 0; index < 20 && !f.helper.records.get(snapshotSession.id).snapshots; index++) await turn();
    assert.equal(f.helper.records.get(snapshotSession.id).snapshots, 1);
    queueGate.resolve(); await otherBlocking; await snapshotPrune;
    assert.ok(f.helper.records.has(snapshotSession.id), 'a snapshot arriving while retirement was queued was ignored');
    captureGate.resolve(); const captured = await capture; assert.equal(captured.status, 200); await captured.arrayBuffer();
    await f.helper.prune();
    await reconnected.body.cancel();
});
