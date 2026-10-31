'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const CameraWall = require('../lib/helpers/camera-wall.helper');
const { getStreamLimit, SETTING_KEY } = require('../lib/helpers/camera-stream-limit.helper');

const CREDENTIALS_KEY = 'camera_wall_credentials';
const API_KEY = 'dedicated-read-only-test-key';
const SECRET = 'secret-source-url-rtsp://user:password@camera/private';
const OFFER = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
const ANSWER = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n';

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function harness(t, options = {}) {
    let time = 1000000;
    const settings = new Map(options.configured === false ? [] : [[CREDENTIALS_KEY, { apiKey: API_KEY }]]);
    const calls = [];
    const videoOffer = options.videoOffer || (async () => ({ answerSdp: ANSWER, streamId: SECRET }));
    const api = { sessions: {
        async getSessionMe(args) { calls.push(['scope', args]); return options.session || { type: 'PAT', intersectedScopes: ['homey.device.readonly'] }; }
    }, videos: {
        async getVideos(args) { calls.push(['inventory', args]); return options.getVideos ? options.getVideos() : {}; },
        async videoOffer(args) { calls.push(['offer', args]); return videoOffer(args); },
        async videoKeepAlive(args) { calls.push(['keepAlive', args]); if (options.keepAlive) return options.keepAlive(args); }
    } };
    const homey = {
        api: { async getLocalUrl() { return options.address || 'http://127.0.0.1:4859'; } },
        settings: {
            get(key) { return settings.get(key); },
            set(key, value) { calls.push(['save', key]); settings.set(key, value); },
            unset(key) { calls.push(['clear', key]); settings.delete(key); }
        },
        app: { deviceList: [], appSettings: { retained: true }, FfmpegManager: {
            videos: new Map(), sessions: new Map(), stationOwners: new Map(), stopping: new Map(), maxSessions: 4,
            sourceCount() { return new Set([...this.sessions.keys(), ...this.stopping.keys()]).size; },
            isolatedP2P(device) {
                const enabled = settings.get('camera_isolated_p2p_devices');
                return enabled === true || (Array.isArray(enabled) && enabled.includes(device.getId()));
            },
            supports: device => device?.camera === true,
            nativeEnabled: device => device.native === true,
            assertCamera(device) { if (!device.ready || device.privacy) throw Error(SECRET); }
        } }
    };
    const manager = new CameraWall(homey, {
        now: () => time,
        createLocalAPI: async args => { calls.push(['client', args]); if (options.createLocalAPI) return options.createLocalAPI(args); return api; }
    });
    let sourceLimitOverride;
    Object.defineProperty(homey.app.FfmpegManager, 'maxSessions', {
        configurable: true,
        get() { return sourceLimitOverride === undefined ? getStreamLimit(homey) : sourceLimitOverride; },
        set(value) { sourceLimitOverride = value; }
    });
    t.after(() => manager.dispose());
    function camera(index = 1, options = {}) {
        const device = {
            ready: true, available: true, privacy: false,
            getId() { return `DEVICE_${index}`; },
            getName() { return `Camera ${index}`; },
            getAvailable() { return this.available; },
            EufyDevice: { camera: true, getSerial() { return `SERIAL_${index}`; }, getStationSerial() { return `HOMEBASE_${index}`; } },
            ...options
        };
        homey.app.deviceList.push(device);
        const entry = { device, video: { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }, token: SECRET };
        homey.app.FfmpegManager.videos.set(device.EufyDevice.getSerial(), entry);
        return device;
    }
    return { manager, homey, settings, calls, api, camera, advance(ms) { time += ms; } };
}

function safeError(error) {
    assert.equal(error.cameraWallPublic, true);
    assert.equal(String(error).includes(SECRET), false);
    assert.equal(String(error).includes(API_KEY), false);
    return true;
}

