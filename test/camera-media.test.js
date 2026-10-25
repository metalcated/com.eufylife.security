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
    const homey = { platformVersion: 2, app: { eufyClient: client, log() {}, debug() {}, error() {}, warn() {} },
        videos: { createVideoRTSP: () => createVideo('rtsp'), createVideoOther: (config) => createVideo('other', config) }
    };
    const nativeRequire = createRequire(filename);
    const localRequire = (request) => {
        if (request === 'eufy-security-client') return { CommandName, PropertyName, VideoCodec };
        if (request === 'node:fs') return fakeFs;
        if (request === './ffmpeg-binary.helper') return class { async resolve() { throw Error('Unexpected resolver construction'); } };
        return nativeRequire(request);
    };
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname,setTimeout,clearTimeout) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(localRequire, module, module.exports, filename, path.dirname(filename), setTimer, clearTimer);
    const Manager = module.exports;
    const manager = new Manager(homey, {
        userdata: '/virtual/camera-tests', startTimeoutMs: 101, snapshotTimeoutMs: 102, idleTimeoutMs: 103, maxDurationMs: 104,
        resolveBinary: async () => { calls.push(['resolve-binary']); return options.resolveBinary ? options.resolveBinary() : '/virtual/ffmpeg'; },
        spawn: (command, args) => { const proc = fakeProcess(command, args); processes.push(proc); return proc; },
        createServer: (handler) => {
            const server = new EventEmitter();
            server.handler = handler;
            server.listen = (port, host, ready) => { server.bind = { port, host }; queueMicrotask(ready); };
            server.address = () => ({ port: 46543 });
            server.close = (done) => { server.closed = true; queueMicrotask(done); };
            servers.push(server);
            return server;
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
        const homeyDevice = { EufyDevice: device, _started: true, values, registrations: [], images: [],
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
        await manager.streamHandler(video, audio, cameraDevice.EufyDevice, cameraDevice.EufyStation, metadata);
        const proc = processes.findLast((candidate) => candidate.args.includes('mpegts') && !candidate.args.includes('image2pipe'));
        if (bytes) proc.stdout.emit('data', bytes);
        await flush();
        return { proc, video, audio };
    }

    function fireTimer(delay) {
        const matching = [...timers].filter((timer) => timer.delay === delay);
        assert.ok(matching.length, `missing timer ${delay}`);
        for (const timer of matching) { timers.delete(timer); timer.fn(); }
    }

    return { manager, homey, client, camera, deliver, calls, processes, timers, files, fileCalls, fileHandles, unlinkedFiles, fakeFs, servers, videos, fireTimer };
}

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
                const retry = await h.manager.getSession(h.camera());
                await h.deliver(h.camera());
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
