'use strict';

// Run in the cached production image with --network none. No account or footage.
const assert = require('node:assert/strict');
const path = require('node:path');
const dgram = require('node:dgram');
const { AsyncLocalStorage, createHook } = require('node:async_hooks');
const { PassThrough } = require('node:stream');
const { Camera, CommandName, DeviceType, P2PConnectionType, RequestMessageType } = require('eufy-security-client');
const build = path.dirname(require.resolve('eufy-security-client'));
const { P2PDataType, CommandType, EncryptionType } = require(path.join(build, 'p2p/types.js'));
const { getNewRSAPrivateKey } = require(path.join(build, 'p2p/utils.js'));
const { isNativeVideoRSAKey } = require('/app/lib/helpers/camera-native-video-rsa.helper.js');
const CameraP2POwnedSession = require(path.resolve(process.env.OWNED_HELPER || path.join(__dirname, '../lib/helpers/camera-p2p-owned-session.helper.js')));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);
const waitFor = async (condition, label) => {
    const end = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > end) throw Error(label);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
};
const context = new AsyncLocalStorage();
const timers = new Map();
const hook = createHook({
    init(id, type, trigger, resource) { if (type === 'Timeout' && context.getStore()) timers.set(id, { owner: context.getStore(), resource, stack: new Error().stack }); },
    destroy(id) { timers.delete(id); },
}).enable();
const sockets = [];
const createSocket = dgram.createSocket;
dgram.createSocket = function (...args) {
    const socket = createSocket.apply(this, args);
    const observed = { socket, owner: context.getStore(), binds: 0, sends: 0, packets: [], closed: false, listening: false };
    sockets.push(observed);
    const bind = socket.bind, send = socket.send, emit = socket.emit;
    socket.bind = function (...values) { observed.binds++; return bind.apply(this, values); };
    socket.send = function (...values) {
        observed.sends++;
        if (Buffer.isBuffer(values[0])) observed.packets.push(Buffer.from(values[0]));
        return send.apply(this, values);
    };
    socket.emit = function (event, ...values) {
        if (event === 'close') observed.closed = true;
        if (event === 'listening') observed.listening = true;
        return emit.call(this, event, ...values);
    };
    return socket;
};
const base = 'FIXTURE_HOMEBASE';
const rawDevices = ['A', 'B', 'C'].map((label, channel) => ({ device_sn: `FIXTURE_CAMERA_${label}`, station_sn: base,
    device_channel: channel, device_type: DeviceType.CAMERA2, device_name: label, params: [], main_sw_version: '4.0.0.0' }));
const rawStation = { station_sn: base, device_type: DeviceType.HB3, station_name: 'Fixture', p2p_did: 'FIXTURE_DID',
    app_conn: '', main_sw_version: '3.3.0.0', params: [], member: { admin_user_id: 'FIXTURE_USER' }, devices: rawDevices };
const pending = [], requests = [], cipherCalls = [], errors = [], sessions = [];
const api = {
    isConnected: () => true, getPublicKey: async () => undefined, getVoices: async () => ({}),
    getCipher: async (id, admin) => { cipherCalls.push([id, admin]); return undefined; },
    request: request => {
        assert.equal(request.endpoint, 'v1/app/equipment/get_dsk_keys');
        assert.deepEqual(request.data.station_sns, [base]);
        const reply = deferred(); requests.push(request); pending.push(reply); return reply.promise;
    },
};
const client = { getApi: () => api, getConfig: () => ({ stationIPAddresses: { [base]: '127.0.0.1' } }) };
const originalStation = { getRawStation: () => rawStation, getConnectionType: () => P2PConnectionType.ONLY_LOCAL };
function candidate(label, index) {
    const device = new Camera(api, rawDevices[index], {}), received = [], streams = [], commands = [];
    const homeyDevice = { EufyDevice: device, EufyStation: originalStation };
    const session = new CameraP2POwnedSession({ client, homeyDevice, startupTimeoutMs: 10000, shutdownTimeoutMs: 50, disposalTimeoutMs: 1000,
        onStream(video, audio, info) {
            assert.equal(audio, null); streams.push({ video, info });
            video.on('data', chunk => received.push(Buffer.from(chunk)));
        }, onError(error) { errors.push(error); } });
    sessions.push(session);
    const started = context.run(label, () => session.start()); started.catch(() => {});
    return { label, session, started, homeyDevice, device, received, streams, commands,
        close: () => context.run(label, () => session.close()) };
}
const keys = () => ({ status: 200, data: { code: 0, data: { dsk_keys: [
    { station_sn: base, dsk_key: 'fixture-key', expiration: Math.floor(Date.now() / 1000) + 3600 }
] } } });
const ownedTimers = owner => [...timers.values()].filter(value => value.owner === owner && !value.resource._destroyed);
const activeSocket = observation => process._getActiveHandles().includes(observation.socket);

