'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);
const root = path.resolve(__dirname, '..');
const appId = 'com.eufylife.security';
const version = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).version;

function loadInstaller({ validation = true } = {}) {
    const filename = path.join(root, 'scripts/install-app.cjs');
    const nativeRequire = createRequire(filename);
    const calls = [];
    const archive = { packageArchive: true };
    class App {
        constructor(directory) { calls.push(['construct', directory]); }
        async preprocess() { calls.push(['preprocess']); }
        async _validate() { calls.push(['validate']); return validation; }
        async _getPackStream() { calls.push(['pack']); return archive; }
    }
    const localRequire = (request) => request === 'homey/lib/App' ? App : nativeRequire(request);
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require, module, exports, __filename, __dirname, console) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(localRequire, module, module.exports, filename, path.dirname(filename), { log: () => {}, error: () => {} });
    return { ...module.exports, calls, archive };
}

function runningApp(overrides = {}) {
    return { id: appId, version, state: 'running', enabled: true, crashed: false, ...overrides };
}

function homeyDouble() {
    const calls = [];
    return {
        id: 'HOMEY-SELECTED',
        name: 'Selected Homey',
        calls,
        sessions: { getSessionMe: async (options) => { calls.push(['authenticate', options]); return {}; } },
        devkit: { runApp: async (options) => { calls.push(['upload', options]); return { appId }; } },
        apps: { getApp: async (options) => { calls.push(['runtime', options]); return runningApp(); } }
    };
}

function pingResponse({ ok = true, id = 'HOMEY-SELECTED', body = 'true' } = {}) {
    return { ok, headers: { get: (name) => name.toLowerCase() === 'x-homey-id' ? id : null }, text: async () => body };
}

test('installer readiness requires the selected application and expected running version', async () => {
    const { verifyInstalled } = loadInstaller();
    const expected = runningApp();
    const actual = await verifyInstalled({ getApp: async () => expected, version, appId });
    assert.equal(actual, expected);
});

test('installer rejects wrong version, wrong app, crash, and disabled runtime', async (t) => {
    const { verifyInstalled } = loadInstaller();
    for (const [name, overrides] of [
        ['wrong version', { version: '0.0.0' }],
        ['wrong app', { id: 'com.other.app' }],
        ['crash flag', { crashed: true, crashedMessage: 'Startup failed' }],
        ['crashed state', { state: 'crashed' }],
        ['disabled runtime', { enabled: false }]
    ]) {
        await t.test(name, async () => {
            await assert.rejects(verifyInstalled({ getApp: async () => runningApp(overrides), version, appId }));
        });
    }
});

test('installer readiness polls startup and rejects a runtime that never becomes running', async () => {
    const { verifyInstalled } = loadInstaller();
    let time = 0;
    let polls = 0;
    await assert.rejects(verifyInstalled({
        getApp: async () => { polls++; return runningApp({ state: 'starting' }); },
        version,
        appId,
        now: () => time,
        sleep: async (delay) => { time += delay; },
        timeoutMs: 2000
    }), /running|time/i);
    assert.ok(time >= 2000);
    assert.ok(polls >= 2 && polls <= 4);
});

test('installer readiness succeeds only after Homey reports the new app running', async () => {
    const { verifyInstalled } = loadInstaller();
    let time = 0;
    let polls = 0;
    const installed = await verifyInstalled({
        getApp: async () => runningApp({ state: ++polls < 3 ? 'starting' : 'running' }),
        version,
        appId,
        now: () => time,
        sleep: async (delay) => { time += delay; },
        timeoutMs: 5000
    });
    assert.equal(installed.state, 'running');
    assert.equal(polls, 3);
});

test('installation route accepts only supported local tunnel origins', () => {
    const { validateInstallUrl } = loadInstaller();
    for (const url of ['http://127.0.0.1:8080', 'https://localhost:8443', 'http://[::1]:8080/', 'http://host.docker.internal:8080']) {
        assert.equal(validateInstallUrl(url), new URL(url).origin);
    }
    for (const url of [
        'https://homey.example.com',
        'http://192.0.2.20:8080',
        'http://127.0.0.1.evil.example',
        'http://user:password@127.0.0.1:8080',
        'http://127.0.0.1:8080/api',
        'http://127.0.0.1:8080/?token=test',
        'http://127.0.0.1:8080/#fragment',
        'file:///tmp/homey',
        'not a URL'
    ]) assert.throws(() => validateInstallUrl(url), undefined, url);
});

