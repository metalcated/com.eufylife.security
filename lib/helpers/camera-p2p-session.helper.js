'use strict';

const path = require('node:path');
const { PassThrough } = require('node:stream');
const { Worker } = require('node:worker_threads');

const MAX_CHUNK = 64 * 1024;
const DSK_ENDPOINT = 'v1/app/equipment/get_dsk_keys';
const FAILURE_PHASES = Object.freeze({
    'device-create': 'The independent camera connection failed while preparing the camera (device-create).',
    'device-init': 'The independent camera connection failed while initializing the camera (device-init).',
    'station-create': 'The independent camera connection failed while preparing its station (station-create).',
    'station-init': 'The independent camera connection failed while initializing its station (station-init).',
    connect: 'The independent camera connection failed while connecting to its station (connect).',
    start: 'The independent camera connection failed while starting video (start).',
    stream: 'The independent camera connection failed while receiving video (stream).',
});
const publicError = message => Object.assign(new Error(message), { mediaPublic: true });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Cloud metadata is needed by the SDK's public factories. Account authentication
// belongs exclusively to the parent API; never copy a client/config/session object.
function metadata(value) {
    return JSON.parse(JSON.stringify(value, (key, item) =>
        /^(?:password|username|authorization|cookie|(?:access|refresh|cloud|auth)_?token|api_?key|token)$/i.test(key) ? undefined : item));
}

class CameraP2PSession {
    constructor({ client, homeyDevice, onStream = () => {}, onStop = () => {}, onError = () => {}, WorkerClass = Worker,
        startupTimeoutMs = 25000, shutdownTimeoutMs = 1000, terminationTimeoutMs = 2000, rpcTimeoutMs = 10000 }) {
        this.client = client;
        this.homeyDevice = homeyDevice;
        this.device = homeyDevice?.EufyDevice;
        this.station = homeyDevice?.EufyStation;
        this.onStream = onStream;
        this.onStop = onStop;
        this.onError = onError;
        this.WorkerClass = WorkerClass;
        this.startupTimeoutMs = startupTimeoutMs;
        this.shutdownTimeoutMs = shutdownTimeoutMs;
        this.terminationTimeoutMs = terminationTimeoutMs;
        this.rpcTimeoutMs = rpcTimeoutMs;
        this.pendingRpc = new Map();
        this.rpcCount = 0;
        this.lastSequence = 0;
        this.stopConfirmed = false;
        try {
            this.api = client.getApi();
            const config = client.getConfig?.() || {};
            const rawStation = metadata(this.station.getRawStation());
            const rawDevice = metadata(this.device.getRawDevice());
            this.stationSerial = rawStation.station_sn;
            this.deviceSerial = rawDevice.device_sn;
            this.adminUserID = rawStation.member?.admin_user_id;
            if (!identity(this.stationSerial) || !identity(this.deviceSerial)
                || rawDevice.station_sn !== this.stationSerial
                || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(this.device.constructor.name)) throw new Error();
            const ip = config.stationIPAddresses?.[this.stationSerial];
            this.workerData = {
                rawStation, rawDevice, deviceConstructor: this.device.constructor.name,
                connectionType: this.station.getConnectionType(),
                ...(typeof ip === 'string' ? { ipAddress: ip } : {}),
                config: {
                    deviceConfig: { ...(typeof config.deviceConfig?.simultaneousDetections === 'boolean'
                        ? { simultaneousDetections: config.deviceConfig.simultaneousDetections } : {}) },
                    enableEmbeddedPKCS1Support: config.enableEmbeddedPKCS1Support === true,
                },
                connected: this.api.isConnected() === true,
            };
        } catch { throw publicError('This camera cannot create an independent video connection.'); }
    }

