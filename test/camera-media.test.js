'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 3000 }, fn);
const filename = path.resolve(__dirname, '../lib/helpers/camera-media.helper.js');
const CommandName = { DeviceStartLivestream: 'deviceStartLivestream' };
const PropertyName = { DeviceEnabled: 'enabled', DeviceRTSPStream: 'rtspStream', DeviceRTSPStreamUrl: 'rtspStreamUrl' };
const VideoCodec = { H264: 0, H265: 1 };

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flush() {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await new Promise(setImmediate);
}

function transportPackets(count = 1) {
    const bytes = Buffer.alloc(188 * count);
    for (let index = 0; index < count; index++) bytes[index * 188] = 0x47;
    return bytes;
}

function fakeProcess(command, args) {
    const proc = new EventEmitter();
    proc.command = command;
    proc.args = args;
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.inputs = [];
    proc.stdin.on('data', (chunk) => proc.inputs.push(Buffer.from(chunk)));
    proc.kills = [];
    proc.kill = (signal) => { proc.kills.push(signal); return true; };
    proc.complete = (code) => { proc.exitCode = code; proc.emit('exit', code); proc.emit('close', code); };
    return proc;
}

function fakeResponse() {
    const response = new EventEmitter();
    Object.assign(response, {
        destroyed: false, headersSent: false, writableLength: 0, chunks: [],
        writeHead(code, headers) { this.code = code; this.headers = headers; this.headersSent = true; return this; },
        write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; },
        end() { this.ended = true; },
        destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
    });
    return response;
}

function harness(t, options = {}) {
    const calls = [];
    const processes = [];
    const timers = new Set();
    const files = new Map();
    const fileCalls = [];
    const fileHandles = [];
    const unlinkedFiles = [];
    const servers = [];
    const videos = [];
    const adapters = [];
    const settings = new Map();
    if (Object.hasOwn(options, 'isolated')) settings.set('camera_isolated_p2p_devices', options.isolated);
    const fakeFs = { promises: {
        async open(file, flags, mode) {
            if (files.has(file)) throw Object.assign(Error('Test file already exists'), { code: 'EEXIST' });
            files.set(file, Buffer.alloc(0));
            const handle = { file, flags, mode, closed: false,
                async writeFile(bytes) { return fakeFs.promises.writeFile(file, bytes); },
                async close() { this.closed = true; }
            };
            fileHandles.push(handle);
            return handle;
        },
        async writeFile(file, bytes) { fileCalls.push(['write', file]); files.set(file, Buffer.from(bytes)); },
        async rename(from, to) { fileCalls.push(['rename', from, to]); files.set(to, files.get(from)); files.delete(from); },
        async unlink(file) { unlinkedFiles.push(file); files.delete(file); },
        async mkdir() {},
        async readFile(file) { if (!files.has(file)) throw Object.assign(Error('Missing test file'), { code: 'ENOENT' }); return files.get(file); },
        async stat(file) { return { size: files.get(file)?.length || 0 }; }
    } };
    const setTimer = (fn, delay) => {
        const timer = { fn, delay, unref() { return this; } };
        timers.add(timer);
        return timer;
    };
    const clearTimer = (timer) => timers.delete(timer);
    const client = new EventEmitter();
    client.setCameraMaxLivestreamDuration = (duration) => calls.push(['duration', duration]);
    client.startStationLivestream = async (serial) => calls.push(['start', serial]);
    client.stopStationLivestream = async (serial) => calls.push(['stop', serial]);
    const createVideo = async (type, config) => {
        const video = { type, config, unregisterCount: 0,
            registerVideoUrlListener(listener) { this.listener = listener; },
            async unregister() { this.unregisterCount++; }
        };
        videos.push(video);
        return video;
    };
    const homeyEvents = new EventEmitter();
    const homey = Object.assign(homeyEvents, { platformVersion: 2, app: { eufyClient: client, log() {}, debug() {}, error() {}, warn() {} },
        settings: { get: key => settings.get(key), set: (key, value) => settings.set(key, value) },
        videos: { createVideoRTSP: () => createVideo('rtsp'), createVideoOther: (config) => createVideo('other', config) }
    });
    const nativeRequire = createRequire(filename);
    const localRequire = (request) => {
        if (request === 'eufy-security-client') return { CommandName, PropertyName, VideoCodec };
        if (request === 'node:fs') return fakeFs;
        if (request === './ffmpeg-binary.helper') return class { async resolve() { throw Error('Unexpected resolver construction'); } };
        return nativeRequire(request);
    };
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname,setTimeout,clearTimeout,Date) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    const clock = options.now ? class extends Date { static now() { return options.now(); } } : Date;
    factory(localRequire, module, module.exports, filename, path.dirname(filename), setTimer, clearTimer, clock);
    const Manager = module.exports;
    const manager = new Manager(homey, {
        ...(options.productionDefaults ? {} : { preferSharedP2P: false }),
        userdata: '/virtual/camera-tests', startTimeoutMs: 101, snapshotTimeoutMs: 102, idleTimeoutMs: 103, maxDurationMs: 104,
        resolveBinary: async () => { calls.push(['resolve-binary']); return options.resolveBinary ? options.resolveBinary() : '/virtual/ffmpeg'; },
        spawn: (command, args, options) => { const proc = fakeProcess(command, args); proc.options = options; processes.push(proc); return proc; },
        createServer: (handler) => {
            const server = new EventEmitter();
            server.handler = handler;
            server.listen = (port, host, ready) => { server.bind = { port, host }; queueMicrotask(ready); };
            server.address = () => ({ port: 46543 });
            server.close = (done) => { server.closed = true; queueMicrotask(done); };
            servers.push(server);
            return server;
        },
        createP2PSession: (params) => {
            const serial = params.homeyDevice.EufyDevice.getSerial();
            const adapter = { params, serial, starts: 0, closes: 0,
                async start() { this.starts++; calls.push(['private-start', serial]); if (options.startAdapter) return options.startAdapter(this); },
                async close() { this.closes++; calls.push(['private-close', serial]); if (options.closeAdapter) return options.closeAdapter(this); }
            };
            adapters.push(adapter);
            return adapter;
        },
        ...options.managerOptions
    });
    t.after(async () => { await manager.dispose(); });

    function camera(serial = 'CAMERA_A', station = 'HOMEBASE_A', settings = {}) {
        const values = { [PropertyName.DeviceEnabled]: true, ...settings.values };
        if (settings.native) values[PropertyName.DeviceRTSPStream] = true;
        const device = {
            getSerial: () => serial, getStationSerial: () => station,
            hasCommand: (name) => settings.supported !== false && name === CommandName.DeviceStartLivestream,
            hasProperty: (name) => Object.hasOwn(values, name),
            getPropertyValue: (name) => values[name],
            isRTSPStreamEnabled: () => values[PropertyName.DeviceRTSPStream] === true
        };
        if (Object.hasOwn(settings, 'battery')) device.hasBattery = () => settings.battery;
        const homeyDevice = { EufyDevice: device, _started: true, values, registrations: [], images: [],
            getId: () => settings.homeyId || `HOMEY_${serial}`,
            EufyStation: { startRTSPStream: () => calls.push(['native-start', serial]) },
            async setCameraVideo(...args) { this.registrations.push(args); },
            async updateImage(...args) { this.images.push(args); }
        };
        return homeyDevice;
    }

    async function deliver(cameraDevice, bytes = transportPackets(), metadata = { videoCodec: VideoCodec.H264, videoFPS: 15 }) {
        await flush();
        const video = new PassThrough();
        const audio = new PassThrough();
        const adapter = adapters.findLast(candidate => candidate.serial === cameraDevice.EufyDevice.getSerial());
        if (adapter) await adapter.params.onStream(video, audio, metadata);
        else await manager.streamHandler(video, audio, cameraDevice.EufyDevice, cameraDevice.EufyStation, metadata);
        const proc = manager.sessions.get(cameraDevice.EufyDevice.getSerial())?.process;
        if (bytes) proc.stdout.emit('data', bytes);
        await flush();
        return { proc, video, audio };
    }

    function fireTimer(delay) {
        const matching = [...timers].filter((timer) => timer.delay === delay);
        assert.ok(matching.length, `missing timer ${delay}`);
        for (const timer of matching) { timers.delete(timer); timer.fn(); }
    }

    return { manager, homey, homeyEvents, client, camera, deliver, calls, processes, timers, files, fileCalls, fileHandles, unlinkedFiles, fakeFs, servers, videos, fireTimer, adapters, settings };
}

function helperFixture(overrides = {}) {
    const calls = [], statuses = new Map();
    const helper = { calls, statuses,
        selected: device => device.getId() === 'HOMEY_REMOTE', sourceCount: () => 0,
        async videoUrl(device) { calls.push(['video', device.getId()]); return `http://127.0.0.1:8769/v1/media/${'a'.repeat(48)}.ts`; },
        async snapshot(device) { calls.push(['snapshot', device.getId()]); return Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]); },
        async stop(serial) { calls.push(['stop', serial]); }, async reset() { calls.push(['reset']); },
        async dispose() { calls.push(['dispose']); }, async refreshStatus() { calls.push(['refresh']); },
        getStatus: serial => statuses.get(serial) || null, ...overrides };
    return helper;
}

test('helper video retains the native camera slot and returns its direct media URL without creating in-app media', async t => {
    const helper = helperFixture(); const h = harness(t, { managerOptions: { helperClient: helper } });
    const camera = h.camera('REMOTE'); await h.manager.registerVideo(camera);
    assert.equal(camera.registrations.length, 1); assert.equal(camera.registrations[0][0], 'main');
    assert.equal(camera.registrations[0][1], 'Live');
    const result = await h.videos[0].listener();
    assert.equal(result.url, `http://127.0.0.1:8769/v1/media/${'a'.repeat(48)}.ts`);
    assert.deepEqual(helper.calls, [['video', 'HOMEY_REMOTE']]);
    assert.equal(h.processes.length, 0); assert.equal(h.servers.length, 0); assert.equal(h.adapters.length, 0);
    assert.equal(h.calls.some(([name]) => name === 'resolve-binary' || name === 'start'), false);
});

test('a selected helper camera fails closed during an outage and an old in-app URL cannot start a replacement source', async t => {
    const helper = helperFixture({ async videoUrl() { throw Object.assign(Error('Media helper is unavailable.'), { mediaPublic: true }); } });
    const h = harness(t, { managerOptions: { helperClient: helper } }); const camera = h.camera('REMOTE');
    await h.manager.registerVideo(camera);
    await assert.rejects(h.videos[0].listener(), /helper is unavailable/);
    await assert.rejects(h.manager.getSession(camera), /uses the media helper/);
    assert.equal(h.processes.length, 0); assert.equal(h.adapters.length, 0); assert.equal(h.servers.length, 0);
    assert.equal(h.calls.some(([name]) => name === 'start' || name === 'resolve-binary'), false);
});

test('selected native RTSP cameras retain their existing path and helper snapshots publish atomically without a local decoder', async t => {
    const helper = helperFixture({ selected: () => true });
    const h = harness(t, { managerOptions: { helperClient: helper } });
    const native = h.camera('NATIVE', 'BASE', { native: true, values: { rtspStreamUrl: 'rtsp://fixture-camera/live' } });
    await h.manager.registerVideo(native);
    assert.deepEqual(await h.videos[0].listener(), { url: 'rtsp://fixture-camera/live' });
    assert.equal(helper.calls.length, 0);
    const remote = h.camera('REMOTE');
    await h.manager.requestSnapshot(remote);
    assert.deepEqual(remote.images, [['snapshot', 'REMOTE']]);
    assert.deepEqual(h.files.get('/virtual/camera-tests/REMOTE_snapshot.jpg'), Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]));
    assert.equal(h.fileHandles[0].flags, 'wx'); assert.equal(h.fileHandles[0].mode, 0o600);
    assert.equal(h.processes.length, 0); assert.equal(h.adapters.length, 0);
});

