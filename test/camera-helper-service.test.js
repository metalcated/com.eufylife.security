'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const nodeTest = require('node:test');

const test = (name, fn) => nodeTest(name, { timeout: 7000 }, fn);
const OWNER = 'com.eufylife.security';
const SECRET = 'b'.repeat(64);
const SDK_VERSION = '4.2.6';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    return { promise, resolve, reject };
}

const turn = () => new Promise(setImmediate);

class Camera {
    constructor(api, raw) { this.api = api; this.raw = raw; }
    static async getInstance(api, raw) { return new Camera(api, raw); }
    initialize() {}
    getSerial() { return this.raw.device_sn; }
    getStationSerial() { return this.raw.station_sn; }
    getChannel() { return this.raw.device_channel; }
    getRawDevice() { return this.raw; }
    hasCommand(name) { return name === 'deviceStartLivestream'; }
    hasProperty(name) { return name === 'enabled'; }
    getPropertyValue(name) { return name === 'enabled' ? true : undefined; }
}

const sdk = {
    Camera,
    CommandName: { DeviceStartLivestream: 'deviceStartLivestream' },
    PropertyName: { DeviceEnabled: 'enabled', DeviceRTSPStream: 'rtspStream', DeviceRTSPStreamUrl: 'rtspStreamUrl' },
    VideoCodec: { H264: 0, H265: 1 },
};

function metadata(label = 'A') {
    const station = 'FIXTURE_HOMEBASE';
    const device = `FIXTURE_CAMERA_${label}`;
    return {
        rawStation: { station_sn: station, device_type: 18, station_name: 'Synthetic HomeBase',
            p2p_did: 'FIXTURE_DID', app_conn: '', main_sw_version: '3.3.0.0', params: [],
            member: { admin_user_id: 'FIXTURE_ADMIN' } },
        rawDevice: { device_sn: device, station_sn: station, device_channel: label.charCodeAt(0) - 65,
            device_type: 1, device_name: `Synthetic ${label}`, params: [], main_sw_version: '4.0.0.0' },
        deviceConstructor: 'Camera', connectionType: 1, ipAddress: '127.0.0.1',
        config: { deviceConfig: { simultaneousDetections: true }, enableEmbeddedPKCS1Support: false },
        connected: true,
    };
}

// This fixture replaces heavy media work, while the production server still
// owns authentication, epochs, HTTP routes, capabilities, leases and cleanup.
class FixtureManager {
    constructor(homey, options, fixture) {
        this.homey = homey;
        this.options = options;
        this.fixture = fixture;
        this.sessions = new Map();
        this.stopping = new Map();
        this.starts = [];
        this.stops = [];
        this.disposed = false;
    }
    async registerVideo() {}
    async getSession(hd) {
        const serial = hd.EufyDevice.getSerial();
        if (this.sessions.has(serial)) return this.sessions.get(serial);
        const session = { serial, hd, ready: deferred(), bytes: 188, startedAt: this.fixture.now(), state: 'connecting' };
        this.sessions.set(serial, session);
        this.starts.push(serial);
        if (this.fixture.autoReady) {
            session.state = 'streaming';
            session.firstFrameAt = this.fixture.now();
            session.ready.resolve();
        }
        return session;
    }
    getStatus(serial) {
        const session = this.sessions.get(serial);
        return session ? { state: session.state, bytes: session.bytes, startedAt: session.startedAt,
            firstFrameAt: session.firstFrameAt } : { state: 'stopped', bytes: 0 };
    }
    sourceCount() { return new Set([...this.sessions.keys(), ...this.stopping.keys()]).size; }
    async stopStream(serial) {
        if (serial == null) return Promise.all([...this.sessions.keys()].map(id => this.stopStream(id)));
        if (this.stopping.has(serial)) return this.stopping.get(serial);
        const session = this.sessions.get(serial);
        if (!session) return;
        this.stops.push(serial);
        const stopped = (async () => {
            const gate = this.fixture.closeGates.get(serial);
            if (gate) await gate.promise;
            session.ready.reject(Error('Synthetic source cancelled.'));
            this.sessions.delete(serial);
        })();
        this.stopping.set(serial, stopped);
        try { await stopped; } finally { this.stopping.delete(serial); }
    }
    async dispose() {
        await Promise.all([...this.sessions.keys()].map(id => this.stopStream(id)));
        await Promise.all(this.stopping.values());
        this.disposed = true;
    }
    async serve(request, response) {
        this.fixture.mediaRequests.push(request.url);
        const bytes = Buffer.alloc(188);
        bytes[0] = 0x47;
        response.writeHead(200, { 'Content-Type': 'video/MP2T' });
        response.end(bytes);
    }
    async requestSnapshot() { return true; }
}

