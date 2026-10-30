'use strict';

const { PassThrough } = require('node:stream');
const { wrapVideoRSAKey, isNativeVideoRSAKey } = require('./camera-native-video-rsa.helper');

const MAX_BUFFER = 2 * 1024 * 1024;
const DSK_ENDPOINT = 'v1/app/equipment/get_dsk_keys';
const TIMERS = ['connectTimeout', 'lookupTimeout', 'localLookupRetryTimeout', 'lookupRetryTimeout', 'lookup2Timeout',
    'lookup2RetryTimeout', 'heartbeatTimeout', 'keepaliveTimeout', 'esdDisconnectTimeout', 'secondaryCommandTimeout'];
const STREAM_TIMERS = ['waitForSeqNoTimeout', 'waitForAudioData', 'p2pStreamingTimeout'];
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const publicError = message => Object.assign(new Error(message), { mediaPublic: true });
const cancelled = () => publicError('Camera startup was cancelled.');
const closingError = () => publicError('The private camera connection could not finish closing. Retry Stop.');
const keysAre = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
const copy = value => JSON.parse(JSON.stringify(value, (key, item) =>
    /^(?:password|username|authorization|cookie|(?:access|refresh|cloud|auth)_?token|api_?key|token)$/i.test(key) ? undefined : item));

// Disposal below is deliberately specific to the pinned 4.2.6 transport. Its
// public close() leaves UDP open, recreates sockets on close, and omits timers.
// Only the private Station created here is ever patched or disposed.
class CameraP2POwnedSession {
    constructor({ client, homeyDevice, onStream = () => {}, onStop = () => {}, onError = () => {},
        startupTimeoutMs = 25000, shutdownTimeoutMs = 1000, disposalTimeoutMs = 2000, rpcTimeoutMs = 10000 }) {
        this.client = client;
        this.homeyDevice = homeyDevice;
        this.device = homeyDevice?.EufyDevice;
        this.originalStation = homeyDevice?.EufyStation;
        this.onStream = onStream; this.onStop = onStop; this.onError = onError;
        this.startupTimeoutMs = startupTimeoutMs; this.shutdownTimeoutMs = shutdownTimeoutMs;
        this.disposalTimeoutMs = disposalTimeoutMs; this.rpcTimeoutMs = rpcTimeoutMs;
        this.pending = new Set(); this.pendingTransport = new Set(); this.stopConfirmed = false; this.socketSendDepth = 0;
        this.videoCrypto = 'forge';
        try {
            if (require('eufy-security-client/package.json').version !== '4.2.6') throw new Error();
            this.sdk = require('eufy-security-client');
            if (typeof this.sdk.Station?.getInstance !== 'function'
                || typeof this.sdk.CommandName?.DeviceStartLivestream !== 'string'
                || typeof this.sdk.CommandName.DeviceStopLivestream !== 'string'
                || !Number.isInteger(this.sdk.VideoCodec?.H264)) throw new Error();
            this.api = client.getApi(); this.config = client.getConfig?.() || {};
            this.rawStation = copy(this.originalStation.getRawStation());
            this.serial = this.device.getSerial(); this.base = this.device.getStationSerial();
            if (typeof this.serial !== 'string' || typeof this.base !== 'string' || this.rawStation.station_sn !== this.base
                || !this.device.hasCommand(this.sdk.CommandName.DeviceStartLivestream)) throw new Error();
            this.admin = this.rawStation.member?.admin_user_id;
            this.rawDevice = copy(this.device.getRawDevice?.()
                || this.rawStation.devices?.find(device => device.device_sn === this.serial) || {});
            this.apiProxy = this.createAPI();
        } catch { throw publicError('This camera cannot create a supported private video connection.'); }
    }

    current() { return this.homeyDevice.EufyDevice === this.device && this.homeyDevice.EufyStation === this.originalStation; }