test('reset while a helper snapshot is pending preserves the old image and does not publish a late response', async t => {
    const jpeg = deferred(); const helper = helperFixture({ snapshot: () => jpeg.promise });
    const h = harness(t, { managerOptions: { helperClient: helper } }); const remote = h.camera('REMOTE');
    const old = Buffer.from('old snapshot'); h.files.set('/virtual/camera-tests/REMOTE_snapshot.jpg', old);
    const request = h.manager.requestSnapshot(remote); await flush();
    const rejected = assert.rejects(request, /cancelled/); await h.manager.reset();
    jpeg.resolve(Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9])); await rejected;
    assert.equal(h.files.get('/virtual/camera-tests/REMOTE_snapshot.jpg'), old);
    assert.equal(remote.images.length, 0); assert.equal(h.processes.length, 0);
});

test('helper reservations share the global source cap with legacy media and a single-camera Stop preserves peer leases', async t => {
    const helper = helperFixture({ sourceCount: () => 3 });
    const h = harness(t, { managerOptions: { helperClient: helper } });
    const legacy = h.camera('LEGACY', 'BASE_A'); await h.manager.getSession(legacy); await h.deliver(legacy);
    assert.equal(h.manager.sourceCount(), 4);
    await assert.rejects(h.manager.getSession(h.camera('EXTRA', 'BASE_B')), /4 active camera/);
    await h.manager.stopStream('REMOTE');
    assert.deepEqual(helper.calls, [['stop', 'REMOTE']]);
    assert.equal(h.manager.sessions.has('LEGACY'), true);
    assert.equal(h.calls.some(([name]) => name === 'stop'), false);
});

test('helper cleanup failure cannot prevent local shutdown or unregistering native camera videos', async t => {
    let unavailable = true;
    const fail = () => { if (unavailable) throw Object.assign(Error('Helper cleanup unavailable.'), { cameraHelper: true, mediaPublic: true }); };
    const helper = helperFixture({ async stop() { fail(); }, async reset() { fail(); }, async dispose() { fail(); } });
    const h = harness(t, { managerOptions: { helperClient: helper } }); const legacy = h.camera('LEGACY');
    await h.manager.registerVideo(legacy); await h.manager.getSession(legacy); const media = await h.deliver(legacy);
    await assert.rejects(h.manager.dispose(), error => error.cameraHelper === true);
    assert.equal(media.video.destroyed, true); assert.ok(media.proc.kills.length);
    assert.equal(h.videos[0].unregisterCount, 1); assert.equal(h.manager.videos.size, 0);
    assert.equal(h.manager.sessions.size, 0);
    unavailable = false;
});

test('retired helper history cannot hide current legacy playback or a camera switched to direct native RTSP', async t => {
    const helper = helperFixture({ selected: () => false });
    helper.statuses.set('LEGACY', { state: 'stopped', source: 'helper', error: 'Old helper error' });
    helper.statuses.set('NATIVE', { state: 'stopped', source: 'helper', error: 'Old helper error' });
    const h = harness(t, { managerOptions: { helperClient: helper } });
    const legacy = h.camera('LEGACY'); await h.manager.registerVideo(legacy);
    await h.manager.getSession(legacy); await h.deliver(legacy);
    assert.equal(h.manager.getStatus('LEGACY').state, 'streaming'); assert.equal(h.manager.getStatus('LEGACY').source, 'p2p');
    const native = h.camera('NATIVE', 'BASE', { native: true, values: { rtspStreamUrl: 'rtsp://fixture-camera/live' } });
    await h.manager.registerVideo(native);
    assert.deepEqual(h.manager.getStatus('NATIVE'), { state: 'idle' });
});

test('a faster helper failure cannot mask a local source cleanup failure during account reset', async t => {
    let failing = true;
    const helper = helperFixture({ async stop() { if (failing) throw Object.assign(Error('Helper unavailable'), { cameraHelper: true }); } });
    const h = harness(t, { isolated: true, managerOptions: { helperClient: helper },
        closeAdapter: () => { if (failing) throw Error('Local private transport did not close'); } });
    const camera = h.camera('LEGACY'); await h.manager.getSession(camera); await h.deliver(camera);
    await assert.rejects(h.manager.stopStream('LEGACY'), error => error.cameraHelper !== true && /private camera connection could not be closed/.test(error.message));
    failing = false; await h.manager.stopStream('LEGACY');
    assert.equal(h.manager.sourceCount(), 0);
});

test('same-camera requests share one upstream and become ready only after complete TS packets', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    const [first, second] = await Promise.all([h.manager.getSession(camera), h.manager.getSession(camera)]);
    assert.equal(first, second);
    await flush();
    assert.equal(h.calls.filter(([type]) => type === 'resolve-binary').length, 1);
    assert.deepEqual(h.calls.filter(([type]) => type === 'start'), [['start', 'CAMERA_A']]);
    const { proc } = await h.deliver(camera, null);
    let ready = false;
    first.ready.promise.then(() => { ready = true; });
    const packet = transportPackets();
    proc.stdout.emit('data', packet.subarray(0, 100));
    await flush();
    assert.equal(ready, false);
    proc.stdout.emit('data', packet.subarray(100));
    await first.ready.promise;
    assert.equal(first.bytes, 188);
    assert.equal(first.tail.length, 0);
    assert.equal(h.manager.getStatus('CAMERA_A').state, 'streaming');
});

test('selected cameras on one HomeBase use separate sources and stopping one leaves the other delivering media', async t => {
    const h = harness(t, { isolated: ['HOMEY_A', 'HOMEY_B'] });
    const a = h.camera('A', 'SHARED'), b = h.camera('B', 'SHARED');
    const originalStation = { startRTSPStream() {}, controlCalls: 0, setGuardMode() { this.controlCalls++; } };
    a.EufyStation = originalStation; b.EufyStation = originalStation;
    const [first, second] = await Promise.all([h.manager.getSession(a), h.manager.getSession(b)]);
    await flush();
    assert.equal(h.adapters.length, 2);
    assert.notEqual(h.adapters[0], h.adapters[1]);
    assert.equal(h.adapters.every(adapter => adapter.params.client === h.client), true);
    assert.deepEqual(h.calls.filter(([name]) => name === 'private-start').map(([, serial]) => serial).sort(), ['A', 'B']);
    assert.equal(h.calls.some(([name]) => name === 'start' || name === 'duration'), false, 'private sources do not operate the account client livestream');
    const responseA = fakeResponse(), responseB = fakeResponse();
    responseA._eufyReady = true; responseB._eufyReady = true;
    first.consumers.add(responseA); second.consumers.add(responseB);
    const packetA = transportPackets(); packetA[12] = 0x41;
    const packetB = transportPackets(); packetB[12] = 0x42;
    const mediaA = await h.deliver(a, packetA), mediaB = await h.deliver(b, packetB);
    assert.notEqual(mediaA.proc, mediaB.proc);
    mediaA.video.write(Buffer.from('camera-a-only')); mediaB.video.write(Buffer.from('camera-b-only'));
    await flush();
    assert.equal(Buffer.concat(mediaA.proc.inputs).toString(), 'camera-a-only');
    assert.equal(Buffer.concat(mediaB.proc.inputs).toString(), 'camera-b-only');
    assert.deepEqual(Buffer.concat(responseA.chunks), packetA);
    assert.deepEqual(Buffer.concat(responseB.chunks), packetB);
    await h.manager.stopStream('A');
    assert.equal(mediaA.video.destroyed, true); assert.equal(responseA.destroyed, true);
    assert.equal(h.adapters.find(adapter => adapter.serial === 'A').closes, 1);
    assert.equal(h.adapters.find(adapter => adapter.serial === 'B').closes, 0);
    assert.equal(mediaB.proc.kills.length, 0); assert.equal(mediaB.video.destroyed, false);
    mediaB.proc.stdout.emit('data', packetB);
    assert.equal(second.bytes, 376);
    assert.deepEqual(Buffer.concat(responseB.chunks), Buffer.concat([packetB, packetB]));
    assert.equal(a.EufyStation, originalStation); assert.equal(b.EufyStation, originalStation);
    originalStation.setGuardMode(); assert.equal(originalStation.controlCalls, 1);
    assert.equal(h.calls.some(([name]) => name === 'stop'), false);
});

test('shared-first mode uses one original Station and only an additional worker for concurrent cameras on that HomeBase', async t => {
    const h = harness(t, { isolated: ['HOMEY_A', 'HOMEY_B'], managerOptions: { preferSharedP2P: true } });
    const a = h.camera('A', 'SHARED'), b = h.camera('B', 'SHARED');
    const original = { startRTSPStream() {}, controls: 0, setGuardMode() { this.controls++; } };
    a.EufyStation = original; b.EufyStation = original;
    const first = await h.manager.getSession(a), second = await h.manager.getSession(b);
    const mediaA = await h.deliver(a), mediaB = await h.deliver(b);
    assert.equal(first.isolated, false); assert.equal(second.isolated, true);
    assert.equal(h.adapters.length, 1); assert.equal(h.adapters[0].serial, 'B');
    assert.deepEqual(h.calls.filter(([name]) => name === 'start'), [['start', 'A']]);
    assert.deepEqual([...h.manager.stationOwners], [['SHARED', 'A']]);
    await h.manager.stopStream('A');
    assert.equal(mediaA.video.destroyed, true); assert.ok(mediaA.proc.kills.length);
    assert.equal(h.manager.sessions.get('B'), second);
    assert.equal(mediaB.video.destroyed, false); assert.equal(mediaB.proc.kills.length, 0);
    assert.equal(h.adapters[0].starts, 1); assert.equal(h.adapters[0].closes, 0, 'the worker is neither promoted nor restarted');
    const reopened = await h.manager.getSession(a); await h.deliver(a);
    assert.notEqual(reopened, first); assert.equal(reopened.isolated, false);
    assert.equal(h.adapters.length, 1);
    assert.deepEqual(h.calls.filter(([name]) => name === 'start'), [['start', 'A'], ['start', 'A']]);
    await h.manager.sourceStopped(original, b.EufyDevice);
    assert.equal(h.manager.sessions.get('B'), second, 'a global Station event cannot stop its private peer');
    mediaB.proc.stdout.emit('data', transportPackets());
    assert.equal(second.bytes, 376);
    assert.equal(a.EufyStation, original); assert.equal(b.EufyStation, original);
    original.setGuardMode(); assert.equal(original.controls, 1);
});

test('an isolated snapshot and live viewer of the same camera share one source while another camera stays live', async t => {
    const h = harness(t, { isolated: true });
    const a = h.camera('A', 'SHARED'), b = h.camera('B', 'SHARED');
    const liveA = await h.manager.getSession(a), liveB = await h.manager.getSession(b);
    const viewerA = fakeResponse(); viewerA._eufyReady = true; liveA.consumers.add(viewerA);
    const mediaB = await h.deliver(b);
    const snapshot = h.manager.requestSnapshot(a);
    const sameSnapshot = h.manager.requestSnapshot(a);
    const sameLive = await h.manager.getSession(a);
    const mediaA = await h.deliver(a);
    assert.equal(sameLive, liveA);
    assert.equal(h.adapters.filter(adapter => adapter.serial === 'A').length, 1);
    const decoders = h.processes.filter(proc => proc.args.includes('image2pipe'));
    assert.equal(decoders.length, 1);
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    decoders[0].stdout.emit('data', jpeg); decoders[0].complete(0);
    assert.deepEqual(await Promise.all([snapshot, sameSnapshot]), [true, true]);
    assert.equal(h.manager.sessions.get('A'), liveA);
    assert.equal(h.manager.sessions.get('B'), liveB);
    assert.equal(mediaA.proc.kills.length, 0); assert.equal(mediaB.proc.kills.length, 0);
    assert.equal(h.adapters.every(adapter => adapter.closes === 0), true);
    assert.deepEqual(a.images, [['snapshot', 'A']]);
});