async function fixture(t, options = {}) {
    const { HelperServer } = require('../helper/service.cjs');
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-helper-service-test-'));
    const fixture = { now: options.now || (() => Date.now()), autoReady: options.autoReady !== false,
        closeGates: new Map(), managers: [], mediaRequests: [], servers: [] };
    t.after(async () => {
        for (const gate of fixture.closeGates.values()) gate.resolve();
        await Promise.allSettled(fixture.servers.map(server => server.close()));
        await fs.rm(workspace, { recursive: true, force: true });
    });
    const makeServer = async (extra = {}) => {
        const helper = new HelperServer({ secret: SECRET, port: 0, host: '127.0.0.1', mediaDir: workspace,
            now: fixture.now, leaseMs: options.leaseMs || 75000, startTimeoutMs: 1000, rpcTimeoutMs: 1000,
            runtime: { sdk, ManagerClass: FixtureManager },
            managerFactory: (homey, config) => {
                const manager = new FixtureManager(homey, config, fixture);
                fixture.managers.push(manager);
                return manager;
            },
            ...extra });
        const address = await helper.listen();
        fixture.servers.push(helper);
        return { helper, origin: `http://127.0.0.1:${address.port}` };
    };
    const running = await makeServer();
    Object.assign(fixture, running, { makeServer, epoch: randomUUID(), owner: OWNER });
    fixture.request = async (method, route, body, extra = {}) => {
        const response = await fetch(`${extra.origin || fixture.origin}${route}`, {
            method, headers: { Authorization: `Bearer ${SECRET}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                ...(extra.headers || {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(3000),
        });
        const text = await response.text();
        let json;
        try { json = JSON.parse(text); } catch { /* Media/error responses need not be JSON. */ }
        return { status: response.status, json, text, headers: response.headers };
    };
    fixture.connect = (body = {}, extra) => fixture.request('POST', '/v1/connect', {
        owner: fixture.owner, epoch: fixture.epoch, protocol: 1, sdk: SDK_VERSION, ...body,
    }, extra);
    fixture.open = async (label = 'A', body = {}, extra) => {
        const response = await fixture.request('POST', '/v1/sessions', {
            owner: fixture.owner, epoch: fixture.epoch, requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata(label), ...body,
        }, extra);
        assert.ok(response.status >= 200 && response.status < 300, `Session creation failed (${response.status}).`);
        assert.match(response.json.id, /^[0-9a-f-]{36}$/);
        assert.match(response.json.mediaUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1\/media\/[0-9a-f]{48}\.ts$/);
        return response.json;
    };
    if (options.connect !== false) assert.equal((await fixture.connect()).status, 200);
    return fixture;
}

async function eventReader(t, fixture, id) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 4000);
    const response = await fetch(`${fixture.origin}/v1/sessions/${id}/events`, {
        headers: { Authorization: `Bearer ${SECRET}` }, signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/x-ndjson/);
    const reader = response.body.getReader();
    let buffered = '';
    t.after(() => { clearTimeout(deadline); controller.abort(); });
    return {
        close() { controller.abort(); },
        async next() {
            while (true) {
                const at = buffered.indexOf('\n');
                if (at >= 0) {
                    const line = buffered.slice(0, at).trim(); buffered = buffered.slice(at + 1);
                    if (line) return JSON.parse(line);
                    continue;
                }
                const result = await reader.read();
                if (result.done) throw Error('The synthetic RPC event stream ended.');
                buffered += Buffer.from(result.value).toString('utf8');
            }
        },
    };
}

test('helper health and control endpoints require the persistent bearer secret', async t => {
    const f = await fixture(t, { connect: false });
    const unauthorized = await f.request('GET', '/v1/health', undefined, { headers: { Authorization: '' } });
    assert.equal(unauthorized.status, 401);
    const wrongSecret = await f.request('POST', '/v1/connect', { owner: OWNER, epoch: f.epoch, protocol: 1, sdk: SDK_VERSION },
        { headers: { Authorization: `Bearer ${'a'.repeat(64)}` } });
    assert.equal(wrongSecret.status, 401);
    assert.equal(f.managers.reduce((count, manager) => count + manager.starts.length, 0), 0);
    assert.ok(!unauthorized.text.includes(SECRET));
    const health = await f.request('GET', '/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.protocol, 1);
    assert.equal(health.json.sdk, SDK_VERSION);
    assert.match(health.json.instance, /^[0-9a-f-]{36}$/);
});

test('incompatible protocol or SDK fails before reserving any camera', async t => {
    const f = await fixture(t, { connect: false });
    assert.ok((await f.connect({ protocol: 2 })).status >= 400);
    assert.ok((await f.connect({ sdk: '4.3.0' })).status >= 400);
    assert.equal(f.helper.records.size, 0);
    assert.equal(f.managers.reduce((count, manager) => count + manager.starts.length, 0), 0);
    assert.equal((await f.connect()).status, 200, 'a rejected upgrade must leave the supported version usable');
    await f.open();
});

test('a media capability cannot create a camera without a current validated lease', async t => {
    const f = await fixture(t);
    const session = await f.open();
    const route = new URL(session.mediaUrl).pathname;
    const active = await fetch(session.mediaUrl, { signal: AbortSignal.timeout(2000) });
    assert.equal(active.status, 200);
    await active.arrayBuffer();
    const removed = await f.request('DELETE', `/v1/sessions/${session.id}`, { owner: OWNER, epoch: f.epoch });
    assert.equal(removed.status, 200);
    const stale = await fetch(`${f.origin}${route}`, { signal: AbortSignal.timeout(2000) });
    assert.equal(stale.status, 404);
    await stale.arrayBuffer();
    assert.equal(f.helper.records.size, 0);
});

test('recreating the helper with the same secret preserves links but never resurrects a lease', async t => {
    const f = await fixture(t);
    const deviceId = randomUUID();
    const oldHealth = (await f.request('GET', '/v1/health')).json;
    const old = await f.open('A', { deviceId });
    const oldRoute = new URL(old.mediaUrl).pathname;
    await f.helper.close();
    const replacement = await f.makeServer();
    f.helper = replacement.helper;
    f.origin = replacement.origin;
    f.epoch = randomUUID();
    const health = (await f.request('GET', '/v1/health')).json;
    assert.notEqual(health.instance, oldHealth.instance);
    assert.equal((await f.request('GET', oldRoute)).status, 404);
    assert.equal((await f.request('GET', `/v1/sessions/${old.id}/status`)).status, 404);
    assert.equal((await f.connect()).status, 200);
    const reopened = await f.open('A', { deviceId });
    assert.notEqual(reopened.id, old.id);
    assert.equal(new URL(reopened.mediaUrl).pathname, oldRoute, 'persistent links must not encode the transient instance or epoch');
    assert.equal((await f.request('GET', oldRoute)).status, 200);
});

test('stopping one camera leaves a same-HomeBase peer and its media lease intact', async t => {
    const f = await fixture(t);
    const a = await f.open('A');
    const b = await f.open('B');
    assert.equal((await f.request('DELETE', `/v1/sessions/${a.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
    assert.equal((await f.request('GET', `/v1/sessions/${b.id}/status`)).status, 200);
    assert.equal((await f.request('GET', new URL(b.mediaUrl).pathname)).status, 200);
    assert.equal((await f.request('GET', new URL(a.mediaUrl).pathname)).status, 404);
    assert.ok(f.managers.at(-1).sessions.has('FIXTURE_CAMERA_B'));
    assert.ok(!f.managers.at(-1).stops.includes('FIXTURE_CAMERA_B'));
});

test('lease expiry revokes media access and closes the source until explicit restoration', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, leaseMs: 100 });
    const session = await f.open();
    now += 101;
    await f.helper.prune();
    assert.equal((await f.request('GET', `/v1/sessions/${session.id}/status`)).status, 404);
    assert.equal((await f.request('GET', new URL(session.mediaUrl).pathname)).status, 404);
    assert.equal(f.helper.records.size, 0);
    assert.ok(f.managers.at(-1).stops.includes('FIXTURE_CAMERA_A'));
    await turn();
    assert.equal(f.managers.at(-1).starts.length, 1, 'expiry must not start its own reconnect loop');
});

test('an expired app epoch cannot renew or revive a session after reconnect', async t => {
    const f = await fixture(t);
    const oldEpoch = f.epoch;
    const old = await f.open();
    f.epoch = randomUUID();
    assert.equal((await f.connect()).status, 200);
    assert.equal((await f.request('POST', `/v1/sessions/${old.id}/renew`, { owner: OWNER, epoch: oldEpoch })).status, 404);
    assert.equal((await f.request('GET', new URL(old.mediaUrl).pathname)).status, 404);
    const staleOpen = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: oldEpoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('B') });
    assert.ok(staleOpen.status >= 400);
    assert.equal(f.helper.records.size, 0);
    await f.open('B');
});

