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
const VERSION = '0.1.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/;
const BODY_LIMIT = 512 * 1024;
const EVENT_LIMIT = 64 * 1024;
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
        this.startTimeoutMs = options.startTimeoutMs ?? 25000; this.rpcTimeoutMs = options.rpcTimeoutMs ?? 10000;
        this.closeTimeoutMs = options.closeTimeoutMs ?? 5000; this.maxSessions = Math.min(options.maxSessions || 4, 4);
        this.requestTtlMs = options.requestTtlMs ?? 120000; this.maxRequests = options.maxRequests || 128;
        for (const [value, maximum] of [[this.maxSessions, 4], [this.maxRequests, 128], [this.leaseMs, 75000],
            [this.startTimeoutMs, 25000], [this.rpcTimeoutMs, 10000], [this.closeTimeoutMs, 5000], [this.requestTtlMs, 120000]]) {
            if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error('Invalid camera helper limits.');
        }
        this.mediaDir = options.mediaDir || path.join(os.tmpdir(), `eufy-media-${process.pid}`);
        if (!path.isAbsolute(this.mediaDir)) throw new Error('The media cache must use an absolute path.');
        this.instance = crypto.randomUUID(); this.records = new Map(); this.cameras = new Map(); this.capabilities = new Map();
        this.requests = new Map(); this.owners = new Map(); this.context = new AsyncLocalStorage(); this.mutations = Promise.resolve();
        this.activeSockets = new Set(); this.runtime = options.runtime || runtime();
        const homey = this.homey = new EventEmitter();
        homey.platformVersion = 2; homey.settings = { get: name => name === 'camera_isolated_p2p_devices' ? true : undefined };
        this.globalClient = new EventEmitter(); this.globalClient.isConnected = () => true;
        homey.app = { eufyClient: this.globalClient, log() {}, warn() {}, error() {} };
        const managerOptions = { userdata: this.mediaDir, maxSessions: this.maxSessions, startTimeoutMs: this.startTimeoutMs,
            resolveBinary: async () => options.ffmpeg || '/usr/bin/ffmpeg',
            createP2PSession: params => {
                const record = params.homeyDevice.helperRecord;
                const configured = { ...params, client: params.homeyDevice.rpcClient,
                    onStream: (...args) => this.context.run(record, () => params.onStream(...args)),
                    onStop: (...args) => this.context.run(record, () => params.onStop(...args)),
                    onError: (...args) => this.context.run(record, () => params.onError(...args)) };
                return options.createP2PSession ? options.createP2PSession(configured) : new this.runtime.WorkerSessionClass(configured);
            },
            spawn: (...args) => {
                const proc = (options.spawn || spawn)(...args), record = this.context.getStore();
                if (record) { record.processes.add(proc); proc.once('close', () => record.processes.delete(proc)); proc.once('error', () => record.processes.delete(proc)); }
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
        const record = this.records.get(id);
        if (!record) throw new HTTPError(404, 'Camera session not found.');
        if (!allowClosing && !this.current(record)) throw new HTTPError(409, 'The camera session is no longer current.');
        return record;
    }

    trimRequests() {
        for (const [id, entry] of this.requests) if (entry.cancelled && entry.expiresAt <= this.now() && !entry.record) this.requests.delete(id);
    }

    requestBinding(requestId, binding) {
        this.trimRequests();
        let entry = this.requests.get(requestId);
        if (entry && (entry.owner !== binding.owner || entry.epoch !== binding.epoch || entry.deviceId !== binding.deviceId)) throw new HTTPError(409, 'The camera request belongs to another session.');
        if (!entry) {
            if (this.requests.size >= this.maxRequests) throw new HTTPError(429, 'Too many camera requests. Retry later.');
            entry = { owner: binding.owner, epoch: binding.epoch, deviceId: binding.deviceId, requestId };
            this.requests.set(requestId, entry);
        }
        return entry;
    }

    async connect(body) {
        if (!keys(body, ['owner', 'epoch', 'protocol', 'sdk']) || body.protocol !== 1 || body.sdk !== SDK) throw new HTTPError(409, 'The camera helper protocol is incompatible.');
        this.binding(body); this.owners.set(body.owner, body.epoch);
        const stopped = await Promise.allSettled([...this.records.values()].filter(record => record.owner === body.owner && record.epoch !== body.epoch)
            .map(record => this.closeRecord(record)));
        if (stopped.some(result => result.status === 'rejected')) throw fixedError();
        return { protocol: 1, version: VERSION, sdk: SDK, instance: this.instance, owner: body.owner, epoch: body.epoch };
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
        if (this.records.size >= this.maxSessions) throw new HTTPError(429, 'There are already four active camera sessions.');
        if ([...this.records.values()].some(record => record.serial === metadata.rawDevice.device_sn)) throw new HTTPError(409, 'This camera already has an active request.');
        const cap = crypto.createHmac('sha256', Buffer.from(this.secret, 'utf8')).update(`${body.owner}\0${body.deviceId}`).digest('hex').slice(0, 48);
        const record = { id: crypto.randomUUID(), requestId: body.requestId, owner: body.owner, epoch: body.epoch, deviceId: body.deviceId,
            metadata, serial: metadata.rawDevice.device_sn, cap, cameraKey, expiresAt: this.now() + this.leaseMs,
            startedAt: this.now(), pending: new Map(), rpcId: 0, rpcWindowStartedAt: this.now(), rpcWindowCount: 0, processes: new Set() };
        record.mediaUrl = `${this.origin}/v1/media/${cap}.ts`; record.hd = this.makeDevice(record);
        this.records.set(record.id, record); this.cameras.set(cameraKey, record); this.capabilities.set(cap, record); entry.record = record;
        this.manager.tokens?.set(cap, { device: record.hd, token: cap });
        this.manager.registrations?.set(record.serial, 1);
        record.startPromise = this.context.run(record, async () => {
            if (record.closing) return;
            const session = await this.manager.getSession(record.hd); record.mediaSession = session;
            if (record.closing) { await this.manager.stopStream(record.serial); return; }
            session.ready.promise.then(() => {
                if (!record.closing && !session.consumers?.size) this.manager.releaseConsumer?.(session, null);
            }).catch(() => {});
        });
        record.startPromise.catch(() => {});
        return { id: record.id, mediaUrl: record.mediaUrl };
    }

    rpc(record, method, args) {
        // A renewed lease can outlive several bounded Worker instances. Each
        // Worker keeps its own 32-call ceiling; transport IDs stay monotonic so
        // an idle/reopened camera cannot collide with a cached earlier reply.
        if (!this.current(record) || !validRPC(record.metadata, method, args) || record.pending.size >= 4 || record.rpcId >= Number.MAX_SAFE_INTEGER) return Promise.reject(fixedError());
        if (this.now() - record.rpcWindowStartedAt >= 60000 && !record.pending.size) {
            record.rpcWindowStartedAt = this.now(); record.rpcWindowCount = 0;
        }
        if (record.rpcWindowCount >= 32) return Promise.reject(fixedError());
        const id = ++record.rpcId, packet = { id, method, args };
        if (Buffer.byteLength(JSON.stringify(packet)) + 1 > EVENT_LIMIT) return Promise.reject(fixedError());
        record.rpcWindowCount++;
        return new Promise((resolve, reject) => {
            const pending = { packet, resolve, reject, timer: setTimeout(() => { record.pending.delete(id); reject(fixedError()); }, this.rpcTimeoutMs) };
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
        Object.hasOwn(body, 'error') ? pending.reject(fixedError()) : pending.resolve(body.value);
        return { accepted: true };
    }

    status(record) {
        const source = this.manager.getStatus(record.serial) || {};
        return { id: record.id, deviceId: record.deviceId,
            state: record.closing ? 'stopping' : ['streaming', 'stopped', 'starting'].includes(source.state) ? source.state : 'starting',
            bytes: Number.isFinite(source.bytes) && source.bytes >= 0 ? source.bytes : 0, startedAt: record.startedAt,
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
        })().catch(() => { record.closePromise = null; throw fixedError(); });
        return record.closePromise;
    }

    async cancel(requestId, body) {
        if (!UUID.test(requestId) || !keys(body, ['owner', 'epoch', 'deviceId']) || !UUID.test(body.deviceId)) throw new HTTPError(400, 'Invalid camera cancellation.');
        this.binding(body); const entry = this.requestBinding(requestId, body);
        entry.cancelled = true; entry.expiresAt = this.now() + this.requestTtlMs;
        if (entry.record) await this.closeRecord(entry.record);
        return { cancelled: true, requestId };
    }

    async prune() {
        return this.mutate(async () => {
            const stopped = await Promise.allSettled([...this.records.values()].filter(record => record.expiresAt <= this.now())
                .map(record => this.closeRecord(record)));
            this.trimRequests();
            if (stopped.some(result => result.status === 'rejected')) throw fixedError();
        });
    }

    async route(request, response) {
        const route = request.url || '';
        const media = /^\/v1\/media\/([a-f0-9]{48})\.ts$/.exec(route);
        if (media && request.method === 'GET') {
            const record = this.capabilities.get(media[1]);
            if (!record || !this.current(record)) throw new HTTPError(404, 'Camera stream not found.');
            await record.startPromise;
            if (!this.current(record)) throw new HTTPError(404, 'Camera stream not found.');
            request.url = `/live/${record.cap}.ts`;
            await this.context.run(record, () => this.manager.serve(request, response)); return;
        }
        if (!this.authenticated(request)) throw new HTTPError(401, 'Camera helper authentication required.');
        if (this.closed) throw new HTTPError(503, 'The camera helper is shutting down.');
        if (request.method === 'GET' && route === '/v1/health') return this.json(response, 200, { protocol: 1, version: VERSION, sdk: SDK, instance: this.instance });
        if (request.method === 'POST' && route === '/v1/connect') {
            const body = await this.body(request); return this.json(response, 200, await this.mutate(() => this.connect(body)));
        }
        if (request.method === 'POST' && route === '/v1/sessions') {
            const body = await this.body(request); return this.json(response, 200, await this.mutate(() => this.createSession(body)));
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
                await this.closeRecord(record); this.json(response, 200, { closed: true, id });
            });
        }
        const record = this.record(id);
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
            await session.ready.promise;
            if (!this.current(record)) throw new HTTPError(409, 'The camera session is no longer current.');
            return this.json(response, 200, { ready: true, id });
        }
        if (request.method === 'GET' && action === 'snapshot') {
            await this.context.run(record, () => this.manager.requestSnapshot(record.hd));
            if (!this.current(record)) throw new HTTPError(409, 'The camera session is no longer current.');
            const jpeg = await fs.readFile(path.join(this.mediaDir, `${record.serial}_snapshot.jpg`));
            if (!this.current(record)) throw new HTTPError(409, 'The camera session is no longer current.');
            if (jpeg.length < 4 || jpeg.length > 8 * 1024 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8
                || jpeg.at(-2) !== 0xff || jpeg.at(-1) !== 0xd9) throw fixedError();
            response.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
            response.end(jpeg); return;
        }
        throw new HTTPError(404, 'Camera helper endpoint not found.');
    }

    close() {
        if (this.closePromise) return this.closePromise;
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