test('a failed private source is cleaned independently and its stale callbacks cannot poison a retry', async t => {
    const h = harness(t, { isolated: true });
    const a = h.camera('A', 'SHARED'), b = h.camera('B', 'SHARED');
    const first = await h.manager.getSession(a), other = await h.manager.getSession(b);
    const mediaB = await h.deliver(b);
    const old = h.adapters.find(adapter => adapter.serial === 'A');
    old.params.onError(Error('private station failure'));
    await assert.rejects(first.ready.promise);
    await flush();
    assert.equal(old.closes, 1);
    assert.equal(h.manager.sessions.get('B'), other);
    assert.equal(mediaB.proc.kills.length, 0);
    const retry = await h.manager.getSession(a); await flush();
    const current = h.adapters.findLast(adapter => adapter.serial === 'A');
    assert.notEqual(current, old);
    const staleVideo = new PassThrough(), staleAudio = new PassThrough();
    await old.params.onStream(staleVideo, staleAudio, { videoCodec: VideoCodec.H264 });
    old.params.onStop(); old.params.onError(Error('late old failure')); await flush();
    assert.equal(staleVideo.destroyed, true); assert.equal(staleAudio.destroyed, true);
    assert.equal(h.manager.sessions.get('A'), retry);
    assert.equal(current.closes, 0);
    await h.deliver(a); await retry.ready.promise;
    assert.equal(h.manager.getStatus('A').state, 'streaming');
});

test('four private startup or closing sources reserve capacity until owned cleanup finishes', async t => {
    const closing = deferred();
    const h = harness(t, { isolated: true, startAdapter: () => new Promise(() => {}),
        closeAdapter: adapter => adapter.serial === 'A' ? closing.promise : undefined });
    for (const serial of ['A', 'B', 'C', 'D']) await h.manager.getSession(h.camera(serial, 'SHARED'));
    await flush();
    assert.equal(h.adapters.length, 4);
    await assert.rejects(h.manager.getSession(h.camera('E', 'SHARED')), /4|active|limit/i);
    const stopping = h.manager.stopStream('A'); await flush();
    assert.equal(h.manager.sessions.size, 3);
    await assert.rejects(h.manager.getSession(h.camera('E', 'SHARED')), /4|active|limit/i);
    assert.equal(h.adapters.length, 4, 'closing transport resources continue to reserve a slot');
    closing.resolve(); await stopping;
    const next = await h.manager.getSession(h.camera('E', 'SHARED')); await flush();
    assert.equal(next.serial, 'E'); assert.equal(h.adapters.length, 5);
});

test('private startup cancellation and disposal cannot dispatch late media or operate the account station', async t => {
    for (const action of ['stop', 'reset', 'dispose']) await t.test(action, async subtest => {
        const starting = deferred();
        const h = harness(subtest, { isolated: true, startAdapter: () => starting.promise });
        const camera = h.camera('A', 'SHARED');
        const session = await h.manager.getSession(camera); await flush();
        const adapter = h.adapters[0];
        const rejected = assert.rejects(session.ready.promise);
        if (action === 'stop') await h.manager.stopStream('A'); else await h.manager[action]();
        await rejected;
        starting.resolve(); await flush();
        const video = new PassThrough(), audio = new PassThrough();
        await adapter.params.onStream(video, audio, { videoCodec: VideoCodec.H264 });
        assert.equal(video.destroyed, true); assert.equal(audio.destroyed, true);
        assert.equal(adapter.closes, 1);
        assert.equal(h.manager.sessions.size, 0);
        assert.equal(h.processes.length, 0);
        assert.equal(h.calls.some(([name]) => name === 'start' || name === 'stop' || name === 'duration'), false);
    });
});