test('the four-source cap counts cameras still connecting', async t => {
    const f = await fixture(t, { autoReady: false });
    for (const label of ['A', 'B', 'C', 'D']) await f.open(label);
    const fifth = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('E') });
    assert.ok(fifth.status >= 400, 'a fifth pending source escaped the capacity bound');
    assert.equal(f.helper.records.size, 4);
    assert.equal(f.managers.at(-1).starts.length, 4);
});

test('cancelling before session creation leaves a tombstone that blocks a delayed POST', async t => {
    const f = await fixture(t);
    const requestId = randomUUID();
    const deviceId = randomUUID();
    const cancelled = await f.request('DELETE', `/v1/requests/${requestId}`, { owner: OWNER, epoch: f.epoch, deviceId });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.cancelled, true);
    const delayed = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId, deviceId, metadata: metadata('A') });
    assert.equal(delayed.status, 409);
    assert.equal(f.helper.records.size, 0);
    assert.equal(f.managers.at(-1).starts.length, 0);
    await f.open('A', { deviceId });
});

test('retrying an uncertain creation request is idempotent and cannot allocate twice', async t => {
    const f = await fixture(t);
    const requestId = randomUUID();
    const deviceId = randomUUID();
    const first = await f.open('A', { requestId, deviceId });
    const replayed = await f.open('A', { requestId, deviceId });
    assert.deepEqual(replayed, first);
    assert.equal(f.managers.at(-1).starts.length, 1);
    assert.equal(f.helper.records.size, 1);
    const mismatched = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId, deviceId: randomUUID(), metadata: metadata('B') });
    assert.equal(mismatched.status, 409);
    assert.equal(f.managers.at(-1).starts.length, 1);
});

