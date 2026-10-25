'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);
const root = path.resolve(__dirname, '..');

function loadDriver(filename) {
    const cache = new Map();
    const waits = [];
    const utils = { ...require('../lib/utils'), sleep: async (ms) => { waits.push(ms); } };
    function load(requested) {
        const absolute = require.resolve(requested);
        if (cache.has(absolute)) return cache.get(absolute).exports;
        const module = { exports: {} };
        cache.set(absolute, module);
        const nativeRequire = createRequire(absolute);
        const localRequire = (request) => {
            if (request === 'homey') return { Driver: class {} };
            const resolved = nativeRequire.resolve(request);
            if (resolved === path.join(root, 'lib/utils.js')) return utils;
            if (resolved.startsWith(`${root}${path.sep}`) && resolved.endsWith('.js')) return load(resolved);
            return nativeRequire(request);
        };
        const factory = vm.runInThisContext(`(function(require, module, exports, __filename, __dirname) {\n${fs.readFileSync(absolute, 'utf8')}\n})`, { filename: absolute });
        factory(localRequire, module, module.exports, absolute, path.dirname(absolute));
        return module.exports;
    }
    return { Driver: load(path.join(root, filename)), waits };
}

function sessionDouble() {
    return {
        handlers: new Map(),
        views: [],
        messages: [],
        setHandler(name, handler) { this.handlers.set(name, handler); },
        async showView(view) { this.views.push(view); },
        async emit(name, data) { this.messages.push([name, data]); }
    };
}

function display(serial = 'T87A0PAIRING') {
    return {
        rawDevice: { device_sn: serial, device_name: 'Display', device_id: 'mega', station_sn: '' },
        getSerial: () => serial,
        getModel: () => 'T87A0'
    };
}

function harness(filename = 'drivers/driver_SMART_DISPLAY/driver.js') {
    const { Driver, waits } = loadDriver(filename);
    const driver = new Driver();
    const calls = [];
    const noop = () => {};
    const client = {
        isConnected: () => true,
        getDevices: async () => { calls.push(['camera-discovery']); return []; },
        getStations: async () => { calls.push(['station-discovery']); return []; }
    };
    driver.id = filename.includes('SMART_DISPLAY') ? 'driver_SMART_DISPLAY' : 'existing-driver';
    driver.homey = {
        __: (key) => key,
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout,
        app: {
            eufyClient: client,
            appSettings: { USERNAME: 'test@example.test', PASSWORD: 'test-password', REGION: 'US' },
            deviceList: [], deviceTypes: { OTHER: ['UNKNOWN'] },
            log: noop, debug: noop, error: noop,
            getSmartDisplayDevices: async () => { calls.push(['display-discovery']); return []; },
            getSmartDisplayStatus: () => ({ complete: true, attempted: true, pending: false, updatedAt: 1 }),
            initDevices: () => calls.push(['initialize']),
            eufyLogin: async (settings) => { calls.push(['login', settings]); return true; },
            eufyCaptcha: (value) => calls.push(['captcha', value]),
            eufy2FA: (value) => calls.push(['2fa', value])
        }
    };
    return { driver, client, calls, waits, app: driver.homey.app };
}

const turn = () => new Promise(setImmediate);

test('display loading acknowledges the UI before blocked discovery and later opens the device list', async () => {
    const h = harness();
    const session = sessionDouble();
    let release;
    h.app.getSmartDisplayDevices = () => new Promise((resolve) => { release = resolve; });
    await h.driver.onPair(session);
    await turn();
    let acknowledged = false;
    const acknowledgement = session.handlers.get('showView')('loading').then(() => { acknowledged = true; });
    await turn();
    const beforeDiscoveryCompleted = acknowledged;
    assert.equal(typeof release, 'function');
    release([display()]);
    await acknowledgement;
    await turn();
    assert.equal(beforeDiscoveryCompleted, true, 'Homey must not wait for cloud discovery to acknowledge the loading view');
    assert.deepEqual(session.views, ['list_devices']);
    const listed = await session.handlers.get('list_devices')();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].data.device_sn, 'T87A0PAIRING');
});

test('an empty display lookup finishes after one attempt and distinguishes missing devices from a discovery failure', async (t) => {
    for (const failed of [false, true]) {
        await t.test(failed ? 'unavailable discovery' : 'complete empty discovery', async () => {
            const h = harness();
            const session = sessionDouble();
            if (failed) h.app.getSmartDisplayStatus = () => ({ complete: false, error: 'Discovery unavailable' });
            await h.driver.onPair(session);
            await turn();
            await session.handlers.get('showView')('loading');
            await turn();
            assert.equal(h.calls.filter(([name]) => name === 'display-discovery').length, 1);
            assert.deepEqual(session.views, ['error']);
            if (failed) assert.match(h.driver.deviceError, /account|login|retry/i);
            else assert.equal(h.driver.deviceError, 'pair.no_devices');
        });
    }
});

test('a rejected background display lookup reports an error after acknowledging the loading view', async () => {
    const h = harness();
    const session = sessionDouble();
    h.app.getSmartDisplayDevices = async () => { throw Error('Unexpected backend failure'); };
    await h.driver.onPair(session);
    const acknowledged = await session.handlers.get('showView')('loading');
    assert.equal(acknowledged, true);
    await turn();
    assert.deepEqual(session.views, ['error']);
    assert.equal(h.driver.deviceError, 'pair.no_devices');
    await session.handlers.get('showView')('error');
    assert.deepEqual(session.messages.find(([name]) => name === 'deviceError'), ['deviceError', 'pair.no_devices']);
});

