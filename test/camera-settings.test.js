'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const api = require('../api');
const limits = require('../lib/helpers/camera-stream-limit.helper');
const SECRET = 'private-account-and-helper-fixture';
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function fixture(options = {}) {
    const values = new Map(), writes = [], syncs = [];
    if (Object.hasOwn(options, 'stored')) values.set(limits.SETTING_KEY, options.stored);
    const state = { values, writes, syncs, applied: true, failWrite: false, failSync: false, syncHook: null };
    const filename = path.resolve(__dirname, '../app.js'), module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require,module,exports){\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(name => name === 'homey' ? { App: class {}, manifest: { id: 'com.eufylife.security' } }
        : name === './lib/helpers/camera-stream-limit.helper' ? limits : {}, module, module.exports);
    const app = new module.exports();
    const homey = app.homey = { app, settings: {
        get: name => values.get(name),
        async set(name, value) {
            if (state.failWrite) throw Error(SECRET);
            writes.push([name, structuredClone(value)]); values.set(name, structuredClone(value));
        },
    } };
    if (options.helper !== false) app.FfmpegManager = { helperClient: {
        getStreamLimitStatus: () => ({ applied: state.applied, token: SECRET }),
        async syncStreamLimit() {
            syncs.push(limits.getStreamLimit(homey));
            if (state.syncHook) await state.syncHook();
            if (state.failSync) throw Error(SECRET);
            return { applied: state.applied, token: SECRET };
        },
    } };
    app.updateSettings = () => assert.fail('stream settings must not change account settings');
    app.resetEufyClient = () => assert.fail('stream settings must not restart the Eufy account');
    return Object.assign(state, { app, homey, get: () => api.getCameraSettings({ homey }), put: body => api.setCameraSettings({ homey, body }) });
}

test('the shared limit defaults to four and validates explicit unlimited or every positive safe integer', () => {
    const homey = { settings: { get: () => undefined } };
    assert.equal(limits.SETTING_KEY, 'camera_stream_limit'); assert.equal(limits.getStreamLimit(homey), 4);
    assert.equal(limits.read(homey), 4); assert.equal(limits.format(null), 'No limit');
    for (const maxStreams of [1, 4, 33, 1000, Number.MAX_SAFE_INTEGER, null]) {
        assert.deepEqual(limits.validate({ maxStreams }), { maxStreams });
        assert.equal(limits.getStreamLimit({ settings: { get: () => ({ maxStreams }) } }), maxStreams);
    }
    assert.equal(limits.isAtCapacity(4, 4), true); assert.equal(limits.isAtCapacity(3, 4), false);
    assert.equal(limits.isAtCapacity(Number.MAX_SAFE_INTEGER, null), false);
    for (const count of [-1, NaN, 0.5, '4']) assert.equal(limits.isAtCapacity(count, null), true);
    for (const stored of [null, {}, { maxStreams: 0 }, { maxStreams: 'No limit' }, { maxStreams: 8, token: SECRET }]) {
        assert.deepEqual(limits.getSettings({ settings: { get: () => stored } }), { maxStreams: 4, saved: false });
    }
});

test('camera settings routes require Homey authentication and expose only GET and PUT', () => {
    for (const filename of ['../.homeycompose/app.json', '../app.json']) {
        const manifest = require(filename);
        assert.deepEqual(manifest.api.getCameraSettings, { method: 'GET', path: '/camera-settings', public: false });
        assert.deepEqual(manifest.api.setCameraSettings, { method: 'PUT', path: '/camera-settings', public: false });
    }
});

test('GET returns the shared saved setting and cached application status without writes or helper calls', async () => {
    const h = fixture();
    assert.deepEqual(await h.get(), { maxStreams: 4, defaultMaxStreams: 4, saved: false, applyStatus: 'applied',
        message: 'The stream limit is ready. Existing streams will continue.' });
    h.values.set(limits.SETTING_KEY, { maxStreams: null }); h.applied = false;
    const current = await h.get();
    assert.equal(current.maxStreams, null); assert.equal(current.saved, true); assert.equal(current.applyStatus, 'pending');
    assert.equal(h.writes.length, 0); assert.equal(h.syncs.length, 0); assert.doesNotMatch(JSON.stringify(current), /private-account|token/);
});