test('status exposes camera health without credentials, source URLs, serials, or registered video IDs', t => {
    const h = harness(t);
    const first = h.camera();
    h.camera(2, { privacy: true });
    const status = h.manager.status();
    assert.deepEqual(status, { configured: true, maxViews: 4, cameras: [
        { id: 'DEVICE_1', name: 'Camera 1', available: true, videoRegistered: true, usesStreamLimit: true },
        { id: 'DEVICE_2', name: 'Camera 2', available: false, videoRegistered: true, usesStreamLimit: true }
    ] });
    const text = JSON.stringify(status);
    for (const privateValue of [API_KEY, SECRET, 'SERIAL_', '00000000-0000-4000']) assert.equal(text.includes(privateValue), false);
    h.homey.app.FfmpegManager.videos.get(first.EufyDevice.getSerial()).device = {};
    assert.equal(h.manager.status().cameras[0].videoRegistered, false);
});

test('duplicate wall names identify a video lock and camera without renaming Homey devices or changing IDs', t => {
    const h = harness(t);
    const camera = h.camera(1, { getName: () => 'Basement Door', driver: { id: 'driver_INDOOR_CAM' } });
    const lock = h.camera(2, { getName: () => 'Basement Door', driver: { id: 'driver_SMART_LOCK' } });
    const other = h.camera(3);
    assert.deepEqual(h.manager.status().cameras.map(({ id, name }) => ({ id, name })), [
        { id: 'DEVICE_1', name: 'Basement Door (camera)' },
        { id: 'DEVICE_2', name: 'Basement Door (video lock)' },
        { id: 'DEVICE_3', name: 'Camera 3' }
    ]);
    assert.equal(camera.getName(), 'Basement Door');
    assert.equal(lock.getName(), 'Basement Door');
    assert.equal(other.getName(), 'Camera 3');
    assert.deepEqual([camera.getId(), lock.getId(), other.getId()], ['DEVICE_1', 'DEVICE_2', 'DEVICE_3']);
});

test('a key is validated through camera read access before saving only the dedicated DB setting', async t => {
    const h = harness(t, { configured: false });
    const status = await h.manager.configure(API_KEY);
    assert.equal(status.configured, true);
    assert.deepEqual(h.calls.map(call => call[0]), ['client', 'scope', 'inventory', 'save']);
    assert.deepEqual(h.calls[0][1], { address: 'http://127.0.0.1:4859', token: API_KEY });
    assert.deepEqual(h.calls[2][1], { $cache: false, $socket: false, $timeout: 10000 });
    assert.deepEqual(h.settings.get(CREDENTIALS_KEY), { apiKey: API_KEY });
    assert.deepEqual(h.homey.app.appSettings, { retained: true });
    assert.equal(JSON.stringify(status).includes(API_KEY), false);
});

test('permission or connection failures are redacted and retain the last working key', async t => {
    const h = harness(t, { getVideos: async () => { throw Error(SECRET); } });
    await assert.rejects(h.manager.configure('replacement-read-only-test-key'), safeError);
    assert.deepEqual(h.settings.get(CREDENTIALS_KEY), { apiKey: API_KEY });
    assert.equal(h.calls.some(call => call[0] === 'save'), false);
    await assert.rejects(h.manager.configure(undefined), safeError);
    await assert.rejects(h.manager.configure('short'), safeError);
    await assert.rejects(h.manager.configure(API_KEY + '\n'), safeError);
});

test('owner sessions and keys with device control or unrelated access are rejected', async t => {
    for (const session of [
        { type: 'OAUTH', intersectedScopes: ['homey.device.readonly'] },
        { type: 'PAT', intersectedScopes: ['homey'] },
        { type: 'PAT', intersectedScopes: ['homey.device'] },
        { type: 'PAT', intersectedScopes: ['homey.device.readonly', 'homey.device.control'] },
        { type: 'PAT', intersectedScopes: ['homey.device.readonly', 'homey.flow.readonly'] },
        { type: 'PAT', intersectedScopes: [] }
    ]) {
        const h = harness(t, { session, configured: false });
        h.camera();
        await assert.rejects(h.manager.configure(API_KEY), safeError);
        assert.equal(h.calls.some(call => call[0] === 'inventory' || call[0] === 'save'), false);
        assert.equal(h.manager.status().configured, false);
    }
    const h = harness(t, { session: { type: 'PAT', intersectedScopes: ['resource', 'homey.device.readonly'] } });
    await h.manager.configure(API_KEY);
    assert.equal(h.manager.status().configured, true);
});