test('CAPTCHA and two-factor challenges still take precedence over display discovery', async (t) => {
    for (const [field, value, view] of [
        ['needCaptcha', { captcha: 'test-captcha' }, 'login_captcha'],
        ['need2FA', true, 'pincode']
    ]) {
        await t.test(view, async () => {
            const h = harness();
            const session = sessionDouble();
            h.app[field] = value;
            await h.driver.onPair(session);
            await turn();
            await session.handlers.get('showView')('loading');
            await turn();
            assert.deepEqual(session.views, [view]);
            assert.equal(h.calls.some(([name]) => name === 'display-discovery'), false);
        });
    }
});

test('saved login, CAPTCHA submission, and two-factor submission retain their existing account handlers', async () => {
    const h = harness();
    const session = sessionDouble();
    await h.driver.onPair(session);
    await turn();
    await session.handlers.get('showView')('login_eufy');
    assert.equal(session.messages.some(([name]) => name === 'set_user'), true);
    assert.equal(session.messages.some(([name]) => name === 'set_password'), true);
    await session.handlers.get('login')({ username: 'new@example.test', password: 'new-test-password', region: 'CA' });
    await session.handlers.get('login_captcha')({ captcha: 'typed-captcha' });
    await session.handlers.get('pincode')(['1', '2', '3', '4', '5', '6']);
    const login = h.calls.find(([name]) => name === 'login')[1];
    assert.equal(login.USERNAME, 'new@example.test');
    assert.equal(login.REGION, 'CA');
    assert.deepEqual(h.calls.find(([name]) => name === 'captcha'), ['captcha', 'typed-captcha']);
    assert.deepEqual(h.calls.find(([name]) => name === '2fa'), ['2fa', '123456']);
});

test('display repair initializes existing devices and completes without requiring another pairing', async () => {
    const h = harness();
    const session = sessionDouble();
    h.app.deviceList = [{ getData: () => ({ device_sn: 'T87A0PAIRING' }) }];
    h.app.getSmartDisplayDevices = async () => [display()];
    await h.driver.onRepair(session);
    await turn();
    await session.handlers.get('showView')('loading');
    await turn();
    assert.deepEqual(session.views, ['done']);
    assert.equal(h.calls.some(([name]) => name === 'initialize'), true);
});

test('disconnecting a pairing session discards late display results and view changes', async () => {
    const h = harness();
    const session = sessionDouble();
    let release;
    h.app.getSmartDisplayDevices = () => new Promise((resolve) => { release = resolve; });
    await h.driver.onPair(session);
    await turn();
    const acknowledgement = session.handlers.get('showView')('loading');
    await turn();
    await session.handlers.get('disconnect')();
    release([display()]);
    await acknowledgement;
    await turn();
    assert.deepEqual(session.views, []);
    assert.deepEqual(h.driver._devices, []);
});

test('a new pairing session prevents old discovery from changing either session device list or view', async () => {
    const h = harness();
    const oldSession = sessionDouble();
    let release;
    h.app.getSmartDisplayDevices = () => new Promise((resolve) => { release = resolve; });
    await h.driver.onPair(oldSession);
    await turn();
    const acknowledgement = oldSession.handlers.get('showView')('loading');
    await turn();
    const newSession = sessionDouble();
    await h.driver.onPair(newSession);
    await turn();
    release([display()]);
    await acknowledgement;
    await turn();
    assert.deepEqual(oldSession.views, []);
    assert.deepEqual(newSession.views, []);
    assert.deepEqual(await newSession.handlers.get('list_devices')(), []);
});

test('back navigation discards an earlier lookup and a new loading attempt can complete', async () => {
    const h = harness();
    const session = sessionDouble();
    let releaseEarlier;
    h.app.getSmartDisplayDevices = () => new Promise((resolve) => { releaseEarlier = resolve; });
    await h.driver.onPair(session);
    await session.handlers.get('showView')('loading');
    await turn();
    h.client.isConnected = () => false;
    await session.handlers.get('showView')('login_eufy');
    h.client.isConnected = () => true;
    h.app.getSmartDisplayDevices = async () => [display('T87A0RETRY')];
    await session.handlers.get('showView')('loading');
    await turn();
    releaseEarlier([display('T87A0STALE')]);
    await turn();
    assert.deepEqual(session.views, ['list_devices']);
    const listed = await session.handlers.get('list_devices')();
    assert.deepEqual(listed.map(({ data }) => data.device_sn), ['T87A0RETRY']);
});

test('existing camera and station loading retain their ten-attempt discovery policy', async (t) => {
    for (const [filename, call] of [
        ['drivers/main-driver.js', 'camera-discovery'],
        ['drivers/main-hub-driver.js', 'station-discovery']
    ]) {
        await t.test(call, async () => {
            const h = harness(filename);
            const session = sessionDouble();
            await h.driver.onPair(session);
            await turn();
            await session.handlers.get('showView')('loading');
            assert.equal(h.calls.filter(([name]) => name === call).length, 10);
            assert.deepEqual(session.views, ['error']);
        });
    }
});