test('isolation is opt-in by Homey device ID and leaves native RTSP on its existing path', async t => {
    const h = harness(t, { isolated: ['HOMEY_SELECTED', 'SERIAL_ONLY'] });
    const selected = h.camera('SELECTED', 'SHARED');
    const unselected = h.camera('SERIAL_ONLY', 'SHARED');
    const native = h.camera('NATIVE', 'SHARED', { native: true, values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
    await h.manager.getSession(selected); await h.manager.getSession(unselected); await h.manager.getSession(native); await flush();
    assert.deepEqual(h.adapters.map(adapter => adapter.serial), ['SELECTED']);
    assert.deepEqual(h.calls.filter(([name]) => name === 'start'), [['start', 'SERIAL_ONLY']]);
    assert.equal(h.processes.some(proc => proc.args.includes('rtsp://fixture-camera/live')), true);
    assert.equal(selected.EufyDevice.getSerial(), 'SELECTED');
    assert.equal(h.manager.isolatedP2P(native), false);
});

test('a synchronous private factory failure and rejected private startup both release capacity for retry', async t => {
    for (const phase of ['factory', 'start']) await t.test(phase, async subtest => {
        let starts = 0;
        const h = harness(subtest, { isolated: true, startAdapter: () => {
            if (phase === 'start' && starts++ === 0) throw Error('private startup failure');
        } });
        const factory = h.manager.createP2PSession;
        if (phase === 'factory') h.manager.createP2PSession = () => { throw Error('private construction failure'); };
        const camera = h.camera('A', 'SHARED');
        const failed = await h.manager.getSession(camera);
        await assert.rejects(failed.ready.promise);
        await flush();
        assert.equal(h.manager.sourceCount(), 0);
        if (phase === 'start') assert.equal(h.adapters[0].closes, 1);
        h.manager.createP2PSession = factory;
        const retry = await h.manager.getSession(camera);
        await h.deliver(camera); await retry.ready.promise;
        assert.equal(h.manager.getStatus('A').state, 'streaming');
    });
});

test('global events retain exact legacy source ownership and cannot stop or inject a private session', async t => {
    const h = harness(t, { isolated: ['HOMEY_PRIVATE'] });
    const legacy = h.camera('LEGACY', 'SHARED'), isolated = h.camera('PRIVATE', 'SHARED');
    const left = await h.manager.getSession(legacy), right = await h.manager.getSession(isolated);
    await flush();
    await assert.rejects(h.manager.getSession(h.camera('OTHER_LEGACY', 'SHARED')), /HomeBase|P2P|another|busy/i);
    const injectedVideo = new PassThrough(), injectedAudio = new PassThrough();
    await h.manager.streamHandler(injectedVideo, injectedAudio, isolated.EufyDevice, isolated.EufyStation, { videoCodec: VideoCodec.H264 });
    assert.equal(injectedVideo.destroyed, true); assert.equal(injectedAudio.destroyed, true);
    assert.equal(right.input, undefined);
    await h.manager.sourceStopped(isolated.EufyStation, isolated.EufyDevice);
    await h.manager.sourceStopped({}, legacy.EufyDevice);
    assert.equal(h.manager.sessions.get('LEGACY'), left); assert.equal(h.manager.sessions.get('PRIVATE'), right);
    await h.deliver(legacy); const media = await h.deliver(isolated);
    await h.manager.sourceStopped(legacy.EufyStation, legacy.EufyDevice);
    assert.equal(left.stopped, true); assert.equal(right.stopped, false);
    assert.equal(media.proc.kills.length, 0);
    assert.deepEqual(h.calls.filter(([name]) => name === 'stop'), [['stop', 'LEGACY']]);
    assert.equal(h.adapters[0].closes, 0);
});

test('reset and disposal await every owned close even when a session was already removed', async t => {
    for (const action of ['reset', 'dispose']) await t.test(action, async subtest => {
        const aClose = deferred(), bClose = deferred();
        const h = harness(subtest, { isolated: true, closeAdapter: adapter => adapter.serial === 'A' ? aClose.promise : bClose.promise });
        await h.manager.getSession(h.camera('A', 'SHARED'));
        await h.manager.getSession(h.camera('B', 'SHARED'));
        await flush();
        const stopping = h.manager.stopStream('A'); await flush();
        let done = false;
        const shutdown = h.manager[action]().then(() => { done = true; });
        await flush();
        assert.equal(done, false); assert.equal(h.manager.sourceCount(), 2);
        aClose.resolve(); await stopping; await flush();
        assert.equal(done, false, 'one completed cleanup must not release the other owned transport');
        bClose.resolve(); await shutdown;
        assert.equal(h.manager.sourceCount(), 0);
        assert.equal(h.adapters.every(adapter => adapter.closes === 1), true);
    });
});

test('failed private termination keeps its capacity reserved until an explicit cleanup retry succeeds', async t => {
    let rejectClose = true;
    const h = harness(t, { isolated: true, closeAdapter: adapter => {
        if (adapter.serial === 'A' && rejectClose) throw Error('private worker termination secret');
    } });
    try {
        for (const serial of ['A', 'B', 'C', 'D']) await h.manager.getSession(h.camera(serial, 'SHARED'));
        await flush();
        await assert.rejects(h.manager.stopStream('A'), error => error.mediaPublic === true && !error.message.includes('secret'));
        assert.equal(h.manager.sessions.size, 3);
        assert.equal(h.manager.sourceCount(), 4, 'failed cleanup must not make a still-owned transport free');
        await assert.rejects(h.manager.getSession(h.camera('E', 'SHARED')), /4|active|limit/i);
        rejectClose = false;
        await h.manager.stopStream('A');
        assert.equal(h.adapters.find(adapter => adapter.serial === 'A').closes, 2);
        assert.equal(h.manager.sourceCount(), 3);
        await h.manager.getSession(h.camera('E', 'SHARED')); await flush();
        assert.equal(h.manager.sourceCount(), 4);
    } finally { rejectClose = false; }
});

test('reset and disposal retry failed private termination and await its successful cleanup', async t => {
    for (const action of ['reset', 'dispose']) await t.test(action, async subtest => {
        const finish = deferred();
        let attempts = 0;
        const h = harness(subtest, { isolated: true, closeAdapter: () => {
            if (++attempts === 1) throw Error('worker termination failed');
            return finish.promise;
        } });
        await h.manager.getSession(h.camera('A')); await flush();
        await assert.rejects(h.manager.stopStream('A'));
        let done = false;
        const shutdown = h.manager[action]().then(() => { done = true; });
        await flush();
        assert.equal(done, false); assert.equal(attempts, 2);
        assert.equal(h.manager.sourceCount(), 1);
        finish.resolve(); await shutdown;
        assert.equal(h.manager.sourceCount(), 0);
    });
});

test('global media cannot claim a private session while binary preparation has no adapter owner yet', async t => {
    const binary = deferred();
    const h = harness(t, { isolated: true, resolveBinary: () => binary.promise });
    const camera = h.camera('A');
    const session = await h.manager.getSession(camera);
    const video = new PassThrough(), audio = new PassThrough();
    await h.manager.streamHandler(video, audio, camera.EufyDevice, camera.EufyStation, { videoCodec: VideoCodec.H264 });
    assert.equal(video.destroyed, true); assert.equal(audio.destroyed, true);
    assert.equal(session.input, undefined);
    assert.equal(h.processes.length, 0);
    await h.manager.stopStream('A');
    binary.resolve('/virtual/ffmpeg'); await flush();
    assert.equal(h.adapters.length, 0, 'cancellation before preparation must not construct a transport');
});

test('a memory warning stops the newest isolated source by insertion order without changing legacy, native or controls', async t => {
    const h = harness(t, { isolated: ['HOMEY_OLDER', 'HOMEY_NEWER'] });
    const older = h.camera('OLDER', 'SHARED'), newer = h.camera('NEWER', 'SHARED');
    const legacy = h.camera('LEGACY', 'SHARED');
    const native = h.camera('NATIVE', 'SHARED', { native: true, values: { rtspStreamUrl: 'rtsp://fixture-camera/live' } });
    const original = { startRTSPStream() {}, controls: 0, setGuardMode() { this.controls++; } };
    older.EufyStation = original; newer.EufyStation = original; legacy.EufyStation = original;
    const first = await h.manager.getSession(older), second = await h.manager.getSession(newer);
    const legacySession = await h.manager.getSession(legacy), nativeSession = await h.manager.getSession(native);
    // Wall-clock order is deliberately misleading. The last two inserted
    // sources are also non-private and must never be chosen instead.
    first.startedAt = 9000; second.startedAt = 1;
    const firstMedia = await h.deliver(older), secondMedia = await h.deliver(newer), legacyMedia = await h.deliver(legacy);
    nativeSession.process.stdout.emit('data', transportPackets()); await nativeSession.ready.promise;
    const owners = [...h.manager.stationOwners];
    h.homey.emit('memwarn', { count: 1, limit: 3 }); await flush();
    assert.equal(second.stopped, true);
    assert.equal(h.manager.sessions.has('NEWER'), false);
    assert.equal(h.adapters.find(adapter => adapter.serial === 'NEWER').closes, 1);
    assert.equal(secondMedia.video.destroyed, true); assert.ok(secondMedia.proc.kills.length);
    assert.equal(h.manager.sessions.get('OLDER'), first); assert.equal(firstMedia.proc.kills.length, 0);
    assert.equal(h.manager.sessions.get('LEGACY'), legacySession); assert.equal(legacyMedia.proc.kills.length, 0);
    assert.equal(h.manager.sessions.get('NATIVE'), nativeSession); assert.equal(nativeSession.process.kills.length, 0);
    assert.deepEqual([...h.manager.stationOwners], owners);
    assert.equal(h.calls.some(([name]) => name === 'stop'), false);
    assert.equal(h.manager.getStatus('NEWER').error.replace(/’/g, "'"),
        "Live video was stopped to stay within Homey's memory limit. Try fewer cameras.");
    original.setGuardMode(); assert.equal(original.controls, 1);
    assert.equal(older.EufyStation, original); assert.equal(newer.EufyStation, original);
    firstMedia.proc.stdout.emit('data', transportPackets());
    assert.equal(first.bytes, 376, 'the older private feed still delivers video after shedding the newest');
});

test('repeated memory warnings shed one private source each and closing workers retain all four capacity slots', async t => {
    const closed = { C: deferred(), D: deferred() };
    const h = harness(t, { isolated: true, closeAdapter: adapter => closed[adapter.serial]?.promise });
    try {
        for (const serial of ['A', 'B', 'C', 'D']) {
            const camera = h.camera(serial, 'SHARED');
            await h.manager.getSession(camera); await h.deliver(camera);
        }
        h.homey.emit('memwarn', { count: 1, limit: 3 });
        assert.deepEqual([...h.manager.sessions.keys()], ['A', 'B', 'C']);
        h.homey.emit('memwarn', { count: 2, limit: 3 }); await flush();
        assert.deepEqual([...h.manager.sessions.keys()], ['A', 'B']);
        assert.deepEqual(h.calls.filter(([name]) => name === 'private-close').map(([, serial]) => serial), ['D', 'C']);
        assert.equal(h.manager.sourceCount(), 4, 'warning cleanup cannot release an unconfirmed worker');
        await assert.rejects(h.manager.getSession(h.camera('E', 'SHARED')), /4|active|limit/i);
        assert.equal(h.adapters.length, 4);
        closed.C.resolve(); closed.D.resolve();
        await Promise.all([...h.manager.stopping.values()]); await flush();
        assert.equal(h.manager.sourceCount(), 2);
        assert.equal(h.calls.filter(([name]) => name === 'private-start').length, 4, 'warning recovery never restarts a stopped source');
        h.homey.emit('memwarn', { count: 3, limit: 3 }); await flush();
        assert.deepEqual([...h.manager.sessions.keys()], ['A']);
        h.homey.emit('memwarn', { count: 4, limit: 3 }); await flush();
        assert.equal(h.manager.sessions.size, 0);
        h.homey.emit('memwarn', { count: 5, limit: 3 }); await flush();
        assert.equal(h.adapters.length, 4);
        assert.equal(h.adapters.every(adapter => adapter.closes === 1), true);
    } finally { closed.C.resolve(); closed.D.resolve(); }
});

test('memory warnings without private sources leave existing legacy and native media untouched', async t => {
    const h = harness(t);
    const legacy = h.camera('LEGACY', 'SHARED');
    const native = h.camera('NATIVE', 'SHARED', { native: true, values: { rtspStreamUrl: 'rtsp://fixture-camera/live' } });
    const first = await h.manager.getSession(legacy), second = await h.manager.getSession(native);
    const media = await h.deliver(legacy);
    second.process.stdout.emit('data', transportPackets()); await second.ready.promise;
    const before = h.calls.slice();
    for (let count = 1; count <= 3; count++) h.homey.emit('memwarn', { count, limit: 3 });
    await flush();
    assert.equal(h.manager.sessions.get('LEGACY'), first); assert.equal(h.manager.sessions.get('NATIVE'), second);
    assert.equal(media.proc.kills.length, 0); assert.equal(second.process.kills.length, 0);
    assert.deepEqual(h.calls, before); assert.equal(h.adapters.length, 0);
});

test('a warning during pending private preparation cancels only the newest request and cannot create its worker later', async t => {
    const binary = deferred();
    const h = harness(t, { isolated: true, resolveBinary: () => binary.promise });
    const firstCamera = h.camera('FIRST', 'SHARED'), newestCamera = h.camera('NEWEST', 'SHARED');
    const first = await h.manager.getSession(firstCamera), newest = await h.manager.getSession(newestCamera);
    const rejected = assert.rejects(newest.ready.promise, /memory limit.*fewer cameras/i);
    h.homey.emit('memwarn', { count: 1, limit: 3 });
    await rejected;
    binary.resolve('/virtual/ffmpeg'); await flush();
    assert.equal(h.manager.sessions.get('FIRST'), first);
    assert.equal(h.manager.sessions.has('NEWEST'), false);
    assert.deepEqual(h.adapters.map(adapter => adapter.serial), ['FIRST']);
    await h.deliver(firstCamera); await first.ready.promise;
    assert.equal(h.manager.getStatus('FIRST').state, 'streaming');
});

test('disposal removes only the manager resource listeners and later warnings cannot operate retired media', async t => {
    const h = harness(t, { isolated: true });
    const warnings = [];
    const external = warning => warnings.push(warning);
    h.homey.on('memwarn', external);
    h.homey.on('cpuwarn', external);
    assert.equal(h.homey.listenerCount('memwarn'), 2);
    assert.equal(h.homey.listenerCount('cpuwarn'), 2);
    await h.manager.getSession(h.camera()); await flush();
    await h.manager.dispose();
    assert.deepEqual(h.homey.listeners('memwarn'), [external]);
    assert.deepEqual(h.homey.listeners('cpuwarn'), [external]);
    const before = h.calls.slice();
    const warning = { count: 1, limit: 3 };
    h.homey.emit('memwarn', warning); await flush();
    h.homey.emit('cpuwarn', warning); await flush();
    assert.deepEqual(warnings, [warning, warning]); assert.deepEqual(h.calls, before);
});

test('selected cameras use owned video from the first source while unselected controls and media keep their account Station', async t => {
    const h = harness(t, { isolated: ['HOMEY_A', 'HOMEY_B'], productionDefaults: true });
    const a = h.camera('A', 'SHARED'), b = h.camera('B', 'SHARED'), legacy = h.camera('LEGACY', 'SHARED');
    const first = await h.manager.getSession(a), second = await h.manager.getSession(b), normal = await h.manager.getSession(legacy);
    await h.deliver(a); await h.deliver(b); await h.deliver(legacy);
    assert.equal(first.isolated, true); assert.equal(second.isolated, true); assert.equal(normal.isolated, false);
    assert.deepEqual(h.adapters.map(adapter => adapter.serial), ['A', 'B']);
    assert.deepEqual(h.calls.filter(([name]) => name === 'start').map(([, serial]) => serial), ['LEGACY']);
    await h.manager.stopStream('A');
    assert.equal(h.manager.sessions.get('B'), second); assert.equal(h.manager.sessions.get('LEGACY'), normal);
    assert.equal(h.calls.some(([name, serial]) => name === 'stop' && serial === 'LEGACY'), false);
});

test('sustained CPU warnings shed only the newest private video and preserve legacy and native streams during cooldown', async t => {
    const h = harness(t, { isolated: ['HOMEY_A', 'HOMEY_B'], now: () => 1000 });
    const a = h.camera('A', 'SHARED'), b = h.camera('B', 'SHARED'), legacy = h.camera('LEGACY', 'SHARED');
    const native = h.camera('NATIVE', 'SHARED', { native: true, values: { rtspStreamUrl: 'rtsp://fixture-camera/live' } });
    const first = await h.manager.getSession(a), second = await h.manager.getSession(b), normal = await h.manager.getSession(legacy);
    const nativeSession = await h.manager.getSession(native);
    const firstMedia = await h.deliver(a); await h.deliver(b); const normalMedia = await h.deliver(legacy);
    nativeSession.process.stdout.emit('data', transportPackets()); await nativeSession.ready.promise;
    for (const count of [1, 2]) h.homey.emit('cpuwarn', { count, limit: 12 });
    await flush(); assert.equal(second.stopped, false); assert.equal(h.adapters.every(adapter => adapter.closes === 0), true);
    h.homey.emit('cpuwarn', { count: 3, limit: 12 }); await flush();
    assert.equal(second.stopped, true); assert.equal(h.manager.sessions.get('A'), first);
    assert.match(h.manager.getStatus('B').error, /CPU limit/);
    await assert.rejects(h.manager.getSession(b), /CPU limit/);
    assert.equal(h.manager.sessions.get('LEGACY'), normal); assert.equal(h.manager.sessions.get('NATIVE'), nativeSession);
    assert.equal(normalMedia.proc.kills.length, 0); assert.equal(nativeSession.process.kills.length, 0);
    firstMedia.proc.stdout.emit('data', transportPackets()); assert.equal(first.bytes, 376);
    h.homey.emit('cpuwarn', { count: 4, limit: 12 }); await flush();
    assert.equal(first.stopped, true); assert.equal(normalMedia.proc.kills.length, 0); assert.equal(nativeSession.process.kills.length, 0);
    assert.equal(h.calls.some(([name]) => name === 'stop'), false);
});

test('memory pressure blocks immediate new private workers but shares current sources and permits an explicit retry after cooldown', async t => {
    let now = 1000;
    const h = harness(t, { isolated: ['HOMEY_A', 'HOMEY_B', 'HOMEY_C'], now: () => now,
        managerOptions: { memoryRetryMs: 20 } });
    const a = h.camera('A', 'SHARED'), b = h.camera('B', 'SHARED'), legacy = h.camera('LEGACY', 'SHARED');
    const first = await h.manager.getSession(a), newest = await h.manager.getSession(b), normal = await h.manager.getSession(legacy);
    await h.deliver(a); await h.deliver(b); await h.deliver(legacy);
    h.homey.emit('memwarn', { count: 1, limit: 3 }); await flush();
    assert.equal(newest.stopped, true);
    const memoryError = /Live video was stopped to stay within Homey['’]s memory limit\. Try fewer cameras\./;
    await assert.rejects(h.manager.getSession(b), memoryError);
    await assert.rejects(h.manager.getSession(h.camera('C', 'SHARED')), memoryError);
    assert.equal(h.adapters.length, 2, 'requests inside the cooldown cannot allocate replacement workers');
    assert.equal(await h.manager.getSession(a), first, 'an existing private source requires no additional worker');
    assert.equal(await h.manager.getSession(legacy), normal, 'normal Station sharing stays available');
    const native = h.camera('NATIVE', 'SHARED', { native: true, values: { rtspStreamUrl: 'rtsp://fixture-camera/live' } });
    const nativeSession = await h.manager.getSession(native); await flush();
    assert.equal(nativeSession.native, true); assert.equal(h.adapters.length, 2);
    now += 21; await flush();
    assert.equal(h.adapters.length, 2, 'the cooldown ending cannot itself start a camera');
    const retried = await h.manager.getSession(b); await flush();
    assert.notEqual(retried, newest);
    assert.equal(h.adapters.length, 3);
    assert.deepEqual(h.calls.filter(([name]) => name === 'private-start').map(([, serial]) => serial), ['A', 'B', 'B']);
    await h.deliver(b); await retried.ready.promise;
    assert.equal(h.manager.getStatus('B').state, 'streaming');
});

test('a completed reset clears the private memory cooldown without needing the clock to advance', async t => {
    const h = harness(t, { isolated: true, now: () => 1000, managerOptions: { memoryRetryMs: 20 } });
    const camera = h.camera('A');
    await h.manager.getSession(camera); await h.deliver(camera);
    h.homey.emit('memwarn', { count: 1, limit: 3 }); await flush();
    await assert.rejects(h.manager.getSession(camera), /memory limit/i);
    await h.manager.reset();
    const restarted = await h.manager.getSession(camera); await flush();
    assert.equal(h.adapters.length, 2);
    await h.deliver(camera); await restarted.ready.promise;
    assert.equal(h.manager.getStatus('A').state, 'streaming');
});

test('H264 P2P video keeps its copy path without encoder or resizing work', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    const session = await h.manager.getSession(camera);
    const { proc } = await h.deliver(camera, transportPackets(), { videoCodec: VideoCodec.H264, videoFPS: 30 });
    await session.ready.promise;
    assert.equal(proc.args[proc.args.indexOf('-f') + 1], 'h264');
    assert.equal(proc.args[proc.args.indexOf('-c:v') + 1], 'copy');
    assert.equal(proc.args.includes('libx264'), false);
    assert.equal(proc.args.includes('-vf'), false);
    assert.equal(proc.args.includes('-profile:v'), false);
    assert.equal(proc.args.includes('-filter_threads'), false);
    assert.equal(proc.args.includes('-an'), true);
    assert.equal(h.manager.getStatus('CAMERA_A').state, 'streaming');
});

test('H265 P2P video uses bounded browser-compatible H264 encoding and retains stream lifecycle', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    const session = await h.manager.getSession(camera);
    const { proc, video, audio } = await h.deliver(camera, transportPackets(), { videoCodec: VideoCodec.H265, videoFPS: 60 });
    await session.ready.promise;
    const option = (name) => proc.args[proc.args.indexOf(name) + 1];
    assert.equal(option('-f'), 'hevc');
    assert.equal(option('-c:v'), 'libx264');
    assert.equal(proc.args.includes('copy'), false);
    assert.equal(option('-preset'), 'ultrafast');
    assert.equal(option('-tune'), 'zerolatency');
    assert.equal(option('-profile:v'), 'baseline');
    assert.equal(option('-level:v'), '3.1');
    assert.equal(option('-pix_fmt'), 'yuv420p');
    assert.match(option('-vf'), /^fps=15,/);
    assert.match(option('-vf'), /min\(1280,iw\)/);
    assert.match(option('-vf'), /min\(720,ih\)/);
    assert.match(option('-vf'), /force_original_aspect_ratio=decrease/);
    assert.match(option('-vf'), /force_divisible_by=2/);
    assert.match(option('-vf'), /setsar=1$/);
    assert.equal(Number(option('-g')) <= 30, true);
    assert.equal(option('-g'), option('-keyint_min'));
    assert.equal(option('-sc_threshold'), '0');
    assert.match(option('-x264-params'), /(?:^|:)repeat-headers=1(?:$|:)/);
    assert.equal(option('-filter_threads'), '1');
    const threadLimits = proc.args.flatMap((arg, index) => arg === '-threads' ? [proc.args[index + 1]] : []);
    assert.deepEqual(threadLimits, ['1', '1']);
    assert.equal(option('-maxrate'), '2000k');
    assert.equal(option('-bufsize'), '4000k');
    assert.equal(option('-mpegts_flags'), 'resend_headers+pat_pmt_at_frames');
    assert.equal(h.manager.getStatus('CAMERA_A').state, 'streaming');
    assert.equal(video.destroyed, false);
    assert.equal(audio.destroyed, false);
    await h.manager.stopStream('CAMERA_A');
    assert.equal(video.destroyed, true);
    assert.equal(audio.destroyed, true);
    assert.equal(proc.kills.length > 0, true);
    assert.equal(h.manager.sessions.size, 0);
    assert.equal(h.manager.stationOwners.size, 0);
});

test('H265 encoding preserves lower frame rates and uses the safe default for invalid metadata', async (t) => {
    for (const [reported, expected] of [[2.5, 2.5], [1, 1], [undefined, 15], [0, 15], [Infinity, 15]]) {
        await t.test(String(reported), async (subtest) => {
            const h = harness(subtest);
            const camera = h.camera();
            const session = await h.manager.getSession(camera);
            const { proc } = await h.deliver(camera, transportPackets(), { videoCodec: VideoCodec.H265, videoFPS: reported });
            await session.ready.promise;
            assert.match(proc.args[proc.args.indexOf('-vf') + 1], new RegExp(`^fps=${String(expected).replace('.', '\\.')},`));
            const gop = Number(proc.args[proc.args.indexOf('-g') + 1]);
            assert.equal(gop >= 1 && gop <= 30, true);
            assert.equal(gop, Math.max(1, Math.round(expected * 2)));
        });
    }
});

test('native RTSP snapshot sessions retain copy behavior when their source codec is unknown', async (t) => {
    const h = harness(t);
    const camera = h.camera('NATIVE_A', 'HOMEBASE_A', { native: true,
        values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
    const session = await h.manager.getSession(camera);
    await flush();
    const proc = h.processes[0];
    assert.equal(proc.args.includes('-rtsp_transport'), true);
    assert.equal(proc.args[proc.args.indexOf('-c:v') + 1], 'copy');
    assert.equal(proc.args.includes('libx264'), false);
    assert.equal(proc.args.includes('-vf'), false);
    proc.stdout.emit('data', transportPackets());
    await session.ready.promise;
});

test('battery NAS views coalesce one bounded decoded-frame probe and return working native video', async (t) => {
    const h = harness(t);
    const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true,
        values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
    await h.manager.registerVideo(camera);
    await h.manager.registerVideo(camera);
    assert.equal(h.videos.length, 1);
    assert.equal(h.videos[0].type, 'other');
    assert.equal(h.videos[0].config, undefined);
    const first = h.videos[0].listener();
    const second = h.videos[0].listener();
    let settled = false;
    first.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    assert.equal(h.processes.length, 1);
    assert.deepEqual(h.calls.filter(([type]) => type === 'native-start'), [['native-start', 'BATTERY']]);
    const probe = h.processes[0];
    assert.equal(probe.args[probe.args.indexOf('-frames:v') + 1], '1');
    assert.equal(probe.args[probe.args.indexOf('-progress') + 1], 'pipe:1');
    assert.deepEqual(probe.options.stdio, ['ignore', 'pipe', 'ignore']);
    assert.deepEqual(probe.args.flatMap((arg, i) => arg === '-threads' ? [probe.args[i + 1]] : []), ['1', '1']);
    probe.stdout.emit('data', Buffer.from('fra'));
    probe.stdout.emit('data', Buffer.from('me=1\nprogress=end\n'));
    probe.emit('exit', 0);
    await flush();
    assert.equal(settled, false);
    probe.complete(0);
    assert.deepEqual(await Promise.all([first, second]), [{ url: 'rtsp://fixture-camera/live' }, { url: 'rtsp://fixture-camera/live' }]);
    assert.equal(h.manager.p2pFallback.has('BATTERY'), false);
    assert.equal(h.manager.nativeEnabled(camera.EufyDevice), true);
    assert.equal(h.manager.nativeProbes.size, 0);
    assert.equal(h.manager.nativeProbeProcesses.size, 0);
    assert.equal(h.servers.length, 0);
    assert.equal(h.calls.some(([type]) => type === 'start'), false);
    assert.equal(h.client.listenerCount('close'), 0);
    assert.equal([...h.timers].some(({ delay }) => delay === 5000), false);
});

test('battery NAS EOF, decoder failure, and timeout select P2P without retrying NAS during the same client session', async (t) => {
    for (const failure of ['eof', 'decode', 'spawn', 'timeout']) {
        await t.test(failure, async (subtest) => {
            const h = harness(subtest);
            const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true,
                values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
            await h.manager.registerVideo(camera);
            const request = h.videos[0].listener();
            await flush();
            const probe = h.processes[0];
            if (failure === 'decode') { probe.stdout.emit('data', Buffer.from('frame=1\n')); probe.complete(1); }
            else if (failure === 'spawn') { probe.emit('error', Error('Fixture process failed')); probe.complete(1); }
            else if (failure === 'timeout') { h.fireTimer(5000); probe.complete(1); }
            else probe.complete(0);
            const first = await request;
            assert.match(first.url, /^http:\/\/127\.0\.0\.1:46543\/live\/[a-f0-9]{48}\.ts$/);
            assert.equal(h.manager.p2pFallback.has('BATTERY'), true);
            assert.equal(h.manager.nativeEnabled(camera.EufyDevice), false);
            assert.equal(h.manager.nativeConfigured(camera.EufyDevice), true);
            assert.deepEqual(await h.videos[0].listener(), first);
            assert.equal(h.processes.length, 1);
            assert.deepEqual(h.calls.filter(([type]) => type === 'native-start'), [['native-start', 'BATTERY']]);
            assert.equal(h.calls.some(([type]) => type === 'start'), false);
            const session = await h.manager.getSession(camera);
            await flush();
            assert.equal(session.native, false);
            assert.equal(h.manager.stationOwners.get('HOMEBASE'), 'BATTERY');
            assert.deepEqual(h.calls.filter(([type]) => type === 'start'), [['start', 'BATTERY']]);
            await h.deliver(camera);
            await session.ready.promise;
            assert.equal(h.manager.getStatus('BATTERY').state, 'streaming');
        });
    }
});

test('a missing battery NAS address falls back without running a decoder', async (t) => {
    const h = harness(t);
    const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true });
    await h.manager.registerVideo(camera);
    const request = h.videos[0].listener();
    h.fireTimer(101);
    assert.match((await request).url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(h.processes.length, 0);
    assert.equal(h.manager.p2pFallback.has('BATTERY'), true);
    assert.equal(h.client.listenerCount('device property changed'), 0);
});

test('battery fallback keeps the HomeBase P2P ownership guard', async (t) => {
    const h = harness(t);
    const busy = await h.manager.getSession(h.camera('OTHER', 'SHARED'));
    const camera = h.camera('BATTERY', 'SHARED', { native: true, battery: true,
        values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
    await h.manager.registerVideo(camera);
    const request = h.videos[0].listener();
    await flush();
    h.processes[0].complete(0);
    await request;
    await assert.rejects(h.manager.getSession(camera), /another camera.*homebase/i);
    assert.equal(h.manager.sessions.get('OTHER'), busy);
    assert.equal(h.manager.stationOwners.get('SHARED'), 'OTHER');
    assert.deepEqual(h.calls.filter(([type]) => type === 'start'), [['start', 'OTHER']]);
});

test('missing, unknown, and false battery reports retain the wired native video path', async (t) => {
    for (const report of ['missing', undefined, false]) {
        await t.test(String(report), async (subtest) => {
            const h = harness(subtest);
            const settings = { native: true, values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } };
            if (report !== 'missing') settings.battery = report;
            const camera = h.camera('WIRED', 'HOMEBASE', settings);
            await h.manager.registerVideo(camera);
            assert.equal(h.videos[0].type, 'rtsp');
            assert.deepEqual(await h.videos[0].listener(), { url: 'rtsp://fixture-camera/live' });
            assert.equal(h.processes.length, 0);
            assert.equal(h.manager.nativeProbes.size, 0);
            assert.equal(h.manager.p2pFallback.size, 0);
        });
    }
});

test('stop, release, reset, disposal, disconnect, privacy, and registration changes cannot publish a late probe or trigger fallback', async (t) => {
    for (const action of ['stop', 'release', 'reset', 'dispose', 'disconnect', 'privacy', 'rtsp_disabled', 'registration', 'client']) {
        await t.test(action, async (subtest) => {
            const h = harness(subtest);
            const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true,
                values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
            await h.manager.registerVideo(camera);
            const request = h.videos[0].listener();
            const rejected = assert.rejects(request, /stopped|cancel|disconnect|privacy|switched off|shutting down/i);
            await flush();
            const probe = h.processes[0];
            if (action === 'stop') await h.manager.stopStream('BATTERY');
            else if (action === 'release') await h.manager.releaseDevice('BATTERY');
            else if (action === 'reset') await h.manager.reset();
            else if (action === 'dispose') await h.manager.dispose();
            else if (action === 'disconnect') h.client.emit('close');
            else if (action === 'privacy') camera.values.enabled = false;
            else if (action === 'rtsp_disabled') camera.values.rtspStream = false;
            else if (action === 'registration') {
                camera.EufyDevice = { ...camera.EufyDevice };
                await h.manager.registerVideo(camera);
            } else h.homey.app.eufyClient = new EventEmitter();
            probe.stdout.emit('data', Buffer.from('frame=1\nprogress=end\n'));
            probe.complete(0);
            await rejected;
            assert.equal(h.manager.p2pFallback.size, 0);
            assert.equal(h.manager.nativeProbes.size, 0);
            assert.equal(h.manager.nativeProbeProcesses.size, 0);
            assert.equal(h.servers.length, 0);
            assert.equal(h.calls.some(([type]) => type === 'start'), false);
            assert.equal(h.client.listenerCount('close'), 0);
            assert.equal([...h.timers].some(({ delay }) => delay === 5000), false);
        });
    }
});

test('Stop during relay preparation cannot return a late battery fallback URL', async (t) => {
    for (const scope of ['device', 'all']) {
        await t.test(scope, async (subtest) => {
            const h = harness(subtest);
            const server = deferred();
            const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true,
                values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
            await h.manager.registerVideo(camera);
            h.manager.ensureServer = () => server.promise;
            const request = h.videos[0].listener();
            const rejected = assert.rejects(request, /cancel/i);
            await flush();
            h.processes[0].complete(0);
            await flush();
            assert.equal(h.manager.p2pFallback.has('BATTERY'), true);
            await h.manager.stopStream(scope === 'device' ? 'BATTERY' : undefined);
            server.resolve();
            await rejected;
            assert.equal(h.calls.some(([type]) => type === 'start'), false);
        });
    }
});

test('cancelling during binary preparation never launches a late NAS probe', async (t) => {
    const binary = deferred();
    const h = harness(t, { resolveBinary: () => binary.promise });
    const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true,
        values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
    await h.manager.registerVideo(camera);
    const request = h.videos[0].listener();
    const rejected = assert.rejects(request, /stopped|cancel/i);
    await flush();
    await h.manager.releaseDevice('BATTERY');
    await rejected;
    binary.resolve('/virtual/ffmpeg');
    await flush();
    assert.equal(h.processes.length, 0);
    assert.equal(h.manager.nativeProbes.size, 0);
    assert.equal(h.manager.p2pFallback.size, 0);
    assert.equal(h.client.listenerCount('close'), 0);
});

test('at most four NAS checks run and stopping all cancels every pending check', async (t) => {
    const h = harness(t);
    const requests = [];
    for (let i = 0; i < 5; i++) {
        await h.manager.registerVideo(h.camera(`BATTERY_${i}`, `BASE_${i}`, { native: true, battery: true,
            values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } }));
        if (i < 4) requests.push(assert.rejects(h.videos[i].listener(), /stopped|cancel/i));
    }
    await flush();
    assert.equal(h.processes.length, 4);
    assert.equal(h.manager.nativeProbes.size, 4);
    await assert.rejects(h.videos[4].listener(), /four camera connections/i);
    assert.equal(h.manager.p2pFallback.size, 0);
    assert.equal(h.calls.filter(([type]) => type === 'native-start').length, 4);
    await h.manager.stopStream();
    await Promise.all(requests);
    for (const proc of h.processes) { assert.equal(proc.kills.length > 0, true); proc.complete(1); }
    assert.equal(h.manager.nativeProbes.size, 0);
    assert.equal(h.manager.nativeProbeProcesses.size, 0);
    assert.equal(h.client.listenerCount('close'), 0);
    assert.equal([...h.timers].some(({ delay }) => delay === 5000), false);
});

test('client reset clears battery fallback and rebinds video so native NAS can be checked again', async (t) => {
    const h = harness(t);
    const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true,
        values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
    await h.manager.registerVideo(camera);
    const first = h.videos[0].listener();
    await flush();
    h.processes[0].complete(0);
    await first;
    assert.equal(h.manager.p2pFallback.has('BATTERY'), true);
    await h.manager.reset();
    assert.equal(h.manager.p2pFallback.size, 0);
    await assert.rejects(h.videos[0].listener(), /cancel/i);
    await h.manager.registerVideo(camera);
    assert.equal(h.videos.length, 2);
    assert.equal(h.videos[0].unregisterCount, 1);
    const retried = h.videos[1].listener();
    await flush();
    h.processes[1].stdout.emit('data', Buffer.from('frame=1\n'));
    h.processes[1].complete(0);
    assert.deepEqual(await retried, { url: 'rtsp://fixture-camera/live' });
    assert.equal(h.manager.p2pFallback.size, 0);
});

test('a snapshot opened before Live View probes battery NAS and publishes a fresh P2P image when NAS fails', async (t) => {
    const h = harness(t);
    const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true,
        values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
    await h.manager.registerVideo(camera);
    const snapshot = h.manager.requestSnapshot(camera);
    const concurrent = h.manager.getSession(camera);
    await flush();
    assert.equal(h.manager.sessions.size, 0);
    assert.equal(h.processes.length, 1);
    assert.equal(h.processes[0].args.includes('-progress'), true);
    assert.equal(h.calls.some(([type]) => type === 'start'), false);
    h.processes[0].complete(0);
    const session = await concurrent;
    await flush();
    assert.equal(session.native, false);
    assert.equal(h.manager.sessions.size, 1);
    assert.equal(h.manager.stationOwners.get('HOMEBASE'), 'BATTERY');
    assert.deepEqual(h.calls.filter(([type]) => type === 'start'), [['start', 'BATTERY']]);
    await h.deliver(camera);
    const decoder = h.processes.find((proc) => proc.args.includes('image2pipe'));
    const jpeg = Buffer.from([0xff, 0xd8, 5, 0xff, 0xd9]);
    decoder.stdout.emit('data', jpeg);
    decoder.complete(0);
    assert.equal(await snapshot, true);
    assert.deepEqual(h.files.get('/virtual/camera-tests/BATTERY_snapshot.jpg'), jpeg);
    assert.deepEqual(camera.images, [['snapshot', 'BATTERY']]);
    assert.equal(await h.manager.getSession(camera), session);
    await h.manager.stopStream('BATTERY');
    const retry = await h.manager.getSession(camera);
    await flush();
    assert.notEqual(retry, session);
    assert.equal(retry.native, false);
    assert.equal(h.processes.filter((proc) => proc.args.includes('-progress')).length, 1);
    assert.deepEqual(h.calls.filter(([type]) => type === 'native-start'), [['native-start', 'BATTERY']]);
});

test('a snapshot opened first retains working battery NAS and shares the checked native session', async (t) => {
    const h = harness(t);
    const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true,
        values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
    const snapshot = h.manager.requestSnapshot(camera);
    const concurrent = h.manager.getSession(camera);
    await flush();
    assert.equal(h.processes.length, 1);
    h.processes[0].stdout.emit('data', Buffer.from('frame=1\n'));
    h.processes[0].complete(0);
    const session = await concurrent;
    await flush();
    assert.equal(session.native, true);
    assert.equal(h.manager.sessions.size, 1);
    assert.equal(h.manager.p2pFallback.size, 0);
    assert.equal(h.manager.stationOwners.size, 0);
    assert.equal(h.calls.some(([type]) => type === 'start'), false);
    const mux = h.processes.find((proc) => proc.args.includes('mpegts'));
    assert.equal(mux.args.includes('-rtsp_transport'), true);
    assert.equal(mux.args[mux.args.indexOf('-c:v') + 1], 'copy');
    mux.stdout.emit('data', transportPackets());
    await flush();
    const decoder = h.processes.find((proc) => proc.args.includes('image2pipe'));
    decoder.stdout.emit('data', Buffer.from([0xff, 0xd8, 7, 0xff, 0xd9]));
    decoder.complete(0);
    assert.equal(await snapshot, true);
    assert.equal(await h.manager.getSession(camera), session);
    assert.equal(h.processes.filter((proc) => proc.args.includes('-progress')).length, 1);
});

test('Stop during a snapshot-first NAS check cannot open a late source or publish an image', async (t) => {
    const h = harness(t);
    const camera = h.camera('BATTERY', 'HOMEBASE', { native: true, battery: true,
        values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://fixture-camera/live' } });
    const snapshot = h.manager.requestSnapshot(camera);
    const rejected = assert.rejects(snapshot, /stopped|cancel/i);
    await flush();
    const probe = h.processes[0];
    await h.manager.stopStream('BATTERY');
    await rejected;
    probe.stdout.emit('data', Buffer.from('frame=1\n'));
    probe.complete(0);
    await flush();
    assert.equal(h.manager.sessions.size, 0);
    assert.equal(h.manager.stationOwners.size, 0);
    assert.equal(h.manager.p2pFallback.size, 0);
    assert.equal(h.manager.snapshots.size, 0);
    assert.equal(h.calls.some(([type]) => type === 'start'), false);
    assert.equal(h.processes.length, 1);
    assert.equal(h.files.size, 0);
    assert.equal(camera.images.length, 0);
});

test('unreported camera privacy and a disconnected P2P client cannot start a source', async t => {
    const h = harness(t);
    await assert.rejects(h.manager.getSession(h.camera('UNKNOWN', 'STATION', { values: { enabled: undefined } })), /privacy state/i);
    h.client.isConnected = () => false;
    await assert.rejects(h.manager.getSession(h.camera()), /disconnected/i);
    assert.equal(h.calls.some(([type]) => type === 'start'), false);
});

test('a native address arriving after privacy changes cannot be returned to a viewer', async t => {
    const h = harness(t);
    const camera = h.camera('NATIVE', 'STATION', { native: true });
    const request = h.manager.nativeUrl(camera);
    h.client.emit('device property changed', camera.EufyDevice, PropertyName.DeviceRTSPStreamUrl, 'rtsp://camera.example/live');
    camera.values.enabled = false;
    await assert.rejects(request, /privacy|switched off/i);
    assert.equal(h.client.listenerCount('device property changed'), 0);
});

test('native requests are cancelled immediately by release or reset before any late address', async t => {
    const h = harness(t);
    const camera = h.camera('NATIVE', 'STATION', { native: true });
    for (const action of ['release', 'reset']) {
        const request = h.manager.nativeUrl(camera);
        if (action === 'release') await h.manager.releaseDevice('NATIVE'); else await h.manager.reset();
        await assert.rejects(request, /stopped|cancelled/i);
        h.client.emit('device property changed', camera.EufyDevice, PropertyName.DeviceRTSPStreamUrl, 'rtsp://camera.example/late');
        assert.equal(h.client.listenerCount('device property changed'), 0);
    }
});

test('a matched Eufy streaming rejection settles promptly and removes station listeners', async t => {
    const h = harness(t);
    const camera = h.camera();
    camera.EufyStation = new EventEmitter();
    camera.EufyDevice.getChannel = () => 3;
    const session = await h.manager.getSession(camera);
    await flush();
    camera.EufyStation.emit('command result', camera.EufyStation, { channel: 2, return_code: 9, customData: { command: { name: CommandName.DeviceStartLivestream } } });
    assert.equal(h.manager.sessions.size, 1);
    camera.EufyStation.emit('command result', camera.EufyStation, { channel: 3, return_code: 9, customData: { command: { name: CommandName.DeviceStartLivestream } } });
    await assert.rejects(session.ready.promise, /code 9/i);
    await flush();
    assert.equal(camera.EufyStation.listenerCount('command result'), 0);
    assert.equal(camera.EufyStation.listenerCount('livestream error'), 0);
    assert.equal(h.manager.sessions.size, 0);
});

test('the public start-video action waits for actual media and releases an unwatched stream after the idle window', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    let completed = false;
    const starting = h.manager.startVideo(camera).then((value) => { completed = true; return value; });
    await flush();
    assert.equal(completed, false, 'dispatch alone is not a successful stream');
    await h.deliver(camera);
    assert.equal(await starting, true);
    h.fireTimer(103);
    await flush();
    assert.equal(h.manager.sessions.size, 0);
    assert.deepEqual(h.calls.filter(([type]) => type === 'stop'), [['stop', 'CAMERA_A']]);
});

test('binary preparation precedes P2P dispatch and station ownership includes pending starts', async (t) => {
    const binary = deferred();
    const h = harness(t, { resolveBinary: () => binary.promise });
    const first = await h.manager.getSession(h.camera('A', 'SHARED'));
    await assert.rejects(h.manager.getSession(h.camera('B', 'SHARED')), /HomeBase|P2P|another|busy/i);
    const independent = await h.manager.getSession(h.camera('C', 'OTHER'));
    await flush();
    assert.equal(h.calls.some(([type]) => type === 'start'), false);
    binary.resolve('/virtual/ffmpeg');
    await flush();
    assert.equal(first.binary, '/virtual/ffmpeg');
    assert.equal(independent.binary, '/virtual/ffmpeg');
    assert.deepEqual(h.calls.filter(([type]) => type === 'start').map(([, serial]) => serial).sort(), ['A', 'C']);
});

test('stopping a device releases only its upstream and processor, allowing the other station to continue', async (t) => {
    const h = harness(t);
    const a = h.camera('A', 'FIRST');
    const b = h.camera('B', 'SECOND');
    const sessionA = await h.manager.getSession(a);
    const sessionB = await h.manager.getSession(b);
    const mediaA = await h.deliver(a);
    const mediaB = await h.deliver(b);
    await h.manager.stopStream('A');
    assert.equal(sessionA.stopped, true);
    assert.equal(mediaA.proc.kills.length > 0, true);
    assert.equal(mediaA.video.destroyed, true);
    assert.equal(mediaB.proc.kills.length, 0);
    assert.equal(mediaB.video.destroyed, false);
    assert.equal(h.manager.sessions.get('B'), sessionB);
    assert.deepEqual(h.calls.filter(([type]) => type === 'stop'), [['stop', 'A']]);
    mediaB.proc.stdout.emit('data', transportPackets());
    assert.equal(sessionB.bytes, 376);
});

test('failed binary preparation releases station ownership and can be retried', async (t) => {
    let attempts = 0;
    const h = harness(t, { resolveBinary: async () => { if (++attempts === 1) throw Error('Resolver unavailable'); return '/virtual/ffmpeg'; } });
    const camera = h.camera();
    const first = await h.manager.getSession(camera);
    await assert.rejects(first.ready.promise);
    await flush();
    assert.equal(h.manager.sessions.size, 0);
    assert.equal(h.manager.stationOwners.size, 0);
    assert.equal(h.calls.some(([type]) => type === 'start'), false);
    const retry = await h.manager.getSession(camera);
    await h.deliver(camera);
    await retry.ready.promise;
    assert.equal(attempts, 2);
    assert.equal(h.manager.getStatus('CAMERA_A').state, 'streaming');
});

test('P2P dispatch rejection releases the session and permits a fresh attempt', async (t) => {
    const h = harness(t);
    let attempts = 0;
    h.client.startStationLivestream = async (serial) => { h.calls.push(['start', serial]); if (++attempts === 1) throw Error('Backend refused'); };
    const camera = h.camera();
    const first = await h.manager.getSession(camera);
    await assert.rejects(first.ready.promise);
    await flush();
    const retry = await h.manager.getSession(camera);
    await h.deliver(camera);
    await retry.ready.promise;
    assert.equal(attempts, 2);
    assert.equal(h.manager.stationOwners.get('HOMEBASE_A'), 'CAMERA_A');
});

test('a processor error rejects readiness safely and does not poison the retry', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    const first = await h.manager.getSession(camera);
    const media = await h.deliver(camera, null);
    const rejected = assert.rejects(first.ready.promise, (error) => !error.message.includes('PRIVATE_PROCESS_DETAIL'));
    media.proc.emit('error', Error('PRIVATE_PROCESS_DETAIL'));
    await rejected;
    await flush();
    assert.equal(h.manager.stationOwners.size, 0);
    const retry = await h.manager.getSession(camera);
    const fresh = await h.deliver(camera);
    await retry.ready.promise;
    assert.notEqual(fresh.proc, media.proc);
    assert.equal(h.manager.getStatus('CAMERA_A').state, 'streaming');
});

test('stream startup timeout releases the HomeBase and rejects rather than reporting a ready stream', async (t) => {
    const h = harness(t);
    const session = await h.manager.getSession(h.camera());
    const rejected = assert.rejects(session.ready.promise, /time|deliver|connection/i);
    h.fireTimer(101);
    await rejected;
    await flush();
    assert.equal(h.manager.stationOwners.size, 0);
    assert.equal(h.manager.sessions.size, 0);
});

test('reset and disposal during binary preparation prevent stale P2P dispatch', async (t) => {
    for (const action of ['reset', 'dispose']) {
        await t.test(action, async (subtest) => {
            const binary = deferred();
            const h = harness(subtest, { resolveBinary: () => binary.promise });
            const session = await h.manager.getSession(h.camera());
            const rejected = assert.rejects(session.ready.promise);
            await h.manager[action]();
            binary.resolve('/virtual/ffmpeg');
            await rejected;
            await flush();
            assert.equal(h.calls.some(([type]) => type === 'start'), false);
            assert.equal(h.manager.sessions.size, 0);
            assert.equal(h.manager.stationOwners.size, 0);
            if (action === 'dispose') await assert.rejects(h.manager.getSession(h.camera()), /shut|stop|closed|disposed/i);
            else {
                const retryCamera = h.camera();
                const retry = await h.manager.getSession(retryCamera);
                await h.deliver(retryCamera);
                await retry.ready.promise;
            }
        });
    }
});

test('a session waiting for an earlier stop cannot resurrect after disposal', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    await h.manager.getSession(camera);
    await flush();
    const stop = deferred();
    h.client.stopStationLivestream = () => stop.promise;
    const stopping = h.manager.stopStream('CAMERA_A');
    const waiting = h.manager.getSession(camera);
    const observed = waiting.then(() => 'created', () => 'cancelled');
    await flush();
    const disposing = h.manager.dispose();
    stop.resolve();
    await Promise.all([stopping, disposing]);
    assert.equal(await observed, 'cancelled');
    assert.equal(h.manager.sessions.size, 0);
});

test('a HomeBase remains busy until the earlier upstream stop has finished', async (t) => {
    const h = harness(t);
    await h.manager.getSession(h.camera('A', 'SHARED'));
    await flush();
    const stop = deferred();
    h.client.stopStationLivestream = () => stop.promise;
    const stopping = h.manager.stopStream('A');
    await flush();
    try { await assert.rejects(h.manager.getSession(h.camera('B', 'SHARED')), /HomeBase|P2P|another|busy/i); }
    finally { stop.resolve(); await stopping; }
    const next = await h.manager.getSession(h.camera('B', 'SHARED'));
    assert.equal(next.serial, 'B');
});

test('camera privacy, missing readiness, and unsupported commands are refused before dispatch', async (t) => {
    const h = harness(t);
    const off = h.camera('OFF', 'BASE', { values: { [PropertyName.DeviceEnabled]: false } });
    const unready = h.camera('UNREADY');
    unready._started = false;
    for (const camera of [off, unready, h.camera('UNSUPPORTED', 'BASE', { supported: false })]) await assert.rejects(h.manager.getSession(camera));
    assert.equal(h.calls.length, 0);
    assert.equal(h.processes.length, 0);
});

test('TS chunks stay packet aligned and even an oversized output chunk cannot defeat the replay bound', async (t) => {
    const h = harness(t);
    const session = await h.manager.getSession(h.camera());
    const chunks = [];
    session.consumers.add({ _eufyReady: true, writableLength: 0, write: (chunk) => chunks.push(Buffer.from(chunk)), destroy() {} });
    const packets = transportPackets(6000);
    h.manager.onData(session, packets.subarray(0, 99));
    assert.equal(session.bytes, 0);
    h.manager.onData(session, packets.subarray(99, 405));
    h.manager.onData(session, packets.subarray(405));
    await session.ready.promise;
    assert.equal(session.bytes, packets.length);
    assert.ok(session.tail.length < 188);
    assert.ok(session.replayBytes <= 1024 * 1024, `replay retained ${session.replayBytes} bytes`);
    for (const chunk of session.replay) assert.equal(chunk.length % 188, 0);
    for (const chunk of chunks) { assert.equal(chunk.length % 188, 0); assert.equal(chunk[0], 0x47); }
});

test('slow viewers are disconnected without affecting a healthy viewer or growing their output queue indefinitely', async (t) => {
    const h = harness(t);
    const session = await h.manager.getSession(h.camera());
    const slow = { _eufyReady: true, writableLength: 0, destroyed: false, peak: 0,
        write(chunk) { this.writableLength += chunk.length; this.peak = Math.max(this.peak, this.writableLength); return false; },
        destroy() { this.destroyed = true; }
    };
    let healthyBytes = 0;
    const healthy = { _eufyReady: true, writableLength: 0, write(chunk) { healthyBytes += chunk.length; }, destroy() { assert.fail('Healthy viewer was stopped'); } };
    session.consumers.add(slow);
    session.consumers.add(healthy);
    const chunk = transportPackets(300);
    for (let i = 0; i < 60; i++) h.manager.onData(session, chunk);
    assert.equal(slow.destroyed, true);
    assert.equal(session.consumers.has(slow), false);
    assert.ok(slow.peak <= 2 * 1024 * 1024 + chunk.length);
    assert.equal(healthyBytes, chunk.length * 60);
    session.consumers.delete(healthy);
});

test('native RTSP listens before synchronous URL delivery, ignores unrelated updates, and removes listeners', async (t) => {
    const h = harness(t);
    const camera = h.camera('NATIVE', 'SHARED', { native: true });
    camera.EufyStation.startRTSPStream = () => {
        assert.equal(h.client.listenerCount('device property changed'), 1);
        h.client.emit('device property changed', h.camera('OTHER').EufyDevice, PropertyName.DeviceRTSPStreamUrl, 'rtsp://192.0.2.99/other');
        h.client.emit('device property changed', camera.EufyDevice, PropertyName.DeviceRTSPStreamUrl, 'Camera_is_off');
        h.client.emit('device property changed', camera.EufyDevice, PropertyName.DeviceRTSPStreamUrl, 'rtsp://192.0.2.8/live');
    };
    assert.equal(await h.manager.nativeUrl(camera), 'rtsp://192.0.2.8/live');
    assert.equal(h.client.listenerCount('device property changed'), 0);
    assert.equal(h.client.listenerCount('close'), 0);
    assert.equal(h.processes.length, 0);
});

test('native URL timeout and disconnection reject with no leftover event listeners', async (t) => {
    for (const cause of ['timeout', 'disconnect']) {
        await t.test(cause, async (subtest) => {
            const h = harness(subtest);
            const camera = h.camera('NATIVE', 'BASE', { native: true });
            const request = h.manager.nativeUrl(camera);
            const rejected = assert.rejects(request);
            if (cause === 'timeout') h.fireTimer(101);
            else h.client.emit('close');
            await rejected;
            assert.equal(h.client.listenerCount('device property changed'), 0);
            assert.equal(h.client.listenerCount('close'), 0);
        });
    }
});

test('native RTSP and a P2P camera on the same HomeBase do not contend for the P2P slot', async (t) => {
    const h = harness(t);
    const native = h.camera('NATIVE', 'SHARED', { native: true, values: { [PropertyName.DeviceRTSPStreamUrl]: 'rtsp://192.0.2.8/live' } });
    const first = await h.manager.getSession(native);
    const second = await h.manager.getSession(h.camera('P2P', 'SHARED'));
    await flush();
    assert.equal(first.native, true);
    assert.equal(second.native, false);
    assert.deepEqual(h.calls.filter(([type]) => type === 'start'), [['start', 'P2P']]);
    assert.equal(h.manager.stationOwners.get('SHARED'), 'P2P');
});

test('late video creation after disposal never attaches a playable camera and unregisters the new object', async (t) => {
    const h = harness(t);
    const creation = deferred();
    const video = { registerVideoUrlListener() {}, async unregister() { this.unregistered = true; } };
    h.homey.videos.createVideoOther = () => creation.promise;
    const camera = h.camera();
    const registration = h.manager.registerVideo(camera).catch(() => {});
    await flush();
    await h.manager.dispose();
    creation.resolve(video);
    await registration;
    assert.equal(camera.registrations.length, 0);
    assert.equal(video.unregistered, true);
    assert.equal(h.manager.tokens.size, 0);
    assert.equal(h.manager.videos.size, 0);
});

test('Homey video relay binds only loopback, rejects unknown capabilities, and starts work only for an authorized viewer', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    await h.manager.registerVideo(camera);
    await h.manager.registerVideo(camera);
    assert.equal(camera.registrations.length, 1);
    assert.deepEqual(h.videos[0].config, { demuxer: 'mpegts' });
    const { url } = await h.videos[0].listener();
    assert.match(url, /^http:\/\/127\.0\.0\.1:46543\/live\/[a-f0-9]{48}\.ts$/);
    assert.deepEqual(h.servers[0].bind, { port: 0, host: '127.0.0.1' });
    assert.equal(h.calls.some(([type]) => type === 'start'), false);
    for (const request of [{ url: '/live/unknown.ts', method: 'GET' }, { url: new URL(url).pathname, method: 'POST' }]) {
        const denied = fakeResponse();
        await h.manager.serve(request, denied);
        assert.equal(denied.code, 404);
    }
    const response = fakeResponse();
    const serving = h.manager.serve({ method: 'GET', url: new URL(url).pathname }, response);
    await flush();
    await h.deliver(camera);
    await serving;
    assert.equal(response.code, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.headers['Content-Type'].toLowerCase(), 'video/mp2t');
    assert.equal(response.chunks.length > 0, true);
    await h.manager.releaseDevice('CAMERA_A');
    assert.equal(response.destroyed, true);
    assert.equal(h.videos[0].unregisterCount, 1);
    assert.equal(h.manager.tokens.size, 0);
});

