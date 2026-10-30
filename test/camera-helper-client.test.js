'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const CameraHelperClient = require('../lib/helpers/camera-helper-client.helper');
const SECRET = 'fixture-account-secret';
const ORIGIN = 'http://127.0.0.1:32199';
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(setImmediate); };

function heldJSON(value) {
    let body;
    const response = new Response(new ReadableStream({ start(controller) { body = controller; } }),
        { headers: { 'Content-Type': 'application/json' } });
    return { response, finish() { body.enqueue(Buffer.from(JSON.stringify(value))); body.close(); } };
}

function harness(t, options = {}) {
    const settings = new Map([['camera_helper_devices', true], ['camera_helper_connection', { url: ORIGIN, token: 'a'.repeat(64), protocol: 1 }]]);
    const records = new Map(), tombstones = new Set(), calls = [], apiCalls = [], timers = new Set();
    let counter = 1, instance = uuid(900), ownerEpoch, local = options.local || 0, clock = 0;
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const state = { settings, records, tombstones, calls, apiCalls, timers, failDelete: false, hook: null };
    const api = { isConnected: () => true,
        getCipher: async (...args) => { apiCalls.push(['getCipher', ...args]); return state.cipher ? state.cipher(...args) : { private_key: 'own-key', token: SECRET }; },
        getPublicKey: async (...args) => { apiCalls.push(['getPublicKey', ...args]); return 'own-public'; },
        getVoices: async (...args) => { apiCalls.push(['getVoices', ...args]); return {}; },
        request: async (...args) => { apiCalls.push(['request', ...args]); return { status: 200, data: { code: 0, data: { dsk_keys: [] }, token: SECRET } }; },
    };
    const account = { getApi: () => api, isConnected: () => true,
        getConfig: () => ({ password: SECRET, cloudToken: SECRET, stationIPAddresses: { BASE: '127.0.0.1' } }) };
    const homey = { settings: { get: name => settings.get(name) }, app: { eufyClient: account } };
    class Camera {
        constructor(serial) { this.serial = serial; }
        getSerial() { return this.serial; }
        getStationSerial() { return 'BASE'; }
        getRawDevice() { return { device_sn: this.serial, station_sn: 'BASE', token: SECRET }; }
    }
    const station = { getRawStation: () => ({ station_sn: 'BASE', token: SECRET, member: { admin_user_id: 'ADMIN' } }), getConnectionType: () => 1 };
    const camera = serial => ({ EufyDevice: new Camera(serial), EufyStation: station, allowed: true, getId: () => uuid(100 + serial.charCodeAt(0)) });
    const fetch = async (url, request) => {
        const pathname = new URL(url).pathname;
        assert.equal(new URL(url).origin, ORIGIN); assert.equal(request.redirect, 'error');
        assert.equal(request.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
        const body = request.body ? JSON.parse(request.body) : undefined;
        calls.push({ pathname, method: request.method, body, signal: request.signal });
        if (request.signal.aborted) throw Error('aborted');
        if (state.hook) {
            const intercepted = await state.hook(pathname, request, body);
            if (intercepted !== undefined) return intercepted;
        }
        if (pathname === '/v1/health') return response({ protocol: 1, version: '0.1.0', sdk: '4.2.6', instance });
        if (pathname === '/v1/connect') { ownerEpoch = body.epoch; return response({ protocol: 1, version: '0.1.0', sdk: '4.2.6', instance, ...body }); }
        if (pathname === '/v1/sessions') {
            if (tombstones.has(body.requestId)) return response({ error: SECRET }, 409);
            assert.equal(body.epoch, ownerEpoch); assert.equal(JSON.stringify(body.metadata).includes(SECRET), false);
            const id = uuid(counter++), cap = crypto.createHash('sha256').update(body.deviceId).digest('hex').slice(0, 48);
            const record = { id, deviceId: body.deviceId, requestId: body.requestId, streams: [], replies: [], bytes: 376, state: 'streaming' };
            records.set(id, record);
            return response({ id, mediaUrl: `${ORIGIN}/v1/media/${cap}.ts` });
        }
        const cancellation = /^\/v1\/requests\/([^/]+)$/.exec(pathname);
        if (cancellation) {
            if (state.failDelete) return response({ error: SECRET }, 503);
            tombstones.add(cancellation[1]);
            for (const [id, record] of records) if (record.requestId === cancellation[1]) { closeEvents(record); records.delete(id); }
            return response({ cancelled: true, requestId: cancellation[1] });
        }
        const match = /^\/v1\/sessions\/([^/]+)\/(events|ready|renew|rpc|status|snapshot)$/.exec(pathname);
        const record = match && records.get(match[1]);
        if (!record) return response({ error: SECRET }, 404);
        switch (match[2]) {
            case 'events': {
                const stream = new ReadableStream({ start(controller) {
                    record.streams.push(controller);
                    request.signal.addEventListener('abort', () => { try { controller.error(Error('aborted')); } catch {} }, { once: true });
                } });
                return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
            }
            case 'ready': return response({ ready: true, id: record.id });
            case 'renew': return response({ renewed: true, expiresAt: Date.now() + 75000 });
            case 'rpc': record.replies.push(body); return response({ accepted: true });
            case 'status': return response({ id: record.id, deviceId: record.deviceId, state: record.state, bytes: record.bytes,
                startedAt: record.startedAt ?? 100,
                ...(Object.hasOwn(record, 'leaseStartedAt') ? { leaseStartedAt: record.leaseStartedAt } : {}),
                ...(Object.hasOwn(record, 'firstFrameAt') ? { firstFrameAt: record.firstFrameAt } : {}),
                error: SECRET, details: SECRET, token: SECRET });
            case 'snapshot': return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'Content-Type': 'image/jpeg' } });
        }
    };
    const closeEvents = record => { for (const stream of record.streams) { try { stream.error(Error('closed')); } catch {} } record.streams = []; };
    const client = new CameraHelperClient({ homey, fetch, localSourceCount: () => local,
        assertCamera: device => { if (!device.allowed) throw Object.assign(Error('Camera is in privacy mode.'), { mediaPublic: true }); },
        randomUUID: () => uuid(counter++), now: () => clock, requestTimeoutMs: 100, readyTimeoutMs: 500, eventsTimeoutMs: 10000,
        renewIntervalMs: 20, retryDelays: [7, 13, 27],
        setTimeout(fn, delay) { const token = { fn, delay, unref() {} }; timers.add(token); return token; },
        clearTimeout: token => timers.delete(token) });
    t.after(async () => { state.failDelete = false; state.hook = null; await client.dispose().catch(() => {}); for (const record of records.values()) closeEvents(record); });
    return Object.assign(state, { client, homey, account, station, camera, response, local: count => { local = count; }, advance: ms => { clock += ms; },
        emit(record, message) { for (const stream of record.streams) { try { stream.enqueue(Buffer.from(`${JSON.stringify(message)}\n`)); } catch {} } },
        restart() { for (const record of records.values()) closeEvents(record); records.clear(); instance = uuid(901); },
        fire(delay) { const selected = [...timers].filter(timer => timer.delay === delay); assert.ok(selected.length, `missing timer ${delay}`);
            for (const timer of selected) { timers.delete(timer); timer.fn(); } },
    });
}

