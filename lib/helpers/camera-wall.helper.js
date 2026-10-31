'use strict';

const crypto = require('node:crypto');
const { getStreamLimit, isAtCapacity } = require('./camera-stream-limit.helper');

const CREDENTIALS_KEY = 'camera_wall_credentials';
const LEASE_MS = 75000;
const MAX_SDP_BYTES = 65536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HANDLE = /^[0-9a-f]{48}$/;
const publicErrors = new WeakSet();
const publicError = message => {
    const error = Object.assign(new Error(message), { cameraWallPublic: true });
    publicErrors.add(error);
    return error;
};

// The optional key remains in Homey's persistent settings database. Never put it
// in appSettings: that existing configuration object is included in app logs.
class CameraWall {
    constructor(homey, options = {}) {
        this.homey = homey;
        this.createLocalAPI = options.createLocalAPI || (properties => require('homey-api').HomeyAPI.createLocalAPI(properties));
        this.now = options.now || Date.now;
        this.handles = new Map();
        this.generation = 0;
        this.disposed = false;
        this.timer = setInterval(() => this.prune(), 15000);
        this.timer.unref?.();
    }

    assertActive() {
        if (this.disposed) throw publicError('The camera wall is shutting down.');
    }

    configured() {
        try {
            const value = this.homey.settings.get(CREDENTIALS_KEY);
            return typeof value?.apiKey === 'string' && value.apiKey.length > 0;
        } catch { return false; }
    }

    registration(device) {
        const manager = this.homey.app.FfmpegManager;
        const eufy = device?.EufyDevice;
        if (!manager || !eufy || !manager.supports(eufy)) return null;
        const entry = manager.videos.get(eufy.getSerial());
        // SDK Video.id is the registered UUID; device's 'main' slot is not a UUID.
        return entry?.device === device && UUID.test(entry.video?.id || '') ? entry : null;
    }

    available(device) {
        try {
            if (device.getAvailable() !== true) return false;
            this.homey.app.FfmpegManager.assertCamera(device);
            return true;
        } catch { return false; }
    }

    usesStreamLimit(device) {
        try { return this.homey.app.FfmpegManager.nativeEnabled(device.EufyDevice) !== true; }
        catch { return true; }
    }

    limitedCameraIds() {
        const viewed = new Set();
        for (const lease of this.handles.values()) {
            let usesLimit = true;
            try {
                const device = (this.homey.app.deviceList || []).find(candidate => candidate.getId() === lease.deviceId);
                usesLimit = !device || this.registration(device) !== lease.entry || this.usesStreamLimit(device);
            }
            catch { /* An unresolved registration cannot safely claim the native exemption. */ }
            if (usesLimit) viewed.add(lease.deviceId);
        }
        return viewed;
    }

    status() {
        this.assertActive();
        this.prune();
        const manager = this.homey.app.FfmpegManager;
        const cameras = [];
        const names = new Map();
        const kinds = new Map();
        for (const device of this.homey.app.deviceList || []) {
            try {
                if (!manager?.supports(device.EufyDevice)) continue;
                const id = device.getId();
                if (typeof id !== 'string' || !id || id.length > 128) continue;
                cameras.push({ id, name: String(device.getName()).slice(0, 512),
                    available: this.available(device), videoRegistered: Boolean(this.registration(device)),
                    usesStreamLimit: this.usesStreamLimit(device) });
                const name = cameras[cameras.length - 1].name;
                names.set(name, (names.get(name) || 0) + 1);
                kinds.set(id, device.driver?.id === 'driver_SMART_LOCK' ? 'video lock' : 'camera');
            } catch { /* A device initializing or being removed is not a playable camera. */ }
        }
        for (const camera of cameras) if (names.get(camera.name) > 1) camera.name += ` (${kinds.get(camera.id)})`;
        return { configured: this.configured(), cameras, maxViews: getStreamLimit(this.homey) };
    }

