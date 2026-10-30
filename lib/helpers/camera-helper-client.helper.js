'use strict';

const { randomUUID } = require('node:crypto');
const CameraP2PSession = require('./camera-p2p-session.helper');

const OWNER = 'com.eufylife.security';
const SDK = '4.2.6';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTITY = /^[A-Za-z0-9_-]{1,128}$/;
const UNAVAILABLE = 'The camera helper is unavailable. Check its connection and retry.';
const CANCELLED = 'Camera startup was cancelled. Reopen the camera to retry.';
const CLOSING = 'The camera helper could not finish closing this connection. Retry Stop.';
const CAMERA_FAILED = 'The camera helper could not deliver video. Check the camera and retry.';
const publicError = message => Object.assign(new Error(message), { mediaPublic: true, cameraHelper: true });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;

class CameraHelperClient {
    constructor({ homey, assertCamera = () => {}, localSourceCount = () => 0, fetch: request = globalThis.fetch,
        setTimeout: timer = setTimeout, clearTimeout: clearTimer = clearTimeout, randomUUID: uuid = randomUUID, now = Date.now,
        requestTimeoutMs = 10000, readyTimeoutMs = 55000, eventsTimeoutMs = 55000, renewIntervalMs = 20000,
        retryDelays = [1000, 2000, 5000, 10000, 30000], maxSources = 4 } = {}) {
        this.homey = homey; this.assertCamera = assertCamera; this.localSourceCount = localSourceCount;
        this.fetch = request; this.setTimer = timer; this.clearTimer = clearTimer; this.uuid = uuid; this.now = now;
        this.requestTimeoutMs = requestTimeoutMs; this.readyTimeoutMs = readyTimeoutMs; this.eventsTimeoutMs = eventsTimeoutMs;
        this.renewIntervalMs = renewIntervalMs; this.retryDelays = retryDelays; this.maxSources = Math.min(4, maxSources);
        this.epoch = uuid(); this.entries = new Map(); this.history = new Map(); this.controllers = new Set();
        this.connectionState = null; this.disposed = false;
    }

    selected(homeyDevice) {
        const selected = this.homey.settings?.get?.('camera_helper_devices');
        const id = homeyDevice?.getId?.();
        return selected === true || Array.isArray(selected) && typeof id === 'string' && selected.includes(id);
    }

