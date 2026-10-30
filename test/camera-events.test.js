'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);
const filename = path.resolve(__dirname, '../lib/helpers/eufy-events.helper.js');
const PropertyName = Object.freeze({ DeviceEnabled: 'enabled', DeviceRTSPStream: 'rtspStream', DeviceLocked: 'locked' });
const clientEvents = ['device property changed', 'station property changed', 'station livestream start', 'station livestream stop', 'close'];
const flush = () => new Promise(setImmediate);

function client() {
    const result = new EventEmitter();
    result.pushService = new EventEmitter();
    return result;
}

function camera(serial) {
    return { rawDevice: { device_sn: serial }, getSerial: () => serial };
}

function harness() {
    const nativeRequire = createRequire(filename);
    const localRequire = (name) => name === 'eufy-security-client' ? { PropertyName, AlarmEvent: {} } : nativeRequire(name);
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require, module, exports, __filename, __dirname) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(localRequire, module, module.exports, filename, path.dirname(filename));
    const current = client();
    const calls = [];
    const errors = [];
    const remote = camera('CAMERA-ONE');
    const device = {
        HomeyDevice: { device_sn: remote.getSerial() },
        setVideo: async () => calls.push(['video'])
    };
    const manager = {
        streamHandler: async (...args) => calls.push(['start', ...args]),
        sourceStopped: async (...args) => calls.push(['source-stop', ...args]),
        stopStream: async (...args) => calls.push(['stop', ...args])
    };
    const homey = { app: {
        eufyClient: current,
        deviceList: [device],
        FfmpegManager: manager,
        log: () => {},
        error: (error) => errors.push(error)
    } };
    const helper = new module.exports(homey);
    helper.updateDeviceProperties = async (...args) => calls.push(['property', ...args]);
    return { helper, client: current, homey, manager, remote, device, calls, errors };
}

test('shared event helper initializes once and disposal removes only its own listeners', async () => {
    const h = harness();
    const external = () => {};
    for (const event of clientEvents) h.client.on(event, external);
    h.client.pushService.on('raw message', external);
    await h.helper.init();
    for (const event of clientEvents) assert.equal(h.client.listenerCount(event), 2, event);
    assert.equal(h.client.pushService.listenerCount('raw message'), 2);
    h.helper.dispose();
    h.helper.dispose();
    for (const event of clientEvents) assert.deepEqual(h.client.listeners(event), [external], event);
    assert.deepEqual(h.client.pushService.listeners('raw message'), [external]);
    assert.equal(h.errors.length, 0);
});

test('client replacement detaches old streams, properties and push before binding the new client', async () => {
    const h = harness();
    const old = h.client;
    const replacement = client();
    h.homey.app.eufyClient = replacement;
    await h.helper.init();
    await h.helper.init();
    for (const event of clientEvents) {
        assert.equal(old.listenerCount(event), 0, `old ${event}`);
        assert.equal(replacement.listenerCount(event), 1, `new ${event}`);
    }
    assert.equal(old.pushService.listenerCount('raw message'), 0);
    assert.equal(replacement.pushService.listenerCount('raw message'), 1);
    old.emit('station livestream start', {}, h.remote, {}, {}, {});
    old.emit('device property changed', h.remote, PropertyName.DeviceEnabled, false);
    old.emit('close');
    await flush();
    assert.equal(h.calls.length, 0, 'closed client cannot operate media or update devices');
    replacement.emit('device property changed', h.remote, PropertyName.DeviceLocked, true);
    await flush();
    assert.deepEqual(h.calls, [['property', h.device, h.remote, PropertyName.DeviceLocked, true]]);
    h.helper.dispose();
    for (const event of clientEvents) assert.equal(replacement.listenerCount(event), 0);
    assert.equal(replacement.pushService.listenerCount('raw message'), 0);
});

test('stream starts preserve station, device, video, audio and codec metadata identities', async () => {
    const h = harness();
    const station = { getSerial: () => 'STATION-ONE' };
    const metadata = { videoCodec: 1, videoFPS: 15, videoWidth: 1920, videoHeight: 1080, audioCodec: 0 };
    const video = { kind: 'video fixture' };
    const audio = { kind: 'audio fixture' };
    h.client.emit('station livestream start', station, h.remote, metadata, video, audio);
    await flush();
    assert.deepEqual(h.calls, [['start', video, audio, h.remote, station, metadata]]);
    assert.equal(h.errors.length, 0);
});

test('an asynchronous stream failure is handled without an unhandled event promise rejection', async () => {
    const h = harness();
    const failure = new Error('Fixture decoder failure');
    h.manager.streamHandler = async () => { throw failure; };
    assert.doesNotThrow(() => h.client.emit('station livestream start', {}, h.remote, {}, {}, {}));
    await flush();
    assert.deepEqual(h.errors, [failure]);
    const station = {};
    h.client.emit('station livestream stop', station, h.remote);
    await flush();
    assert.deepEqual(h.calls, [['source-stop', station, h.remote]], 'a failed source does not break later cleanup events');
});