    start() {
        if (this.startPromise) return this.startPromise;
        if (this.closing) return Promise.reject(publicError('Camera startup was cancelled.'));
        this.startPromise = new Promise((resolve, reject) => { this.resolveStart = resolve; this.rejectStart = reject; });
        this.startPromise.catch(() => {});
        try {
            this.worker = new this.WorkerClass(path.join(__dirname, 'camera-p2p-worker.js'), {
                workerData: this.workerData, env: {}, stdout: true, stderr: true,
                resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4, codeRangeSizeMb: 4 },
            });
            this.worker.stdout?.resume?.();
            this.worker.stderr?.resume?.();
            this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
            this.worker.on('message', message => this.receive(message));
            this.worker.on('error', () => this.fail('The independent camera connection failed.'));
            this.worker.on('exit', () => {
                this.exited = true;
                this.resolveExit?.();
                if (!this.closing) this.fail('The independent camera connection ended.');
            });
            this.startTimer = setTimeout(() => this.fail('The camera did not deliver independent video in time.'), this.startupTimeoutMs);
        } catch { this.fail('The independent camera connection could not start.'); }
        return this.startPromise;
    }

    send(message) {
        if (!this.worker || this.exited) return;
        try { this.worker.postMessage(message); } catch { /* Termination owns final cleanup. */ }
    }

    receive(message) {
        if (!record(message)) return;
        if (message.type === 'closed') {
            this.stopConfirmed = message.stopConfirmed === true;
            this.resolveClosed?.();
            return;
        }
        if (this.closing) return;
        if (message.type === 'rpc') { this.rpc(message).catch(() => this.fail('The camera API connection failed.')); return; }
        if (message.type === 'error') {
            this.fail(typeof message.phase === 'string' && Object.prototype.hasOwnProperty.call(FAILURE_PHASES, message.phase)
                ? FAILURE_PHASES[message.phase] : 'The independent camera connection failed. Check the camera and retry.');
            return;
        }
        if (message.type === 'stopped') {
            if (!this.streaming) { this.fail('The camera stopped before independent video was ready.'); return; }
            try { Promise.resolve(this.onStop()).catch(() => {}); } catch { /* Session cleanup must still complete. */ }
            this.close().catch(() => {});
            return;
        }
        if (message.type === 'stream') {
            if (this.streaming) { this.fail('The camera sent an unexpected video restart.'); return; }
            const info = {};
            for (const key of ['videoCodec', 'videoFPS', 'videoHeight', 'videoWidth', 'audioCodec']) {
                if (typeof message.metadata?.[key] === 'number' && Number.isFinite(message.metadata[key])) info[key] = message.metadata[key];
            }
            this.streaming = true;
            clearTimeout(this.startTimer);
            this.video = new PassThrough({ highWaterMark: 256 * 1024 });
            this.video.on('error', () => this.fail('The independent camera video failed.'));
            this.video.on('close', () => { if (!this.closing) this.close().catch(() => {}); });
            try {
                Promise.resolve(this.onStream(this.video, null, info)).then(() => {
                    if (this.closing) return;
                    this.resolveStart?.();
                    this.send({ type: 'ack', sequence: 0 });
                }).catch(() => this.fail('The camera video could not be attached.'));
            } catch { this.fail('The camera video could not be attached.'); }
            return;
        }
        if (message.type === 'video') {
            const chunk = message.data;
            if (!this.streaming || !this.video || !(chunk instanceof Uint8Array) || !chunk.byteLength || chunk.byteLength > MAX_CHUNK
                || message.sequence !== this.lastSequence + 1) { this.fail('The camera returned invalid video data.'); return; }
            this.lastSequence = message.sequence;
            const acknowledge = () => { if (!this.closing) this.send({ type: 'ack', sequence: message.sequence }); };
            if (this.video.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) acknowledge();
            else this.video.once('drain', acknowledge);
        }
    }

    async rpc(message) {
        const { id, method, args } = message;
        const permitted = Number.isSafeInteger(id) && id > 0 && Array.isArray(args) && !this.pendingRpc.has(id)
            && this.pendingRpc.size < 4 && ++this.rpcCount <= 32;
        if (!permitted) { this.send({ type: 'rpc-result', id, error: 'Camera API request refused.' }); return; }
        let call;
        if (method === 'getPublicKey' && args.length === 2 && args[0] === this.stationSerial && args[1] === 2) {
            call = () => this.api.getPublicKey(...args);
        } else if (method === 'getCipher' && args.length === 2 && Number.isInteger(args[0]) && args[0] >= 0 && args[0] <= 65535
            && typeof this.adminUserID === 'string' && this.adminUserID.length > 0 && this.adminUserID.length <= 256 && args[1] === this.adminUserID) {
            // The SDK reads this cipher during its CMD_GATEWAYINFO handshake.
            // Only its original station owner may supply handshake key material.
            call = () => this.api.getCipher(...args);
        } else if (method === 'getVoices' && args.length === 1 && args[0] === this.deviceSerial) {
            call = () => this.api.getVoices(...args);
        } else if (method === 'request' && args.length === 1) {
            const request = args[0];
            const data = request?.data;
            if (keysAre(request, ['method', 'endpoint', 'data']) && request.method === 'post' && request.endpoint === DSK_ENDPOINT
                && keysAre(data, ['station_sns', 'invalid_dsks', 'transaction'])
                && Array.isArray(data.station_sns) && data.station_sns.length === 1 && data.station_sns[0] === this.stationSerial
                && record(data.invalid_dsks) && Object.keys(data.invalid_dsks).length === 1 && data.invalid_dsks[this.stationSerial] === ''
                && typeof data.transaction === 'string' && /^\d{10,20}$/.test(data.transaction)) {
                call = () => this.api.request(request);
            }
        }
        if (!call) { this.send({ type: 'rpc-result', id, error: 'Camera API request refused.' }); return; }
        const pending = {};
        this.pendingRpc.set(id, pending);
        const finish = (value, error) => {
            if (this.pendingRpc.get(id) !== pending) return;
            clearTimeout(pending.timer);
            this.pendingRpc.delete(id);
            if (!this.closing) this.send({ type: 'rpc-result', id, ...(error ? { error: 'Camera API request failed.' } : { value }) });
        };
        pending.timer = setTimeout(() => finish(undefined, true), this.rpcTimeoutMs);
        Promise.resolve().then(() => {
            if (this.closing || this.homeyDevice.EufyDevice !== this.device || this.homeyDevice.EufyStation !== this.station
                || this.api.isConnected() !== true) throw new Error();
            return call();
        }).then(value => {
            if (method === 'request') {
                const result = value?.data;
                value = { status: Number.isInteger(value?.status) ? value.status : 503, data: {
                    code: Number.isInteger(result?.code) ? result.code : -1,
                    data: { dsk_keys: (Array.isArray(result?.data?.dsk_keys) ? result.data.dsk_keys : [])
                        .filter(key => key?.station_sn === this.stationSerial && typeof key.dsk_key === 'string' && key.dsk_key.length <= 4096 && Number.isFinite(key.expiration)).slice(0, 1)
                        .map(key => ({ station_sn: this.stationSerial, dsk_key: key.dsk_key, expiration: key.expiration })) },
                } };
            } else if (method === 'getPublicKey') {
                if (value != null && (typeof value !== 'string' || value.length > 16384)) throw new Error();
            } else if (method === 'getCipher') {
                if (value !== undefined) {
                    if (!record(value)) throw new Error();
                    const cipher = {};
                    for (const key of ['private_key', 'ecc_private_key']) {
                        if (value[key] === undefined) continue;
                        if (typeof value[key] !== 'string' || value[key].length > 16384) throw new Error();
                        cipher[key] = value[key];
                    }
                    value = Object.keys(cipher).length ? cipher : undefined;
                }
            } else {
                value = Object.fromEntries(Object.entries(record(value) ? value : {}).slice(0, 100).flatMap(([key, voice]) =>
                    record(voice) && Number.isFinite(voice.voice_id) ? [[key, { voice_id: voice.voice_id, desc: typeof voice.desc === 'string' ? voice.desc.slice(0, 256) : '' }]] : []));
            }
            finish(value);
        }).catch(() => finish(undefined, true));
    }

    fail(message) {
        if (this.closing) return;
        const error = publicError(message);
        this.rejectStart?.(error);
        try { Promise.resolve(this.onError(error)).catch(() => {}); } catch { /* Cleanup remains owned here. */ }
        this.close().catch(() => {});
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        clearTimeout(this.startTimer);
        this.rejectStart?.(publicError('Camera startup was cancelled.'));
        for (const pending of this.pendingRpc.values()) clearTimeout(pending.timer);
        this.pendingRpc.clear();
        this.video?.destroy();
        // Run the polite shutdown once, but allow an explicit retry when Node
        // could not confirm termination. The manager keeps the reservation in
        // that case, so a rejected close must never become a permanent cache.
        if (!this.shutdownPromise) this.shutdownPromise = (async () => {
            if (!this.worker) return;
            let timer;
            const closed = new Promise(resolve => { this.resolveClosed = resolve; });
            this.send({ type: 'close' });
            try {
                await Promise.race([closed, this.exitPromise, new Promise(resolve => { timer = setTimeout(resolve, this.shutdownTimeoutMs); })]);
            } finally { clearTimeout(timer); }
        })();
        this.closePromise = (async () => {
            await this.shutdownPromise;
            if (this.worker && !this.exited) {
                let timer;
                try {
                    // Promise.race keeps handlers attached to late termination
                    // settlement. A deadline failure retains the manager's
                    // reservation and can be retried without reopening video.
                    const terminated = Promise.resolve().then(() => this.worker.terminate());
                    await Promise.race([terminated, this.exitPromise, new Promise((resolve, reject) => {
                        timer = setTimeout(() => reject(publicError('The independent camera connection could not finish closing. Retry Stop.')),
                            this.terminationTimeoutMs);
                    })]);
                }
                catch {
                    if (!this.exited) throw publicError('The independent camera connection could not finish closing. Retry Stop.');
                } finally { clearTimeout(timer); }
            }
            return { stopConfirmed: this.stopConfirmed };
        })().catch(error => {
            this.closePromise = null;
            throw error;
        });
        return this.closePromise;
    }
}

module.exports = CameraP2PSession;