test('helper settings are opt-in, loopback-only and exact-device selected', async t => {
    const h = harness(t), camera = h.camera('A');
    assert.equal(h.client.enabled(camera), true);
    h.settings.set('camera_helper_devices', [h.camera('B').getId()]); assert.equal(h.client.selected(camera), false);
    h.settings.set('camera_helper_devices', true);
    for (const url of ['https://127.0.0.1:32199', 'http://localhost:32199', 'http://192.168.1.1:32199', 'http://127.0.0.1:32199/path',
        'http://user@127.0.0.1:32199', 'http://127.0.0.1:32199?token=x', 'http://127.0.0.1:0']) {
        h.settings.set('camera_helper_connection', { url, token: 'a'.repeat(64), protocol: 1 });
        assert.equal(h.client.enabled(camera), false); await assert.rejects(h.client.videoUrl(camera), error => error.mediaPublic && !error.message.includes(SECRET));
    }
    assert.equal(h.calls.length, 0); assert.equal(h.client.sourceCount(), 0);
});

test('one native helper lease serves repeated video calls and snapshots without account credentials in its URL or metadata', async t => {
    const h = harness(t), camera = h.camera('A');
    const [first, second] = await Promise.all([h.client.videoUrl(camera), h.client.videoUrl(camera)]);
    assert.equal(first, second); assert.match(first, /^http:\/\/127\.0\.0\.1:32199\/v1\/media\/[a-f0-9]{48}\.ts$/);
    assert.equal(first.includes('a'.repeat(64)), false);
    assert.deepEqual(await h.client.snapshot(camera), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
    assert.equal(h.records.size, 1); assert.equal(h.client.sourceCount(), 1);
    await h.client.stop('A'); assert.equal(h.records.size, 0); assert.equal(h.client.sourceCount(), 0);
});

test('the actual strict broker forwards only own-camera RPC and caches replies for NDJSON replay', async t => {
    const h = harness(t); await h.client.videoUrl(h.camera('A')); await flush();
    const record = [...h.records.values()][0];
    h.emit(record, { id: 1, method: 'getCipher', args: [7, 'ADMIN'] }); await flush();
    assert.deepEqual(h.apiCalls, [['getCipher', 7, 'ADMIN']]);
    assert.deepEqual(record.replies, [{ id: 1, value: { private_key: 'own-key' } }]);
    h.emit(record, { id: 1, method: 'getCipher', args: [7, 'ADMIN'] }); await flush();
    assert.equal(h.apiCalls.length, 1); assert.equal(record.replies.length, 2);
    h.emit(record, { id: 2, method: 'getCipher', args: [7, 'OTHER'] });
    h.emit(record, { id: 3, method: 'setGuardMode', args: ['BASE', 0] }); await flush();
    assert.equal(h.apiCalls.length, 1); assert.equal(record.replies.slice(-2).every(reply => typeof reply.error === 'string'), true);
    assert.equal(JSON.stringify(record.replies).includes(SECRET), false);
});

test('undefined cipher replies use the exact id-only HTTP contract and late replies are dropped after Stop', async t => {
    const h = harness(t), pending = deferred(); h.cipher = async () => undefined;
    await h.client.videoUrl(h.camera('A')); await flush(); const record = [...h.records.values()][0];
    h.emit(record, { id: 1, method: 'getCipher', args: [7, 'ADMIN'] }); await flush();
    assert.deepEqual(record.replies, [{ id: 1 }]);
    h.cipher = () => pending.promise;
    h.emit(record, { id: 2, method: 'getCipher', args: [7, 'ADMIN'] }); await flush();
    await h.client.stop('A'); pending.resolve({ private_key: SECRET }); await flush();
    assert.equal(record.replies.length, 1); assert.equal(h.client.sourceCount(), 0);
});

test('privacy and replaced account identities revoke the helper lease before replying to another RPC', async t => {
    for (const change of ['privacy', 'device', 'station', 'client']) {
        const h = harness(t), camera = h.camera('A'); await h.client.videoUrl(camera); await flush();
        const record = [...h.records.values()][0];
        if (change === 'privacy') camera.allowed = false;
        else if (change === 'device') camera.EufyDevice = h.camera('B').EufyDevice;
        else if (change === 'station') camera.EufyStation = {};
        else h.homey.app.eufyClient = {};
        h.emit(record, { id: 1, method: 'getCipher', args: [7, 'ADMIN'] }); await flush();
        assert.equal(h.apiCalls.length, 0); assert.equal(h.records.size, 0); assert.equal(h.client.sourceCount(), 0);
    }
});

test('global source capacity includes local sources, pending leases and failed cleanup until retry proves cancellation', async t => {
    const h = harness(t, { local: 3 }); await h.client.videoUrl(h.camera('A'));
    await assert.rejects(h.client.videoUrl(h.camera('B')), /four active/);
    h.failDelete = true; await assert.rejects(h.client.stop('A'), error => error.mediaPublic && error.cameraHelper === true);
    assert.equal(h.client.sourceCount(), 1); await assert.rejects(h.client.videoUrl(h.camera('B')), /four active/);
    h.failDelete = false; await h.client.stop('A'); assert.equal(h.client.sourceCount(), 0);
    await h.client.videoUrl(h.camera('B')); assert.equal(h.client.sourceCount(), 1);
});

test('Stop tombstones a known request before a delayed creation can allocate or install a late lease', async t => {
    const h = harness(t), barrier = deferred();
    h.hook = async pathname => { if (pathname === '/v1/sessions') await barrier.promise; };
    const pending = h.client.videoUrl(h.camera('A')); pending.catch(() => {}); await flush();
    const create = h.calls.find(call => call.pathname === '/v1/sessions'); assert.ok(create);
    await h.client.stop('A'); assert.equal(h.tombstones.has(create.body.requestId), true); assert.equal(h.client.sourceCount(), 0);
    barrier.resolve(); await assert.rejects(pending, error => error.mediaPublic); await flush();
    assert.equal(h.records.size, 0); assert.equal(h.client.sourceCount(), 0);
});

test('helper restart recreates only desired, revalidated video with the same media capability and ignores old channel completion', async t => {
    const h = harness(t), camera = h.camera('A'), first = await h.client.videoUrl(camera); await flush();
    const old = [...h.records.values()][0]; h.restart();
    h.fire(20); await flush();
    const retry = h.client.entries.get('A').retryTimer;
    assert.ok(retry.delay >= 7 && retry.delay <= 27); h.fire(retry.delay); await flush();
    assert.equal(h.records.size, 1); assert.equal(h.client.sourceCount(), 1);
    assert.equal(await h.client.videoUrl(camera), first);
    assert.notEqual([...h.records.values()][0].id, old.id);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 2);
    await h.client.stop('A'); h.restart(); await flush(); assert.equal(h.records.size, 0);
});

