'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');

function loadCameraSDK() {
    const packageFile = require.resolve('eufy-security-client/package.json');
    const entrypoint = require.resolve('eufy-security-client');
    const build = path.join(path.dirname(packageFile), 'build');
    // These public classes live in internal distribution files. Keep the
    // exception tied to the validated SDK version and fail closed on updates.
    if (require(packageFile).version !== '4.2.6' || entrypoint !== path.join(build, 'index.js')) {
        throw new Error('The independent camera SDK version is unsupported.');
    }
    const devices = require(path.join(build, 'http', 'device.js'));
    const { Station } = require(path.join(build, 'http', 'station.js'));
    const { CommandName } = require(path.join(build, 'http', 'types.js'));
    const { VideoCodec } = require(path.join(build, 'p2p', 'types.js'));
    if (typeof devices.Device !== 'function' || typeof Station?.getInstance !== 'function'
        || !['initialize', 'connect', 'startLivestream', 'stopLivestream', 'close'].every(name => typeof Station.prototype[name] === 'function')
        || typeof CommandName?.DeviceStartLivestream !== 'string' || typeof CommandName.DeviceStopLivestream !== 'string'
        || !Number.isInteger(VideoCodec?.H264)) throw new Error('The independent camera SDK shape is unsupported.');
    // Avoid loading the account client, push service and MQTT implementation in
    // every camera worker. The parent alone owns the authenticated account API.
    return { ...devices, Station, CommandName, VideoCodec };
}

const sdk = loadCameraSDK();

const MAX_CHUNK = 64 * 1024;
const MAX_BUFFER = 2 * 1024 * 1024;
let closing = false;
let station;
let device;
let video;
let audio;
let sequence = 0;
let credit = false;
let queuedBytes = 0;
let queue = [];
let rpcId = 0;
let dispatched = false;
let phase = 'device-create';
let stopConfirmed = false;
let finishStop;
let cancelConnect;
const pending = new Map();
const send = message => { try { parentPort.postMessage(message); } catch { /* Parent termination is final. */ } };
const cancelled = () => new Error('Camera connection closed.');

function rpc(method, args) {
    if (closing) return Promise.reject(cancelled());
    const id = ++rpcId;
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ type: 'rpc', id, method, args }); });
}

const api = {
    isConnected: () => workerData.connected === true && !closing,
    getDevices: () => ({ [workerData.rawDevice.device_sn]: workerData.rawDevice }),
    getPublicKey: (...args) => rpc('getPublicKey', args),
    getCipher: (...args) => rpc('getCipher', args),
    getVoices: (...args) => rpc('getVoices', args),
    request: (...args) => rpc('request', args),
    refreshStationData: async () => {},
};

function fail() {
    if (!closing) send({ type: 'error', phase });
    close().catch(() => {});
}

function pump() {
    if (closing || !credit || !queue.length) return;
    const first = queue[0];
    const length = Math.min(first.length, MAX_CHUNK);
    const bytes = Uint8Array.from(first.subarray(0, length));
    if (length === first.length) queue.shift(); else queue[0] = first.subarray(length);
    queuedBytes -= length;
    credit = false;
    parentPort.postMessage({ type: 'video', sequence: ++sequence, data: bytes }, [bytes.buffer]);
}

function connect() {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            station.removeListener('connect', ready);
            station.removeListener('connection error', failed);
            station.removeListener('close', failed);
            cancelConnect = null;
        };
        const ready = () => { cleanup(); closing ? reject(cancelled()) : resolve(); };
        const failed = () => { cleanup(); reject(cancelled()); };
        cancelConnect = failed;
        station.once('connect', ready);
        station.once('connection error', failed);
        station.once('close', failed);
        Promise.resolve().then(() => station.connect()).catch(failed);
    });
}