test('a changed local address cannot send the key off the Homey loopback interface', async t => {
    const h = harness(t, { address: 'https://untrusted.example/' });
    await assert.rejects(h.manager.configure(API_KEY), safeError);
    assert.equal(h.calls.some(call => call[0] === 'client'), false);
});

test('unknown, replaced, unavailable, and private cameras fail before any API request', async t => {
    const h = harness(t);
    const camera = h.camera();
    await assert.rejects(h.manager.offer('OTHER_APP_DEVICE', OFFER), safeError);
    await assert.rejects(h.manager.offer('homey:video:foreign-video', OFFER), safeError);
    camera.privacy = true;
    await assert.rejects(h.manager.offer(camera.getId(), OFFER), safeError);
    camera.privacy = false;
    camera.available = false;
    await assert.rejects(h.manager.offer(camera.getId(), OFFER), safeError);
    camera.available = true;
    h.homey.app.FfmpegManager.videos.get(camera.EufyDevice.getSerial()).video.id = 'main';
    await assert.rejects(h.manager.offer(camera.getId(), OFFER), safeError);
    assert.equal(h.calls.length, 0);
});

test('malformed or oversized SDP is rejected without contacting Homey', async t => {
    const h = harness(t);
    h.camera();
    for (const sdp of [null, {}, 'rtsp://camera', 'v=0\r\nm=audio 9 test\r\n', OFFER + '\0', OFFER + 'x'.repeat(65536)]) {
        await assert.rejects(h.manager.offer('DEVICE_1', sdp), safeError);
    }
    assert.equal(h.calls.length, 0);
});

test('offers use only the own registered video UUID and return opaque handles with SDP', async t => {
    const h = harness(t);
    h.camera();
    const response = await h.manager.offer('DEVICE_1', OFFER);
    assert.match(response.handle, /^[0-9a-f]{48}$/);
    assert.deepEqual(Object.keys(response).sort(), ['answerSdp', 'handle']);
    assert.equal(response.answerSdp, ANSWER);
    assert.equal(JSON.stringify(response).includes(SECRET), false);
    assert.deepEqual(h.calls.find(call => call[0] === 'offer')[1], {
        id: '00000000-0000-4000-8000-000000000001', offer: OFFER, $timeout: 35000, $socket: false
    });
    await h.manager.keepAlive('DEVICE_1', response.handle);
    assert.deepEqual(h.calls.find(call => call[0] === 'keepAlive')[1], {
        id: '00000000-0000-4000-8000-000000000001', streamId: SECRET, $timeout: 10000, $socket: false
    });
});

test('the four-view limit also counts concurrent pending negotiations', async t => {
    const pending = deferred();
    const h = harness(t, { videoOffer: () => pending.promise });
    for (let index = 1; index <= 5; index++) h.camera(index);
    const offers = [1, 2, 3, 4].map(index => h.manager.offer(`DEVICE_${index}`, OFFER));
    await assert.rejects(h.manager.offer('DEVICE_5', OFFER), /camera view limit/);
    assert.equal(h.manager.handles.size, 4);
    pending.resolve({ answerSdp: ANSWER, streamId: SECRET });
    await Promise.all(offers);
    assert.equal(h.calls.filter(call => call[0] === 'client').length, 1);
    assert.equal(h.calls.filter(call => call[0] === 'offer').length, 4);
});