test('snapshot-only callers share a lease and release it after the final image; invalid images never escape', async t => {
    const h = harness(t), camera = h.camera('A');
    const images = await Promise.all([h.client.snapshot(camera), h.client.snapshot(camera)]);
    assert.equal(images.length, 2); assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
    assert.equal(h.client.sourceCount(), 0); assert.equal(h.records.size, 0);
    h.hook = async pathname => pathname.endsWith('/snapshot') ? new Response(Buffer.from('not JPEG')) : undefined;
    await assert.rejects(h.client.snapshot(camera), error => error.mediaPublic && !error.message.includes(SECRET));
    assert.equal(h.client.sourceCount(), 0);
});

test('remote status fields and errors are reduced to safe cached state, and unrelated devices return null', async t => {
    const h = harness(t); assert.equal(h.client.getStatus('unowned'), null);
    await h.client.videoUrl(h.camera('A')); await h.client.refreshStatus();
    assert.deepEqual(h.client.getStatus('A'), { state: 'streaming', source: 'helper', bytes: 376, startedAt: 100 });
    [...h.records.values()][0].state = 'stopped'; await h.client.refreshStatus();
    assert.equal(h.client.getStatus('A').state, 'stopped'); assert.equal(JSON.stringify(h.client.getStatus('A')).includes(SECRET), false);
});