test('request cancellation revokes an uncertain source while preserving a peer', async t => {
    const f = await fixture(t);
    const requestId = randomUUID();
    const deviceId = randomUUID();
    const unknownToCaller = await f.open('A', { requestId, deviceId });
    const peer = await f.open('B');
    const cancelled = await f.request('DELETE', `/v1/requests/${requestId}`, { owner: OWNER, epoch: f.epoch, deviceId });
    assert.equal(cancelled.status, 200);
    assert.equal((await f.request('GET', `/v1/sessions/${unknownToCaller.id}/status`)).status, 404);
    assert.equal((await f.request('GET', new URL(unknownToCaller.mediaUrl).pathname)).status, 404);
    assert.equal((await f.request('GET', `/v1/sessions/${peer.id}/status`)).status, 200);
    assert.ok(!f.managers.at(-1).stops.includes('FIXTURE_CAMERA_B'));
});

test('source capacity remains reserved until cancellation confirms cleanup', async t => {
    const f = await fixture(t);
    const requestId = randomUUID();
    const deviceId = randomUUID();
    const first = await f.open('A', { requestId, deviceId });
    for (const label of ['B', 'C', 'D']) await f.open(label);
    const gate = deferred();
    f.closeGates.set('FIXTURE_CAMERA_A', gate);
    let cancellationFinished = false;
    const cancelling = f.request('DELETE', `/v1/requests/${requestId}`, { owner: OWNER, epoch: f.epoch, deviceId })
        .then(result => { cancellationFinished = true; return result; });
    for (let index = 0; index < 10 && !f.managers.at(-1).stops.includes('FIXTURE_CAMERA_A'); index++) await turn();
    assert.equal(cancellationFinished, false);
    assert.equal((await f.request('GET', new URL(first.mediaUrl).pathname)).status, 404,
        'closing must revoke the public capability before waiting for heavy cleanup');
    let fifthFinished = false;
    const fifth = f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        requestId: randomUUID(), deviceId: randomUUID(), metadata: metadata('E') })
        .then(result => { fifthFinished = true; return result; });
    for (let index = 0; index < 10; index++) await turn();
    assert.equal(fifthFinished, false, 'new allocation must await confirmation that the old source closed');
    assert.equal(f.managers.at(-1).starts.length, 4);
    gate.resolve();
    assert.equal((await cancelling).status, 200);
    assert.equal((await fifth).status, 200);
    assert.equal(f.managers.at(-1).starts.length, 5);
});