test('the shared numeric limit admits six pending views and rejects a seventh', async t => {
    const pending = deferred();
    const h = harness(t, { videoOffer: () => pending.promise });
    h.settings.set(SETTING_KEY, { maxStreams: 6 });
    for (let index = 1; index <= 7; index++) h.camera(index);
    assert.equal(h.manager.status().maxViews, 6);
    const offers = [1, 2, 3, 4, 5, 6].map(index => h.manager.offer(`DEVICE_${index}`, OFFER));
    await assert.rejects(h.manager.offer('DEVICE_7', OFFER), /camera view limit/);
    assert.equal(h.manager.handles.size, 6);
    pending.resolve({ answerSdp: ANSWER, streamId: SECRET });
    await Promise.all(offers);
});

test('No limit survives wall recreation and permits more than four views', async t => {
    const h = harness(t);
    h.settings.set(SETTING_KEY, { maxStreams: null });
    const recreated = new CameraWall(h.homey, { createLocalAPI: async () => h.api });
    t.after(() => recreated.dispose());
    assert.equal(recreated.status().maxViews, null);
    for (let index = 1; index <= 12; index++) {
        h.camera(index);
        await recreated.offer(`DEVICE_${index}`, OFFER);
    }
    assert.equal(recreated.handles.size, 12);
});

test('lowering the shared limit preserves active views and allows sharing an existing camera', async t => {
    const h = harness(t);
    h.settings.set(SETTING_KEY, { maxStreams: 6 });
    for (let index = 1; index <= 7; index++) h.camera(index);
    const views = await Promise.all([1, 2, 3, 4, 5, 6].map(index => h.manager.offer(`DEVICE_${index}`, OFFER)));
    h.settings.set(SETTING_KEY, { maxStreams: 2 });
    assert.equal(h.manager.status().maxViews, 2);
    assert.equal(h.manager.handles.size, 6);
    await h.manager.keepAlive('DEVICE_1', views[0].handle);
    await assert.rejects(h.manager.offer('DEVICE_7', OFFER), /camera view limit/);
    const shared = await h.manager.offer('DEVICE_1', OFFER);
    assert.match(shared.handle, /^[0-9a-f]{48}$/);
    assert.equal(h.manager.handles.size, 7);
});

test('an existing helper source can be viewed at capacity without using a legacy HomeBase session', async t => {
    const h = harness(t);
    const camera = h.camera();
    const media = h.homey.app.FfmpegManager;
    media.sourceCount = () => 4;
    media.stationOwners.set(camera.EufyDevice.getStationSerial(), SECRET);
    media.helperClient = { enabled: () => true, hasSource: device => device === camera };
    let refreshes = 0;
    media.refreshHelperStatus = async () => { refreshes++; };
    await h.manager.offer(camera.getId(), OFFER);
    assert.equal(refreshes, 2);
    assert.equal(media.stationOwners.get(camera.EufyDevice.getStationSerial()), SECRET);
});

test('helper capacity reconciliation rechecks camera privacy before requesting video', async t => {
    const h = harness(t);
    const camera = h.camera();
    const media = h.homey.app.FfmpegManager;
    media.helperClient = { enabled: () => true, hasSource: () => true };
    media.refreshHelperStatus = async () => { camera.privacy = true; };
    await assert.rejects(h.manager.offer(camera.getId(), OFFER), /privacy mode/);
    assert.equal(h.manager.handles.size, 0);
    assert.equal(h.calls.filter(([name]) => name === 'offer').length, 0);
});

test('a cancelled or expired offer cannot dispatch after its second helper-capacity refresh', async t => {
    for (const cancel of ['invalidate', 'dispose', 'expire']) {
        const gate = deferred();
        const h = harness(t);
        const camera = h.camera();
        const media = h.homey.app.FfmpegManager;
        media.helperClient = { enabled: () => true, hasSource: () => true };
        let refreshes = 0;
        media.refreshHelperStatus = () => ++refreshes === 2 ? gate.promise : Promise.resolve();
        const offer = h.manager.offer(camera.getId(), OFFER);
        offer.catch(() => {});
        for (let index = 0; index < 20 && refreshes < 2; index++) await new Promise(setImmediate);
        assert.equal(refreshes, 2);
        if (cancel === 'expire') h.advance(75001);
        else h.manager[cancel]();
        gate.resolve();
        await assert.rejects(offer, safeError);
        assert.equal(h.calls.filter(([name]) => name === 'offer').length, 0);
        assert.equal(h.manager.handles.size, 0);
    }
});