test('snapshot requests coalesce, require fresh decoded JPEG data, and atomically publish one image', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    const destination = '/virtual/camera-tests/CAMERA_A_snapshot.jpg';
    h.files.set(destination, Buffer.from('OLD_IMAGE'));
    const first = h.manager.requestSnapshot(camera);
    const second = h.manager.requestSnapshot(camera);
    await flush();
    await h.deliver(camera);
    const decoders = h.processes.filter((proc) => proc.args.includes('image2pipe'));
    assert.equal(decoders.length, 1);
    assert.equal(h.files.get(destination).toString(), 'OLD_IMAGE');
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    decoders[0].stdout.emit('data', jpeg);
    decoders[0].complete(0);
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.deepEqual(h.files.get(destination), jpeg);
    assert.deepEqual(camera.images, [['snapshot', 'CAMERA_A']]);
    assert.deepEqual(h.fileCalls.map(([type]) => type), ['write', 'rename']);
    assert.deepEqual(h.fileHandles.map(({ flags, mode, closed }) => ({ flags, mode, closed })), [{ flags: 'wx', mode: 0o600, closed: true }]);
    assert.equal(h.manager.snapshots.size, 0);
});

test('snapshot waits for child close so JPEG bytes arriving after exit are included', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    const request = h.manager.requestSnapshot(camera);
    let settled = false;
    request.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    await h.deliver(camera);
    const decoder = h.processes.find((proc) => proc.args.includes('image2pipe'));
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    decoder.stdout.emit('data', jpeg.subarray(0, 3));
    decoder.exitCode = 0;
    decoder.emit('exit', 0);
    await flush();
    assert.equal(settled, false);
    assert.equal(h.fileCalls.length, 0);
    assert.equal(camera.images.length, 0);
    decoder.stdout.emit('data', jpeg.subarray(3));
    decoder.emit('close', 0);
    assert.equal(await request, true);
    assert.deepEqual(h.files.get('/virtual/camera-tests/CAMERA_A_snapshot.jpg'), jpeg);
    assert.deepEqual(camera.images, [['snapshot', 'CAMERA_A']]);
});