test('account-token metadata and malformed JSON are rejected before source allocation', async t => {
    const f = await fixture(t);
    for (const name of ['access_token', 'refreshToken', 'auth_token', 'apiKey', 'password']) {
        const value = metadata(); value.rawStation[name] = 'ACCOUNT_SECRET_SENTINEL';
        const response = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
            requestId: randomUUID(), deviceId: randomUUID(), metadata: value });
        assert.equal(response.status, 400);
        assert.ok(!response.text.includes('ACCOUNT_SECRET_SENTINEL'));
    }
    const malformed = await fetch(`${f.origin}/v1/sessions`, { method: 'POST',
        headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }, body: '{', signal: AbortSignal.timeout(2000) });
    assert.equal(malformed.status, 400); await malformed.text();
    assert.equal(f.helper.records.size, 0);
    assert.equal(f.managers.at(-1).starts.length, 0);
    await f.open();
});

test('only the lease camera and original station owner may issue SDK cloud requests', async t => {
    const f = await fixture(t);
    const session = await f.open();
    const record = f.helper.records.get(session.id);
    const api = record.hd.rpcClient.getApi();
    await assert.rejects(api.getCipher(7, 'OTHER_ADMIN'));
    await assert.rejects(api.getCipher(65536, 'FIXTURE_ADMIN'));
    await assert.rejects(api.getPublicKey('OTHER_HOMEBASE', 2));
    await assert.rejects(api.getVoices('OTHER_CAMERA'));
    await assert.rejects(api.request({ method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys',
        data: { station_sns: ['OTHER_HOMEBASE'], invalid_dsks: { OTHER_HOMEBASE: '' }, transaction: '1700000000000' } }));
    assert.equal(record.pending.size, 0);
    assert.equal(record.rpcId, 0, 'forbidden requests must not produce replayable RPC events');
    const events = await eventReader(t, f, session.id);
    const call = api.getCipher(7, 'FIXTURE_ADMIN'); call.catch(() => {});
    const packet = await events.next();
    assert.deepEqual({ method: packet.method, args: packet.args }, { method: 'getCipher', args: [7, 'FIXTURE_ADMIN'] });
    assert.equal((await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: packet.id })).status, 200);
    assert.equal(await call, undefined, 'the ID-only response is the protocol representation of undefined');
});

test('RPC event reconnection replays the same pending ID and rejects stale replies after cancellation', async t => {
    const f = await fixture(t);
    const session = await f.open();
    const record = f.helper.records.get(session.id);
    const pending = record.hd.rpcClient.getApi().getCipher(7, 'FIXTURE_ADMIN'); pending.catch(() => {});
    const firstStream = await eventReader(t, f, session.id);
    const first = await firstStream.next(); firstStream.close();
    const secondStream = await eventReader(t, f, session.id);
    assert.deepEqual(await secondStream.next(), first);
    assert.equal(record.pending.size, 1);
    assert.equal((await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: first.id + 100, value: {} })).status, 404);
    assert.equal(record.pending.size, 1);
    await f.request('DELETE', `/v1/sessions/${session.id}`, { owner: OWNER, epoch: f.epoch });
    await assert.rejects(pending);
    const late = await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: first.id, value: { private_key: 'STALE_FIXTURE' } });
    assert.equal(late.status, 404);
    assert.equal(record.pending.size, 0);
    assert.equal(f.helper.records.size, 0);
});

test('the helper permits at most four pending RPCs and releases them all on privacy cancellation', async t => {
    const f = await fixture(t);
    const session = await f.open();
    const record = f.helper.records.get(session.id), api = record.hd.rpcClient.getApi();
    const calls = Array.from({ length: 4 }, (_, index) => api.getCipher(index, 'FIXTURE_ADMIN'));
    for (const call of calls) call.catch(() => {});
    await assert.rejects(api.getCipher(4, 'FIXTURE_ADMIN'));
    assert.equal(record.pending.size, 4);
    await f.request('DELETE', `/v1/sessions/${session.id}`, { owner: OWNER, epoch: f.epoch });
    assert.ok((await Promise.allSettled(calls)).every(result => result.status === 'rejected'));
    assert.equal(record.pending.size, 0);
});