test('a busy P2P HomeBase is explained before requesting video without changing source ownership', async t => {
    const h = harness(t);
    const camera = h.camera();
    const media = h.homey.app.FfmpegManager;
    media.stationOwners.set(camera.EufyDevice.getStationSerial(), SECRET);
    media.sessions.set(SECRET, { untouched: true });
    const before = [...media.stationOwners];
    await assert.rejects(h.manager.offer('DEVICE_1', OFFER), error => {
        safeError(error);
        assert.match(error.message, /HomeBase is busy streaming/);
        assert.doesNotMatch(error.message, /API key/);
        return true;
    });
    assert.equal(h.calls.length, 0);
    assert.equal(h.manager.handles.size, 0);
    assert.deepEqual([...media.stationOwners], before);
    assert.deepEqual([...media.sessions], [[SECRET, { untouched: true }]]);
});

test('full P2P source capacity is refused before negotiation but an existing own source is shared', async t => {
    const h = harness(t);
    const camera = h.camera();
    const media = h.homey.app.FfmpegManager;
    media.maxSessions = 1;
    media.sessions.set(SECRET, { untouched: true });
    await assert.rejects(h.manager.offer('DEVICE_1', OFFER), error => {
        safeError(error);
        assert.match(error.message, /stream limit/);
        return true;
    });
    assert.equal(h.calls.length, 0);
    media.sessions.set(camera.EufyDevice.getSerial(), { shared: true });
    const view = await h.manager.offer('DEVICE_1', OFFER);
    assert.match(view.handle, /^[0-9a-f]{48}$/);
    assert.equal(media.sessions.size, 2, 'the wall must not reserve or release source sessions');
});

test('selected isolated cameras may negotiate on a busy HomeBase without changing its legacy owner', async t => {
    const h = harness(t);
    const selected = h.camera();
    const media = h.homey.app.FfmpegManager;
    const station = selected.EufyDevice.getStationSerial();
    media.stationOwners.set(station, SECRET);
    media.sessions.set(SECRET, { legacy: true });
    h.settings.set('camera_isolated_p2p_devices', [selected.getId()]);
    const view = await h.manager.offer(selected.getId(), OFFER);
    assert.match(view.handle, /^[a-f0-9]{48}$/);
    assert.equal(h.calls.filter(([name]) => name === 'offer').length, 1);
    assert.equal(media.stationOwners.get(station), SECRET);
    assert.deepEqual([...media.sessions], [[SECRET, { legacy: true }]], 'the wall does not start or replace manager sources');
});

test('isolated wall eligibility still counts closing sources and shares an existing own session', async t => {
    const h = harness(t);
    const camera = h.camera();
    const media = h.homey.app.FfmpegManager;
    h.settings.set('camera_isolated_p2p_devices', true);
    for (const serial of ['A', 'B', 'C']) media.sessions.set(serial, {});
    media.stopping.set('D', Promise.resolve());
    await assert.rejects(h.manager.offer(camera.getId(), OFFER), /stream limit/i);
    assert.equal(h.calls.filter(([name]) => name === 'offer').length, 0);
    media.sessions.set(camera.EufyDevice.getSerial(), { shared: true });
    const view = await h.manager.offer(camera.getId(), OFFER);
    assert.match(view.handle, /^[a-f0-9]{48}$/);
    assert.equal(media.stopping.has('D'), true);
});