async function main() {
    const baselineRSS = process.memoryUsage().rss;
    const a = candidate('A', 0), b = candidate('B', 1);
    await waitFor(() => pending.length === 2, 'real SDK did not request independent station keys');
    assert.notEqual(a.session.station, b.session.station);
    for (const candidate of [a, b]) {
        const p2p = candidate.session.station.p2pSession;
        assert.equal(candidate.session.videoCrypto, 'native');
        assert.equal(isNativeVideoRSAKey(p2p.currentMessageState[P2PDataType.VIDEO].rsaKey), true);
        const binary = p2p.getDownloadRSAPrivateKey(), binaryDecrypt = binary.decrypt;
        const replacement = getNewRSAPrivateKey(false), originalDecrypt = replacement.decrypt;
        const oldState = p2p.currentMessageState[P2PDataType.VIDEO];
        oldState.videoStream?.destroy(); oldState.audioStream?.destroy();
        p2p.initializeMessageState(P2PDataType.VIDEO, replacement);
        p2p.initializeStream(P2PDataType.VIDEO);
        assert.equal(candidate.session.videoCrypto, 'native');
        assert.equal(isNativeVideoRSAKey(p2p.currentMessageState[P2PDataType.VIDEO].rsaKey), true);
        assert.equal(replacement.decrypt, originalDecrypt, 'original Forge VIDEO key was mutated');
        assert.equal(p2p.currentMessageState[P2PDataType.BINARY].rsaKey, binary);
        assert.equal(binary.decrypt, binaryDecrypt); assert.equal(isNativeVideoRSAKey(binary), false);
    }
    const aSocket = sockets.find(value => value.owner === 'A'), bSocket = sockets.find(value => value.owner === 'B');
    assert.ok(aSocket && bSocket); assert.notEqual(aSocket.socket, bSocket.socket);
    assert.equal(aSocket.binds, 0); assert.equal(bSocket.binds, 0);
    await a.close(); await assert.rejects(a.started, /cancel/i);
    const beforeLate = sockets.length;
    pending[0].resolve(keys()); await tick(); await tick();
    assert.equal(aSocket.binds, 0, 'late DSK response bound the cancelled socket');
    assert.equal(aSocket.sends, 0); assert.equal(sockets.length, beforeLate, 'cleanup recreated a socket');
    assert.equal(ownedTimers('A').length, 0); assert.equal(activeSocket(aSocket), false);
    pending[1].resolve(keys());
    await waitFor(() => bSocket.listening, 'real SDK never bound its UDP socket');
    assert.equal(bSocket.binds, 1);
    assert.ok(ownedTimers('B').length > 0, 'lookup should have real SDK retry timers');
    await b.close(); await assert.rejects(b.started, /cancel/i); await tick(); await tick();
    assert.equal(bSocket.closed, true, 'close did not observe actual UDP close');
    assert.equal(activeSocket(bSocket), false); assert.equal(ownedTimers('B').length, 0);
    assert.equal(sockets.length, beforeLate);

    const c = candidate('C', 0), d = candidate('D', 1);
    await waitFor(() => pending.length === 4, 'second SDK pair did not request its keys');
    pending[2].resolve(keys()); pending[3].resolve(keys());
    const cSocket = sockets.find(value => value.owner === 'C'), dSocket = sockets.find(value => value.owner === 'D');
    await waitFor(() => cSocket.listening && dSocket.listening, 'second SDK pair did not bind');
    for (const candidate of [c, d]) {
        // Offline connection/media fixture: SDK initialization and transport are
        // real; device connection and encoded media events are synthetic.
        const station = candidate.session.station;
        station.p2pSession.connected = true;
        station.p2pSession.connecting = false;
        station.p2pSession.connectAddress = { host: '127.0.0.1', port: 32108 };
        const sendCommand = station.p2pSession.sendCommand;
        station.p2pSession.sendCommand = function (...args) {
            candidate.commands.push(args[3]?.command?.name);
            return sendCommand.apply(this, args);
        };
        context.run(candidate.label, () => station.emit('connect', station));
    }
    await tick();
    const sourceC = new PassThrough(), sourceD = new PassThrough();
    for (const [candidate, source, channel] of [[c, sourceC, 0], [d, sourceD, 1]]) {
        context.run(candidate.label, () => candidate.session.station.emit('livestream start', candidate.session.station, channel,
            { videoCodec: 0, videoFPS: 15 }, source, new PassThrough()));
    }
    await Promise.all([c.started, d.started]);
    const data = Buffer.alloc(20); data.writeUInt16LE(7, 0);
    context.run('C', () => c.session.station.p2pSession.handleData({ dataType: P2PDataType.CONTROL,
        commandId: CommandType.CMD_GATEWAYINFO, signCode: 0, type: 0, seqNo: 65535, channel: 255, bytesToRead: data.length, data }));
    await waitFor(() => cipherCalls.length === 1 && c.session.station.p2pSession.encryption === EncryptionType.LEVEL_1,
        'actual SDK gateway-info handler did not complete its own cipher fallback');
    assert.deepEqual(cipherCalls, [[7, 'FIXTURE_USER']]);
    assert.ok(Buffer.isBuffer(c.session.station.p2pSession.p2pKey));
    sourceC.write(Buffer.from('camera-C')); sourceD.write(Buffer.from('camera-D'));
    assert.equal(Buffer.concat(c.received).toString(), 'camera-C');
    assert.equal(Buffer.concat(d.received).toString(), 'camera-D');
    await c.close(); await waitFor(() => !activeSocket(cSocket), 'closed C UDP handle was retained');
    if (ownedTimers('C').length) console.error(ownedTimers('C').map(value => ({ delay: value.resource._idleTimeout, stack: value.stack })));
    assert.equal(cSocket.closed, true); assert.equal(activeSocket(cSocket), false); assert.equal(ownedTimers('C').length, 0);
    assert.ok(c.commands.includes(CommandName.DeviceStopLivestream), 'private close never dispatched its camera STOP command');
    assert.ok(cSocket.packets.some(packet => packet.subarray(0, 2).equals(RequestMessageType.END)), 'private close never sent its own UDP END packet');
    assert.equal(dSocket.closed, false); assert.equal(sourceD.destroyed, false);
    sourceD.write(Buffer.from('-still-running'));
    assert.equal(Buffer.concat(d.received).toString(), 'camera-D-still-running');
    await d.close(); await waitFor(() => !activeSocket(dSocket), 'closed D UDP handle was retained');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(dSocket.closed, true); assert.equal(activeSocket(dSocket), false); assert.equal(ownedTimers('D').length, 0);
    assert.ok(d.commands.includes(CommandName.DeviceStopLivestream));
    assert.ok(dSocket.packets.some(packet => packet.subarray(0, 2).equals(RequestMessageType.END)));
    assert.equal(sockets.length, 4, 'a private close recreated SDK sockets');
    assert.equal(rawStation.privateInitialized, undefined);
    for (const candidate of [a, b, c, d]) assert.equal(candidate.homeyDevice.EufyStation, originalStation);
    assert.equal(errors.length, 0);
    console.log(JSON.stringify({ result: 'PASS', actualSDK: require('eufy-security-client/package.json').version,
        realSockets: sockets.length, cameraPayloadsIsolated: true, lateDSKBindPrevented: true, remainingOwnedTimers: [...timers.values()].filter(value => !value.resource._destroyed).length,
        rssBaselineMiB: Math.round(baselineRSS / 1048576), rssEndMiB: Math.round(process.memoryUsage().rss / 1048576) }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
    await Promise.allSettled(sessions.map(session => session.close()));
    hook.disable(); dgram.createSocket = createSocket;
});