test('PUT saves explicit No limit and larger finite values without touching credentials or account lifecycle', async () => {
    const h = fixture(); h.values.set('camera_helper_connection', { token: SECRET });
    for (const maxStreams of [null, 64, 1]) {
        const response = await h.put({ maxStreams });
        assert.deepEqual(h.values.get(limits.SETTING_KEY), { maxStreams });
        assert.equal(response.maxStreams, maxStreams); assert.equal(response.saved, true); assert.equal(response.applyStatus, 'applied');
        assert.equal((await h.get()).maxStreams, maxStreams);
        assert.doesNotMatch(JSON.stringify(response), /private-account|token/);
    }
    assert.deepEqual(h.syncs, [null, 64, 1]);
    assert.ok(h.writes.every(([name]) => name === limits.SETTING_KEY));
    assert.deepEqual(h.values.get('camera_helper_connection'), { token: SECRET });
});

test('invalid values and extra fields fail before a write or helper call and never echo input', async () => {
    const h = fixture();
    const getter = { get maxStreams() { throw Error(SECRET); } };
    for (const body of [undefined, null, [], {}, 4, { maxStreams: 0 }, { maxStreams: -1 }, { maxStreams: 1.5 },
        { maxStreams: '4' }, { maxStreams: true }, { maxStreams: Infinity }, { maxStreams: Number.MAX_SAFE_INTEGER + 1 },
        { maxStreams: 4, token: SECRET }, Object.create({ maxStreams: null }), getter]) {
        await assert.rejects(h.put(body), error => error.statusCode === 400 && !error.message.includes(SECRET));
    }
    assert.equal(h.writes.length, 0); assert.equal(h.syncs.length, 0);
});

test('offline or incompatible helpers leave the saved intent pending for later application', async () => {
    const h = fixture(); h.failSync = true; h.applied = false;
    const pending = await h.put({ maxStreams: null });
    assert.equal(pending.saved, true); assert.equal(pending.applyStatus, 'pending'); assert.equal(pending.maxStreams, null);
    assert.deepEqual(h.values.get(limits.SETTING_KEY), { maxStreams: null });
    assert.doesNotMatch(JSON.stringify(pending), /private-account|token|stack/);
    h.failSync = false; h.applied = true;
    assert.equal((await h.put({ maxStreams: 8 })).applyStatus, 'applied');
    assert.equal((await h.get()).maxStreams, 8);
});

test('concurrent settings writes serialize persistence and helper application in request order', async () => {
    const h = fixture(), held = deferred();
    let attempts = 0;
    h.syncHook = () => ++attempts === 1 ? held.promise : undefined;
    const first = h.put({ maxStreams: null }), second = h.put({ maxStreams: 8 });
    await flush();
    assert.deepEqual(h.writes, [[limits.SETTING_KEY, { maxStreams: null }]]);
    assert.deepEqual(h.syncs, [null]);
    held.resolve();
    assert.equal((await first).maxStreams, null); assert.equal((await second).maxStreams, 8);
    assert.deepEqual(h.syncs, [null, 8]); assert.deepEqual(h.values.get(limits.SETTING_KEY), { maxStreams: 8 });
});

test('failed persistence is safe and does not poison the next update or apply an unsaved limit', async () => {
    const h = fixture({ stored: { maxStreams: 4 } }); h.failWrite = true;
    await assert.rejects(h.put({ maxStreams: null }), error => error.statusCode === 503 && !error.message.includes(SECRET));
    assert.deepEqual(h.values.get(limits.SETTING_KEY), { maxStreams: 4 }); assert.equal(h.syncs.length, 0);
    h.failWrite = false;
    assert.equal((await h.put({ maxStreams: 12 })).applyStatus, 'applied'); assert.deepEqual(h.syncs, [12]);
});

test('saved limits apply to the local path before a helper or account has been initialized', async () => {
    const h = fixture({ helper: false });
    const saved = await h.put({ maxStreams: null });
    assert.equal(saved.saved, true); assert.equal(saved.applyStatus, 'applied');
    assert.equal((await h.get()).maxStreams, null); assert.equal(h.syncs.length, 0);
});