test('RPC rate windows reset only after a minute with no pending calls, preserving monotonic IDs', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now });
    const session = await f.open();
    const record = f.helper.records.get(session.id), api = record.hd.rpcClient.getApi();
    const events = await eventReader(t, f, session.id);
    const held = api.getCipher(0, 'FIXTURE_ADMIN'); held.catch(() => {});
    const heldPacket = await events.next();
    now += 60000;
    let last = heldPacket.id;
    for (let index = 1; index < 32; index++) {
        const call = api.getCipher(index, 'FIXTURE_ADMIN'); call.catch(() => {});
        const packet = await events.next();
        assert.ok(packet.id > last); last = packet.id;
        assert.equal((await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: packet.id })).status, 200);
        assert.equal(await call, undefined);
    }
    await assert.rejects(api.getCipher(32, 'FIXTURE_ADMIN'));
    assert.equal(record.pending.size, 1, 'a minute alone must not reset the window while an old call remains pending');
    assert.equal(record.rpcId, last);
    await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: heldPacket.id }); await held;
    const renewed = api.getCipher(33, 'FIXTURE_ADMIN'); renewed.catch(() => {});
    const packet = await events.next();
    assert.ok(packet.id > last, 'new windows must not reuse an old cached reply ID');
    await f.request('POST', `/v1/sessions/${session.id}/rpc`, { id: packet.id }); await renewed;
});

test('bounded cancellation tombstones cannot be evicted to revive an earlier delayed request', async t => {
    const f = await fixture(t);
    const first = { requestId: randomUUID(), deviceId: randomUUID() };
    for (let index = 0; index < 128; index++) {
        const binding = index === 0 ? first : { requestId: randomUUID(), deviceId: randomUUID() };
        const response = await f.request('DELETE', `/v1/requests/${binding.requestId}`, { owner: OWNER, epoch: f.epoch, deviceId: binding.deviceId });
        assert.equal(response.status, 200);
    }
    const extra = await f.request('DELETE', `/v1/requests/${randomUUID()}`, { owner: OWNER, epoch: f.epoch, deviceId: randomUUID() });
    assert.equal(extra.status, 429);
    const delayed = await f.request('POST', '/v1/sessions', { owner: OWNER, epoch: f.epoch,
        ...first, metadata: metadata('A') });
    assert.equal(delayed.status, 409);
    assert.equal(f.helper.records.size, 0);
    assert.equal(f.managers.at(-1).starts.length, 0);
});

test('epoch replacement closes every old source even if one cleanup fails', async t => {
    const f = await fixture(t);
    const previousEpoch = f.epoch;
    const first = await f.open('A');
    const peer = await f.open('B');
    const failed = deferred(); failed.reject(Error('Synthetic cleanup failure.'));
    f.closeGates.set('FIXTURE_CAMERA_A', failed);
    f.epoch = randomUUID();
    assert.equal((await f.connect()).status, 503);
    assert.ok(f.managers.at(-1).stops.includes('FIXTURE_CAMERA_B'), 'one cleanup failure prevented peer disposal');
    assert.ok(f.helper.records.has(first.id), 'unconfirmed cleanup must retain its capacity reservation');
    assert.ok(!f.helper.records.has(peer.id));
    assert.equal((await f.request('GET', new URL(first.mediaUrl).pathname)).status, 404);
    f.closeGates.delete('FIXTURE_CAMERA_A');
    assert.equal((await f.request('DELETE', `/v1/sessions/${first.id}`, { owner: OWNER, epoch: previousEpoch })).status, 200);
    assert.equal(f.helper.records.size, 0);
});

test('lease pruning disposes every expired source while retaining only failed cleanup reservations', async t => {
    let now = 1000;
    const f = await fixture(t, { now: () => now, leaseMs: 100 });
    const first = await f.open('A');
    const peer = await f.open('B');
    const failed = deferred(); failed.reject(Error('Synthetic cleanup failure.'));
    f.closeGates.set('FIXTURE_CAMERA_A', failed);
    now += 101;
    await assert.rejects(f.helper.prune());
    assert.ok(f.managers.at(-1).stops.includes('FIXTURE_CAMERA_B'));
    assert.ok(f.helper.records.has(first.id));
    assert.ok(!f.helper.records.has(peer.id));
    f.closeGates.delete('FIXTURE_CAMERA_A');
    assert.equal((await f.request('DELETE', `/v1/sessions/${first.id}`, { owner: OWNER, epoch: f.epoch })).status, 200);
    assert.equal(f.helper.records.size, 0);
});
