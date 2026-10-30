'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

const filename = path.resolve(__dirname, '../lib/helpers/camera-p2p-owned-session.helper.js');
const SECRET = 'fixture-private-account-detail';
const CommandName = { DeviceStartLivestream: 'deviceStartLivestream', DeviceStopLivestream: 'deviceStopLivestream' };
const directTimers = ['connectTimeout', 'lookupTimeout', 'localLookupRetryTimeout', 'lookupRetryTimeout', 'lookup2Timeout',
    'lookup2RetryTimeout', 'heartbeatTimeout', 'keepaliveTimeout', 'esdDisconnectTimeout', 'secondaryCommandTimeout'];
const stateTimers = ['waitForSeqNoTimeout', 'waitForAudioData', 'p2pStreamingTimeout'];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 15; index++) await Promise.resolve(); await new Promise(setImmediate); };

function harness(options = {}) {
    const timers = new Set(), stations = [], calls = [], streams = [], errors = [], stops = [];
    const timer = (fn, delay) => { const token = { fn, delay, unref() {} }; timers.add(token); return token; };
    const clearTimer = token => timers.delete(token);
    let socketId = 0;
    class Socket extends EventEmitter {
        constructor() { super(); this.id = ++socketId; this.bound = false; this.binds = 0; this.sends = 0; this.closes = 0; this.closed = false; }
        bind(port, callback) { this.binds++; this.bound = true; queueMicrotask(() => { this.emit('listening'); callback?.(); }); }
        address() { if (!this.bound || this.closed) throw Object.assign(Error('not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }); return { address: '127.0.0.1', port: 42000 + this.id, family: 'IPv4' }; }
        send(...args) { this.sends++; if (typeof args.at(-1) === 'function') queueMicrotask(() => args.at(-1)(null)); }
        close(callback) {
            this.closes++;
            if (!this.bound && !options.closeUnbound) throw Object.assign(Error('not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
            if (callback) this.once('close', callback);
            if (options.autoClose !== false) queueMicrotask(() => this.finishClose());
        }
        finishClose() { if (this.closed) return; this.closed = true; this.bound = false; this.emit('close'); }
        setRecvBufferSize() {}
        getRecvBufferSize() { return 1048576; }
        setBroadcast() {}
        unref() {}
    }
    class Protocol extends EventEmitter {
        constructor(raw, api) {
            super(); this.rawStation = raw; this.api = api; this.socket = new Socket();
            this.connected = false; this.connecting = false; this.binded = false; this.terminating = false;
            this.sendQueue = []; this.messageStates = new Map(); this.messageVideoStates = new Map(); this.p2pSeqMapping = new Map();
            this.currentMessageState = {}; this.currentMessageBuilder = {}; this.talkbackStream = new PassThrough();
            for (let type = 0; type < 4; type++) {
                this.currentMessageState[type] = { videoStream: new PassThrough(), audioStream: new PassThrough(), queuedData: new Map(),
                    leftoverData: Buffer.from('old'), preFrameVideoData: Buffer.from('old'), p2pStreaming: false,
                    rsaKey: type === 1 ? options.videoKey || null : type === 3 ? options.binaryKey || null : null };
                this.currentMessageBuilder[type] = { messages: {} };
            }
            this.socket.on('close', () => this.onClose());
            this.socket.on('message', () => calls.push(['socket-message', this]));
            this.socket.on('error', () => {});
        }
        isConnected() { return this.connected; }
        isConnecting() { return this.connecting; }
        setConnectionType(value) { this.connectionType = value; }
        async renewDSKKey() {
            // The pinned SDK absorbs cloud lookup errors; connect continues
            // after this await even when its API facade rejected cancellation.
            try { await this.api.request({ method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys', data: {
                station_sns: [this.rawStation.station_sn], invalid_dsks: { [this.rawStation.station_sn]: '' }, transaction: '1000000000000' } }); } catch {}
        }
        async connect() { this.connecting = true; await this.renewDSKKey(); this.socket.bind(0, () => { this.binded = true; this.lookup(); }); }
        lookup() { calls.push(['lookup', this]); }
        async sendMessage() {
            calls.push(['send-message', this]);
            if (options.sendMessage) await options.sendMessage();
            this.socket.send(Buffer.alloc(1), 0, 1, 32108, '127.0.0.1', () => {});
        }
        async _sendCommand() { await this.sendMessage(); this.waitForStreamData(1); }
        waitForStreamData(type) {
            this.currentMessageState[type].p2pStreamingTimeout = timer(() => calls.push(['late-stream-timeout', this]), 777);
        }
        initializeMessageState(type, rsaKey = null) { this.currentMessageState[type] = { ...this.currentMessageState[type], rsaKey }; }
        sendQueuedMessage() { calls.push(['send-queued', this]); }
        close() { this.terminating = true; this.connected = false; }
        onClose() { calls.push(['socket-recreated', this]); this.socket = new Socket(); this._disconnected(); }
        _disconnected() { this.connected = false; this.emit('close'); this._initialize(); }
        _initialize() { calls.push(['reinitialize', this]); }
    }
    for (const method of ['_connect', 'localLookup', 'cloudLookup', 'cloudLookup2', 'cloudLookupWithTurnServer', 'localLookupByAddress',
        'cloudLookupByAddress', 'cloudLookupByAddress2', 'cloudLookupByAddressWithTurnServer', 'scheduleHeartbeat', 'scheduleP2PKeepalive',
        'closeEnergySavingDevice', 'sendCamCheck', 'resendNotAcknowledgedCommand', 'handleMsg', 'handleData', 'sendCommand']) {
        Protocol.prototype[method] = function () { calls.push([method, this]); };
    }
    for (const [suffix, field] of [['Connect', 'connectTimeout'], ['Lookup', 'lookupTimeout'], ['LocalLookupRetry', 'localLookupRetryTimeout'],
        ['LookupRetry', 'lookupRetryTimeout'], ['Lookup2', 'lookup2Timeout'], ['Lookup2Retry', 'lookup2RetryTimeout'], ['Heartbeat', 'heartbeatTimeout'],
        ['Keepalive', 'keepaliveTimeout'], ['ESDDisconnect', 'esdDisconnectTimeout'], ['SecondaryCommand', 'secondaryCommandTimeout']]) {
        Protocol.prototype[`_clear${suffix}Timeout`] = function () { clearTimer(this[field]); this[field] = undefined; };
    }
    Protocol.prototype._clearMessageStateTimeouts = function () { for (const value of this.messageStates.values()) clearTimer(value.timeout); };
    Protocol.prototype._clearMessageVideoStateTimeouts = function () { for (const value of this.messageVideoStates.values()) clearTimer(value.timeout); };
    class Station extends EventEmitter {
        constructor(api, raw) {
            super(); this.rawStation = raw; this.api = api; this.p2pSession = new Protocol(raw, api); this.eventTimeouts = new Map();
            this.starts = 0; this.stops = 0; this.closes = 0; this.terminating = false;
            this.p2pSession.on('close', () => this.onDisconnect());
            this.p2pSession.on('timeout', () => this.onTimeout());
        }
        static async getInstance(api, raw) {
            if (options.factory) await options.factory(api, raw);
            if (options.factoryError) throw Error(SECRET);
            const result = new Station(api, raw); stations.push(result); return result;
        }
        initialize() { this.rawStation.privateInitialized = true; }
        getRawStation() { return this.rawStation; }
        getSerial() { return this.rawStation.station_sn; }
        getConnectionType() { return 2; }
        setConnectionType(value) { this.connectionType = value; }
        isConnected() { return this.p2pSession.connected; }
        async connect() { await this.p2pSession.connect(); }
        startLivestream(device, codec) { this.starts++; calls.push(['start', this, device, codec]); }
        stopLivestream(device) { this.stops++; calls.push(['stop', this, device]); this.emit('command result', this,
            { channel: device.getChannel(), return_code: 0, customData: { command: { name: CommandName.DeviceStopLivestream } } }); }
        close() { this.closes++; this.terminating = true; if (this.isConnected()) this.p2pSession.close(); }
        onConnect() { this.terminating = false; this.emit('connect', this); }
        onDisconnect() { this.emit('close', this); if (!this.terminating) this.scheduleReconnect(); }
        onTimeout() { this.emit('connection error', this, Error(SECRET)); this.scheduleReconnect(); }
        scheduleReconnect() { calls.push(['reconnect', this]); this.reconnectTimeout = timer(() => this.connect(), 5000); }
    }
    const cloud = options.cloud || { request: async () => ({ status: 200, data: { code: 0, data: { dsk_keys: [] } } }),
        isConnected: () => true, getPublicKey: async () => undefined, getVoices: async () => ({}), getCipher: async () => undefined };
    const raw = { station_sn: 'HOMEBASE_A', member: { admin_user_id: 'USER_A' }, devices: [{ device_sn: 'CAMERA_A', device_channel: 2 }] };
    const original = new Station(cloud, raw);
    original.p2pSession.connected = true; original.p2pSession.socket.bound = true;
    const device = new EventEmitter();
    Object.assign(device, { getSerial: () => 'CAMERA_A', getStationSerial: () => 'HOMEBASE_A', getChannel: () => 2,
        hasCommand: () => true, destroy() { throw Error('Original device must never be destroyed'); } });
    const homeyDevice = { EufyDevice: device, EufyStation: original };
    const client = { getApi: () => cloud, getConfig: () => ({ stationIPAddresses: { HOMEBASE_A: '127.0.0.1' } }),
        startStationLivestream() { assert.fail('Owned adapter operated the original Station'); }, stopStationLivestream() { assert.fail('Owned adapter stopped the original Station'); } };
    const nativeRequire = createRequire(filename);
    const mockRequire = name => {
        if (name === 'eufy-security-client') return { Station, CommandName, VideoCodec: { H264: 0 },
            P2PDataType: { DATA: 0, VIDEO: 1, CONTROL: 2, BINARY: 3 }, RequestMessageType: { END: Buffer.from([0xf1, 0xf0]) } };
        if (name === 'eufy-security-client/package.json') return { version: options.version || '4.2.6' };
        return nativeRequire(name);
    };
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname,setTimeout,clearTimeout) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(mockRequire, module, module.exports, filename, path.dirname(filename), timer, clearTimer);
    const sessionOptions = { client, homeyDevice, startupTimeoutMs: 101, shutdownTimeoutMs: 102, disposalTimeoutMs: 103,
        onStream: (video, audio, metadata) => streams.push({ video, audio, metadata }), onStop: () => stops.push(true), onError: error => errors.push(error) };
    const session = new module.exports(sessionOptions);
    const emitConnected = station => { station.p2pSession.connected = true; station.p2pSession.connecting = false; station.emit('connect', station); };
    return { session, stations, original, device, homeyDevice, client, cloud, raw, calls, streams, errors, stops, timers,
        createSession(overrides) { return new module.exports({ ...sessionOptions, ...overrides }); },
        async ready() {
            const start = session.start(); await flush(); const station = stations.at(-1); emitConnected(station); await flush();
            const video = new PassThrough(), audio = new PassThrough();
            station.emit('livestream start', station, 2, { videoCodec: 0, videoFPS: 15 }, video, audio);
            await start; return { station, video, audio };
        },
        emitConnected,
        fire(delay) { const selected = [...timers].filter(value => value.delay === delay); assert.ok(selected.length, `missing deadline ${delay}`);
            for (const value of selected) { timers.delete(value); value.fn(); } },
        populate(station) {
            const p2p = station.p2pSession;
            for (const field of directTimers) p2p[field] = timer(() => p2p.lookup(), 777);
            station.reconnectTimeout = timer(() => station.connect(), 777); station.eventTimeouts.set('event', timer(() => {}, 777));
            for (const state of Object.values(p2p.currentMessageState)) {
                for (const field of stateTimers) state[field] = timer(() => p2p.lookup(), 777);
                state.queuedData.set(1, Buffer.alloc(2));
            }
            for (const map of [p2p.messageStates, p2p.messageVideoStates]) map.set(1,
                { timeout: timer(() => p2p.sendQueuedMessage(), 777), retryTimeout: timer(() => p2p.sendQueuedMessage(), 777) });
            p2p.sendQueue.push({ command: 'old' }); p2p.p2pSeqMapping.set(1, 1);
        },
    };
}

test('owned setup uses a distinct Station and waits for its connect event before starting only the selected camera', async () => {
    const h = harness();
    const originalConnect = h.original.connect, originalSocket = h.original.p2pSession.socket;
    const start = h.session.start(); assert.equal(h.session.start(), start); await flush();
    const station = h.stations[0];
    assert.notEqual(station, h.original); assert.notEqual(station.p2pSession, h.original.p2pSession);
    assert.equal(station.starts, 0); assert.equal(h.original.starts, 0);
    h.emitConnected(station); await flush();
    assert.equal(station.starts, 1);
    const wrongVideo = new PassThrough(), wrongAudio = new PassThrough();
    station.emit('livestream start', station, 7, { videoCodec: 0 }, wrongVideo, wrongAudio);
    assert.equal(wrongVideo.destroyed, true); assert.equal(wrongAudio.destroyed, true); assert.equal(h.streams.length, 0);
    const video = new PassThrough(), audio = new PassThrough();
    station.emit('livestream start', station, 2, { videoCodec: 0, videoFPS: 15 }, video, audio); await start;
    assert.notEqual(h.streams[0].video, video, 'the SDK source drains into a bounded consumer bridge');
    assert.equal(h.streams[0].audio, null);
    const received = [];
    h.streams[0].video.on('data', bytes => received.push(Buffer.from(bytes)));
    video.write(Buffer.from('owned-camera'));
    assert.equal(Buffer.concat(received).toString(), 'owned-camera');
    await h.session.close();
    assert.equal(h.original.connect, originalConnect); assert.equal(h.original.p2pSession.socket, originalSocket);
    assert.equal(originalSocket.closes, 0); assert.equal(h.original.starts, 0); assert.equal(h.original.stops, 0);
    assert.equal(h.homeyDevice.EufyStation, h.original); assert.equal(h.homeyDevice.EufyDevice, h.device);
    assert.equal(h.raw.privateInitialized, undefined, 'initialization must not mutate the original Station metadata');
});

test('close cancels a pending DSK continuation before it can bind, look up, or dispatch a camera', async () => {
    const key = deferred();
    const cloud = { isConnected: () => true, request: () => key.promise };
    const h = harness({ cloud }); const start = h.session.start(); await flush();
    const station = h.stations[0]; assert.ok(station);
    const close = h.session.close(); await assert.rejects(start, /cancel/i); await close;
    key.resolve({ status: 200, data: { code: 0, data: { dsk_keys: [] } } }); await flush();
    assert.equal(station.p2pSession.socket.binds, 0);
    assert.equal(station.starts, 0); assert.equal(h.calls.some(([name, owner]) => name === 'lookup' && owner === station.p2pSession), false);
    assert.equal(h.calls.some(([name]) => name === 'socket-recreated'), false);
    assert.equal(h.timers.size, 0);
});

test('cancelling a factory key lookup prevents late allocation and never changes the original Station', async () => {
    const key = deferred();
    const cloud = { isConnected: () => true, getPublicKey: () => key.promise, request: async () => ({}) };
    const h = harness({ cloud, factory: api => api.getPublicKey('HOMEBASE_A', 2) });
    const start = h.session.start(); await flush(); assert.equal(h.stations.length, 0);
    const close = h.session.close(); await assert.rejects(start, /cancel/i); await close;
    key.resolve('late-public-key'); await flush();
    assert.equal(h.stations.length, 0);
    assert.equal(h.original.p2pSession.socket.closes, 0); assert.equal(h.original.closes, 0);
    assert.equal(h.timers.size, 0);
});

test('confirmed close clears every pinned timer, retry, stream and queue without recreating the UDP socket', async () => {
    const h = harness(); const { station, video, audio } = await h.ready(); h.populate(station);
    const p2p = station.p2pSession, socket = p2p.socket;
    const stale = [...h.timers].filter(value => value.delay === 777).map(value => value.fn);
    const stateStreams = Object.values(p2p.currentMessageState).flatMap(value => [value.videoStream, value.audioStream]);
    await h.session.close();
    assert.equal(h.timers.size, 0);
    assert.equal(video.destroyed, true); assert.equal(audio.destroyed, true);
    assert.equal(stateStreams.every(stream => stream.destroyed), true);
    assert.equal(p2p.talkbackStream == null || p2p.talkbackStream.destroyed, true);
    assert.equal(p2p.messageStates.size, 0); assert.equal(p2p.messageVideoStates.size, 0); assert.equal(p2p.p2pSeqMapping.size, 0);
    assert.equal(p2p.sendQueue.length, 0); assert.equal(socket.closed, true); assert.equal(p2p.socket, socket);
    const before = h.calls.length;
    for (const callback of stale) callback(); await flush();
    assert.equal(h.calls.length, before, 'late queued callbacks cannot recreate network work');
    assert.equal(h.timers.size, 0); assert.equal(h.original.p2pSession.socket.closed, false);
});

test('close is idempotent and requires the actual owned socket close event before it confirms cleanup', async () => {
    const h = harness({ autoClose: false }); const { station } = await h.ready();
    const socket = station.p2pSession.socket;
    const close = h.session.close(); assert.equal(h.session.close(), close); await flush();
    let done = false; close.then(() => { done = true; });
    assert.equal(done, false); assert.equal(socket.closes, 1);
    socket.finishClose(); await close;
    assert.equal(done, true); assert.equal(h.timers.size, 0);
});

test('an unconfirmed UDP close fails safely within its deadline and can be retried after the close event', async () => {
    const h = harness({ autoClose: false }); const { station } = await h.ready();
    const close = h.session.close(); await flush(); h.fire(103);
    await assert.rejects(close, error => error.mediaPublic === true && !error.message.includes(SECRET));
    const retry = h.session.close(); let done = false; retry.then(() => { done = true; }); await flush();
    assert.equal(done, false, 'a retry must still await actual disposal');
    station.p2pSession.socket.finishClose(); await retry;
    assert.equal(h.timers.size, 0);
});

test('a stale connection event cannot start video after the paired device or Station was replaced', async () => {
    for (const changed of ['EufyDevice', 'EufyStation']) {
        const h = harness(); const start = h.session.start(); await flush(); const station = h.stations[0];
        h.homeyDevice[changed] = {};
        h.emitConnected(station); await assert.rejects(start);
        await h.session.close(); assert.equal(station.starts, 0);
    }
});

test('factory failures are public and redacted without closing original resources', async () => {
    const h = harness({ factoryError: true });
    await assert.rejects(h.session.start(), error => error.mediaPublic === true && !error.message.includes(SECRET));
    await h.session.close();
    assert.equal(h.original.closes, 0); assert.equal(h.original.p2pSession.socket.closes, 0); assert.equal(h.timers.size, 0);
});

test('two cameras reuse the same account SDK but keep their Station, UDP socket and video independent', async () => {
    const h = harness();
    const secondDevice = Object.assign(new EventEmitter(), h.device, { getSerial: () => 'CAMERA_B', getChannel: () => 3 });
    const second = h.createSession({ homeyDevice: { EufyDevice: secondDevice, EufyStation: h.original } });
    const firstStart = h.session.start(), secondStart = second.start(); await flush();
    assert.equal(h.stations.length, 2);
    const [a, b] = h.stations;
    assert.notEqual(a, b); assert.notEqual(a.p2pSession.socket, b.p2pSession.socket);
    assert.equal(a.api.isConnected(), true); assert.equal(b.api.isConnected(), true);
    h.emitConnected(a); h.emitConnected(b); await flush();
    const videoA = new PassThrough(), videoB = new PassThrough();
    a.emit('livestream start', a, 2, { videoCodec: 0, videoFPS: 15 }, videoA, new PassThrough());
    b.emit('livestream start', b, 3, { videoCodec: 0, videoFPS: 15 }, videoB, new PassThrough());
    await Promise.all([firstStart, secondStart]);
    const receivedA = [], receivedB = [];
    h.streams[0].video.on('data', chunk => receivedA.push(Buffer.from(chunk)));
    h.streams[1].video.on('data', chunk => receivedB.push(Buffer.from(chunk)));
    videoA.write(Buffer.from('only-A')); videoB.write(Buffer.from('only-B'));
    assert.equal(Buffer.concat(receivedA).toString(), 'only-A');
    assert.equal(Buffer.concat(receivedB).toString(), 'only-B');
    await h.session.close();
    assert.equal(a.p2pSession.socket.closed, true);
    assert.equal(b.p2pSession.socket.closed, false); assert.equal(b.stops, 0);
    videoB.write(Buffer.from('-continues'));
    assert.equal(Buffer.concat(receivedB).toString(), 'only-B-continues');
    assert.equal(h.original.stops, 0);
    await second.close(); assert.equal(h.timers.size, 0);
});

test('unread independent video is bounded and failure closes only its own session', async () => {
    const h = harness(); const { station, video } = await h.ready();
    const bridge = h.streams[0].video;
    for (let index = 0; index < 48 && !video.destroyed; index++) video.write(Buffer.alloc(65536));
    await flush();
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0].mediaPublic, true);
    assert.equal(bridge.destroyed, true); assert.equal(video.destroyed, true);
    assert.ok(bridge.readableLength + bridge.writableLength <= 2 * 1024 * 1024 + 65536);
    await h.session.close();
    assert.equal(station.p2pSession.socket.closed, true);
    assert.equal(h.original.p2pSession.socket.closed, false);
    assert.equal(h.timers.size, 0);
});

test('a foreign Station cannot attach, stop or fail the private camera using the same channel', async () => {
    const h = harness(); const { station, video } = await h.ready();
    const foreignVideo = new PassThrough(), foreignAudio = new PassThrough();
    station.emit('livestream start', h.original, 2, { videoCodec: 0 }, foreignVideo, foreignAudio);
    station.emit('livestream stop', h.original, 2);
    station.emit('livestream error', h.original, 2, Error(SECRET)); await flush();
    assert.equal(foreignVideo.destroyed, false); assert.equal(foreignAudio.destroyed, false);
    assert.equal(h.streams.length, 1); assert.equal(h.errors.length, 0); assert.equal(h.stops.length, 0);
    assert.equal(video.destroyed, false); assert.equal(station.p2pSession.socket.closed, false);
    await h.session.close(); foreignVideo.destroy(); foreignAudio.destroy();
});

test('startup timeout cancels late connection and stream events without reopening a source', async () => {
    const h = harness(); const start = h.session.start(); await flush(); const station = h.stations[0];
    h.fire(101);
    await assert.rejects(start, error => error.mediaPublic === true && !error.message.includes(SECRET));
    await h.session.close();
    h.emitConnected(station);
    const video = new PassThrough(), audio = new PassThrough();
    station.emit('livestream start', station, 2, { videoCodec: 0 }, video, audio); await flush();
    assert.equal(station.starts, 0); assert.equal(h.streams.length, 0);
    assert.equal(h.errors.length, 1); assert.equal(h.timers.size, 0);
    assert.equal(station.p2pSession.socket.closed, true);
});

test('an asynchronous consumer attachment failure is redacted and disposes its owned transport', async () => {
    const h = harness();
    const session = h.createSession({ onStream: async () => { throw Error(SECRET); } });
    const start = session.start(); await flush(); const station = h.stations[0];
    h.emitConnected(station); await flush();
    const video = new PassThrough(), audio = new PassThrough();
    station.emit('livestream start', station, 2, { videoCodec: 0 }, video, audio);
    await assert.rejects(start, error => error.mediaPublic === true && !error.message.includes(SECRET));
    await session.close();
    assert.equal(station.p2pSession.socket.closed, true);
    assert.equal(video.destroyed, true); assert.equal(audio.destroyed, true);
    assert.equal(h.errors.length, 1); assert.equal(h.errors[0].message.includes(SECRET), false);
    assert.equal(h.original.p2pSession.socket.closed, false); assert.equal(h.timers.size, 0);
    await h.session.close();
});

test('unsupported SDK versions fail safely without accepting a partially compatible private transport', () => {
    assert.throws(() => harness({ version: '4.2.7' }), error => error.mediaPublic === true && !error.message.includes(SECRET));
});

test('the shared account facade admits only own-station cipher and DSK reads and projects bounded key fields', async () => {
    const calls = [];
    const h = harness({ cloud: {
        isConnected: () => true,
        async getCipher(...args) { calls.push(['cipher', ...args]); return { private_key: 'rsa', ecc_private_key: 'ecc', token: SECRET, user_id: SECRET }; },
        async request(request) { calls.push(['request', request]); return { status: 200, headers: { authorization: SECRET }, data: {
            code: 0, msg: SECRET, data: { token: SECRET, dsk_keys: [
                { station_sn: 'OTHER', dsk_key: SECRET, expiration: 1 },
                { station_sn: 'HOMEBASE_A', dsk_key: 'own-key', expiration: 100, token: SECRET },
            ] } } }; },
    } });
    const api = h.session.apiProxy;
    assert.deepEqual(await api.getCipher(7, 'USER_A'), { private_key: 'rsa', ecc_private_key: 'ecc' });
    const request = { method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys', data: {
        station_sns: ['HOMEBASE_A'], invalid_dsks: { HOMEBASE_A: '' }, transaction: '1000000000000' } };
    const response = await api.request(request);
    assert.deepEqual(response, { status: 200, data: { code: 0, data: {
        dsk_keys: [{ station_sn: 'HOMEBASE_A', dsk_key: 'own-key', expiration: 100 }] } } });
    assert.equal(JSON.stringify(response).includes(SECRET), false);
    for (const args of [[7, 'OTHER'], [-1, 'USER_A'], [65536, 'USER_A'], [1.5, 'USER_A'], ['7', 'USER_A']]) {
        await assert.rejects(api.getCipher(...args), error => error.mediaPublic && !error.message.includes(SECRET));
    }
    for (const bad of [
        { ...request, method: 'get' }, { ...request, endpoint: 'v1/app/equipment/set_device' },
        { ...request, headers: { token: SECRET } }, { ...request, data: { ...request.data, station_sns: ['OTHER'] } },
        { ...request, data: { ...request.data, invalid_dsks: { HOMEBASE_A: '', OTHER: '' } } },
        { ...request, data: { ...request.data, transaction: SECRET } },
    ]) await assert.rejects(api.request(bad), error => error.mediaPublic && !error.message.includes(SECRET));
    assert.equal(calls.length, 2, 'denied operations never reach the shared account');
    await h.session.close(); assert.equal(h.timers.size, 0);
});