test('helper status follows source restarts while retaining the separate lease timestamp', async t => {
    const h = harness(t);
    await h.client.videoUrl(h.camera('A'));
    assert.equal(Object.hasOwn(h.client.getStatus('A'), 'startedAt'), false, 'local readiness must not invent a source timestamp');
    const source = [...h.records.values()][0];
    Object.assign(source, { startedAt: 1000, firstFrameAt: 1100, leaseStartedAt: 900, bytes: 9400 });
    await h.client.refreshStatus();
    assert.deepEqual(h.client.getStatus('A'), { state: 'streaming', source: 'helper', bytes: 9400,
        startedAt: 1000, leaseStartedAt: 900, firstFrameAt: 1100 });

    Object.assign(source, { startedAt: 300000, firstFrameAt: 300100, bytes: 376 });
    await h.client.refreshStatus();
    assert.equal(h.records.size, 1, 'a source can restart within the same lease');
    assert.deepEqual(h.client.getStatus('A'), { state: 'streaming', source: 'helper', bytes: 376,
        startedAt: 300000, leaseStartedAt: 900, firstFrameAt: 300100 });

    Object.assign(source, { leaseStartedAt: SECRET, firstFrameAt: { token: SECRET } });
    await h.client.refreshStatus();
    assert.deepEqual(h.client.getStatus('A'), { state: 'streaming', source: 'helper', bytes: 376, startedAt: 300000 });
});

test('viewer-idle retirement frees four cached slots for a fifth camera and a fresh same-camera callback', async t => {
    const h = harness(t), retired = new Set(), oldEntries = [];
    const urls = new Map();
    for (const serial of ['A', 'B', 'C', 'D']) urls.set(serial, await h.client.videoUrl(h.camera(serial)));
    oldEntries.push(...h.client.entries.values());
    for (const record of h.records.values()) retired.add(record.id);
    h.records.clear();
    h.hook = async pathname => [...retired].some(id => pathname.startsWith(`/v1/sessions/${id}/`)) ? h.response({}, 410) : undefined;

    await h.client.videoUrl(h.camera('E'));
    assert.equal(h.client.sourceCount(), 1); assert.equal(h.records.size, 1);
    assert.ok(oldEntries.every(entry => entry.closing && !entry.videoDesired && !entry.ready));
    assert.ok([...h.timers].every(timer => ![7, 13, 27].includes(timer.delay)), 'retired leases must not schedule recovery');
    assert.equal(await h.client.videoUrl(h.camera('A')), urls.get('A'), 'a fresh lease retains the canonical media address');
    assert.equal(h.client.sourceCount(), 2); assert.equal(h.records.size, 2);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 6);
    assert.ok(!retired.has(h.client.entries.get('A').id));
});

