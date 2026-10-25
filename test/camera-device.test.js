'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness() {
    const filename = path.resolve(__dirname, '../drivers/main-device.js');
    const nativeRequire = createRequire(filename);
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(request => request === 'homey' ? { Device: class {} } : request === 'eufy-security-client' ? { PropertyName: {} }
        : request === '../lib/utils.js' ? { sleep: async () => {} } : nativeRequire(request), module, module.exports);
    const calls = [];
    let connected = true;
    const remote = { getStationSerial: () => 'STATION', hasBattery: () => false, getSerial: () => 'CAMERA' };
    const station = { rawStation: { member: {} }, getLANIPAddress: () => '192.0.2.2', getSerial: () => 'STATION' };
    const client = { getDevice: async () => remote, getStation: async () => station, isConnected: () => connected };
    const device = new module.exports();
    device.HomeyDevice = { device_sn: 'CAMERA', station_sn: 'STATION' };
    device.homey = { platformVersion: 2, __: value => value, app: { eufyClient: client,
        appSettings: { STATION_IPS: {} }, setDevice: async () => {}, log() {}, debug() {}, error() {},
        FfmpegManager: { releaseDevice: async id => calls.push(['release', id]) } } };
    device.getName = () => 'Camera'; device.getSettings = () => ({});
    for (const name of ['setImage', 'setVideo', 'checkCapabilities', 'resetCapabilities', 'check_alarm_arm_mode',
        'check_alarm_generic', 'check_alarm_motion', 'setCapabilitiesListeners', 'setSettings', 'updateRemoteWarning', 'setUnavailable', 'setAvailable']) {
        device[name] = async (...args) => calls.push([name, ...args]);
    }
    return { device, calls, client, remote, disconnect: () => { connected = false; } };
}

test('a failed camera reconnect clears earlier readiness and cannot expose stale camera objects', async () => {
    const h = harness();
    await h.device.onStartup(true, 0);
    assert.equal(h.device._started, true);
    h.client.getDevice = async () => { throw Error('No longer authorized'); };
    h.calls.length = 0;
    await h.device.onStartup(false, 0);
    assert.equal(h.device._started, false);
    assert.equal(h.calls.some(([name]) => name === 'setAvailable'), false);
});

test('removal or client replacement during camera lookup discards late startup results', async () => {
    for (const action of ['unload', 'replace']) {
        const h = harness();
        let resolve;
        h.client.getDevice = () => new Promise(yes => { resolve = yes; });
        const startup = h.device.onStartup(true, 0);
        await new Promise(setImmediate);
        if (action === 'unload') await h.device.onUninit();
        else h.device.homey.app.eufyClient = { isConnected: () => true };
        resolve(h.remote);
        await startup;
        assert.equal(h.device._started, false);
        assert.equal(h.calls.some(([name]) => name === 'setImage' || name === 'setAvailable'), false);
    }
});

test('connection loss while final camera settings are saved cannot mark it ready', async () => {
    const h = harness();
    h.device.setSettings = async () => { h.disconnect(); };
    await h.device.onStartup(true, 0);
    assert.equal(h.device._started, false);
    assert.equal(h.calls.some(([name]) => name === 'setAvailable'), false);
});