test('snapshot write and rename failures remove only the owned temporary file and permit retry', async (t) => {
    for (const failure of ['write', 'rename']) {
        await t.test(failure, async (subtest) => {
            const h = harness(subtest);
            const camera = h.camera();
            const destination = '/virtual/camera-tests/CAMERA_A_snapshot.jpg';
            h.files.set(destination, Buffer.from('OLD_IMAGE'));
            const writeFile = h.fakeFs.promises.writeFile;
            const rename = h.fakeFs.promises.rename;
            if (failure === 'write') h.fakeFs.promises.writeFile = async (file, bytes) => {
                await writeFile(file, bytes.subarray(0, 3));
                throw Error('Fixture partial write failure');
            };
            else h.fakeFs.promises.rename = async () => { throw Error('Fixture rename failure'); };
            const request = h.manager.requestSnapshot(camera);
            const rejected = assert.rejects(request, /Fixture .* failure/);
            await flush();
            await h.deliver(camera);
            const decoder = h.processes.find((proc) => proc.args.includes('image2pipe'));
            decoder.stdout.emit('data', Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]));
            decoder.complete(0);
            await rejected;
            assert.deepEqual([...h.files.keys()], [destination]);
            assert.equal(h.files.get(destination).toString(), 'OLD_IMAGE');
            assert.deepEqual(h.unlinkedFiles, [h.fileHandles[0].file]);
            assert.notEqual(h.unlinkedFiles[0], destination);
            assert.equal(h.fileHandles[0].closed, true);
            assert.equal(camera.images.length, 0);
            assert.equal(h.manager.snapshots.size, 0);

            h.fakeFs.promises.writeFile = writeFile;
            h.fakeFs.promises.rename = rename;
            const retry = h.manager.requestSnapshot(camera);
            await flush();
            const fresh = h.processes.findLast((proc) => proc.args.includes('image2pipe'));
            assert.notEqual(fresh, decoder);
            fresh.stdout.emit('data', Buffer.from([0xff, 0xd8, 7, 0xff, 0xd9]));
            fresh.complete(0);
            assert.equal(await retry, true);
            assert.equal(camera.images.length, 1);
        });
    }
});