test('idle retirement during renewal removes only the unused lease without recreating it', async t => {
    const h = harness(t);
    await h.client.videoUrl(h.camera('A')); await h.client.videoUrl(h.camera('B'));
    const idle = h.client.entries.get('A'), active = h.client.entries.get('B');
    h.records.delete(idle.id);
    h.hook = async pathname => pathname === `/v1/sessions/${idle.id}/renew` ? h.response({}, 410) : undefined;
    await h.client.renew(idle); await flush();
    assert.equal(h.client.sourceCount(), 1); assert.equal(h.client.entries.get('B'), active);
    assert.equal(active.ready, true);
    assert.deepEqual(h.client.getStatus('A'), { state: 'stopped', source: 'helper' });
    assert.ok([...h.timers].every(timer => ![7, 13, 27].includes(timer.delay)));
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 2);
});

test('an idle events response retires the lease instead of starting desired-video recovery', async t => {
    const h = harness(t);
    await h.client.videoUrl(h.camera('A')); await flush();
    const entry = h.client.entries.get('A'), remote = h.records.get(entry.id);
    h.records.delete(entry.id);
    h.hook = async pathname => pathname === `/v1/sessions/${entry.id}/events` ? h.response({}, 410) : undefined;
    for (const stream of remote.streams) stream.close();
    await flush(); h.fire(7); await flush();
    assert.equal(h.client.sourceCount(), 0);
    assert.ok([...h.timers].every(timer => ![7, 13, 27].includes(timer.delay)));
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
});

test('idle retirement during readiness or a snapshot cannot leave a reservation or recovery timer', async t => {
    for (const endpoint of ['ready', 'snapshot']) await t.test(endpoint, async subtest => {
        const h = harness(subtest), camera = h.camera('A');
        if (endpoint === 'snapshot') await h.client.videoUrl(camera);
        h.hook = async pathname => pathname.endsWith(`/${endpoint}`) ? h.response({}, 410) : undefined;
        await assert.rejects(endpoint === 'ready' ? h.client.videoUrl(camera) : h.client.snapshot(camera), error => error.mediaPublic === true);
        await flush();
        assert.equal(h.client.sourceCount(), 0);
        assert.deepEqual(h.client.getStatus('A'), { state: 'stopped', source: 'helper' });
        assert.ok([...h.timers].every(timer => ![7, 13, 27].includes(timer.delay)));
    });
});

test('a confirmed idle response during explicit Stop releases the slot without a failed-close retry', async t => {
    const h = harness(t); await h.client.videoUrl(h.camera('A'));
    h.hook = async pathname => pathname.startsWith('/v1/requests/') ? h.response({}, 410) : undefined;
    await h.client.stop('A'); await flush();
    assert.equal(h.client.sourceCount(), 0);
    assert.ok([...h.timers].every(timer => ![7, 13, 27].includes(timer.delay)));
});

test('recovery cancellation of an already idle-retired request cannot create another lease', async t => {
    const h = harness(t);
    await h.client.videoUrl(h.camera('A')); await h.client.videoUrl(h.camera('B'));
    const idle = h.client.entries.get('A'), active = h.client.entries.get('B');
    const requestPath = `/v1/requests/${idle.requestId}`;
    h.records.delete(idle.id);
    h.hook = async pathname => pathname === requestPath ? h.response({}, 410) : undefined;

    h.client.scheduleRecovery(idle);
    h.fire(7); await flush();
    assert.equal(h.calls.filter(call => call.pathname === requestPath && call.method === 'DELETE').length, 1);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 2, 'confirmed idle cleanup must not allocate a replacement');
    assert.equal(h.client.sourceCount(), 1); assert.equal(h.client.entries.get('B'), active);
    assert.equal(active.ready, true);
    assert.deepEqual(h.client.getStatus('A'), { state: 'stopped', source: 'helper' });
    assert.ok([...h.timers].every(timer => ![7, 13, 27].includes(timer.delay)));
});