async function start() {
    const Constructor = sdk[workerData.deviceConstructor];
    if (typeof Constructor?.getInstance !== 'function' || !(Constructor.prototype instanceof sdk.Device)) throw cancelled();
    device = await Constructor.getInstance(api, workerData.rawDevice, workerData.config.deviceConfig);
    if (closing) return;
    phase = 'device-init';
    device.initialize();
    if (device.getSerial() !== workerData.rawDevice.device_sn || device.getStationSerial() !== workerData.rawStation.station_sn
        || !device.hasCommand(sdk.CommandName.DeviceStartLivestream)) throw cancelled();
    phase = 'station-create';
    station = await sdk.Station.getInstance(api, workerData.rawStation, workerData.ipAddress, 0, workerData.config.enableEmbeddedPKCS1Support);
    if (closing) { station.close(); return; }
    phase = 'station-init';
    station.initialize();
    station.setConnectionType(workerData.connectionType);
    station.on('livestream start', (source, channel, info, videoStream, audioStream) => {
        if (closing || channel !== device.getChannel() || video) { videoStream.destroy(); audioStream?.destroy(); return; }
        phase = 'stream';
        video = videoStream;
        audio = audioStream;
        const infoCopy = {};
        for (const key of ['videoCodec', 'videoFPS', 'videoHeight', 'videoWidth', 'audioCodec']) {
            if (typeof info?.[key] === 'number' && Number.isFinite(info[key])) infoCopy[key] = info[key];
        }
        send({ type: 'stream', metadata: infoCopy });
        audio?.on('error', () => {});
        audio?.resume();
        video.on('error', fail);
        // Always drain the SDK's UDP-backed source into a bounded queue. A
        // single credited chunk may be in flight to the parent at any time.
        video.on('data', chunk => {
            if (closing) return;
            if (!Buffer.isBuffer(chunk) || !chunk.length || queuedBytes + chunk.length > MAX_BUFFER) { fail(); return; }
            queue.push(chunk);
            queuedBytes += chunk.length;
            pump();
        });
    });
    station.on('livestream error', (source, channel) => { if (channel === device.getChannel()) fail(); });
    station.on('connection error', fail);
    station.on('close', () => { if (!closing) { send({ type: 'stopped' }); close().catch(() => {}); } });
    station.on('livestream stop', (source, channel) => {
        if (!closing && channel === device.getChannel()) { send({ type: 'stopped' }); close().catch(() => {}); }
    });
    station.on('command result', (source, result) => {
        if (result?.channel !== device.getChannel()) return;
        const name = result.customData?.command?.name;
        if (closing && name === sdk.CommandName.DeviceStopLivestream && result.return_code === 0) {
            stopConfirmed = true;
            finishStop?.();
        } else if (!closing && name === sdk.CommandName.DeviceStartLivestream && result.return_code !== 0) fail();
    });
    phase = 'connect';
    await connect();
    if (closing) return;
    phase = 'start';
    dispatched = true;
    station.startLivestream(device, sdk.VideoCodec.H264);
}

let closePromise;
function close() {
    if (closePromise) return closePromise;
    closing = true;
    cancelConnect?.();
    for (const rpc of pending.values()) rpc.reject(cancelled());
    pending.clear();
    queue = [];
    queuedBytes = 0;
    closePromise = (async () => {
        if (station && device && dispatched && station.isConnected()) {
            let timer;
            const stopped = new Promise(resolve => { finishStop = resolve; timer = setTimeout(resolve, 700); });
            try { station.stopLivestream(device); await stopped; } catch { /* Termination still owns the socket. */ }
            clearTimeout(timer);
        }
        video?.destroy(); audio?.destroy();
        try { station?.close(); } catch { /* Parent terminate disposes pending sockets and timers too. */ }
        try { device?.destroy(); } catch { /* Independent metadata object only. */ }
        // Give the public close() call's UDP END packet a bounded opportunity
        // to leave before the parent terminates the entire transport thread.
        await new Promise(resolve => setTimeout(resolve, 50));
        send({ type: 'closed', stopConfirmed });
    })();
    return closePromise;
}

parentPort.on('message', message => {
    if (message?.type === 'close') { close().catch(() => {}); return; }
    if (closing) return;
    if (message?.type === 'rpc-result') {
        const rpc = pending.get(message.id);
        if (!rpc) return;
        pending.delete(message.id);
        message.error ? rpc.reject(cancelled()) : rpc.resolve(message.value);
    } else if (message?.type === 'ack' && message.sequence === sequence) { credit = true; pump(); }
});

start().catch(() => { if (!closing) fail(); });