test('route configuration checks the selected Homey ping before authenticated requests', async () => {
    const { configureRoute } = loadInstaller();
    const homey = homeyDouble();
    const fetchImpl = async (url, options) => {
        homey.calls.push(['ping', url, options]);
        assert.equal(homey.calls.some(([name]) => name === 'authenticate'), false);
        assert.equal(homey.__baseUrlPromise, undefined);
        return pingResponse();
    };
    await configureRoute(homey, 'http://127.0.0.1:8080', fetchImpl);
    const [ping, authenticated] = homey.calls;
    assert.equal(ping[0], 'ping');
    assert.equal(ping[1], 'http://127.0.0.1:8080/api/manager/system/ping?id=HOMEY-SELECTED');
    assert.equal(ping[2].headers['X-Homey-ID'], homey.id);
    assert.equal(ping[2].redirect, 'error');
    assert.equal(Object.keys(ping[2].headers).some((name) => /authorization|cookie/i.test(name)), false);
    assert.equal(authenticated[0], 'authenticate');
    assert.deepEqual(authenticated[1], { $cache: false, $socket: false });
    assert.equal(await homey.__baseUrlPromise, 'http://127.0.0.1:8080');
});

test('a failed or mismatched ping cannot change route or send authentication', async (t) => {
    const { configureRoute } = loadInstaller();
    for (const [name, response] of [
        ['HTTP failure', pingResponse({ ok: false })],
        ['wrong Homey', pingResponse({ id: 'ANOTHER-HOMEY' })],
        ['missing Homey identity', pingResponse({ id: null })],
        ['unexpected body', pingResponse({ body: 'false' })]
    ]) {
        await t.test(name, async () => {
            const homey = homeyDouble();
            await assert.rejects(configureRoute(homey, 'http://127.0.0.1:8080', async () => response), /selected|Homey|tunnel/i);
            assert.equal(homey.__baseUrlPromise, undefined);
            assert.equal(homey.calls.length, 0);
        });
    }
    const homey = homeyDouble();
    await assert.rejects(configureRoute(homey, 'http://127.0.0.1:8080', async () => { throw Error('Network unavailable'); }), /Network unavailable/);
    assert.equal(homey.calls.length, 0);
});

test('an invalid route is rejected before any ping or authenticated request', async () => {
    const { configureRoute } = loadInstaller();
    const homey = homeyDouble();
    let fetches = 0;
    await assert.rejects(configureRoute(homey, 'http://127.0.0.1:8080/?secret=value', async () => { fetches++; return pingResponse(); }));
    assert.equal(fetches, 0);
    assert.equal(homey.calls.length, 0);
});

test('no route override leaves the selected Homey connection unchanged', async () => {
    const { configureRoute } = loadInstaller();
    const homey = homeyDouble();
    await configureRoute(homey, '', async () => assert.fail('No override should make no ping request'));
    assert.equal(homey.calls.length, 0);
    assert.equal(homey.__baseUrlPromise, undefined);
});

test('installation upload failure cannot pass because an older app is already running', async () => {
    const { installApp, calls } = loadInstaller();
    const homey = homeyDouble();
    homey.devkit.runApp = async () => { homey.calls.push(['upload']); throw Error('Upload rejected'); };
    await assert.rejects(installApp({ homey, root }), /Upload rejected/);
    assert.deepEqual(calls.map(([name]) => name), ['construct', 'preprocess', 'validate', 'pack']);
    assert.equal(homey.calls.some(([name]) => name === 'runtime'), false);
});

test('validation or an incorrect upload acknowledgment prevents success', async () => {
    const invalid = loadInstaller({ validation: false });
    const homey = homeyDouble();
    await assert.rejects(invalid.installApp({ homey, root }), /validat/i);
    assert.equal(homey.calls.length, 0);
    const { installApp } = loadInstaller();
    homey.devkit.runApp = async () => ({ appId: 'com.other.app' });
    await assert.rejects(installApp({ homey, root }), /expected|acknowledge|installation/i);
    assert.equal(homey.calls.some(([name]) => name === 'runtime'), false);
});

test('installation uses the packaged archive and verifies the selected app runtime', async () => {
    const { installApp, archive } = loadInstaller();
    const homey = homeyDouble();
    const installed = await installApp({ homey, root });
    const upload = homey.calls.find(([name]) => name === 'upload');
    assert.equal(upload[1].app, archive);
    assert.deepEqual(upload[1].env, {});
    assert.equal(upload[1].debug, false);
    assert.equal(upload[1].clean, false);
    const runtime = homey.calls.find(([name]) => name === 'runtime');
    assert.equal(runtime[1].id, appId);
    assert.equal(runtime[1].$cache, false);
    assert.equal(installed.id, appId);
    assert.equal(installed.version, version);
    assert.equal(installed.state, 'running');
});

test('an upload acknowledgment cannot substitute for the expected app runtime identity', async () => {
    const { installApp } = loadInstaller();
    const homey = homeyDouble();
    homey.apps.getApp = async () => runningApp({ id: 'com.other.app' });
    await assert.rejects(installApp({ homey, root }), /expected|identity|application|app/i);
});