test('a late idle response for an old lease cannot retire a fresh replacement', async t => {
    const h = harness(t), camera = h.camera('A');
    await h.client.videoUrl(camera);
    const previous = h.client.entries.get('A'), held = deferred();
    h.hook = async pathname => pathname === `/v1/sessions/${previous.id}/status` ? held.promise : undefined;
    const refreshing = h.client.refreshStatus(); await flush();
    await h.client.stop('A'); await h.client.videoUrl(camera);
    const replacement = h.client.entries.get('A');
    held.resolve(h.response({}, 410)); await refreshing; await flush();
    assert.notEqual(replacement, previous);
    assert.equal(h.client.entries.get('A'), replacement); assert.equal(replacement.ready, true);
    assert.equal(h.client.sourceCount(), 1);
});

test('late successful response bodies cannot renew or rewrite a retired or replaced lease', async t => {
    for (const endpoint of ['renew', 'status']) for (const transition of ['idle', 'reopen']) await t.test(`${endpoint} after ${transition}`, async subtest => {
        const h = harness(subtest), camera = h.camera('A');
        await h.client.videoUrl(camera);
        const old = h.client.entries.get('A');
        const body = heldJSON(endpoint === 'renew' ? { renewed: true, expiresAt: 75000 }
            : { id: old.id, deviceId: old.deviceId, state: 'streaming', bytes: 9400, startedAt: 1000 });
        const heldPath = `/v1/sessions/${old.id}/${endpoint}`;
        const retirePath = `/v1/sessions/${old.id}/${endpoint === 'renew' ? 'status' : 'renew'}`;
        h.hook = async pathname => pathname === heldPath ? body.response
            : transition === 'idle' && pathname === retirePath ? h.response({}, 410) : undefined;
        const pending = endpoint === 'renew' ? h.client.renew(old) : h.client.refreshStatus();
        await flush();
        let replacement;
        if (transition === 'idle') {
            if (endpoint === 'renew') await h.client.refreshStatus();
            else await h.client.renew(old);
            assert.equal(h.client.sourceCount(), 0);
        } else {
            await h.client.stop('A'); await h.client.videoUrl(camera);
            replacement = h.client.entries.get('A');
        }
        const oldStatus = old.status, replacementStatus = replacement?.status;
        body.finish(); await pending; await flush();
        assert.equal(old.status, oldStatus, 'late status data must not rewrite retired state');
        assert.equal(h.timers.has(old.renewTimer), false, 'late renewal must not leave a timer outside the entries map');
        assert.ok([...h.timers].every(timer => ![7, 13, 27].includes(timer.delay)));
        assert.equal(h.client.sourceCount(), replacement ? 1 : 0);
        if (replacement) {
            assert.equal(h.client.entries.get('A'), replacement);
            assert.equal(replacement.status, replacementStatus); assert.equal(replacement.ready, true);
        } else assert.deepEqual(h.client.getStatus('A'), { state: 'stopped', source: 'helper' });
    });
});

test('privacy enabled while reconciling cached leases prevents a replacement camera request', async t => {
    const h = harness(t), camera = h.camera('A');
    await h.client.videoUrl(camera);
    const entry = h.client.entries.get('A'), held = deferred();
    h.hook = async pathname => pathname === `/v1/sessions/${entry.id}/status` ? held.promise : undefined;
    const reopening = h.client.videoUrl(camera); await flush();
    camera.allowed = false;
    held.resolve(h.response({}, 410));
    await assert.rejects(reopening, error => error.mediaPublic === true);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
    assert.equal(h.client.sourceCount(), 0);
});

test('cross-origin media responses and HTTP failures expose fixed errors, never secret response text', async t => {
    const h = harness(t);
    h.hook = async pathname => pathname === '/v1/sessions' ? h.response({ id: uuid(50), mediaUrl: `https://example.test/${SECRET}` }) : undefined;
    await assert.rejects(h.client.videoUrl(h.camera('A')), error => error.mediaPublic && !error.message.includes(SECRET));
    h.hook = null; await h.client.stop('A');
    h.hook = async pathname => pathname === '/v1/health' ? h.response({ error: SECRET }, 503) : undefined;
    h.client.connectionState = null;
    await assert.rejects(h.client.videoUrl(h.camera('B')), error => error.mediaPublic && !error.message.includes(SECRET));
});

test('disposal aborts event pumps and removes renewal, recovery and request timers without starting replacement leases', async t => {
    const h = harness(t); await h.client.videoUrl(h.camera('A')); await flush();
    await h.client.dispose(); await flush();
    assert.equal(h.records.size, 0); assert.equal(h.client.sourceCount(), 0); assert.equal(h.timers.size, 0);
    assert.equal(h.client.enabled(h.camera('A')), false);
    await assert.rejects(h.client.videoUrl(h.camera('A')), error => error.mediaPublic);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
});