test('the wall rechecks isolated capacity after asynchronous API preparation', async t => {
    const pending = deferred();
    const h = harness(t, { createLocalAPI: () => pending.promise });
    const camera = h.camera();
    h.settings.set('camera_isolated_p2p_devices', [camera.getId()]);
    const offer = h.manager.offer(camera.getId(), OFFER);
    const media = h.homey.app.FfmpegManager;
    for (const serial of ['A', 'B', 'C', 'D']) media.stopping.set(serial, Promise.resolve());
    pending.resolve(h.api);
    await assert.rejects(offer, /stream limit/i);
    assert.equal(h.calls.filter(([name]) => name === 'offer').length, 0);
    assert.equal(h.manager.handles.size, 0);
});

test('working native RTSP bypasses P2P station ownership and source capacity', async t => {
    const h = harness(t);
    const camera = h.camera();
    const media = h.homey.app.FfmpegManager;
    camera.EufyDevice.native = true;
    media.maxSessions = 1;
    media.sessions.set(SECRET, {});
    media.stationOwners.set(camera.EufyDevice.getStationSerial(), SECRET);
    const view = await h.manager.offer('DEVICE_1', OFFER);
    assert.match(view.handle, /^[0-9a-f]{48}$/);
    assert.equal(h.calls.filter(call => call[0] === 'offer').length, 1);
    assert.equal(media.stationOwners.get(camera.EufyDevice.getStationSerial()), SECRET);
});

test('more than four native RTSP negotiations bypass the finite wall relay budget', async t => {
    const pending = deferred();
    const h = harness(t, { videoOffer: () => pending.promise });
    const media = h.homey.app.FfmpegManager;
    media.sourceCount = () => 4;
    for (let index = 1; index <= 6; index++) h.camera(index).EufyDevice.native = true;
    const offers = [1, 2, 3, 4, 5, 6].map(index => h.manager.offer(`DEVICE_${index}`, OFFER));
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    assert.equal(h.manager.handles.size, 6);
    assert.ok(h.manager.status().cameras.every(camera => camera.usesStreamLimit === false));
    pending.resolve({ answerSdp: ANSWER, streamId: SECRET });
    await Promise.all(offers);
    assert.equal(h.calls.filter(([name]) => name === 'offer').length, 6);
});

test('native RTSP views do not consume mixed-wall P2P capacity and same-camera P2P views still share it', async t => {
    const h = harness(t);
    h.settings.set(SETTING_KEY, { maxStreams: 2 });
    for (let index = 1; index <= 5; index++) h.camera(index).EufyDevice.native = true;
    for (let index = 6; index <= 8; index++) h.camera(index);
    await Promise.all([1, 2, 3, 4, 5].map(index => h.manager.offer(`DEVICE_${index}`, OFFER)));
    await h.manager.offer('DEVICE_6', OFFER); await h.manager.offer('DEVICE_7', OFFER);
    await assert.rejects(h.manager.offer('DEVICE_8', OFFER), /camera view limit/);
    await h.manager.offer('DEVICE_6', OFFER);
    assert.equal(h.manager.handles.size, 8);
    assert.equal(h.manager.status().cameras.find(camera => camera.id === 'DEVICE_6').usesStreamLimit, true);

    const native = h.homey.app.deviceList[0];
    native.privacy = true;
    await assert.rejects(h.manager.offer(native.getId(), OFFER), /privacy mode/);
    assert.equal(h.manager.handles.size, 8, 'privacy checks must not alter unrelated leases');
});