test('privacy-off and source-stop target their own device while client close stops all media', async () => {
    const h = harness();
    h.client.emit('device property changed', h.remote, PropertyName.DeviceEnabled, true);
    h.client.emit('device property changed', h.remote, PropertyName.DeviceLocked, false);
    h.client.emit('device property changed', camera('OTHER-CAMERA'), PropertyName.DeviceEnabled, false);
    await flush();
    assert.equal(h.calls.some(([name]) => name === 'stop'), false);
    h.client.emit('device property changed', h.remote, PropertyName.DeviceEnabled, false);
    const station = {};
    h.client.emit('station livestream stop', station, h.remote);
    h.client.emit('close');
    await flush();
    assert.deepEqual(h.calls.filter(([name]) => name === 'stop' || name === 'source-stop'), [
        ['stop', h.remote],
        ['source-stop', station, h.remote],
        ['stop']
    ]);
    assert.ok(h.calls.some(([name, device, remote, property, value]) =>
        name === 'property' && device === h.device && remote === h.remote && property === PropertyName.DeviceEnabled && value === false));
});

test('media stop rejections from privacy, source stop and client close are all consumed', async () => {
    const h = harness();
    const failure = new Error('Fixture stop failure');
    h.manager.stopStream = async () => { throw failure; };
    h.manager.sourceStopped = async () => { throw failure; };
    h.client.emit('device property changed', h.remote, PropertyName.DeviceEnabled, false);
    h.client.emit('station livestream stop', {}, h.remote);
    h.client.emit('close');
    await flush();
    assert.deepEqual(h.errors, [failure, failure, failure]);
});

test('native RTSP changes refresh only the affected device registration and handle rejection', async () => {
    const h = harness();
    h.client.emit('device property changed', camera('OTHER-CAMERA'), PropertyName.DeviceRTSPStream, true);
    h.client.emit('device property changed', h.remote, PropertyName.DeviceEnabled, true);
    await flush();
    assert.equal(h.calls.some(([name]) => name === 'video'), false);
    h.client.emit('device property changed', h.remote, PropertyName.DeviceRTSPStream, false);
    h.client.emit('device property changed', h.remote, PropertyName.DeviceRTSPStream, true);
    await flush();
    assert.equal(h.calls.filter(([name]) => name === 'video').length, 2);
    const failure = new Error('Fixture video registration failure');
    h.device.setVideo = async () => { throw failure; };
    h.client.emit('device property changed', h.remote, PropertyName.DeviceRTSPStream, true);
    await flush();
    assert.deepEqual(h.errors, [failure]);
});

test('the latest paired roster controls property and privacy routing after device removal', async () => {
    const h = harness();
    const remote = camera('CAMERA-TWO');
    const device = { HomeyDevice: { device_sn: remote.getSerial() } };
    await h.helper.setDevices([device]);
    h.client.emit('device property changed', h.remote, PropertyName.DeviceEnabled, false);
    h.client.emit('device property changed', remote, PropertyName.DeviceEnabled, false);
    await flush();
    assert.deepEqual(h.calls, [
        ['property', device, remote, PropertyName.DeviceEnabled, false],
        ['stop', remote]
    ]);
});

test('station updates route by station serial and rejected property work is caught', async () => {
    const h = harness();
    const station = { getSerial: () => 'STATION-ONE' };
    const device = { HomeyDevice: { device_sn: 'STATION-ONE' } };
    await h.helper.setDevices([device]);
    h.client.emit('station property changed', { getSerial: () => 'OTHER-STATION' }, 'guardMode', 1);
    h.client.emit('station property changed', station, 'guardMode', 1);
    await flush();
    assert.deepEqual(h.calls, [['property', device, station, 'guardMode', 1]]);
    const failure = new Error('Fixture property failure');
    h.helper.updateDeviceProperties = async () => { throw failure; };
    h.client.emit('station property changed', station, 'guardMode', 2);
    await flush();
    assert.deepEqual(h.errors, [failure]);
});

test('raw push handling failures are consumed and old push subscriptions are removed on rebind', async () => {
    const h = harness();
    const failure = new Error('Fixture push failure');
    h.helper.handleRawMessage = async () => { throw failure; };
    h.client.pushService.emit('raw message', { fixture: true });
    await flush();
    assert.deepEqual(h.errors, [failure]);
    h.homey.app.eufyClient = client();
    await h.helper.init();
    h.client.pushService.emit('raw message', { fixture: true });
    await flush();
    assert.deepEqual(h.errors, [failure]);
});