test('an unavailable initial HTTP handshake is aborted and released without background recovery', async t => {
    const h = harness(t);
    h.hook = (pathname, request) => pathname === '/v1/health' ? new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Error(SECRET)), { once: true });
    }) : undefined;
    const pending = h.client.videoUrl(h.camera('A')); pending.catch(() => {}); await flush();
    h.fire(100);
    await assert.rejects(pending, error => error.mediaPublic && !error.message.includes(SECRET)); await flush();
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal.aborted, true);
    assert.equal(h.client.sourceCount(), 0);
    assert.ok([...h.timers].every(timer => ![7, 13, 27].includes(timer.delay)));
    await flush(); assert.equal(h.calls.length, 1, 'failure does not create a recursive retry loop');
    h.hook = null; await h.client.stop('A'); assert.equal(h.client.sourceCount(), 0);
});

test('initial readiness timeout cancels an unviewed lease, preserves its peer and permits an explicit retry', async t => {
    const h = harness(t), peerCamera = h.camera('A'), camera = h.camera('B');
    await h.client.videoUrl(peerCamera);
    const peer = h.client.entries.get('A');
    h.hook = (pathname, request) => pathname.endsWith('/ready') ? new Promise((resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(Error(SECRET)), { once: true });
    }) : undefined;
    const pending = h.client.videoUrl(camera); pending.catch(() => {}); await flush();
    const initial = h.client.entries.get('B'), initialRequest = initial.requestId;
    h.fire(500);
    await assert.rejects(pending, error => error.mediaPublic && !error.message.includes(SECRET)); await flush();
    assert.equal(h.tombstones.has(initialRequest), true);
    assert.equal(h.client.sourceCount(), 1); assert.equal(h.records.size, 1);
    assert.equal(h.client.entries.get('A'), peer); assert.equal(peer.ready, true);
    assert.ok([...h.timers].every(timer => ![7, 13, 27].includes(timer.delay)));
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 2);

    h.hook = null;
    await h.client.videoUrl(camera);
    const retry = h.client.entries.get('B');
    assert.notEqual(retry, initial); assert.notEqual(retry.requestId, initialRequest);
    assert.equal(h.client.sourceCount(), 2); assert.equal(h.records.size, 2);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 3);
    assert.equal(h.client.entries.get('A'), peer); assert.equal(peer.ready, true);
});

test('failed initial cancellation holds capacity and retries only cleanup until confirmed', async t => {
    const h = harness(t, { local: 3 }), camera = h.camera('A');
    h.failDelete = true;
    h.hook = async pathname => pathname.endsWith('/ready') ? h.response({}, 503) : undefined;
    await assert.rejects(h.client.videoUrl(camera), error => error.mediaPublic);
    const closing = h.client.entries.get('A');
    assert.equal(closing.closing, true); assert.equal(h.client.sourceCount(), 1);
    await assert.rejects(h.client.videoUrl(h.camera('B')), /four active/);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
    assert.ok([...h.timers].every(timer => ![7, 13].includes(timer.delay)), 'failed startup may retry cancellation but not creation');
    h.failDelete = false; h.hook = null;
    h.fire(27); await flush();
    assert.equal(h.client.sourceCount(), 0); assert.equal(h.records.size, 0);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
    await h.client.videoUrl(camera);
    assert.equal(h.client.sourceCount(), 1);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 2);
});

test('four pending remote allocations reserve all source capacity before any media is ready', async t => {
    const h = harness(t), barrier = deferred();
    h.hook = async pathname => { if (pathname === '/v1/sessions') await barrier.promise; };
    const pending = ['A', 'B', 'C', 'D'].map(serial => { const promise = h.client.videoUrl(h.camera(serial)); promise.catch(() => {}); return promise; });
    await flush(); assert.equal(h.client.sourceCount(), 4);
    await assert.rejects(h.client.videoUrl(h.camera('E')), /four active/);
    await h.client.reset(); barrier.resolve(); await Promise.allSettled(pending); await flush();
    assert.equal(h.client.sourceCount(), 0); assert.equal(h.records.size, 0);
    assert.equal(h.tombstones.size, 4);
});

test('oversized snapshots and privacy changes during recovery remain bounded and cannot recreate a feed', async t => {
    const h = harness(t), camera = h.camera('A');
    h.hook = async pathname => pathname.endsWith('/snapshot') ? new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } }) : undefined;
    await assert.rejects(h.client.snapshot(camera), error => error.mediaPublic);
    assert.equal(h.client.sourceCount(), 0);
    h.hook = null; await h.client.videoUrl(camera); await flush();
    h.restart(); h.fire(20); await flush(); camera.allowed = false;
    const retry = h.client.entries.get('A').retryTimer; h.fire(retry.delay); await flush();
    assert.equal(h.records.size, 0); assert.equal(h.client.sourceCount(), 0);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 2, 'privacy prevents a third allocation');
});

