'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const OWNER = 'com.eufylife.security';
const SDK = '4.2.6';
const VERSION = '0.2.3';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/;
const BODY_LIMIT = 512 * 1024;
const EVENT_LIMIT = 64 * 1024;
const DIAGNOSTIC_LIMIT = 64;
const DIAGNOSTIC_WINDOW_MS = 60000;
const DIAGNOSTICS = Object.freeze({
    'source.starting': 'A camera source is starting.',
    'source.ready': 'A camera source delivered video.',
    'source.start_timeout': 'A camera source did not deliver video before its startup deadline.',
    'source.failed': 'A camera source could not become ready.',
    'source.closed': 'Camera source resources were closed.',
    'source.close_failed': 'Camera source cleanup is unconfirmed; its capacity remains reserved.',
    'p2p.starting': 'An independent P2P connection is starting.',
    'p2p.device_create': 'The independent camera is being prepared.',
    'p2p.device_init': 'The independent camera is being initialized.',
    'p2p.station_create': 'The independent camera station is being prepared.',
    'p2p.station_init': 'The independent camera station is being initialized.',
    'p2p.connecting': 'The independent camera is connecting to its station.',
    'p2p.start_video': 'The independent camera is requesting video.',
    'p2p.receiving_video': 'The independent camera produced its first video bytes.',
    'p2p.codec_h264_to_hevc': 'The T8423 video input was identified as HEVC instead of declared H.264.',
    'p2p.codec_hevc_to_h264': 'The T8423 video input was identified as H.264 instead of declared HEVC.',
    'p2p.failed': 'An independent P2P connection failed.',
    'p2p.ended': 'An independent P2P connection ended.',
    'media.failed': 'A camera media process failed.',
    'media.ended': 'A camera media process ended.',
    'media.input_bytes': 'The camera media process received its first video input bytes.',
    'media.input_0': 'The startup deadline expired with no parent video input bytes.',
    'media.input_under_32kib': 'The startup deadline expired with less than 32 KiB of parent video input.',
    'media.input_under_256kib': 'The startup deadline expired with at least 32 KiB and less than 256 KiB of parent video input.',
    'media.input_at_least_256kib': 'The startup deadline expired with at least 256 KiB of parent video input.',
    'media.started': 'The camera media process was requested.',
    'media.codec_missing_parameter_sets': 'The camera media input is missing required codec parameter sets.',
    'media.invalid_bitstream': 'The camera media input could not be decoded as the selected video format.',
    'media.no_streams': 'The camera media process could not find a usable video stream.',
    'lease.cancelled': 'A camera lease was cancelled by its owner.',
    'lease.replaced': 'A camera lease was revoked by a newer app connection.',
    'lease.expired': 'A camera lease expired without renewal.',
    'lease.idle': 'An unused camera lease was retired after its source resources closed.',
    'capacity.sources': 'The configured stream limit prevented another camera source.',
    'capacity.requests': 'The bounded camera-request registry is full.',
    'capacity.rpc': 'The pending camera API request limit was reached.',
    'capacity.rpc_rate': 'The camera API request rate limit was reached.',
    'rpc.refused': 'A camera API request was outside the permitted scope.',
    'rpc.timeout': 'A camera API request did not receive a reply before its deadline.',
    'rpc.failed': 'The app reported that a permitted camera API request failed.',
    'helper.stopping': 'The camera helper is stopping and closing its sources.',
    'diagnostics.suppressed': 'Further helper diagnostics are suppressed until the next minute.',
});
const P2P_PHASE_EVENTS = Object.freeze({
    'device-create': 'p2p.device_create',
    'device-init': 'p2p.device_init',
    'station-create': 'p2p.station_create',
    'station-init': 'p2p.station_init',
    connect: 'p2p.connecting',
    start: 'p2p.start_video',
    stream: 'p2p.receiving_video',
});
const MEDIA_STDERR_CATEGORIES = Object.freeze([
    ['media.codec_missing_parameter_sets', /(?:non-existing\s+(?:PPS|SPS|VPS)|(?:PPS|SPS|VPS)[^\r\n]{0,100}(?:unavailable|missing|out of range|does not exist)|missing\s+(?:PPS|SPS|VPS))/i],
    ['media.invalid_bitstream', /(?:invalid (?:NAL unit|data found|bitstream)|error (?:while )?decoding|could not find codec parameters)/i],
    ['media.no_streams', /(?:does not contain any stream|stream map[^\r\n]{0,256}matches no streams|no (?:video )?streams? found|could not find (?:any )?streams)/i],
]);
const START_TIMEOUT_MESSAGES = new Set([
    'The camera did not deliver independent video in time.',
    'The camera did not deliver video in time. Check its connection and retry.',
]);
const CAMERA_CLASSES = new Set(['Camera', 'SoloCamera', 'IndoorCamera', 'DoorbellCamera', 'WiredDoorbellCamera',
    'BatteryDoorbellCamera', 'FloodlightCamera', 'WallLightCam', 'GarageCamera', 'DoorbellLock', 'SmartDrop']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = value => typeof value === 'string' && IDENTITY.test(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const fixedError = () => new Error('The camera helper request could not be completed.');

class HTTPError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function validateMetadata(value) {
    const fail = () => { throw new HTTPError(400, 'Invalid camera metadata.'); };
    if (!keys(value, ['rawStation', 'rawDevice', 'deviceConstructor', 'connectionType', 'ipAddress', 'config', 'connected'])
        || !object(value.rawStation) || !object(value.rawDevice) || !CAMERA_CLASSES.has(value.deviceConstructor)
        || ![0, 1, 2].includes(value.connectionType) || value.connected !== true
        || !identity(value.rawStation.station_sn) || !identity(value.rawDevice.device_sn)
        || value.rawDevice.station_sn !== value.rawStation.station_sn
        || !Number.isInteger(value.rawDevice.device_channel) || value.rawDevice.device_channel < 0 || value.rawDevice.device_channel > 65535
        || !Number.isInteger(value.rawDevice.device_type) || value.rawDevice.device_type < 0
        || typeof value.rawStation.member?.admin_user_id !== 'string' || !value.rawStation.member.admin_user_id.length
        || value.rawStation.member.admin_user_id.length > 256
        || !keys(value.config, ['deviceConfig', 'enableEmbeddedPKCS1Support'])
        || !keys(value.config.deviceConfig, ['simultaneousDetections'])
        || value.config.deviceConfig.simultaneousDetections !== undefined && typeof value.config.deviceConfig.simultaneousDetections !== 'boolean'
        || typeof value.config.enableEmbeddedPKCS1Support !== 'boolean'
        || value.ipAddress !== undefined && (typeof value.ipAddress !== 'string' || net.isIP(value.ipAddress) !== 4)) fail();
    const visit = (item, depth = 0) => {
        if (depth > 32) fail();
        if (!item || typeof item !== 'object') return;
        for (const [name, child] of Object.entries(item)) {
            if (/^(?:__proto__|constructor|prototype|password|username|authorization|cookie|(?:access|refresh|cloud|auth)_?token|api_?key|token)$/i.test(name)) fail();
            visit(child, depth + 1);
        }
    };
    visit(value);
    return JSON.parse(JSON.stringify(value));
}

function validRPC(metadata, method, args) {
    if (!Array.isArray(args)) return false;
    const base = metadata.rawStation.station_sn, device = metadata.rawDevice.device_sn;
    if (method === 'getPublicKey') return args.length === 2 && args[0] === base && args[1] === 2;
    if (method === 'getCipher') return args.length === 2 && Number.isInteger(args[0]) && args[0] >= 0 && args[0] <= 65535
        && args[1] === metadata.rawStation.member.admin_user_id;
    if (method === 'getVoices') return args.length === 1 && args[0] === device;
    if (method !== 'request' || args.length !== 1) return false;
    const request = args[0], data = request?.data;
    return keys(request, ['method', 'endpoint', 'data']) && request.method === 'post' && request.endpoint === 'v1/app/equipment/get_dsk_keys'
        && keys(data, ['invalid_dsks', 'station_sns', 'transaction']) && object(data.invalid_dsks)
        && Object.keys(data.invalid_dsks).length === 1 && data.invalid_dsks[base] === ''
        && Array.isArray(data.station_sns) && data.station_sns.length === 1 && data.station_sns[0] === base
        && typeof data.transaction === 'string' && /^\d{10,20}$/.test(data.transaction);
}

function runtime() {
    if (require('eufy-security-client/package.json').version !== SDK) throw fixedError();
    return { sdk: require('eufy-security-client'), ManagerClass: require('../lib/helpers/camera-media.helper'),
        WorkerSessionClass: require('../lib/helpers/camera-p2p-session.helper') };
}

class HelperServer {
    constructor(options = {}) {
        this.secret = Buffer.isBuffer(options.secret) ? options.secret.toString('utf8').trim() : String(options.secret || '').trim();
        if (!/^[a-f0-9]{64}$/.test(this.secret)) throw new Error('A valid camera helper secret is required.');
        this.host = options.host || '127.0.0.1'; this.port = options.port ?? 8769;
        if (this.host !== '127.0.0.1' || !Number.isInteger(this.port) || this.port < 0 || this.port > 65535) throw new Error('Invalid camera helper address.');
        this.now = options.now || Date.now; this.leaseMs = options.leaseMs ?? 75000;
        this.writeDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : entry => console.log(JSON.stringify(entry));
        this.diagnosticWindow = this.now(); this.diagnosticCount = 0; this.diagnosticSuppressed = false;
        this.observedSources = new WeakSet();
        this.startTimeoutMs = options.startTimeoutMs ?? 25000; this.rpcTimeoutMs = options.rpcTimeoutMs ?? 10000;
        this.idleGraceMs = options.idleGraceMs ?? 5000; this.firstViewerMs = options.firstViewerMs ?? 75000;
        this.closeTimeoutMs = options.closeTimeoutMs ?? 5000;
        this.defaultMaxSessions = options.maxSessions === undefined ? 4 : options.maxSessions;
        if (this.defaultMaxSessions !== null && (!Number.isSafeInteger(this.defaultMaxSessions) || this.defaultMaxSessions < 1)) throw new Error('Invalid camera stream limit.');
        this.maxSessions = this.defaultMaxSessions;
        this.requestTtlMs = options.requestTtlMs ?? 120000; this.maxRequests = options.maxRequests || 128;
        for (const [value, maximum] of [[this.maxRequests, 128], [this.leaseMs, 75000],
            [this.startTimeoutMs, 25000], [this.rpcTimeoutMs, 10000], [this.closeTimeoutMs, 5000], [this.requestTtlMs, 120000],
            [this.idleGraceMs, 5000], [this.firstViewerMs, 75000]]) {
            if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('Invalid camera helper limits.');
        }
        this.mediaDir = options.mediaDir || path.join(os.tmpdir(), `eufy-media-${process.pid}`);
        if (!path.isAbsolute(this.mediaDir)) throw new Error('The media cache must use an absolute path.');
        this.instance = crypto.randomUUID(); this.records = new Map(); this.cameras = new Map(); this.capabilities = new Map();
        this.requests = new Map(); this.owners = new Map(); this.context = new AsyncLocalStorage(); this.mutations = Promise.resolve();
        // Indexed entries remain owned by the existing bounded request registry.
        this.idleRetired = new Map();
        this.activeSockets = new Set(); this.runtime = options.runtime || runtime();
        const homey = this.homey = new EventEmitter();
        homey.platformVersion = 2; homey.settings = { get: name => name === 'camera_isolated_p2p_devices' ? true : undefined };
        this.globalClient = new EventEmitter(); this.globalClient.isConnected = () => true;
        homey.app = { eufyClient: this.globalClient, log() {}, warn() {}, error() {} };
        const managerOptions = { userdata: this.mediaDir, getStreamLimit: () => this.maxSessions, startTimeoutMs: this.startTimeoutMs,
            resolveBinary: async () => options.ffmpeg || '/usr/bin/ffmpeg',
            createP2PSession: params => {
                const record = params.homeyDevice.helperRecord;
                record.sourceFailureReported = false;
                record.p2pPhase = null;
                const input = record.mediaInput = { bytes: 0 };
                this.diagnostic('p2p.starting');
                const configured = { ...params, client: params.homeyDevice.rpcClient,
                    onCodecCorrection: (...args) => {
                        if (args.length !== 2 || ![0, 1].includes(args[0]) || ![0, 1].includes(args[1]) || args[0] === args[1]
                            || !this.current(record) || record.sourceFailureReported || record.codecCorrectionReported) return;
                        record.codecCorrectionReported = true;
                        this.diagnostic(args[0] === 0 ? 'p2p.codec_h264_to_hevc' : 'p2p.codec_hevc_to_h264');
                    },
                    onPhase: phase => {
                        if (!this.current(record) || record.sourceFailureReported || typeof phase !== 'string'
                            || !Object.hasOwn(P2P_PHASE_EVENTS, phase) || record.p2pPhase === phase) return;
                        record.p2pPhase = phase;
                        this.diagnostic(P2P_PHASE_EVENTS[phase]);
                    },
                    onStream: (...args) => this.context.run(record, () => {
                        this.observeSource(record, this.manager.sessions?.get(record.serial));
                        this.observeMediaInput(record, args[0], input);
                        return params.onStream(...args);
                    }),
                    onStop: (...args) => this.context.run(record, () => {
                        if (this.current(record)) { record.sourceFailureReported = true; this.diagnostic('p2p.ended'); }
                        return params.onStop(...args);
                    }),
                    onError: error => this.context.run(record, () => {
                        this.sourceFailure(record, error, 'p2p.failed');
                        return params.onError(error);
                    }) };
                try { return options.createP2PSession ? options.createP2PSession(configured) : new this.runtime.WorkerSessionClass(configured); }
                catch (error) { this.sourceFailure(record, error, 'p2p.failed'); throw error; }
            },
            spawn: (...args) => {
                const proc = (options.spawn || spawn)(...args), record = this.context.getStore();
                if (record) {
                    record.processes.add(proc); proc.once('close', () => record.processes.delete(proc));
                    if (this.current(record) && !record.mediaStartedReported && Array.isArray(args[1]) && args[1].includes('-mpegts_flags')) {
                        record.mediaStartedReported = true; this.diagnostic('media.started');
                    }
                    this.observeMediaStderr(record, proc);
                    proc.once('error', () => { record.processes.delete(proc); if (this.current(record)) this.diagnostic('media.failed'); });
                    proc.once('exit', code => {
                        if (this.current(record) && this.manager.sessions?.get(record.serial)?.process === proc) this.diagnostic(code === 0 ? 'media.ended' : 'media.failed');
                    });
                }
                return proc;
            } };
        this.manager = options.managerFactory ? options.managerFactory(homey, managerOptions) : new this.runtime.ManagerClass(homey, managerOptions);
        homey.app.FfmpegManager = this.manager;
        this.server = http.createServer((request, response) => {
            this.route(request, response).catch(error => {
                if (response.headersSent) { response.destroy(); return; }
                this.json(response, error instanceof HTTPError ? error.status : 503,
                    { error: error instanceof HTTPError ? error.message : 'The camera helper could not complete the request.' });
            });
        });
        this.server.requestTimeout = 30000; this.server.headersTimeout = 10000; this.server.keepAliveTimeout = 5000;
        this.server.maxConnections = 64;
        this.server.on('connection', socket => { this.activeSockets.add(socket); socket.once('close', () => this.activeSockets.delete(socket)); });
    }

    // Only compile-time categories and messages cross this boundary. Never pass
    // SDK errors, request objects, identifiers or media addresses to the sink.
    diagnostic(event) {
        if (!Object.hasOwn(DIAGNOSTICS, event) || event === 'diagnostics.suppressed') return;
        if (this.now() - this.diagnosticWindow >= DIAGNOSTIC_WINDOW_MS) {
            this.diagnosticWindow = this.now(); this.diagnosticCount = 0; this.diagnosticSuppressed = false;
        }
        let category = event;
        if (this.diagnosticCount >= DIAGNOSTIC_LIMIT) {
            if (this.diagnosticSuppressed) return;
            this.diagnosticSuppressed = true; category = 'diagnostics.suppressed';
        } else this.diagnosticCount++;
        try {
            const written = this.writeDiagnostic(Object.freeze({ event: category, message: DIAGNOSTICS[category] }));
            written?.catch?.(() => {});
        } catch { /* Diagnostics must not interrupt video or resource cleanup. */ }
    }

    observeMediaStderr(record, proc) {
        if (typeof proc.stderr?.on !== 'function') return;
        // The fixed-size buffer is scanned only for known error classes. It is
        // never logged or returned: FFmpeg text can contain private input URLs.
        const buffer = Buffer.alloc(8192);
        let length = 0;
        const inspect = chunk => {
            if (!this.current(record) || !Buffer.isBuffer(chunk)) { length = 0; return; }
            for (let offset = 0; offset < chunk.length; offset += 4096) {
                if (!this.current(record)) { length = 0; return; }
                const piece = chunk.subarray(offset, offset + 4096);
                const keep = Math.min(length, buffer.length - piece.length);
                buffer.copy(buffer, 0, length - keep, length);
                piece.copy(buffer, keep); length = keep + piece.length;
                const text = buffer.toString('utf8', 0, length);
                for (const [category, pattern] of MEDIA_STDERR_CATEGORIES) {
                    if (record.mediaDiagnostics?.has(category) || !pattern.test(text) || !this.current(record)) continue;
                    record.mediaDiagnostics ||= new Set(); record.mediaDiagnostics.add(category);
                    this.diagnostic(category);
                }
            }
        };
        proc.stderr.on('data', inspect);
        proc.once('close', () => { proc.stderr.removeListener('data', inspect); buffer.fill(0); length = 0; });
    }

    observeMediaInput(record, video, input) {
        if (typeof video?.on !== 'function') return;
        const inspect = chunk => {
            if (!this.current(record) || record.sourceFailureReported || record.mediaInput !== input
                || !Buffer.isBuffer(chunk) || !chunk.length) return;
            input.bytes += Math.min(chunk.length, Number.MAX_SAFE_INTEGER - input.bytes);
            if (!record.mediaInputReported) {
                record.mediaInputReported = true;
                this.diagnostic('media.input_bytes');
            }
        };
        video.on('data', inspect);
        video.once('close', () => video.removeListener('data', inspect));
    }

    startFailure(error, fallback = 'source.failed') {
        return error?.mediaPublic === true && START_TIMEOUT_MESSAGES.has(error.message) ? 'source.start_timeout' : fallback;
    }

    sourceFailure(record, error, fallback) {
        if (!this.current(record) || record.sourceFailureReported) return;
        record.sourceFailureReported = true;
        const failure = this.startFailure(error, fallback);
        if (failure === 'source.start_timeout') {
            const bytes = record.mediaInput?.bytes || 0;
            this.diagnostic(bytes === 0 ? 'media.input_0' : bytes < 32768 ? 'media.input_under_32kib'
                : bytes < 262144 ? 'media.input_under_256kib' : 'media.input_at_least_256kib');
        }
        this.diagnostic(failure);
    }

    observeSource(record, session) {
        if (!session || this.observedSources.has(session)) return;
        this.observedSources.add(session);
        session.ready.promise.then(() => {
            if (this.current(record)) this.diagnostic('source.ready');
        }, error => {
            this.sourceFailure(record, error);
        });
    }

    async listen() {
        await fs.mkdir(this.mediaDir, { recursive: true, mode: 0o700 });
        await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, resolve); });
        this.origin = `http://127.0.0.1:${this.server.address().port}`;
        this.pruneTimer = setInterval(() => this.prune().catch(() => {}), 5000); this.pruneTimer.unref?.();
        return { address: this.host, port: this.server.address().port };
    }

    json(response, status, body) {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(JSON.stringify(body));
    }

    authenticated(request) {
        const supplied = request.headers.authorization;
        if (typeof supplied !== 'string' || !/^Bearer [a-f0-9]{64}$/.test(supplied)) return false;
        return crypto.timingSafeEqual(Buffer.from(supplied.slice(7)), Buffer.from(this.secret));
    }

    async body(request) {
        if (request.headers['content-encoding'] || Number(request.headers['content-length']) > BODY_LIMIT) throw new HTTPError(413, 'The request is too large.');
        const chunks = []; let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > BODY_LIMIT) throw new HTTPError(413, 'The request is too large.');
            chunks.push(chunk);
        }
        if (!size) return {};
        try { const result = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!object(result)) throw new Error(); return result; }
        catch { throw new HTTPError(400, 'Invalid JSON request.'); }
    }

    mutate(work) {
        const result = this.mutations.then(() => { if (this.closed) throw new HTTPError(503, 'The camera helper is shutting down.'); return work(); });
        this.mutations = result.catch(() => {}); return result;
    }

    binding(value) {
        if (value?.owner !== OWNER || !UUID.test(value.epoch) || value.deviceId !== undefined && !UUID.test(value.deviceId)) throw new HTTPError(400, 'Invalid camera owner.');
        return `${value.owner}\0${value.deviceId || ''}`;
    }

    current(record) { return !this.closed && !record.closing && this.owners.get(record.owner) === record.epoch && record.expiresAt > this.now(); }

    record(id, allowClosing = false) {
        this.trimRequests();
        const record = this.records.get(id);
        if (!record) {
            if (this.idleRetired.has(id)) throw new HTTPError(410, 'The unused camera lease was retired. Open the camera again.');
            throw new HTTPError(404, 'Camera session not found.');
        }
        if (!allowClosing && !this.current(record)) throw new HTTPError(409, 'The camera session is no longer current.');
        return record;
    }

    trimRequests() {
        for (const [id, entry] of this.requests) if (entry.expiresAt <= this.now() && !entry.record) {
            this.requests.delete(id);
            if (entry.idleRetiredId && this.idleRetired.get(entry.idleRetiredId) === entry) this.idleRetired.delete(entry.idleRetiredId);
        }
    }

    async activeRecord(id) {
        const record = this.records.get(id);
        if (record?.idleRetiring) {
            // Do not expose a recoverable 404/409 while source cleanup is still
            // pending. Only a confirmed close authorizes client-side retirement.
            try { if (!record.closePromise) throw fixedError(); await record.closePromise; }
            catch { throw new HTTPError(503, 'Camera source cleanup is not yet confirmed.'); }
        }
        return this.record(id);
    }

    idleDue(record) {
        if (record.closing || record.viewers.size || record.snapshots) return false;
        const deadline = record.hasViewer ? record.idleSince + this.idleGraceMs : record.startedAt + this.firstViewerMs;
        return this.now() >= deadline;
    }

    scheduleIdle(record) {
        clearTimeout(record.idleTimer); record.idleTimer = null;
        if (!this.current(record) || record.viewers.size || record.snapshots) return;
        const deadline = record.hasViewer ? record.idleSince + this.idleGraceMs : record.startedAt + this.firstViewerMs;
        record.idleTimer = setTimeout(() => {
            record.idleTimer = null;
            this.mutate(() => this.retireIdle(record)).catch(() => {});
        }, Math.max(0, deadline - this.now()));
        record.idleTimer.unref?.();
    }

    async retireIdle(record) {
        if (this.records.get(record.id) !== record) return false;
        if (!record.idleRetiring && !this.idleDue(record)) { this.scheduleIdle(record); return false; }
        record.idleRetiring = true;
        await this.closeRecord(record);
        return true;
    }

    trackViewer(record, response) {
        clearTimeout(record.idleTimer); record.idleTimer = null;
        record.hasViewer = true; record.viewers.add(response);
        const release = () => {
            if (!record.viewers.delete(response)) return;
            if (!record.viewers.size) record.idleSince = this.now();
            this.scheduleIdle(record);
        };
        response.once('close', release); response.once('finish', release);
    }

    requestBinding(requestId, binding) {
        this.trimRequests();
        let entry = this.requests.get(requestId);
        if (entry && (entry.owner !== binding.owner || entry.epoch !== binding.epoch || entry.deviceId !== binding.deviceId)) throw new HTTPError(409, 'The camera request belongs to another session.');
        if (!entry) {
            if ([...this.requests.values()].filter(entry => !entry.record).length >= this.maxRequests) {
                this.diagnostic('capacity.requests'); throw new HTTPError(429, 'Too many camera requests. Retry later.');
            }
            entry = { owner: binding.owner, epoch: binding.epoch, deviceId: binding.deviceId, requestId,
                expiresAt: this.now() + this.requestTtlMs };
            this.requests.set(requestId, entry);
        }
        return entry;
    }

    async connect(body) {
        if (!keys(body, ['owner', 'epoch', 'protocol', 'sdk']) || body.protocol !== 1 || body.sdk !== SDK) throw new HTTPError(409, 'The camera helper protocol is incompatible.');
        this.binding(body);
        if (this.owners.get(body.owner) !== body.epoch) this.maxSessions = this.defaultMaxSessions;
        this.owners.set(body.owner, body.epoch);
        const stopped = await Promise.allSettled([...this.records.values()].filter(record => record.owner === body.owner && record.epoch !== body.epoch)
            .map(record => { this.diagnostic('lease.replaced'); return this.closeRecord(record); }));
        if (stopped.some(result => result.status === 'rejected')) throw fixedError();
        return { protocol: 1, version: VERSION, sdk: SDK, instance: this.instance, owner: body.owner, epoch: body.epoch };
    }

    setStreamLimit(body) {
        if (!keys(body, ['owner', 'epoch', 'maxStreams']) || body.maxStreams !== null
            && (!Number.isSafeInteger(body.maxStreams) || body.maxStreams < 1)) throw new HTTPError(400, 'Invalid camera stream limit.');
        this.binding(body);
        if (this.owners.get(body.owner) !== body.epoch) throw new HTTPError(409, 'Connect the camera owner first.');
        this.maxSessions = body.maxStreams;
        return { maxStreams: this.maxSessions };
    }

    makeDevice(record) {
        const metadata = record.metadata, sdk = this.runtime.sdk;
        const api = { isConnected: () => this.current(record) };
        for (const method of ['getPublicKey', 'getCipher', 'getVoices', 'request']) api[method] = (...args) => this.rpc(record, method, args);
        const device = { getRawDevice: () => metadata.rawDevice, getSerial: () => record.serial,
            getStationSerial: () => metadata.rawStation.station_sn, getChannel: () => metadata.rawDevice.device_channel,
            hasCommand: name => name === sdk.CommandName.DeviceStartLivestream || name === sdk.CommandName.DeviceStopLivestream,
            hasProperty: name => name === sdk.PropertyName.DeviceEnabled, getPropertyValue: () => this.current(record),
            hasBattery: () => false, isRTSPStreamEnabled: () => false };
        Object.defineProperty(device, 'constructor', { value: { name: metadata.deviceConstructor } });
        const station = new EventEmitter(); station.getRawStation = () => metadata.rawStation; station.getConnectionType = () => metadata.connectionType;
        const hd = { EufyDevice: device, EufyStation: station, _started: true, helperRecord: record,
            getId: () => record.deviceId, getName: () => 'Camera', updateImage: async () => {},
            rpcClient: { getApi: () => api, getConfig: () => ({ ...metadata.config,
                ...(metadata.ipAddress ? { stationIPAddresses: { [metadata.rawStation.station_sn]: metadata.ipAddress } } : {}) }) } };
        return hd;
    }

    async createSession(body) {
        if (!keys(body, ['owner', 'epoch', 'deviceId', 'requestId', 'metadata']) || !UUID.test(body.deviceId) || !UUID.test(body.requestId)) throw new HTTPError(400, 'Invalid camera request.');
        const cameraKey = this.binding(body);
        if (this.owners.get(body.owner) !== body.epoch) throw new HTTPError(409, 'Connect the camera owner first.');
        const metadata = validateMetadata(body.metadata), entry = this.requestBinding(body.requestId, body);
        if (entry.cancelled) throw new HTTPError(409, 'The camera request was cancelled.');
        if (entry.record) return { id: entry.record.id, mediaUrl: entry.record.mediaUrl };
        if (this.cameras.has(cameraKey)) throw new HTTPError(409, 'This camera already has an active request.');
        if (this.maxSessions !== null && this.records.size >= this.maxSessions) { this.diagnostic('capacity.sources'); throw new HTTPError(429, 'The configured camera stream limit has been reached. Stop a stream or change the limit.'); }
        if ([...this.records.values()].some(record => record.serial === metadata.rawDevice.device_sn)) throw new HTTPError(409, 'This camera already has an active request.');
        const cap = crypto.createHmac('sha256', Buffer.from(this.secret, 'utf8')).update(`${body.owner}\0${body.deviceId}`).digest('hex').slice(0, 48);
        const record = { id: crypto.randomUUID(), requestId: body.requestId, owner: body.owner, epoch: body.epoch, deviceId: body.deviceId,
            metadata, serial: metadata.rawDevice.device_sn, cap, cameraKey, expiresAt: this.now() + this.leaseMs,
            startedAt: this.now(), pending: new Map(), rpcId: 0, rpcWindowStartedAt: this.now(), rpcWindowCount: 0, processes: new Set(),
            viewers: new Set(), snapshots: 0, hasViewer: false };
        record.mediaUrl = `${this.origin}/v1/media/${cap}.ts`; record.hd = this.makeDevice(record);
        this.records.set(record.id, record); this.cameras.set(cameraKey, record); this.capabilities.set(cap, record); entry.record = record;
        this.manager.tokens?.set(cap, { device: record.hd, token: cap });
        this.manager.registrations?.set(record.serial, 1);
        this.diagnostic('source.starting');
        record.startPromise = this.context.run(record, async () => {
            if (record.closing) return;
            const session = await this.manager.getSession(record.hd); record.mediaSession = session;
            this.observeSource(record, session);
            if (record.closing) { await this.manager.stopStream(record.serial); return; }
            session.ready.promise.then(() => {
                if (!record.closing && !session.consumers?.size) this.manager.releaseConsumer?.(session, null);
            }).catch(() => {});
        });
        record.startPromise.catch(error => this.sourceFailure(record, error));
        this.scheduleIdle(record);
        return { id: record.id, mediaUrl: record.mediaUrl };
    }

    rpc(record, method, args) {
        // A renewed lease can outlive several bounded Worker instances. Each
        // Worker keeps its own 32-call ceiling; transport IDs stay monotonic so
        // an idle/reopened camera cannot collide with a cached earlier reply.
        if (!this.current(record)) return Promise.reject(fixedError());
        if (!validRPC(record.metadata, method, args) || record.rpcId >= Number.MAX_SAFE_INTEGER) { this.diagnostic('rpc.refused'); return Promise.reject(fixedError()); }
        if (record.pending.size >= 4) { this.diagnostic('capacity.rpc'); return Promise.reject(fixedError()); }
        if (this.now() - record.rpcWindowStartedAt >= 60000 && !record.pending.size) {
            record.rpcWindowStartedAt = this.now(); record.rpcWindowCount = 0;
        }
        if (record.rpcWindowCount >= 32) { this.diagnostic('capacity.rpc_rate'); return Promise.reject(fixedError()); }
        const id = ++record.rpcId, packet = { id, method, args };
        if (Buffer.byteLength(JSON.stringify(packet)) + 1 > EVENT_LIMIT) return Promise.reject(fixedError());
        record.rpcWindowCount++;
        return new Promise((resolve, reject) => {
            const pending = { packet, resolve, reject, timer: setTimeout(() => { record.pending.delete(id); this.diagnostic('rpc.timeout'); reject(fixedError()); }, this.rpcTimeoutMs) };
            record.pending.set(id, pending); this.sendEvent(record, packet);
        });
    }

    sendEvent(record, packet) {
        const response = record.events;
        if (!response || response.destroyed || response.writableEnded) return;
        if (response.writableLength > EVENT_LIMIT) { response.destroy(); return; }
        response.write(`${JSON.stringify(packet)}\n`);
    }

    events(record, response) {
        record.events?.end(); record.events = response;
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
        response.flushHeaders();
        for (const pending of record.pending.values()) this.sendEvent(record, pending.packet);
        const heartbeat = setInterval(() => { if (!response.destroyed && response.writableLength <= EVENT_LIMIT) response.write('\n'); else response.destroy(); }, 15000);
        heartbeat.unref?.();
        response.on('close', () => { clearInterval(heartbeat); if (record.events === response) record.events = null; });
    }

    reply(record, body) {
        if (!keys(body, ['id', 'value', 'error']) || !Number.isSafeInteger(body.id) || body.id < 1
            || Object.hasOwn(body, 'value') && Object.hasOwn(body, 'error')) throw new HTTPError(400, 'Invalid camera API reply.');
        const pending = record.pending.get(body.id);
        if (!pending) throw new HTTPError(404, 'Camera API request not found.');
        clearTimeout(pending.timer); record.pending.delete(body.id);
        if (Object.hasOwn(body, 'error')) this.diagnostic('rpc.failed');
        Object.hasOwn(body, 'error') ? pending.reject(fixedError()) : pending.resolve(body.value);
        return { accepted: true };
    }

    status(record) {
        const source = this.manager.getStatus(record.serial) || {};
        return { id: record.id, deviceId: record.deviceId,
            state: record.closing ? 'stopping' : ['streaming', 'stopped', 'starting'].includes(source.state) ? source.state : 'starting',
            bytes: Number.isFinite(source.bytes) && source.bytes >= 0 ? source.bytes : 0,
            startedAt: Number.isFinite(source.startedAt) ? source.startedAt : record.startedAt, leaseStartedAt: record.startedAt,
            ...(Number.isFinite(source.firstFrameAt) ? { firstFrameAt: source.firstFrameAt } : {}),
            ...(source.error ? { error: 'The camera stream is unavailable. Reopen the camera to retry.' } : {}) };
    }

    async wait(promise) {
        let timer;
        try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(fixedError()), this.closeTimeoutMs); })]); }
        finally { clearTimeout(timer); }
    }

    async drainProcess(proc) {
        if (proc.exitCode != null || proc.signalCode != null) return;
        let timer;
        try { await this.wait(new Promise(resolve => {
            proc.once('close', resolve); proc.once('error', resolve);
            proc.kill('SIGTERM'); timer = setTimeout(() => proc.kill('SIGKILL'), 2000); timer.unref?.();
        })); } finally { clearTimeout(timer); }
    }

    closeRecord(record) {
        if (record.closePromise) return record.closePromise;
        record.closing = true;
        clearTimeout(record.idleTimer); record.idleTimer = null;
        record.hd._started = false;
        const entry = this.requests.get(record.requestId);
        if (entry) { entry.cancelled = true; entry.expiresAt = this.now() + this.requestTtlMs; }
        record.events?.end(); record.events = null;
        for (const pending of record.pending.values()) { clearTimeout(pending.timer); pending.reject(fixedError()); }
        record.pending.clear();
        record.closePromise = (async () => {
            if (record.startPromise) await this.wait(record.startPromise.catch(() => {}));
            await this.wait(this.context.run(record, () => this.manager.stopStream(record.serial)));
            await Promise.all([...record.processes].map(proc => this.drainProcess(proc)));
            this.manager.tokens?.delete(record.cap); this.manager.registrations?.delete(record.serial);
            this.records.delete(record.id);
            if (this.cameras.get(record.cameraKey) === record) this.cameras.delete(record.cameraKey);
            if (this.capabilities.get(record.cap) === record) this.capabilities.delete(record.cap);
            if (entry?.record === record) entry.record = null;
            record.metadata = null;
            if (record.idleRetiring && entry) {
                entry.expiresAt = this.now() + this.requestTtlMs;
                entry.idleRetiredId = record.id; entry.idleRetiredCap = record.cap;
                this.idleRetired.set(record.id, entry);
                this.diagnostic('lease.idle');
            }
            this.diagnostic('source.closed');
        })().catch(() => { this.diagnostic('source.close_failed'); record.closePromise = null; throw fixedError(); });
        return record.closePromise;
    }

    async cancel(requestId, body) {
        if (!UUID.test(requestId) || !keys(body, ['owner', 'epoch', 'deviceId']) || !UUID.test(body.deviceId)) throw new HTTPError(400, 'Invalid camera cancellation.');
        this.binding(body); const entry = this.requestBinding(requestId, body);
        const assertNotIdleRetired = () => {
            if (entry.idleRetiredId && this.idleRetired.get(entry.idleRetiredId) === entry) throw new HTTPError(410, 'The unused camera lease was retired. Open the camera again.');
        };
        assertNotIdleRetired();
        entry.cancelled = true; entry.expiresAt = this.now() + this.requestTtlMs;
        if (entry.record) { this.diagnostic('lease.cancelled'); await this.closeRecord(entry.record); }
        assertNotIdleRetired();
        return { cancelled: true, requestId };
    }

    async prune() {
        return this.mutate(async () => {
            const stopped = await Promise.allSettled([...this.records.values()].flatMap(record => {
                if (record.idleRetiring || this.idleDue(record)) return [this.retireIdle(record)];
                if (record.expiresAt <= this.now()) { this.diagnostic('lease.expired'); return [this.closeRecord(record)]; }
                return [];
            }));
            this.trimRequests();
            if (stopped.some(result => result.status === 'rejected')) throw fixedError();
        });
    }

    async route(request, response) {
        const route = request.url || '';
        const media = /^\/v1\/media\/([a-f0-9]{48})\.ts$/.exec(route);
        if (media && request.method === 'GET') {
            this.trimRequests();
            const record = this.capabilities.get(media[1]);
            if (!record) {
                if ([...this.idleRetired.values()].some(entry => entry.idleRetiredCap === media[1])) throw new HTTPError(410, 'The unused camera lease was retired. Open the camera again.');
                throw new HTTPError(404, 'Camera stream not found.');
            }
            if (record.idleRetiring) await this.activeRecord(record.id);
            if (!this.current(record)) throw new HTTPError(404, 'Camera stream not found.');
            this.trackViewer(record, response);
            await record.startPromise;
            if (!this.current(record)) throw new HTTPError(404, 'Camera stream not found.');
            request.url = `/live/${record.cap}.ts`;
            await this.context.run(record, () => this.manager.serve(request, response)); return;
        }
        if (!this.authenticated(request)) throw new HTTPError(401, 'Camera helper authentication required.');
        if (this.closed) throw new HTTPError(503, 'The camera helper is shutting down.');
        if (request.method === 'GET' && route === '/v1/health') return this.json(response, 200, { protocol: 1, version: VERSION, sdk: SDK, instance: this.instance,
            capabilities: { streamLimitSettings: true } });
        if (request.method === 'POST' && route === '/v1/connect') {
            const body = await this.body(request); return this.json(response, 200, await this.mutate(() => this.connect(body)));
        }
        if (request.method === 'POST' && route === '/v1/sessions') {
            const body = await this.body(request); return this.json(response, 200, await this.mutate(() => this.createSession(body)));
        }
        if (request.method === 'PUT' && route === '/v1/limits') {
            const body = await this.body(request); return this.json(response, 200, await this.mutate(() => this.setStreamLimit(body)));
        }
        const cancellation = /^\/v1\/requests\/([a-f0-9-]{36})$/i.exec(route);
        if (cancellation && request.method === 'DELETE') {
            const body = await this.body(request); return this.json(response, 200, await this.mutate(() => this.cancel(cancellation[1], body)));
        }
        const match = /^\/v1\/sessions\/([a-f0-9-]{36})(?:\/(events|rpc|ready|status|renew|snapshot))?$/i.exec(route);
        if (!match || !UUID.test(match[1])) throw new HTTPError(404, 'Camera helper endpoint not found.');
        const [, id, action] = match;
        if (request.method === 'DELETE' && !action) {
            const body = await this.body(request);
            return this.mutate(async () => {
                const record = this.record(id, true);
                if (Object.keys(body).length && (!keys(body, ['owner', 'epoch']) || body.owner !== record.owner || body.epoch !== record.epoch)) throw new HTTPError(409, 'The camera session is no longer current.');
                this.diagnostic('lease.cancelled'); await this.closeRecord(record); this.json(response, 200, { closed: true, id });
            });
        }
        const record = await this.activeRecord(id);
        if (request.method === 'GET' && action === 'events') return this.events(record, response);
        if (request.method === 'GET' && action === 'status') return this.json(response, 200, this.status(record));
        if (request.method === 'POST' && action === 'rpc') return this.json(response, 200, this.reply(record, await this.body(request)));
        if (request.method === 'POST' && action === 'renew') {
            const body = await this.body(request);
            if (!keys(body, ['owner', 'epoch']) || body.owner !== record.owner || body.epoch !== record.epoch || !this.current(record)) throw new HTTPError(409, 'The camera session is no longer current.');
            record.expiresAt = this.now() + this.leaseMs; return this.json(response, 200, { renewed: true, expiresAt: record.expiresAt });
        }
        if (request.method === 'GET' && action === 'ready') {
            await record.startPromise; const session = await this.context.run(record, () => this.manager.getSession(record.hd));
            try { await session.ready.promise; }
            catch (error) { if (record.idleRetiring) await this.activeRecord(id); throw error; }
            await this.activeRecord(id);
            return this.json(response, 200, { ready: true, id });
        }
        if (request.method === 'GET' && action === 'snapshot') {
            record.snapshots++; clearTimeout(record.idleTimer); record.idleTimer = null;
            let captureComplete = false, responseComplete = false, delivered = false, released = false;
            const release = () => {
                if (released || !captureComplete || !responseComplete) return;
                released = true; response.removeListener('finish', completeResponse); response.removeListener('close', completeResponse);
                record.snapshots--; this.scheduleIdle(record);
            };
            const completeResponse = () => { responseComplete = true; release(); };
            response.once('finish', completeResponse); response.once('close', completeResponse);
            try {
                await this.context.run(record, () => this.manager.requestSnapshot(record.hd));
                if (!this.current(record)) throw new HTTPError(409, 'The camera session is no longer current.');
                const jpeg = await fs.readFile(path.join(this.mediaDir, `${record.serial}_snapshot.jpg`));
                if (!this.current(record)) throw new HTTPError(409, 'The camera session is no longer current.');
                if (jpeg.length < 4 || jpeg.length > 8 * 1024 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8
                    || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) throw fixedError();
                response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                response.end(jpeg); delivered = true; return;
            } finally {
                captureComplete = true;
                if (!delivered || response.writableFinished || response.destroyed) responseComplete = true;
                release();
            }
        }
        throw new HTTPError(404, 'Camera helper endpoint not found.');
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.diagnostic('helper.stopping');
        this.closed = true; clearInterval(this.pruneTimer);
        this.closePromise = (async () => {
            await this.mutations;
            const result = await Promise.allSettled([...this.records.values()].map(record => this.closeRecord(record)));
            await this.manager.dispose();
            await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections?.(); for (const socket of this.activeSockets) socket.destroy(); });
            if (result.some(item => item.status === 'rejected')) throw fixedError();
        })();
        return this.closePromise;
    }
}

module.exports = { HelperServer, createHelperServer: options => new HelperServer(options), validateMetadata, validRPC };