test('native classification tracks current fallback and unresolved old registrations count conservatively', async t => {
    const h = harness(t);
    h.settings.set(SETTING_KEY, { maxStreams: 1 });
    const native = h.camera(); native.EufyDevice.native = true;
    h.camera(2);
    const view = await h.manager.offer(native.getId(), OFFER);
    assert.equal(h.manager.status().cameras[0].usesStreamLimit, false);
    native.EufyDevice.native = false;
    assert.equal(h.manager.status().cameras[0].usesStreamLimit, true);
    await assert.rejects(h.manager.offer('DEVICE_2', OFFER), /camera view limit/);

    native.EufyDevice.native = true;
    h.homey.app.FfmpegManager.videos.delete(native.EufyDevice.getSerial());
    await assert.rejects(h.manager.offer('DEVICE_2', OFFER), /camera view limit/);
    native.EufyDevice.getSerial = () => { throw Error(SECRET); };
    await assert.rejects(h.manager.offer('DEVICE_2', OFFER), error => safeError(error) && /camera view limit/.test(error.message));
    h.advance(75001);
    await h.manager.offer('DEVICE_2', OFFER);
    assert.equal(h.manager.handles.has(view.handle), false);
});

test('a HomeBase becoming busy during API setup prevents stale negotiation', async t => {
    const pending = deferred();
    const h = harness(t, { createLocalAPI: () => pending.promise });
    const camera = h.camera();
    const offer = h.manager.offer('DEVICE_1', OFFER);
    h.homey.app.FfmpegManager.stationOwners.set(camera.EufyDevice.getStationSerial(), SECRET);
    pending.resolve(h.api);
    await assert.rejects(offer, /HomeBase is busy streaming/);
    assert.equal(h.calls.filter(call => call[0] === 'offer').length, 0);
    assert.equal(h.manager.handles.size, 0);
});

test('native-to-P2P fallback reports current busy or capacity state after a redacted backend rejection', async t => {
    for (const reason of ['station', 'capacity']) {
        let camera;
        const h = harness(t, { videoOffer: async () => {
            camera.EufyDevice.native = false;
            const media = h.homey.app.FfmpegManager;
            if (reason === 'station') media.stationOwners.set(camera.EufyDevice.getStationSerial(), SECRET);
            else { media.maxSessions = 1; media.sessions.set(SECRET, {}); }
            throw Error(SECRET + API_KEY);
        } });
        camera = h.camera();
        camera.EufyDevice.native = true;
        await assert.rejects(h.manager.offer('DEVICE_1', OFFER), error => {
            safeError(error);
            assert.match(error.message, reason === 'station' ? /HomeBase is busy streaming/ : /stream limit/);
            assert.doesNotMatch(error.message, /API key/);
            return true;
        });
        assert.equal(h.calls.filter(call => call[0] === 'offer').length, 1);
        assert.equal(h.manager.handles.size, 0);
    }
});

test('only internally created public errors survive negotiation; backend markers cannot leak details', async t => {
    const backendError = Object.assign(Error(SECRET + API_KEY), { cameraWallPublic: true });
    const raw = harness(t, { videoOffer: async () => { throw backendError; } });
    raw.camera();
    await assert.rejects(raw.manager.offer('DEVICE_1', OFFER), safeError);
    const pending = deferred();
    const privacy = harness(t, { createLocalAPI: () => pending.promise });
    const camera = privacy.camera();
    const offer = privacy.manager.offer('DEVICE_1', OFFER);
    camera.privacy = true;
    pending.resolve(privacy.api);
    await assert.rejects(offer, error => {
        safeError(error);
        assert.match(error.message, /privacy mode/);
        return true;
    });
    assert.equal(privacy.manager.handles.size, 0);
});

test('handle/device binding and camera replacement gate keepalives without affecting another view', async t => {
    const h = harness(t);
    const first = h.camera();
    h.camera(2);
    const view = await h.manager.offer('DEVICE_1', OFFER);
    await assert.rejects(h.manager.keepAlive('DEVICE_2', view.handle), safeError);
    assert.throws(() => h.manager.stop('DEVICE_2', view.handle), safeError);
    assert.equal(h.manager.handles.size, 1);
    h.homey.app.FfmpegManager.videos.set(first.EufyDevice.getSerial(), {
        device: first, video: { id: '00000000-0000-4000-8000-999999999999' }
    });
    await assert.rejects(h.manager.keepAlive('DEVICE_1', view.handle), safeError);
    assert.equal(h.calls.filter(call => call[0] === 'keepAlive').length, 0);
    assert.equal(h.manager.handles.size, 0);
});