test('snapshot exclusive-open failure leaves an unowned temporary file untouched', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    const destination = '/virtual/camera-tests/CAMERA_A_snapshot.jpg';
    h.files.set(destination, Buffer.from('OLD_IMAGE'));
    let collision;
    h.fakeFs.promises.open = async (file) => {
        collision = file;
        h.files.set(file, Buffer.from('UNOWNED_FILE'));
        throw Object.assign(Error('Fixture temporary file collision'), { code: 'EEXIST' });
    };
    const request = h.manager.requestSnapshot(camera);
    const rejected = assert.rejects(request, { code: 'EEXIST' });
    await flush();
    await h.deliver(camera);
    const decoder = h.processes.find((proc) => proc.args.includes('image2pipe'));
    decoder.stdout.emit('data', Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]));
    decoder.complete(0);
    await rejected;
    assert.equal(h.files.get(destination).toString(), 'OLD_IMAGE');
    assert.equal(h.files.get(collision).toString(), 'UNOWNED_FILE');
    assert.deepEqual(h.unlinkedFiles, []);
    assert.equal(camera.images.length, 0);
    assert.equal(h.manager.snapshots.size, 0);
});

test('failed and timed-out snapshots reject without treating an old image as success, then allow retry', async (t) => {
    for (const failure of ['exit', 'timeout']) {
        await t.test(failure, async (subtest) => {
            const h = harness(subtest);
            const camera = h.camera();
            const destination = '/virtual/camera-tests/CAMERA_A_snapshot.jpg';
            h.files.set(destination, Buffer.from('OLD_IMAGE'));
            const failed = h.manager.requestSnapshot(camera);
            const rejected = assert.rejects(failed);
            await flush();
            await h.deliver(camera);
            const decoder = h.processes.find((proc) => proc.args.includes('image2pipe'));
            if (failure === 'exit') decoder.complete(1);
            else h.fireTimer(102);
            await rejected;
            assert.equal(h.files.get(destination).toString(), 'OLD_IMAGE');
            assert.equal(camera.images.length, 0);
            assert.equal(h.fileCalls.length, 0);
            const retry = h.manager.requestSnapshot(camera);
            await flush();
            const fresh = h.processes.findLast((proc) => proc.args.includes('image2pipe'));
            assert.notEqual(fresh, decoder);
            fresh.stdout.emit('data', Buffer.from([0xff, 0xd8, 7, 0xff, 0xd9]));
            fresh.complete(0);
            assert.equal(await retry, true);
            assert.equal(camera.images.length, 1);
        });
    }
});

