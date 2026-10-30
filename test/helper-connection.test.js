'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { connectHelper } = require('../scripts/connect-helper.cjs');
const CameraHelperClient = require('../lib/helpers/camera-helper-client.helper');
const api = require('../api');
const manifest = require('../app.json');

const APP = 'com.eufylife.security';
const TOKEN = 'a'.repeat(64);
const ORIGIN = 'http://127.0.0.1:8769';
const DEVICE_A = '00000000-0000-4000-8000-000000000001';
const DEVICE_B = '00000000-0000-4000-8000-000000000002';
const SECRET = 'private-account-fixture';
const clone = value => value == null ? value : structuredClone(value);
// Files contain only generated fixture strings. The OS temporary directory owns
// their lifecycle; no existing file or private bootstrap identity is removed.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-helper-connection-test-'));
let fileNumber = 0;
function keyFile({ mode = 0o600, text = `${TOKEN}\n` } = {}) {
    const file = path.join(directory, `key-${++fileNumber}`);
    fs.writeFileSync(file, text, { mode, flag: 'wx' }); fs.chmodSync(file, mode);
    return file;
}

function harness(options = {}) {
    const calls = [], settings = new Map();
    if (Object.hasOwn(options, 'connection')) settings.set('camera_helper_connection', clone(options.connection));
    if (Object.hasOwn(options, 'selection')) settings.set('camera_helper_devices', clone(options.selection));
    const state = { calls, settings, tokenFile: keyFile(), installed: { id: APP, version: manifest.version, state: 'running' },
        cameras: [{ id: DEVICE_A, name: 'Camera A', videoRegistered: true }, { id: DEVICE_B, name: 'Camera B', videoRegistered: true }],
        devices: { [DEVICE_A]: { id: DEVICE_A, driverId: `homey:app:${APP}:driver_EUFYCAM_2` }, [DEVICE_B]: { id: DEVICE_B, driverId: `homey:app:${APP}:driver_INDOOR_CAM` } },
        health: { configured: true, available: true, protocol: 1, version: '0.1.0', sdk: '4.2.6' }, selectionFailure: null };
    const homey = { apps: {
        async getApp(args) { calls.push(['getApp', clone(args)]); assert.equal(args.id, APP); return clone(state.installed); },
        async getAppSetting(args) { calls.push(['getSetting', args.name]); assert.equal(args.id, APP); return clone(settings.get(args.name)); },
        async setAppSetting(args) {
            calls.push(['setSetting', args.name, clone(args.value)]); assert.equal(args.id, APP);
            if (args.name === 'camera_helper_devices' && state.selectionFailure) {
                const failure = state.selectionFailure; state.selectionFailure = null;
                if (failure === 'after-commit') settings.set(args.name, clone(args.value));
                throw Error(SECRET);
            }
            settings.set(args.name, clone(args.value));
        },
        async unsetAppSetting(args) { calls.push(['unsetSetting', args.name]); assert.equal(args.id, APP); settings.delete(args.name); },
    }, devices: {
        async getDevices(args) { calls.push(['devices', clone(args)]); return clone(state.devices); },
    }, async call(args) {
        calls.push(['call', args.path]); assert.equal(args.method, 'GET');
        if (args.path === `/api/app/${APP}/cameras/status`) return clone(state.cameras);
        if (args.path === `/api/app/${APP}/camera-helper`) {
            if (state.healthError) throw Error(SECRET);
            assert.equal(settings.get('camera_helper_connection')?.token, TOKEN);
            return clone(state.health);
        }
        assert.fail('unexpected Homey API endpoint');
    } };
    return Object.assign(state, { homey, connect: overrides => connectHelper({ homey, tokenFile: state.tokenFile, origin: ORIGIN, ...overrides }) });
}

const writes = h => h.calls.filter(([name]) => name === 'setSetting' || name === 'unsetSetting');