test('privacy changes end a wall lease without sending another keepalive', async t => {
    const h = harness(t);
    const camera = h.camera();
    const view = await h.manager.offer('DEVICE_1', OFFER);
    camera.privacy = true;
    await assert.rejects(h.manager.keepAlive('DEVICE_1', view.handle), safeError);
    assert.equal(h.manager.handles.size, 0);
    assert.equal(h.calls.filter(call => call[0] === 'keepAlive').length, 0);
});

test('a pending API connection cannot dispatch video after cancellation, privacy, or device replacement', async t => {
    for (const change of ['clear', 'privacy', 'replacement', 'dispose']) {
        const pending = deferred();
        const h = harness(t, { createLocalAPI: () => pending.promise });
        const camera = h.camera();
        const offer = h.manager.offer('DEVICE_1', OFFER);
        if (change === 'clear') await h.manager.configure(null);
        if (change === 'privacy') camera.privacy = true;
        if (change === 'replacement') h.homey.app.FfmpegManager.videos.set(camera.EufyDevice.getSerial(), { device: camera, video: { id: '00000000-0000-4000-8000-999999999999' } });
        if (change === 'dispose') await h.manager.dispose();
        pending.resolve(h.api);
        await assert.rejects(offer, safeError);
        assert.equal(h.calls.filter(call => call[0] === 'offer').length, 0, change);
        assert.equal(h.manager.handles.size, 0);
    }
});

test('expired and stopped views never keep the shared camera source alive', async t => {
    const h = harness(t);
    h.camera();
    const expired = await h.manager.offer('DEVICE_1', OFFER);
    h.advance(75001);
    await assert.rejects(h.manager.keepAlive('DEVICE_1', expired.handle), safeError);
    const stopped = await h.manager.offer('DEVICE_1', OFFER);
    assert.deepEqual(h.manager.stop('DEVICE_1', stopped.handle), { stopped: true });
    assert.deepEqual(h.manager.stop('DEVICE_1', stopped.handle), { stopped: true });
    await assert.rejects(h.manager.keepAlive('DEVICE_1', stopped.handle), safeError);
    assert.equal(h.calls.filter(call => call[0] === 'keepAlive').length, 0);
});

test('backend errors release the view slot and never expose raw errors or credentials', async t => {
    const h = harness(t, { videoOffer: async () => { throw Error(SECRET + API_KEY); } });
    h.camera();
    await assert.rejects(h.manager.offer('DEVICE_1', OFFER), safeError);
    assert.equal(h.manager.handles.size, 0);
    const second = harness(t, { keepAlive: async () => { throw Error(SECRET); } });
    second.camera();
    const view = await second.manager.offer('DEVICE_1', OFFER);
    await assert.rejects(second.manager.keepAlive('DEVICE_1', view.handle), safeError);
    assert.equal(second.manager.handles.size, 0);
});

test('clearing the key cancels pending offers while disposal keeps the saved connection', async t => {
    const pending = deferred();
    const h = harness(t, { videoOffer: () => pending.promise });
    h.camera();
    const offer = h.manager.offer('DEVICE_1', OFFER);
    await h.manager.configure(null);
    pending.resolve({ answerSdp: ANSWER, streamId: SECRET });
    await assert.rejects(offer, safeError);
    assert.equal(h.manager.handles.size, 0);
    assert.equal(h.manager.status().configured, false);
    const second = harness(t);
    second.camera();
    const view = await second.manager.offer('DEVICE_1', OFFER);
    await second.manager.dispose();
    assert.deepEqual(second.settings.get(CREDENTIALS_KEY), { apiKey: API_KEY });
    assert.equal(second.manager.handles.size, 0);
    await assert.rejects(second.manager.keepAlive('DEVICE_1', view.handle), safeError);
});