    connection() {
        const value = this.homey.settings?.get?.('camera_helper_connection');
        if (!record(value) || value.protocol !== 1 || typeof value.url !== 'string' || typeof value.token !== 'string'
            || !/^[a-f0-9]{64}$/.test(value.token)) return null;
        const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(value.url);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) return null;
        const url = new URL(value.url);
        return { origin: url.origin, token: value.token, key: `${url.origin}\0${value.token}` };
    }

    enabled(homeyDevice) { return !this.disposed && this.selected(homeyDevice) && this.connection() !== null; }
    sourceCount() { return this.entries.size; }

    async health() {
        const connection = this.connection();
        if (!connection) return { configured: false, available: false, protocol: 1 };
        try {
            const health = await this.json(connection, '/v1/health');
            if (health.protocol !== 1 || health.sdk !== SDK || !UUID.test(health.instance || '')
                || !/^\d+\.\d+\.\d+$/.test(health.version || '')) throw publicError(UNAVAILABLE);
            return { configured: true, available: true, protocol: 1, version: health.version, sdk: SDK, instance: health.instance };
        } catch { return { configured: true, available: false, protocol: 1, error: UNAVAILABLE }; }
    }

    identity(homeyDevice) {
        const device = homeyDevice?.EufyDevice, client = this.homey.app?.eufyClient, station = homeyDevice?.EufyStation;
        const serial = device?.getSerial?.(), deviceId = homeyDevice?.getId?.();
        if (typeof serial !== 'string' || !IDENTITY.test(serial) || typeof deviceId !== 'string' || !UUID.test(deviceId)
            || !client || !station) throw publicError(CANCELLED);
        return { homeyDevice, device, station, client, serial, deviceId };
    }

    validate(entry) {
        if (this.disposed || this.resetting || entry.closing || this.entries.get(entry.serial) !== entry || !this.selected(entry.homeyDevice)
            || entry.homeyDevice.EufyDevice !== entry.device || entry.homeyDevice.EufyStation !== entry.station
            || this.homey.app?.eufyClient !== entry.client || this.connection()?.key !== entry.connection.key) throw publicError(CANCELLED);
        this.assertAllowed(entry.homeyDevice);
        if (entry.client.isConnected?.() === false) throw publicError(CANCELLED);
    }

    assertAllowed(homeyDevice) {
        try { this.assertCamera(homeyDevice); }
        catch (error) { throw error?.mediaPublic === true ? error : publicError(CANCELLED); }
    }

    current(entry, generation) {
        if (entry.generation !== generation) return false;
        try { this.validate(entry); return true; } catch { return false; }
    }

    retireIdle(entry, generation) {
        // HTTP 410 is the helper's confirmation that this unused lease and its
        // owned resources are gone. It must not trigger desired-video recovery.
        if (this.entries.get(entry.serial) !== entry || entry.generation !== generation) return;
        entry.closing = true; entry.videoDesired = false; entry.ready = false;
        this.invalidate(entry);
        this.entries.delete(entry.serial);
        entry.status = { state: 'stopped', source: 'helper' };
        this.history.set(entry.serial, entry.status);
    }

    later(fn, delay) { const timer = this.setTimer(fn, delay); timer?.unref?.(); return timer; }

    async bytes(response, maximum) {
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > maximum) throw publicError(UNAVAILABLE);
        if (!response.body) return Buffer.alloc(0);
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
            if (chunk.byteLength > maximum - size) throw publicError(UNAVAILABLE);
            const bytes = Buffer.from(chunk); size += bytes.length;
            chunks.push(bytes);
        }
        return Buffer.concat(chunks, size);
    }

    async raw(connection, pathname, { method = 'GET', body, entry, generation, timeout = this.requestTimeoutMs } = {}) {
        if (entry && !this.current(entry, generation)) throw publicError(CANCELLED);
        const controller = new AbortController(); this.controllers.add(controller); entry?.controllers.add(controller);
        const deadline = this.later(() => controller.abort(), timeout);
        const finish = () => {
            this.clearTimer(deadline); this.controllers.delete(controller); entry?.controllers.delete(controller);
        };
        try {
            const response = await this.fetch(`${connection.origin}${pathname}`, { method, redirect: 'error', signal: controller.signal,
                headers: { Authorization: `Bearer ${connection.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            if (entry && !this.current(entry, generation)) { controller.abort(); throw publicError(CANCELLED); }
            if (!response.ok) {
                if (response.status === 410 && entry) this.retireIdle(entry, generation);
                controller.abort();
                throw Object.assign(publicError(UNAVAILABLE), { helperStatus: response.status });
            }
            return { response, controller, finish };
        } catch (error) { finish(); throw Object.assign(publicError(UNAVAILABLE), { helperStatus: error?.helperStatus }); }
    }

    async json(connection, pathname, options = {}) {
        const request = await this.raw(connection, pathname, options);
        try {
            const bytes = await this.bytes(request.response, 256 * 1024);
            const value = bytes.length ? JSON.parse(bytes.toString('utf8')) : {};
            if (!record(value)) throw new Error();
            return value;
        } catch (error) { request.controller.abort(); throw Object.assign(publicError(UNAVAILABLE), { helperStatus: error?.helperStatus }); }
        finally { request.finish(); }
    }

    async connect(connection) {
        const existing = this.connectionState;
        if (existing?.key === connection.key && existing.promise) return existing.promise;
        const state = { key: connection.key };
        state.promise = (async () => {
            const health = await this.json(connection, '/v1/health');
            if (health.protocol !== 1 || health.sdk !== SDK || typeof health.version !== 'string'
                || !/^\d+\.\d+\.\d+$/.test(health.version) || !UUID.test(health.instance || '')) throw publicError(UNAVAILABLE);
            const connected = await this.json(connection, '/v1/connect', { method: 'POST',
                body: { owner: OWNER, epoch: this.epoch, protocol: 1, sdk: SDK } });
            if (connected.protocol !== 1 || connected.sdk !== SDK || connected.version !== health.version || connected.instance !== health.instance
                || connected.owner !== OWNER || connected.epoch !== this.epoch) throw publicError(UNAVAILABLE);
            state.instance = health.instance;
            return health.instance;
        })().catch(error => { if (this.connectionState === state) this.connectionState = null; throw error; });
        this.connectionState = state;
        return state.promise;
    }

    broker(entry, generation) {
        const broker = new CameraP2PSession({ client: entry.client, homeyDevice: entry.homeyDevice });
        entry.rpcWindowStartedAt = this.now();
        broker.send = message => {
            if (!this.current(entry, generation)) {
                if (entry.generation === generation && !entry.closing) this.stop(entry.serial).catch(() => {});
                return;
            }
            if (message?.type !== 'rpc-result') return;
            const reply = { id: message.id, ...(typeof message.error === 'string' ? { error: 'Camera API request failed.' }
                : message.value === undefined ? {} : { value: message.value }) };
            if (Buffer.byteLength(JSON.stringify(reply)) > 128 * 1024) return;
            entry.replies.set(reply.id, reply);
            while (entry.replies.size > 32) entry.replies.delete(entry.replies.keys().next().value);
            this.reply(entry, generation, reply).catch(() => { if (this.current(entry, generation)) entry.pumpController?.abort(); });
        };
        return broker;
    }

    stopBroker(entry) {
        if (!entry.broker) return;
        entry.broker.closing = true;
        for (const pending of entry.broker.pendingRpc.values()) clearTimeout(pending.timer);
        entry.broker.pendingRpc.clear(); entry.broker = null;
    }

    invalidate(entry) {
        entry.generation++; this.clearTimer(entry.renewTimer); this.clearTimer(entry.retryTimer); this.clearTimer(entry.pumpTimer);
        for (const controller of entry.controllers) controller.abort();
        this.stopBroker(entry); entry.replies.clear(); entry.pumpController = null;
    }

    async prepare(entry) {
        this.validate(entry);
        const generation = entry.generation;
        const instance = await this.connect(entry.connection);
        if (!this.current(entry, generation)) throw publicError(CANCELLED);
        if (entry.requestId && entry.instance === instance) {
            const cancelled = await this.json(entry.connection, `/v1/requests/${entry.requestId}`, { method: 'DELETE', entry, generation,
                body: { owner: OWNER, epoch: this.epoch, deviceId: entry.deviceId } });
            if (cancelled.cancelled !== true || cancelled.requestId !== entry.requestId) throw publicError(UNAVAILABLE);
        }
        entry.id = null; entry.instance = instance; entry.requestId = this.uuid(); entry.broker = this.broker(entry, generation);
        if (Buffer.byteLength(JSON.stringify(entry.broker.workerData)) > 256 * 1024) throw publicError(UNAVAILABLE);
        const remote = await this.json(entry.connection, '/v1/sessions', { method: 'POST', entry, generation,
            body: { owner: OWNER, epoch: this.epoch, requestId: entry.requestId, deviceId: entry.deviceId, metadata: entry.broker.workerData } });
        if (!UUID.test(remote.id || '') || typeof remote.mediaUrl !== 'string') throw publicError(UNAVAILABLE);
        const media = new URL(remote.mediaUrl, entry.connection.origin);
        if (media.origin !== entry.connection.origin || media.username || media.password || media.search || media.hash
            || !/^\/v1\/media\/[a-f0-9]{48}\.ts$/.test(media.pathname) || entry.mediaUrl && entry.mediaUrl !== media.href) throw publicError(UNAVAILABLE);
        entry.id = remote.id; entry.mediaUrl = media.href;
        entry.pump = this.events(entry, generation); entry.pump.catch(() => {});
        const ready = await this.json(entry.connection, `/v1/sessions/${entry.id}/ready`, { entry, generation, timeout: this.readyTimeoutMs });
        if (ready.ready !== true || ready.id !== entry.id || !this.current(entry, generation)) throw publicError(UNAVAILABLE);
        entry.ready = true; entry.retry = 0; entry.status = { state: 'streaming', source: 'helper', bytes: 0 };
        this.history.delete(entry.serial); this.scheduleRenew(entry);
        return entry.mediaUrl;
    }

    async getEntry(homeyDevice, videoDesired) {
        if (this.resetting) throw publicError(CANCELLED);
        if (this.disposed || !this.selected(homeyDevice)) {
            await this.stop(homeyDevice?.EufyDevice?.getSerial?.()).catch(() => {});
            throw publicError(UNAVAILABLE);
        }
        const identity = this.identity(homeyDevice), connection = this.connection();
        if (!connection) {
            await this.stop(identity.serial).catch(() => {});
            this.history.set(identity.serial, { state: 'stopped', source: 'helper', error: UNAVAILABLE }); throw publicError(UNAVAILABLE);
        }
        try { this.assertAllowed(homeyDevice); }
        catch (error) { await this.stop(identity.serial).catch(() => {}); throw error; }
        let entry = this.entries.get(identity.serial);
        if (entry && (entry.homeyDevice !== homeyDevice || entry.device !== identity.device || entry.station !== identity.station
            || entry.client !== identity.client || entry.connection.key !== connection.key)) {
            await this.stop(identity.serial); entry = null;
        }
        // A native viewer can stop without calling the app's Stop action. Check
        // cached leases before reusing their URL or refusing another camera.
        if (entry?.ready || this.localSourceCount() + this.sourceCount() >= this.maxSources) {
            await this.refreshStatus();
            if (this.disposed || this.resetting || !this.selected(homeyDevice) || this.connection()?.key !== connection.key
                || homeyDevice.EufyDevice !== identity.device || homeyDevice.EufyStation !== identity.station
                || this.homey.app?.eufyClient !== identity.client) throw publicError(CANCELLED);
            this.assertAllowed(homeyDevice);
            entry = this.entries.get(identity.serial);
        }
        if (!entry) {
            const local = this.localSourceCount();
            if (!integer(local) || local + this.sourceCount() >= this.maxSources) throw publicError('There are already four active camera streams. Stop one and retry.');
            entry = { ...identity, connection, generation: 1, controllers: new Set(), replies: new Map(), retry: 0, pumpRetry: 0,
                videoDesired: false, snapshots: 0, ready: false, status: { state: 'starting', source: 'helper', bytes: 0 } };
            this.entries.set(identity.serial, entry);
        }
        if (entry.closing) throw publicError(CLOSING);
        entry.videoDesired ||= videoDesired;
        this.validate(entry);
        if (!entry.startPromise) {
            entry.startPromise = this.prepare(entry).catch(async error => {
                entry.ready = false; entry.status = { state: 'stopped', source: 'helper', error: UNAVAILABLE };
                // No native viewer received this URL. Cancel the initial
                // request rather than renewing an abandoned startup forever.
                if (!entry.closing && this.entries.get(entry.serial) === entry) await this.stop(entry.serial).catch(() => {});
                throw publicError(error?.mediaPublic && error.message === CANCELLED ? CANCELLED : UNAVAILABLE);
            });
            entry.startPromise.catch(() => {});
        }
        await entry.startPromise;
        this.validate(entry);
        if (!entry.ready) throw publicError(UNAVAILABLE);
        return entry;
    }

    async videoUrl(homeyDevice) { return (await this.getEntry(homeyDevice, true)).mediaUrl; }

    async snapshot(homeyDevice) {
        let entry;
        try {
            entry = await this.getEntry(homeyDevice, false); entry.snapshots++;
            const generation = entry.generation;
            const request = await this.raw(entry.connection, `/v1/sessions/${entry.id}/snapshot`, { entry, generation, timeout: this.readyTimeoutMs });
            try {
                const bytes = await this.bytes(request.response, 8 * 1024 * 1024);
                if (!this.current(entry, generation) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8
                    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw publicError(CAMERA_FAILED);
                return bytes;
            } finally { request.controller.abort(); request.finish(); }
        } catch { throw publicError(CAMERA_FAILED); }
        finally {
            if (entry) {
                entry.snapshots--;
                if (this.entries.get(entry.serial) === entry && !entry.videoDesired && !entry.snapshots) await this.stop(entry.serial).catch(() => {});
            }
        }
    }

    async reply(entry, generation, body) {
        this.validate(entry);
        return this.json(entry.connection, `/v1/sessions/${entry.id}/rpc`, { method: 'POST', body, entry, generation });
    }

    async events(entry, generation) {
        try {
            const request = await this.raw(entry.connection, `/v1/sessions/${entry.id}/events`, { entry, generation, timeout: this.eventsTimeoutMs });
            entry.pumpController = request.controller;
            try {
                if (!request.response.headers?.get?.('content-type')?.toLowerCase().startsWith('application/x-ndjson')) throw publicError(UNAVAILABLE);
                entry.pumpRetry = 0;
                let buffered = '';
                const decoder = new TextDecoder('utf-8', { fatal: true });
                for await (const chunk of request.response.body) {
                    if (!this.current(entry, generation)) {
                        if (entry.generation === generation && !entry.closing) this.stop(entry.serial).catch(() => {});
                        return;
                    }
                    if (chunk.byteLength > 256 * 1024) throw publicError(UNAVAILABLE);
                    buffered += decoder.decode(chunk, { stream: true });
                    if (Buffer.byteLength(buffered) > 256 * 1024) throw publicError(UNAVAILABLE);
                    let newline;
                    while ((newline = buffered.indexOf('\n')) !== -1) {
                        const line = buffered.slice(0, newline).trim(); buffered = buffered.slice(newline + 1);
                        if (!line) continue;
                        const message = JSON.parse(line);
                        if (!record(message) || Object.keys(message).some(key => !['id', 'method', 'args'].includes(key))
                            || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.method !== 'string' || !Array.isArray(message.args)) throw publicError(UNAVAILABLE);
                        if (entry.replies.has(message.id)) this.reply(entry, generation, entry.replies.get(message.id)).catch(() => request.controller.abort());
                        else if (!entry.broker.pendingRpc.has(message.id)) {
                            if (this.now() - entry.rpcWindowStartedAt >= 60000 && entry.broker.pendingRpc.size === 0) {
                                entry.broker.rpcCount = 0; entry.rpcWindowStartedAt = this.now();
                            }
                            entry.broker.rpc(message).catch(() => request.controller.abort());
                        }
                    }
                }
                if (buffered.trim()) throw publicError(UNAVAILABLE);
            } finally { request.controller.abort(); request.finish(); if (entry.pumpController === request.controller) entry.pumpController = null; }
            if (this.current(entry, generation)) entry.pumpTimer = this.later(() => { entry.pump = this.events(entry, generation); entry.pump.catch(() => {}); }, this.retryDelays[0]);
        } catch (error) {
            if (entry.generation !== generation) return;
            if (!this.current(entry, generation)) { this.stop(entry.serial).catch(() => {}); return; }
            if (error?.helperStatus === 404 || error?.helperStatus === 409) this.scheduleRecovery(entry);
            else entry.pumpTimer = this.later(() => { entry.pump = this.events(entry, generation); entry.pump.catch(() => {}); }, this.retryDelays[Math.min(entry.pumpRetry++, this.retryDelays.length - 1)]);
        }
    }

    scheduleRenew(entry) {
        this.clearTimer(entry.renewTimer);
        entry.renewTimer = this.later(() => this.renew(entry).catch(() => {}), this.renewIntervalMs);
    }

    async renew(entry) {
        const generation = entry.generation;
        try {
            this.validate(entry);
            const health = await this.json(entry.connection, '/v1/health', { entry, generation });
            if (health.instance !== entry.instance || health.protocol !== 1 || health.sdk !== SDK) throw publicError(UNAVAILABLE);
            const renewed = await this.json(entry.connection, `/v1/sessions/${entry.id}/renew`, { method: 'POST', entry, generation,
                body: { owner: OWNER, epoch: this.epoch } });
            if (!this.current(entry, generation)) throw publicError(CANCELLED);
            if (renewed.renewed !== true || !Number.isFinite(renewed.expiresAt)) throw publicError(UNAVAILABLE);
            this.scheduleRenew(entry);
        } catch {
            if (this.entries.get(entry.serial) !== entry || entry.generation !== generation) return;
            try { this.validate(entry); this.scheduleRecovery(entry); }
            catch { await this.stop(entry.serial).catch(() => {}); }
        }
    }

    scheduleRecovery(entry) {
        if (entry.closing || entry.retryTimer || this.disposed) return;
        entry.ready = false; entry.status = { state: 'stopped', source: 'helper', error: UNAVAILABLE };
        this.connectionState = null;
        const delay = this.retryDelays[Math.min(entry.retry++, this.retryDelays.length - 1)];
        entry.retryTimer = this.later(() => {
            entry.retryTimer = null;
            try { this.validate(entry); } catch { this.stop(entry.serial).catch(() => {}); return; }
            if (!entry.videoDesired && !entry.snapshots) { this.stop(entry.serial).catch(() => {}); return; }
            this.invalidate(entry); entry.startPromise = null;
            entry.startPromise = this.prepare(entry).catch(() => { this.scheduleRecovery(entry); throw publicError(UNAVAILABLE); });
            entry.startPromise.catch(() => {});
        }, delay);
    }

    async refreshStatus() {
        await Promise.allSettled([...this.entries.values()].filter(entry => entry.ready && !entry.closing).map(async entry => {
            const generation = entry.generation;
            try {
                this.validate(entry);
                const status = await this.json(entry.connection, `/v1/sessions/${entry.id}/status`, { entry, generation });
                if (!this.current(entry, generation)) throw publicError(CANCELLED);
                if (status.id !== entry.id || status.deviceId !== entry.deviceId || !['starting', 'streaming', 'stopped'].includes(status.state)) throw publicError(UNAVAILABLE);
                entry.status = { state: status.state, source: 'helper', bytes: integer(status.bytes) ? status.bytes : 0,
                    ...(Number.isFinite(status.startedAt) ? { startedAt: status.startedAt } : {}),
                    ...(Number.isFinite(status.leaseStartedAt) ? { leaseStartedAt: status.leaseStartedAt } : {}),
                    ...(Number.isFinite(status.firstFrameAt) ? { firstFrameAt: status.firstFrameAt } : {}),
                    ...(status.state === 'stopped' ? { error: CAMERA_FAILED } : {}) };
            } catch {
                if (this.entries.get(entry.serial) !== entry || entry.generation !== generation) return;
                entry.status = { state: 'stopped', source: 'helper', error: UNAVAILABLE };
                try { this.validate(entry); this.scheduleRecovery(entry); }
                catch { await this.stop(entry.serial).catch(() => {}); }
            }
        }));
    }

    getStatus(serial) { return this.entries.get(serial)?.status || this.history.get(serial) || null; }

    stop(serial) {
        const entry = this.entries.get(serial);
        if (!entry) return Promise.resolve();
        if (entry.closePromise) return entry.closePromise;
        entry.closing = true; entry.videoDesired = false; this.invalidate(entry);
        entry.status = { state: 'stopped', source: 'helper', error: CANCELLED };
        entry.closePromise = (async () => {
            if (entry.requestId) {
                const closed = await this.json(entry.connection, `/v1/requests/${entry.requestId}`, { method: 'DELETE',
                    body: { owner: OWNER, epoch: this.epoch, deviceId: entry.deviceId } });
                if (closed.cancelled !== true || closed.requestId !== entry.requestId) throw publicError(CLOSING);
            }
            if (this.entries.get(serial) === entry) this.entries.delete(serial);
            this.history.set(serial, entry.status);
        })().catch(error => {
            if (error?.helperStatus === 410) { this.retireIdle(entry, entry.generation); return; }
            entry.closePromise = null; entry.status = { state: 'stopped', source: 'helper', error: CLOSING };
            if (!this.disposed) entry.retryTimer = this.later(() => { entry.retryTimer = null; this.stop(serial).catch(() => {}); }, this.retryDelays.at(-1));
            throw publicError(CLOSING);
        });
        return entry.closePromise;
    }

    reset() {
        if (this.resetPromise) return this.resetPromise;
        this.resetting = true; this.connectionState = null;
        for (const controller of this.controllers) controller.abort();
        this.resetPromise = (async () => {
            const results = await Promise.allSettled([...this.entries.keys()].map(serial => this.stop(serial)));
            if (results.some(result => result.status === 'rejected')) throw publicError(CLOSING);
            this.epoch = this.uuid();
        })().finally(() => { this.resetting = false; this.resetPromise = null; });
        return this.resetPromise;
    }

    async dispose() {
        this.disposed = true;
        for (const controller of this.controllers) controller.abort();
        return this.reset();
    }
}

module.exports = CameraHelperClient;