    async createClient(apiKey) {
        const address = await this.homey.api.getLocalUrl();
        const parsed = new URL(address);
        if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password) {
            throw publicError('The local Homey connection is unavailable.');
        }
        return this.createLocalAPI({ address, token: apiKey });
    }

    async validateClient(client) {
        const session = await client.sessions.getSessionMe({ $socket: false, $timeout: 10000 });
        const scopes = session?.intersectedScopes || session?.scopes;
        if (session?.type !== 'PAT' || !Array.isArray(scopes) || !scopes.includes('homey.device.readonly')
            || scopes.some(scope => !['homey.device.readonly', 'resource'].includes(scope))) {
            throw publicError('Use a dedicated Homey API key with device read permission only.');
        }
        return client;
    }

    async client() {
        this.assertActive();
        if (!this.clientPromise) {
            const credentials = this.homey.settings.get(CREDENTIALS_KEY);
            if (typeof credentials?.apiKey !== 'string' || !credentials.apiKey) throw publicError('Connect a read-only Homey API key to use the camera wall.');
            const pending = this.createClient(credentials.apiKey).then(client => this.validateClient(client)).catch(() => {
                if (this.clientPromise === pending) this.clientPromise = null;
                throw publicError('The read-only Homey connection failed. Check its API key and retry.');
            });
            this.clientPromise = pending;
        }
        return this.clientPromise;
    }

    async configure(apiKey) {
        this.assertActive();
        if (apiKey === null) {
            // Clearing the connection is only requested through the explicit UI action.
            try { this.homey.settings.unset(CREDENTIALS_KEY); }
            catch { throw publicError('The camera wall connection could not be cleared.'); }
            this.invalidate();
            return this.status();
        }
        if (typeof apiKey !== 'string' || apiKey.length < 16 || apiKey.length > 4096 || /\s/.test(apiKey)) {
            throw publicError('Enter a valid read-only Homey API key.');
        }
        const generation = this.generation;
        let client;
        try {
            client = await this.validateClient(await this.createClient(apiKey));
            const videos = await client.videos.getVideos({ $cache: false, $socket: false, $timeout: 10000 });
            if (!videos || typeof videos !== 'object' || Array.isArray(videos)) throw new Error('Invalid camera inventory');
        } catch { throw publicError('The API key could not read Homey cameras. Use a dedicated key with device read permission.'); }
        this.assertActive();
        if (generation !== this.generation) throw publicError('The camera wall connection changed. Retry connecting the key.');
        try { this.homey.settings.set(CREDENTIALS_KEY, { apiKey }); }
        catch { throw publicError('The camera wall connection could not be saved.'); }
        this.invalidate();
        this.clientPromise = Promise.resolve(client);
        return this.status();
    }

    invalidate() {
        this.generation++;
        this.handles.clear();
        this.clientPromise = null;
    }

    prune() {
        const now = this.now();
        for (const [handle, lease] of this.handles) if (lease.expiresAt <= now) this.handles.delete(handle);
    }

    camera(deviceId) {
        this.assertActive();
        if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 128) throw publicError('Choose an available Eufy camera.');
        try {
            const device = (this.homey.app.deviceList || []).find(candidate => candidate.getId() === deviceId);
            const entry = device && this.registration(device);
            if (!entry) throw publicError('This Eufy camera has no registered live video. Reconnect it and retry.');
            if (!this.available(device)) throw publicError('The camera is unavailable, switched off, or in privacy mode.');
            return { device, entry, videoId: entry.video.id };
        } catch (error) {
            if (publicErrors.has(error)) throw error;
            throw publicError('This Eufy camera is not ready. Reconnect it and retry.');
        }
    }

    async assertSourceCapacity(camera) {
        const manager = this.homey.app.FfmpegManager;
        const remote = camera.device.EufyDevice;
        // Native RTSP has no P2P source reservation; an existing own session is shared.
        if (manager.nativeEnabled(remote)) return;
        const serial = remote.getSerial();
        if (manager.sessions.has(serial)) return;
        if (manager.helperClient?.enabled?.(camera.device)) {
            await manager.refreshHelperStatus?.();
            const current = this.camera(camera.device.getId());
            if (current.entry !== camera.entry) throw publicError('The camera reconnected. Reopen its view.');
            if (manager.helperClient.hasSource(camera.device)) return;
            if (isAtCapacity(manager.sourceCount(), manager.maxSessions)) {
                throw publicError('The active camera stream limit has been reached. Stop another feed or change the limit.');
            }
            return;
        }
        if (isAtCapacity(manager.sourceCount(), manager.maxSessions)) {
            throw publicError('The active camera stream limit has been reached. Stop another feed and retry.');
        }
        const owner = manager.stationOwners.get(remote.getStationSerial());
        if (!manager.isolatedP2P(camera.device) && owner !== undefined && owner !== serial) {
            throw publicError('Another camera on this HomeBase is busy streaming. Stop that feed and retry.');
        }
    }

    validSdp(value) {
        return typeof value === 'string' && Buffer.byteLength(value) <= MAX_SDP_BYTES
            && /^v=0\r?\n/.test(value) && /(?:\r?\n)m=video /.test(value) && !value.includes('\0');
    }

    assertLease(deviceId, handle) {
        this.assertActive();
        this.prune();
        const lease = typeof handle === 'string' && HANDLE.test(handle) ? this.handles.get(handle) : null;
        if (!lease || lease.deviceId !== deviceId || !lease.streamId) throw publicError('This camera view expired. Reopen it to reconnect.');
        let current;
        try { current = this.camera(deviceId); }
        catch (error) { this.handles.delete(handle); throw error; }
        if (current.entry !== lease.entry || lease.generation !== this.generation) {
            this.handles.delete(handle);
            throw publicError('The camera reconnected. Reopen its view.');
        }
        return lease;
    }

    async offer(deviceId, offerSdp) {
        const camera = this.camera(deviceId);
        if (!this.validSdp(offerSdp)) throw publicError('The browser did not provide a valid camera connection request.');
        await this.assertSourceCapacity(camera);
        this.prune();
        const viewed = this.limitedCameraIds();
        if (this.usesStreamLimit(camera.device) && !viewed.has(deviceId) && isAtCapacity(viewed.size, getStreamLimit(this.homey))) {
            throw publicError('The camera view limit has been reached. Close a view or change the limit.');
        }
        const handle = crypto.randomBytes(24).toString('hex');
        const lease = { deviceId, entry: camera.entry, videoId: camera.videoId,
            generation: this.generation, expiresAt: this.now() + LEASE_MS };
        // Reserve a slot before awaiting I/O so concurrent requests share the same bound.
        this.handles.set(handle, lease);
        try {
            const client = await this.client();
            const ready = this.camera(deviceId);
            this.prune();
            if (this.handles.get(handle) !== lease || lease.generation !== this.generation || ready.entry !== lease.entry) {
                throw publicError('Camera startup was cancelled. Reopen its view.');
            }
            await this.assertSourceCapacity(ready);
            const dispatchCamera = this.camera(deviceId);
            this.prune();
            if (this.handles.get(handle) !== lease || lease.generation !== this.generation || dispatchCamera.entry !== lease.entry) {
                throw publicError('Camera startup was cancelled. Reopen its view.');
            }
            const result = await client.videos.videoOffer({ id: lease.videoId, offer: offerSdp, $timeout: 35000, $socket: false });
            if (!this.validSdp(result?.answerSdp) || typeof result?.streamId !== 'string' || !result.streamId || result.streamId.length > 256) {
                throw publicError('Homey could not establish this camera view.');
            }
            const current = this.camera(deviceId);
            this.prune();
            if (this.handles.get(handle) !== lease || lease.generation !== this.generation || current.entry !== lease.entry) {
                throw publicError('Camera startup was cancelled. Reopen its view.');
            }
            lease.streamId = result.streamId;
            lease.expiresAt = this.now() + LEASE_MS;
            return { handle, answerSdp: result.answerSdp };
        } catch (error) {
            const wasCurrent = this.handles.get(handle) === lease;
            if (wasCurrent) this.handles.delete(handle);
            if (publicErrors.has(error)) throw error;
            // NAS can fall back to P2P while Homey is negotiating. Re-read the
            // manager's state so that a busy HomeBase is not reported as a key problem.
            try {
                const current = this.camera(deviceId);
                if (!wasCurrent || lease.generation !== this.generation || current.entry !== lease.entry) {
                    throw publicError('Camera startup was cancelled. Reopen its view.');
                }
                await this.assertSourceCapacity(current);
            } catch (currentError) {
                if (publicErrors.has(currentError)) throw currentError;
            }
            throw publicError('The camera view could not connect. Check the read-only API key and camera connection, then retry.');
        }
    }

    async keepAlive(deviceId, handle) {
        const lease = this.assertLease(deviceId, handle);
        try {
            const client = await this.client();
            if (this.assertLease(deviceId, handle) !== lease) throw new Error('Connection changed');
            await client.videos.videoKeepAlive({ id: lease.videoId, streamId: lease.streamId, $timeout: 10000, $socket: false });
            if (this.assertLease(deviceId, handle) !== lease) throw new Error('Connection changed');
            lease.expiresAt = this.now() + LEASE_MS;
            return { active: true };
        } catch (error) {
            if (this.handles.get(handle) === lease) this.handles.delete(handle);
            if (publicErrors.has(error)) throw error;
            throw publicError('The camera connection ended. Reopen its view to retry.');
        }
    }

    stop(deviceId, handle) {
        this.assertActive();
        if (typeof deviceId !== 'string' || typeof handle !== 'string' || !HANDLE.test(handle)) throw publicError('The camera view could not be closed.');
        const lease = this.handles.get(handle);
        if (lease && lease.deviceId !== deviceId) throw publicError('The camera view could not be closed.');
        this.handles.delete(handle);
        // Closing the browser's peer connection and ending these keepalives lets
        // Homey's proxy release its consumer, without stopping other viewers.
        return { stopped: true };
    }

    async dispose() {
        this.disposed = true;
        clearInterval(this.timer);
        this.invalidate();
    }
}

module.exports = CameraWall;