test('late cipher responses and raw cloud exceptions cannot revive or leak from a closed private session', async () => {
    const cipher = deferred();
    const h = harness({ cloud: { isConnected: () => true, getCipher: () => cipher.promise } });
    const pending = h.session.apiProxy.getCipher(7, 'USER_A'); await flush();
    await h.session.close();
    await assert.rejects(pending, error => error.mediaPublic && !error.message.includes(SECRET));
    cipher.resolve({ private_key: SECRET }); await flush();
    assert.equal(h.timers.size, 0); assert.equal(h.stations.length, 0); assert.equal(h.errors.length, 0);
    const failed = harness({ cloud: { isConnected: () => true, getCipher: async () => { throw Error(SECRET); } } });
    await assert.rejects(failed.session.apiProxy.getCipher(7, 'USER_A'), error => error.mediaPublic && !error.message.includes(SECRET));
    await failed.session.close(); assert.equal(failed.timers.size, 0);
});

test('close drains an in-flight transport send and blocks its late stream-timer continuation', async () => {
    const send = deferred(); const h = harness({ sendMessage: () => send.promise });
    const { station } = await h.ready(); const p2p = station.p2pSession;
    const command = p2p._sendCommand();
    const closing = h.session.close(); let done = false; closing.then(() => { done = true; }); await flush();
    assert.equal(p2p.socket.closed, true); assert.equal(done, false, 'closing UDP alone does not drain an already-running send');
    send.resolve(); await command; await closing;
    assert.equal(p2p.socket.sends, 0, 'late send cannot write through the closed owned socket');
    assert.equal(h.timers.size, 0, 'late waitForStreamData cannot install a new timer');
    assert.equal(h.original.p2pSession.socket.closed, false);
});