test('reset blocks concurrent replacement creation until every previous lease has acknowledged cancellation', async t => {
    const h = harness(t), barrier = deferred(); await h.client.videoUrl(h.camera('A'));
    h.hook = async (pathname, request) => { if (pathname.startsWith('/v1/requests/') && request.method === 'DELETE') await barrier.promise; };
    const resetting = h.client.reset(); assert.equal(h.client.reset(), resetting); await flush();
    await assert.rejects(h.client.videoUrl(h.camera('B')), /cancelled/);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
    barrier.resolve(); await resetting; assert.equal(h.client.sourceCount(), 0);
    h.hook = null; await h.client.videoUrl(h.camera('B')); assert.equal(h.client.sourceCount(), 1);
});

test('a missing cancellation endpoint is not proof that an unknown request was tombstoned', async t => {
    const h = harness(t); await h.client.videoUrl(h.camera('A'));
    h.hook = async pathname => pathname.startsWith('/v1/requests/') ? h.response({ error: SECRET }, 404) : undefined;
    await assert.rejects(h.client.stop('A'), error => error.mediaPublic && !error.message.includes(SECRET));
    assert.equal(h.client.sourceCount(), 1, 'capacity stays reserved without an explicit cancellation ACK');
    h.hook = null; await h.client.stop('A'); assert.equal(h.client.sourceCount(), 0);
});

test('ordinary event-stream recycling keeps a short RPC reconnect gap without recreating video or escalating creation backoff', async t => {
    const h = harness(t); await h.client.videoUrl(h.camera('A')); await flush();
    for (let cycle = 0; cycle < 5; cycle++) {
        h.fire(10000); await flush();
        assert.equal(h.client.entries.get('A').pumpTimer.delay, 7);
        h.fire(7); await flush();
    }
    const record = [...h.records.values()][0];
    h.emit(record, { id: 1, method: 'getCipher', args: [7, 'ADMIN'] }); await flush();
    assert.equal(record.replies.length, 1); assert.equal(h.apiCalls.length, 1);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
    assert.equal(h.client.entries.get('A').retry, 0);
});

test('long leases allow more than 32 key reads across minute windows while refusing a burst above the bounded budget', async t => {
    const h = harness(t); await h.client.videoUrl(h.camera('A')); await flush(); const record = [...h.records.values()][0];
    for (let id = 1; id <= 35; id++) { h.emit(record, { id, method: 'getCipher', args: [7, 'ADMIN'] }); await flush(); }
    assert.equal(h.apiCalls.length, 32); assert.equal(record.replies.filter(reply => typeof reply.error === 'string').length, 3);
    h.advance(60001);
    for (let id = 36; id <= 38; id++) { h.emit(record, { id, method: 'getCipher', args: [7, 'ADMIN'] }); await flush(); }
    assert.equal(h.apiCalls.length, 35); assert.equal(record.replies.slice(-3).every(reply => reply.value?.private_key === 'own-key'), true);
    assert.equal(h.calls.filter(call => call.pathname === '/v1/sessions').length, 1);
});

test('a minute boundary cannot reset the key-read budget while an earlier account read remains pending', async t => {
    const h = harness(t); await h.client.videoUrl(h.camera('A')); await flush(); const record = [...h.records.values()][0];
    for (let id = 1; id <= 31; id++) { h.emit(record, { id, method: 'getCipher', args: [7, 'ADMIN'] }); await flush(); }
    const pending = deferred(); h.cipher = () => pending.promise;
    h.emit(record, { id: 32, method: 'getCipher', args: [7, 'ADMIN'] }); await flush(); h.advance(60001);
    h.emit(record, { id: 33, method: 'getCipher', args: [7, 'ADMIN'] }); await flush();
    assert.equal(h.apiCalls.length, 32); assert.equal(typeof record.replies.find(reply => reply.id === 33)?.error, 'string');
    pending.resolve({ private_key: 'own-key' }); await flush(); h.cipher = null;
    h.emit(record, { id: 34, method: 'getCipher', args: [7, 'ADMIN'] }); await flush();
    assert.equal(h.apiCalls.length, 33); assert.equal(record.replies.at(-1).value.private_key, 'own-key');
});