test('the real bootstrap module autoloads without Homey CLI dependencies, side effects or secret output', () => {
    const result = spawnSync(process.execPath, ['-e', 'require("./scripts/connect-helper.cjs")'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});

test('initial connection verifies the installed fork, native registrations and app-side health before enabling selected cameras', async () => {
    const h = harness(); const result = await h.connect();
    assert.deepEqual(h.settings.get('camera_helper_connection'), { protocol: 1, url: ORIGIN, token: TOKEN });
    assert.equal(h.settings.get('camera_helper_devices'), true);
    assert.deepEqual(result, { connected: true, protocol: 1, helperVersion: '0.1.0', selectedCameras: 2, nativeCameraRegistrationsPreserved: true });
    assert.equal(JSON.stringify(result).includes(TOKEN), false); assert.equal(JSON.stringify(result).includes(ORIGIN), false);
    const health = h.calls.findIndex(call => call[0] === 'call' && call[1].endsWith('/camera-helper'));
    const selected = h.calls.findIndex(call => call[0] === 'setSetting' && call[1] === 'camera_helper_devices');
    assert.ok(health < selected);
    assert.deepEqual(h.cameras.map(camera => camera.videoRegistered), [true, true]);
});

test('repeat connection with the same key preserves its DB identity and can narrow selection without touching camera registrations', async () => {
    const connection = { protocol: 1, url: ORIGIN, token: TOKEN };
    const h = harness({ connection, selection: true });
    const result = await h.connect({ selection: [DEVICE_B] });
    assert.deepEqual(h.settings.get('camera_helper_connection'), connection);
    assert.deepEqual(h.settings.get('camera_helper_devices'), [DEVICE_B]);
    assert.equal(result.selectedCameras, 1);
    assert.equal(writes(h).some(call => call[1] === 'camera_helper_connection'), false);
});

test('wrong app version or a stopped app is rejected before any connection or camera selection write', async () => {
    for (const installed of [{ version: '0.0.0', state: 'running' }, { version: manifest.version, state: 'stopped' }]) {
        const h = harness(); Object.assign(h.installed, installed);
        await assert.rejects(h.connect(), /compatible Eufy fork/); assert.equal(writes(h).length, 0);
        assert.equal(h.calls.some(call => call[0] === 'devices'), false);
    }
});

test('an existing token, endpoint or protocol mismatch is refused without overwriting either setting', async () => {
    for (const connection of [
        { protocol: 1, url: ORIGIN, token: 'b'.repeat(64) },
        { protocol: 1, url: 'http://127.0.0.1:9999', token: TOKEN },
        { protocol: 2, url: ORIGIN, token: TOKEN },
    ]) {
        const h = harness({ connection, selection: [DEVICE_A] });
        await assert.rejects(h.connect(), /identity differs/);
        assert.deepEqual(h.settings.get('camera_helper_connection'), connection);
        assert.deepEqual(h.settings.get('camera_helper_devices'), [DEVICE_A]); assert.equal(writes(h).length, 0);
    }
});

test('failed initial helper health removes only the newly staged connection and preserves the previous selection', async () => {
    for (const response of [{ available: false, protocol: 1, sdk: '4.2.6' }, { available: true, protocol: 2, sdk: '4.2.6' },
        { available: true, protocol: 1, sdk: 'unknown' }]) {
        const h = harness({ selection: [DEVICE_B] }); h.health = response;
        await assert.rejects(h.connect(), /verify the helper connection/);
        assert.equal(h.settings.has('camera_helper_connection'), false);
        assert.deepEqual(h.settings.get('camera_helper_devices'), [DEVICE_B]);
        assert.equal(writes(h).some(call => call[1] === 'camera_helper_devices'), false);
    }
});

test('health API failure retains a pre-existing matching identity and its old selection', async () => {
    const connection = { protocol: 1, url: ORIGIN, token: TOKEN };
    const h = harness({ connection, selection: [DEVICE_A] }); h.healthError = true;
    await assert.rejects(h.connect());
    assert.deepEqual(h.settings.get('camera_helper_connection'), connection);
    assert.deepEqual(h.settings.get('camera_helper_devices'), [DEVICE_A]); assert.equal(writes(h).length, 0);
});

test('an unknown selection-write outcome restores its baseline and rolls back only a new connection', async () => {
    for (const existing of [false, true]) {
        const connection = { protocol: 1, url: ORIGIN, token: TOKEN };
        const h = harness({ selection: [DEVICE_B], ...(existing ? { connection } : {}) }); h.selectionFailure = 'after-commit';
        await assert.rejects(h.connect({ selection: [DEVICE_A] }));
        assert.deepEqual(h.settings.get('camera_helper_devices'), [DEVICE_B]);
        assert.deepEqual(h.settings.get('camera_helper_connection'), existing ? connection : undefined);
    }
    const h = harness(); h.selectionFailure = 'after-commit'; await assert.rejects(h.connect());
    assert.equal(h.settings.has('camera_helper_devices'), false); assert.equal(h.settings.has('camera_helper_connection'), false);
});

test('foreign device ownership, unregistered cameras, empty inventory and non-camera selections fail before mutation', async () => {
    for (const mode of ['foreign', 'unregistered', 'empty', 'selection']) {
        const h = harness();
        if (mode === 'foreign') h.devices[DEVICE_A].driverId = 'homey:app:another.camera:camera';
        if (mode === 'unregistered') h.cameras[0].videoRegistered = false;
        if (mode === 'empty') h.cameras = [];
        const selection = mode === 'selection' ? ['00000000-0000-4000-8000-000000000099'] : true;
        await assert.rejects(h.connect({ selection })); assert.equal(writes(h).length, 0);
    }
});

test('bootstrap accepts only a regular, mode-0600 key file and refuses symlinks, oversized or invalid key data', async () => {
    const symlink = path.join(directory, `link-${++fileNumber}`); fs.symlinkSync(keyFile(), symlink);
    const fixtures = [keyFile({ mode: 0o644 }), keyFile({ mode: 0o400 }), keyFile({ mode: 0o700 }), symlink, directory,
        keyFile({ text: 'x'.repeat(1025) }), keyFile({ text: 'not-a-secret' }), keyFile({ text: 'A'.repeat(64) })];
    for (const tokenFile of fixtures) {
        const h = harness(); await assert.rejects(h.connect({ tokenFile })); assert.equal(h.calls.length, 0);
        assert.equal(h.settings.size, 0);
    }
});

test('non-loopback URLs and invalid selections are rejected before reading Homey or mutating settings', async () => {
    for (const origin of ['https://127.0.0.1:8769', 'http://localhost:8769', 'http://192.168.1.1:8769',
        'http://127.0.0.1:8769/path', 'http://user@127.0.0.1:8769', 'http://127.0.0.1:8769?token=x', 'http://127.0.0.1:65536']) {
        const h = harness(); await assert.rejects(h.connect({ origin })); assert.equal(h.calls.length, 0);
    }
    for (const selection of [false, [], 'all', ['invalid']]) {
        const h = harness(); await assert.rejects(h.connect({ selection })); assert.equal(h.calls.length, 0);
    }
});

test('the private app health endpoint returns only verified diagnostic fields and never forwards token, URL or raw errors', async () => {
    const settings = new Map([['camera_helper_connection', { protocol: 1, url: ORIGIN, token: TOKEN }]]);
    let remote = { protocol: 1, version: '0.1.0', sdk: '4.2.6', instance: DEVICE_A, token: TOKEN, mediaUrl: SECRET, metadata: SECRET };
    const client = new CameraHelperClient({ homey: { settings: { get: name => settings.get(name) } },
        fetch: async () => new Response(JSON.stringify(remote), { headers: { 'Content-Type': 'application/json' } }) });
    const homey = { app: { FfmpegManager: { helperClient: client } } };
    assert.equal(manifest.api.getCameraHelperStatus.public, false);
    assert.deepEqual(await api.getCameraHelperStatus({ homey }), {
        configured: true, available: true, protocol: 1, version: '0.1.0', sdk: '4.2.6', instance: DEVICE_A,
    });
    remote = { ...remote, sdk: SECRET, error: SECRET };
    const failed = await api.getCameraHelperStatus({ homey });
    assert.equal(failed.available, false); assert.equal(JSON.stringify(failed).includes(SECRET), false);
    assert.equal(JSON.stringify(failed).includes(TOKEN), false); assert.equal(Object.hasOwn(failed, 'url'), false);
    settings.clear(); assert.deepEqual(await api.getCameraHelperStatus({ homey }), { configured: false, available: false, protocol: 1 });
    await client.dispose();
});