test('stopping a snapshot in the decoder rejects immediately without publishing a stored image', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    const request = h.manager.requestSnapshot(camera);
    const rejected = assert.rejects(request, /cancel|stop|disconnect/i);
    await flush();
    await h.deliver(camera);
    const decoder = h.processes.find((proc) => proc.args.includes('image2pipe'));
    await h.manager.stopStream('CAMERA_A');
    await rejected;
    assert.equal(decoder.kills.length > 0, true);
    assert.equal(camera.images.length, 0);
    assert.equal(h.fileCalls.length, 0);
    assert.equal(h.manager.snapshots.size, 0);
});

test('reset while a snapshot file is being written cannot replace the last published image', async (t) => {
    const h = harness(t);
    const camera = h.camera();
    const destination = '/virtual/camera-tests/CAMERA_A_snapshot.jpg';
    h.files.set(destination, Buffer.from('OLD_IMAGE'));
    const write = deferred();
    const writeFile = h.fakeFs.promises.writeFile;
    let writing = false;
    h.fakeFs.promises.writeFile = async (...args) => { writing = true; await write.promise; return writeFile(...args); };
    const request = h.manager.requestSnapshot(camera);
    const observed = request.then(() => 'published', () => 'cancelled');
    await flush();
    await h.deliver(camera);
    const decoder = h.processes.find((proc) => proc.args.includes('image2pipe'));
    decoder.stdout.emit('data', Buffer.from([0xff, 0xd8, 9, 0xff, 0xd9]));
    decoder.complete(0);
    await flush();
    assert.equal(writing, true);
    await h.manager.reset();
    write.resolve();
    assert.equal(await observed, 'cancelled');
    assert.equal(h.files.get(destination).toString(), 'OLD_IMAGE');
    assert.equal(camera.images.length, 0);
});