test('a hung transport send fails closing within its deadline and a late rejection is observed before retry succeeds', async () => {
    const send = deferred(); const h = harness({ sendMessage: () => send.promise });
    const { station } = await h.ready();
    const command = station.p2pSession._sendCommand(); command.catch(() => {});
    const closing = h.session.close(); await flush(); assert.equal(station.p2pSession.socket.closed, true);
    h.fire(103);
    await assert.rejects(closing, error => error.mediaPublic === true && !error.message.includes(SECRET));
    send.reject(Error(SECRET)); await assert.rejects(command, error => error.message === SECRET); await flush();
    assert.deepEqual(await h.session.close(), { stopConfirmed: true });
    assert.equal(h.timers.size, 0); assert.equal(h.original.p2pSession.socket.closed, false);
});

test('owned SDK state initialization accelerates only each VIDEO key and leaves original and binary keys unchanged', async () => {
    const { isNativeVideoRSAKey } = require('../lib/helpers/camera-native-video-rsa.helper');
    const generated = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const pem = generated.privateKey.export({ type: 'pkcs1', format: 'pem' });
    const makeKey = () => ({ options: { encryptionScheme: 'pkcs1' },
        exportKey: () => pem, exportPublicComponents: () => ({ n: Uint8Array.from([0, 1]), e: Uint8Array.from([1, 0, 1]) }),
        decrypt: ciphertext => crypto.privateDecrypt({ key: generated.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, ciphertext) });
    const videoKey = makeKey(), binaryKey = makeKey(), originalDecrypt = videoKey.decrypt, binaryDecrypt = binaryKey.decrypt;
    const h = harness({ videoKey, binaryKey });
    const start = h.session.start(); await flush(); const station = h.stations[0], p2p = station.p2pSession;
    assert.equal(h.session.videoCrypto, 'native');
    assert.equal(isNativeVideoRSAKey(p2p.currentMessageState[1].rsaKey), true);
    assert.equal(h.original.p2pSession.currentMessageState[1].rsaKey, videoKey);
    assert.equal(videoKey.decrypt, originalDecrypt); assert.equal(binaryKey.decrypt, binaryDecrypt);
    assert.equal(p2p.currentMessageState[3].rsaKey, binaryKey); assert.equal(isNativeVideoRSAKey(binaryKey), false);
    const replacement = makeKey(); p2p.initializeMessageState(1, replacement);
    assert.equal(isNativeVideoRSAKey(p2p.currentMessageState[1].rsaKey), true);
    assert.notEqual(p2p.currentMessageState[1].rsaKey, replacement);
    p2p.initializeMessageState(3, binaryKey); assert.equal(p2p.currentMessageState[3].rsaKey, binaryKey);
    const ciphertext = crypto.publicEncrypt({ key: generated.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.alloc(16, 9));
    assert.deepEqual(p2p.currentMessageState[1].rsaKey.decrypt(ciphertext), Buffer.alloc(16, 9));
    const closing = h.session.close(); await assert.rejects(start, /cancel/i); await closing;
    p2p.initializeMessageState(1, replacement);
    assert.equal(p2p.currentMessageState[1].rsaKey, null, 'late state initialization cannot restore a key after disposal');
    assert.equal(h.timers.size, 0);
});