    async deadline(promise, timeout, error = closingError) {
        let timer;
        try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(error()), timeout); })]); }
        finally { clearTimeout(timer); }
    }

    apiCall(call, project = value => value) {
        if (this.closing || !this.current()) return Promise.reject(cancelled());
        return new Promise((resolve, reject) => {
            const pending = { reject };
            const finish = (value, error) => {
                if (!this.pending.delete(pending)) return;
                clearTimeout(pending.timer);
                error || this.closing || !this.current() ? reject(cancelled()) : resolve(value);
            };
            pending.timer = setTimeout(() => finish(undefined, true), this.rpcTimeoutMs);
            this.pending.add(pending);
            Promise.resolve().then(() => {
                if (this.closing || !this.current() || this.api.isConnected() !== true) throw new Error();
                return call();
            }).then(value => finish(project(value))).catch(() => finish(undefined, true));
        });
    }

    createAPI() {
        const refused = () => Promise.reject(cancelled());
        return {
            isConnected: () => !this.closing && this.current() && this.api.isConnected() === true,
            getDevices: () => this.closing ? {} : { [this.serial]: this.rawDevice },
            refreshStationData: async () => {},
            getPublicKey: (serial, kind) => serial === this.base && kind === 2 ? this.apiCall(() => this.api.getPublicKey(serial, kind), value => {
                if (value != null && (typeof value !== 'string' || value.length > 16384)) throw new Error();
                return value;
            }) : refused(),
            getCipher: (id, admin) => Number.isInteger(id) && id >= 0 && id <= 65535 && typeof this.admin === 'string'
                && this.admin.length > 0 && this.admin.length <= 256 && admin === this.admin ? this.apiCall(() => this.api.getCipher(id, admin), value => {
                    if (value === undefined) return undefined;
                    if (!record(value)) throw new Error();
                    const result = {};
                    for (const name of ['private_key', 'ecc_private_key']) {
                        if (value[name] === undefined) continue;
                        if (typeof value[name] !== 'string' || value[name].length > 16384) throw new Error();
                        result[name] = value[name];
                    }
                    return Object.keys(result).length ? result : undefined;
                }) : refused(),
            request: request => {
                const data = request?.data;
                if (!keysAre(request, ['method', 'endpoint', 'data']) || request.method !== 'post' || request.endpoint !== DSK_ENDPOINT
                    || !keysAre(data, ['station_sns', 'invalid_dsks', 'transaction'])
                    || !Array.isArray(data.station_sns) || data.station_sns.length !== 1 || data.station_sns[0] !== this.base
                    || !record(data.invalid_dsks) || Object.keys(data.invalid_dsks).length !== 1 || data.invalid_dsks[this.base] !== ''
                    || typeof data.transaction !== 'string' || !/^\d{10,20}$/.test(data.transaction)) return refused();
                return this.apiCall(() => this.api.request(request), value => ({ status: Number.isInteger(value?.status) ? value.status : 503,
                    data: { code: Number.isInteger(value?.data?.code) ? value.data.code : -1, data: {
                        dsk_keys: (Array.isArray(value?.data?.data?.dsk_keys) ? value.data.data.dsk_keys : [])
                            .filter(key => key?.station_sn === this.base && typeof key.dsk_key === 'string' && key.dsk_key.length <= 4096 && Number.isFinite(key.expiration))
                            .slice(0, 1).map(key => ({ station_sn: this.base, dsk_key: key.dsk_key, expiration: key.expiration })),
                    } } }));
            },
        };
    }

    start() {
        if (this.startPromise) return this.startPromise;
        if (this.closing) return Promise.reject(cancelled());
        this.startPromise = new Promise((resolve, reject) => { this.resolveStart = resolve; this.rejectStart = reject; });
        this.startPromise.catch(() => {});
        this.startTimer = setTimeout(() => this.fail('The camera did not deliver private video in time.'), this.startupTimeoutMs);
        this.factoryPromise = Promise.resolve().then(() => {
            if (this.closing || !this.current()) throw cancelled();
            const ip = this.config.stationIPAddresses?.[this.base];
            return this.sdk.Station.getInstance(this.apiProxy, this.rawStation, typeof ip === 'string' ? ip : undefined, 0,
                this.config.enableEmbeddedPKCS1Support === true);
        }).then(station => {
            this.station = station;
            this.guardOwnedStation();
            return station;
        });
        this.factoryPromise.finally(() => {
            // If a non-SDK factory failed to honour cancellation before a close
            // deadline, dispose its eventual private result as soon as it exists.
            if (this.closing && !this.closePromise) queueMicrotask(() => this.close().catch(() => {}));
        }).catch(() => {});
        this.startWork = this.factoryPromise.then(async station => {
            if (this.closing || !this.current()) throw cancelled();
            station.initialize(); station.setConnectionType(this.originalStation.getConnectionType());
            this.listen(station);
            await this.connect(station);
            if (this.closing || !this.current()) throw cancelled();
            this.dispatched = true;
            station.startLivestream(this.device, this.sdk.VideoCodec.H264);
        }).catch(() => { if (!this.closing) this.fail('The private camera connection could not start.'); });
        return this.startPromise;
    }

    guardOwnedStation() {
        const station = this.station, p2p = station?.p2pSession, socket = p2p?.socket;
        if (!station || station === this.originalStation || !p2p || p2p === this.originalStation.p2pSession
            || !socket || socket === this.originalStation.p2pSession?.socket) throw publicError('The private camera connection is not isolated.');
        this.p2p = p2p; this.socket = socket;
        if (!['bind', 'send', 'close', 'address', 'on', 'once', 'removeAllListeners'].every(name => typeof socket[name] === 'function')
            || !['connect', 'lookup', 'onClose', 'sendMessage', 'sendQueuedMessage', '_initialize', '_disconnected', 'close'].every(name => typeof p2p[name] === 'function')
            || ![p2p.messageStates, p2p.messageVideoStates, p2p.p2pSeqMapping].every(map => typeof map?.clear === 'function' && typeof map?.values === 'function')
            || !Array.isArray(p2p.sendQueue) || !record(p2p.currentMessageState) || !record(p2p.currentMessageBuilder)
            || ![0, 1, 2, 3].every(type => record(p2p.currentMessageState[type]))) throw publicError('The private camera SDK disposal shape is unsupported.');
        this.guarded = true;
        const videoType = this.sdk.P2PDataType?.VIDEO;
        this.nativeVideoCrypto = false;
        if (videoType === 1) {
            const applyVideoCrypto = () => {
                const state = p2p.currentMessageState[videoType];
                if (!this.closing && state) {
                    state.rsaKey = wrapVideoRSAKey(state.rsaKey);
                    this.nativeVideoCrypto = isNativeVideoRSAKey(state.rsaKey);
                    this.videoCrypto = this.nativeVideoCrypto ? 'native' : 'forge';
                }
            };
            const initializeState = p2p.initializeMessageState;
            if (typeof initializeState === 'function') p2p.initializeMessageState = (...args) => {
                const result = initializeState.apply(p2p, args);
                if (args[0] === videoType) applyVideoCrypto();
                return result;
            };
            applyVideoCrypto();
        }
        this.socketClosedPromise = new Promise(resolve => { this.resolveSocketClosed = resolve; });
        socket.on('close', () => { this.socketClosed = true; this.socketBinding = false; this.resolveSocketClosed(); });
        socket.on('listening', () => {
            this.socketBinding = false; this.socketBound = true;
            if (this.quiesced) this.requestSocketClose();
        });
        this.nativeSocketClose = socket.close.bind(socket);
        const bind = socket.bind, send = socket.send;
        socket.bind = (...args) => {
            if (this.closing) return socket;
            this.socketBindStarted = true; this.socketBinding = true;
            if (typeof args.at(-1) === 'function') {
                const callback = args.at(-1);
                args[args.length - 1] = (...values) => { if (!this.closing) callback(...values); };
            }
            try { return bind.apply(socket, args); } catch (error) { this.socketBinding = false; throw error; }
        };
        socket.send = (...args) => {
            if (this.quiesced || this.closing && this.socketSendDepth === 0) {
                const callback = args.at(-1);
                if (typeof callback === 'function') queueMicrotask(() => callback(null, 0));
                return;
            }
            return send.apply(socket, args);
        };
        const wrap = (object, name, allowed, asynchronous = false) => {
            const original = object[name];
            if (typeof original !== 'function') return;
            object[name] = (...args) => allowed(...args) ? original.apply(object, args) : asynchronous ? Promise.resolve() : undefined;
        };
        wrap(station, 'connect', () => !this.closing, true);
        wrap(station, 'onConnect', () => !this.closing);
        wrap(station, 'onDisconnect', () => !this.closing);
        wrap(station, 'onTimeout', () => !this.closing);
        station.scheduleReconnect = () => {};
        wrap(p2p, 'connect', () => !this.closing, true);
        for (const name of ['lookup', 'localLookup', 'cloudLookup', 'cloudLookup2', 'cloudLookupWithTurnServer', 'localLookupByAddress',
            'cloudLookupByAddress', 'cloudLookupByAddress2', 'cloudLookupByAddressWithTurnServer', '_connect', '_startConnectTimeout',
            'scheduleHeartbeat', 'scheduleP2PKeepalive', 'closeEnergySavingDevice', 'resendNotAcknowledgedCommand', 'waitForStreamData',
            '_initialize', '_disconnected', 'initializeStream', 'initializeMessageState', 'initializeMessageBuilder']) wrap(p2p, name, () => !this.closing);
        for (const name of ['sendQueuedMessage', 'sendCommand', '_sendCommand']) wrap(p2p, name, () => !this.closing || this.allowStop, name === '_sendCommand');
        for (const name of ['handleMsg', 'handleData']) wrap(p2p, name, () => !this.quiesced);
        const sendMessage = p2p.sendMessage;
        p2p.sendMessage = (...args) => {
            const end = this.sdk.RequestMessageType?.END;
            const isEnd = Buffer.isBuffer(end) && Buffer.isBuffer(args[2]) && end.equals(args[2]);
            if (this.quiesced || this.closing && !this.allowStop && !isEnd) return Promise.resolve();
            this.socketSendDepth++;
            try {
                const work = Promise.resolve(sendMessage.apply(p2p, args));
                this.pendingTransport.add(work);
                work.then(() => this.pendingTransport.delete(work), () => this.pendingTransport.delete(work));
                return work;
            } finally { this.socketSendDepth--; }
        };
        const close = p2p.close;
        p2p.close = (...args) => {
            const result = close.apply(p2p, args);
            this.privateCloseWork = Promise.resolve(result); this.privateCloseWork.catch(() => {});
            return result;
        };
        p2p.onClose = () => {
            p2p.connected = false; p2p.connecting = false; p2p.binded = false;
            if (!this.closing) this.fail('The private camera connection ended.');
        };
    }

    listen(station) {
        station.on('livestream start', (source, channel, info, video, audio) => {
            if (source !== station) return;
            if (this.closing || channel !== this.device.getChannel() || this.input) { video?.destroy(); audio?.destroy(); return; }
            if (!this.current()) { video?.destroy(); audio?.destroy(); this.fail('Camera startup was cancelled.'); return; }
            this.input = video; this.audio = audio;
            this.output = new PassThrough({ highWaterMark: 256 * 1024 });
            this.output.on('error', () => this.fail('The private camera video failed.'));
            this.output.on('close', () => { if (!this.closing) this.close().catch(() => {}); });
            video.on('error', () => this.fail('The private camera video failed.'));
            audio?.on('error', () => {}); audio?.resume();
            video.on('data', chunk => {
                if (this.closing) return;
                if (!Buffer.isBuffer(chunk) || this.output.readableLength + this.output.writableLength + chunk.length > MAX_BUFFER) {
                    this.fail('The private camera video consumer could not keep up.'); return;
                }
                this.output.write(chunk);
            });
            video.on('end', () => this.stopped());
            const metadata = {};
            for (const key of ['videoCodec', 'videoFPS', 'videoHeight', 'videoWidth', 'audioCodec']) {
                if (typeof info?.[key] === 'number' && Number.isFinite(info[key])) metadata[key] = info[key];
            }
            try {
                Promise.resolve(this.onStream(this.output, null, metadata)).then(() => {
                    if (!this.closing) { clearTimeout(this.startTimer); this.resolveStart(); }
                }).catch(() => this.fail('The private camera video could not be attached.'));
            } catch { this.fail('The private camera video could not be attached.'); }
        });
        station.on('livestream stop', (source, channel) => { if (source === station && channel === this.device.getChannel()) this.stopped(); });
        station.on('livestream error', (source, channel) => { if (source === station && channel === this.device.getChannel()) this.fail('The private camera video failed.'); });
        station.on('connection error', source => { if (source === station) this.fail('The private camera connection failed.'); });
        station.on('close', source => { if (source === station) this.stopped(); });
        station.on('command result', (source, result) => {
            if (source !== station || result?.channel !== this.device.getChannel()) return;
            const name = result.customData?.command?.name;
            if (this.closing && name === this.sdk.CommandName.DeviceStopLivestream && result.return_code === 0) {
                this.stopConfirmed = true; this.finishStop?.();
            } else if (!this.closing && name === this.sdk.CommandName.DeviceStartLivestream && result.return_code !== 0) this.fail('The camera refused its private video request.');
        });
    }

    connect(station) {
        return new Promise((resolve, reject) => {
            const cleanup = () => { station.removeListener('connect', ready); station.removeListener('connection error', failed); station.removeListener('close', failed); this.cancelConnect = null; };
            const ready = source => { if (source !== station) return; cleanup(); this.closing || !this.current() ? reject(cancelled()) : resolve(); };
            const failed = source => { if (source !== undefined && source !== station) return; cleanup(); reject(cancelled()); };
            this.cancelConnect = failed;
            station.on('connect', ready); station.once('connection error', failed); station.once('close', failed);
            this.connectWork = Promise.resolve().then(() => { if (!this.closing) return station.connect(); });
            this.connectWork.catch(() => failed());
        });
    }

    stopped() {
        if (this.closing) return;
        try { Promise.resolve(this.onStop()).catch(() => {}); } catch { /* Own disposal still runs. */ }
        this.close().catch(() => {});
    }

    fail(message) {
        if (this.closing) return;
        const error = publicError(message); this.rejectStart?.(error);
        try { Promise.resolve(this.onError(error)).catch(() => {}); } catch { /* Own disposal still runs. */ }
        this.close().catch(() => {});
    }

    async politeClose() {
        const station = this.station;
        if (!this.guarded || this.socketClosed) return;
        if (this.dispatched && station.isConnected()) {
            let timer;
            const stopped = new Promise(resolve => { this.finishStop = resolve; timer = setTimeout(resolve, Math.min(700, this.shutdownTimeoutMs)); });
            try {
                this.allowStop = true;
                try { station.stopLivestream(this.device); } finally { this.allowStop = false; }
                await stopped;
            } catch { /* END and forced disposal remain required. */ }
            finally { this.finishStop = null; clearTimeout(timer); }
        }
        station.terminating = true;
        try { station.close(); } catch { /* The owned socket is still disposed below. */ }
        if (this.privateCloseWork) await this.deadline(this.privateCloseWork, this.shutdownTimeoutMs).catch(() => {});
    }

    clearResources() {
        const station = this.station, p2p = this.p2p;
        station.terminating = true; p2p.terminating = true;
        const clear = (object, key) => { clearTimeout(object[key]); object[key] = undefined; };
        clear(station, 'reconnectTimeout');
        for (const timeout of station.eventTimeouts?.values?.() || []) clearTimeout(timeout);
        station.eventTimeouts?.clear?.();
        for (const key of TIMERS) clear(p2p, key);
        for (const map of [p2p.messageStates, p2p.messageVideoStates]) {
            for (const message of map.values()) { clear(message, 'timeout'); clear(message, 'retryTimeout'); }
            map.clear();
        }
        for (const state of Object.values(p2p.currentMessageState)) {
            for (const key of STREAM_TIMERS) clear(state, key);
            state.videoStream?.destroy(); state.audioStream?.destroy(); state.videoStream = null; state.audioStream = null;
            state.queuedData?.clear?.(); state.leftoverData = Buffer.alloc(0); state.preFrameVideoData = Buffer.alloc(0);
            state.p2pStreaming = false; state.rsaKey = null; state.rtspStream = {}; state.rtspStreaming = {};
        }
        for (const builder of Object.values(p2p.currentMessageBuilder)) { builder.messages = {}; builder.bytesRead = 0; }
        p2p.talkbackStream?.destroy(); p2p.talkbackStream = null;
        p2p.sendQueue.length = 0; p2p.p2pSeqMapping.clear(); p2p.lockAESKeys?.clear?.();
        p2p.customDataStaging = {}; p2p.connectAddress = undefined; p2p.p2pKey = undefined;
        p2p.connected = false; p2p.connecting = false;
        this.output?.destroy(); this.input?.destroy(); this.audio?.destroy();
        station.removeAllListeners(); p2p.removeAllListeners();
        this.socket.removeAllListeners('message'); this.socket.removeAllListeners('error'); this.socket.on('error', () => {});
    }

    requestSocketClose() {
        if (this.socketClosed || this.socketCloseRequested) return;
        try { this.nativeSocketClose(); this.socketCloseRequested = true; }
        catch (error) {
            if (error?.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING' && !this.socketBindStarted) {
                this.socketClosed = true; this.resolveSocketClosed();
            }
            // A bind already in progress must produce close/listening proof;
            // its late callback is guarded and the listening listener retries.
        }
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closing = true; clearTimeout(this.startTimer); this.rejectStart?.(cancelled()); this.cancelConnect?.();
        for (const pending of this.pending) { clearTimeout(pending.timer); pending.reject(cancelled()); }
        this.pending.clear();
        this.closePromise = (async () => {
            if (this.factoryPromise) await this.deadline(this.factoryPromise.catch(() => {}), this.disposalTimeoutMs);
            if (!this.station) return { stopConfirmed: false };
            if (!this.guarded) throw closingError();
            if (!this.politeWork) this.politeWork = this.politeClose();
            await this.politeWork;
            this.quiesced = true;
            this.clearResources(); this.requestSocketClose();
            await this.deadline(this.socketClosedPromise, this.disposalTimeoutMs);
            if (this.connectWork) await this.deadline(this.connectWork.catch(() => {}), this.disposalTimeoutMs);
            await this.deadline(Promise.allSettled([...this.pendingTransport]), this.disposalTimeoutMs);
            this.clearResources();
            return { stopConfirmed: this.stopConfirmed };
        })().catch(() => { this.closePromise = null; throw closingError(); });
        return this.closePromise;
    }
}

module.exports = CameraP2POwnedSession;
