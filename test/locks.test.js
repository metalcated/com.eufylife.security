'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);

const root = path.resolve(__dirname, '..');
// Exact strings from the pinned client's PropertyName enum, including names
// whose public enum key differs from the emitted property string.
const PropertyName = Object.freeze({
    DeviceLocked: 'locked',
    DeviceBattery: 'battery',
    DeviceBatteryTemp: 'batteryTemperature',
    DeviceLowBatteryAlert: 'lowBatteryAlert',
    DeviceEnabled: 'enabled',
    DeviceMotionDetected: 'motionDetected',
    DeviceMotionSensorPIREvent: 'motionSensorPirEvent',
    DevicePersonDetected: 'personDetected',
    DevicePersonName: 'personName',
    DevicePicture: 'picture',
    DevicePictureUrl: 'hidden-pictureUrl',
    DevicePetDetected: 'petDetected',
    DeviceSoundDetected: 'soundDetected',
    DeviceCryingDetected: 'cryingDetected',
    DeviceSensorOpen: 'sensorOpen',
    DeviceRinging: 'ringing',
    DeviceIdentityPersonDetected: 'identityPersonDetected',
    DeviceStrangerPersonDetected: 'strangerPersonDetected',
    DeviceVehicleDetected: 'vehicleDetected',
    StationGuardMode: 'guardMode',
    StationPersonName: 'stationPersonName',
    StationAlarm: 'alarm'
});
const DeviceType = {
    LOCK_BLE: 50,
    LOCK_WIFI: 51,
    LOCK_BLE_NO_FINGER: 52,
    LOCK_WIFI_NO_FINGER: 53,
    LOCK_8503: 54,
    LOCK_8530: 55,
    LOCK_85A3: 56,
    LOCK_8592: 57,
    LOCK_8504: 58,
    LOCK_8502: 180,
    LOCK_8506: 184,
    LOCK_8531: 189,
    LOCK_85L0: 201,
    LOCK_85D0: 202,
    LOCK_85V0: 203,
    LOCK_85P0: 209
};

// Load the real integration with only the unavailable Homey/client runtimes replaced.
// Every test gets isolated modules and deterministic timers; no account is contacted.
function loadIntegration() {
    const cache = new Map();
    const utils = { ...require('../lib/utils'), sleep: async () => {} };
    const mocks = {
        homey: { Device: class {}, Driver: class {} },
        'eufy-security-client': { PropertyName, DeviceType, AlarmEvent: {} }
    };

    function load(filename) {
        const absolute = require.resolve(filename);
        if (cache.has(absolute)) return cache.get(absolute).exports;
        const module = { exports: {} };
        cache.set(absolute, module);
        const nativeRequire = createRequire(absolute);
        const localRequire = (request) => {
            if (Object.hasOwn(mocks, request)) return mocks[request];
            const resolved = nativeRequire.resolve(request);
            if (resolved === path.join(root, 'lib/utils.js')) return utils;
            if (resolved.startsWith(`${root}${path.sep}`) && resolved.endsWith('.js')) return load(resolved);
            return nativeRequire(request);
        };
        const factory = vm.runInThisContext(`(function(require, module, exports, __filename, __dirname) {\n${fs.readFileSync(absolute, 'utf8')}\n})`, { filename: absolute });
        factory(localRequire, module, module.exports, absolute, path.dirname(absolute));
        return module.exports;
    }

    return { load };
}

function eufyDevice({ serial = 'T8520TEST0001', type = 51, channel = 1, properties, writeable = true, lock = true } = {}) {
    const values = properties || {
        [PropertyName.DeviceLocked]: true,
        [PropertyName.DeviceBattery]: 42,
        [PropertyName.DeviceLowBatteryAlert]: false
    };
    return {
        rawDevice: { device_sn: serial, device_name: serial, device_id: 123, station_sn: 'STATION1', device_type: type },
        getSerial: () => serial,
        getName: () => serial,
        getStationSerial: () => 'STATION1',
        getDeviceType: () => type,
        getChannel: () => channel,
        isLock: () => lock,
        hasBattery: () => Object.hasOwn(values, PropertyName.DeviceBattery),
        hasProperty: (name) => Object.hasOwn(values, name),
        getPropertyValue: (name) => values[name],
        getPropertyMetadata: (name) => ({ name, type: 'boolean', readable: true, writeable }),
        values
    };
}

function harness(options = {}) {
    const modules = loadIntegration();
    const Lock = modules.load(path.join(root, 'drivers/main-lock.js'));
    const Events = modules.load(path.join(root, 'lib/helpers/eufy-events.helper.js'));
    const device = new Lock();
    const client = new EventEmitter();
    client.pushService = new EventEmitter();
    client.isConnected = () => true;
    const station = new EventEmitter();
    station.getSerial = () => 'STATION1';
    station.getLANIPAddress = () => '192.0.2.1';
    station.isConnected = () => true;
    const remote = eufyDevice(options);
    const timers = new Map();
    let timerID = 0;
    const values = new Map([['locked', null]]);
    const listeners = new Map();
    const calls = [];
    const log = () => {};
    const homey = {
        platformVersion: 2,
        __: (key) => key,
        setTimeout: (fn, delay) => { const id = ++timerID; timers.set(id, { fn, delay }); return id; },
        clearTimeout: (id) => timers.delete(id),
        app: { log, debug: log, warn: log, error: log, eufyClient: client, deviceList: [device], setDevice: log }
    };
    Object.assign(device, {
        homey,
        driver: { id: 'driver_SMART_LOCK', manifest: { id: 'driver_SMART_LOCK', capabilities: ['locked'] } },
        HomeyDevice: { device_sn: remote.getSerial(), station_sn: station.getSerial() },
        EufyDevice: remote,
        EufyStation: station,
        _started: true,
        _image: {},
        _imageTimeStamp: {},
        getData: () => ({ device_sn: remote.getSerial(), station_sn: station.getSerial() }),
        getName: () => 'Front door',
        getCapabilities: () => [...values.keys()],
        hasCapability: (name) => values.has(name),
        getCapabilityValue: (name) => values.get(name),
        setCapabilityValue: async (name, value) => { values.set(name, value); calls.push(['state', name, value]); },
        addCapability: async (name) => values.set(name, null),
        removeCapability: async (name) => values.delete(name),
        registerCapabilityListener: (name, listener) => listeners.set(name, listener),
        getSettings: () => ({}),
        setSettings: async (settings) => calls.push(['settings', settings]),
        setUnavailable: async (reason) => calls.push(['unavailable', reason]),
        setAvailable: async () => calls.push(['available']),
        unsetWarning: async () => {},
        setWarning: async () => {},
        error: log,
        log,
        setImage: async () => assert.fail('Locks must not create camera images'),
        setVideo: async () => assert.fail('Locks must not create camera streams')
    });
    client.getDevice = async () => remote;
    client.getStation = async () => station;
    client.setDeviceProperty = async (...args) => calls.push(['command', ...args]);
    const events = new Events(homey);
    homey.app.eufyEventsHelper = events;
    return { ...modules, device, remote, station, client, homey, events, values, listeners, calls, timers };
}

async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function resultFor(h, overrides = {}) {
    return {
        channel: h.remote.getChannel(),
        return_code: 0,
        customData: { property: { name: PropertyName.DeviceLocked, value: true } },
        ...overrides
    };
}

test('only client lock types with implemented commands are discoverable', () => {
    const { load } = loadIntegration();
    const { isSupportedLock } = load(path.join(root, 'lib/lock-support.js'));
    for (const type of [50, 51, 52, 53, 54, 55, 58, 180, 184, 201, 203, 209]) {
        assert.equal(isSupportedLock(eufyDevice({ type })), true, `supported type ${type}`);
    }
    for (const type of [56, 57, 189, 202, 999]) {
        assert.equal(isSupportedLock(eufyDevice({ type })), false, `unsupported type ${type}`);
    }
    assert.equal(isSupportedLock(eufyDevice({ type: 1, lock: false })), false);
    assert.equal(isSupportedLock(eufyDevice({ writeable: false })), false);
    assert.equal(isSupportedLock(eufyDevice({ properties: {} })), false);
    assert.equal(isSupportedLock({}), false);
});

test('pairing filters lock families, preserves IDs, and excludes paired devices', async () => {
    const { load } = loadIntegration();
    const Driver = load(path.join(root, 'drivers/driver_SMART_LOCK/driver.js'));
    const driver = new Driver();
    const paired = eufyDevice({ serial: 'T8520PAIRED' });
    const fresh = eufyDevice({ serial: 'T8506NEW', type: 184 });
    driver.id = 'driver_SMART_LOCK';
    driver.homey = { app: {
        deviceTypes: { OTHER: ['UNKNOWN'] },
        deviceList: [{ getData: () => ({ device_sn: paired.getSerial() }) }],
        log: () => {}, error: () => {}
    } };
    driver.deviceList = [paired, fresh, eufyDevice({ type: 202 }), eufyDevice({ type: 1, lock: false })];
    const found = await driver.onDeviceListRequest(driver.id);
    assert.equal(found.length, 1);
    assert.equal(found[0].data.device_sn, fresh.getSerial());
    assert.equal(found[0].data.id, `${fresh.getSerial()}-123`);
    assert.equal(found[0].data.station_sn, 'STATION1');
    assert.deepEqual(found[0].settings, { STATION_SN: 'STATION1' });
});

test('legacy camera pairing retains its existing serial matching behavior', async () => {
    const { load } = loadIntegration();
    const Driver = load(path.join(root, 'drivers/main-driver.js'));
    const driver = new Driver();
    driver.homey = { app: { deviceTypes: { OTHER: ['T8416'] }, deviceList: [], log: () => {}, error: () => {} } };
    driver.deviceList = [eufyDevice({ serial: 'T8416CAMERA', type: 1, lock: false }), eufyDevice()];
    const found = await driver.onDeviceListRequest('camera');
    assert.equal(found.length, 1);
    assert.equal(found[0].data.device_sn, 'T8416CAMERA');
});

test('lock startup uses sensor paths and exposes only reported capabilities', async () => {
    const h = harness();
    await h.device.onStartup(true, 0);
    assert.equal(h.device._started, true);
    assert.deepEqual(h.device.getCapabilities().sort(), ['alarm_battery', 'locked', 'measure_battery']);
    assert.deepEqual([...h.listeners.keys()], ['locked']);
    assert.equal(h.values.get('locked'), true);
    assert.equal(h.values.get('measure_battery'), 42);
    assert.equal(h.values.get('alarm_battery'), false);
    assert.equal(h.calls.some(([name]) => name === 'available'), true);
    assert.equal(h.calls.some(([name]) => name === 'command'), false);
});

test('initial and reconnect hydration preserves unlocked state and zero battery', async () => {
    const h = harness({ properties: {
        [PropertyName.DeviceLocked]: false,
        [PropertyName.DeviceBattery]: 0,
        [PropertyName.DeviceLowBatteryAlert]: true,
        [PropertyName.DeviceBatteryTemp]: 0
    } });
    await h.device.checkCapabilities();
    await h.device.resetCapabilities();
    assert.equal(h.values.get('locked'), false);
    assert.equal(h.values.get('measure_battery'), 0);
    assert.equal(h.values.get('measure_temperature'), 0);
    assert.equal(h.values.get('alarm_battery'), true);
    h.remote.values[PropertyName.DeviceLocked] = true;
    await h.device.onStartup(false, 0);
    assert.equal(h.values.get('locked'), true);
    assert.equal(h.calls.some(([name]) => name === 'command'), false);
});

test('missing optional lock properties do not create battery or temperature readings', async () => {
    const h = harness({ properties: { [PropertyName.DeviceLocked]: true } });
    await h.device.checkCapabilities();
    await h.device.resetCapabilities();
    assert.deepEqual(h.device.getCapabilities(), ['locked']);
    assert.equal(h.values.get('locked'), true);
});

test('unknown initial lock state stays unavailable and recovers after its first reported state', async (t) => {
    for (const initial of [undefined, null]) {
        await t.test(String(initial), async () => {
            const h = harness({ properties: { [PropertyName.DeviceLocked]: initial } });
            h.values.set('locked', true);
            await h.device.onStartup(true, 0);
            assert.equal(h.device._started, false);
            assert.equal(h.values.get('locked'), null);
            assert.equal(h.calls.some(([name]) => name === 'available'), false);
            await assert.rejects(h.device.onCapability_locked(true), /unavailable/i);
            h.remote.values[PropertyName.DeviceLocked] = false;
            h.client.emit('device property changed', h.remote, PropertyName.DeviceLocked, false);
            await new Promise(setImmediate);
            assert.equal(h.device._started, true);
            assert.equal(h.values.get('locked'), false);
            assert.equal(h.calls.some(([name]) => name === 'available'), true);
            assert.equal(h.client.listenerCount('close'), 1, 'recovery replaces the connection listener');
        });
    }
});

test('idle client disconnection invalidates lock state and unload clears lifecycle listeners', async () => {
    const h = harness();
    await h.device.onStartup(true, 0);
    assert.equal(h.values.get('locked'), true);
    h.client.emit('close');
    await flush();
    assert.equal(h.device._started, false);
    assert.equal(h.values.get('locked'), null);
    assert.match(h.calls.filter(([name]) => name === 'unavailable').at(-1)[1], /Connection|lost/i);
    await assert.rejects(h.device.onCapability_locked(false), /unavailable/i);
    await h.device.onUninit();
    assert.equal(h.client.listenerCount('close'), 0);
    assert.equal(h.client.listenerCount('device property changed'), 1, 'only the shared event helper remains');
});

test('client reconnect rehydrates an idle lock without duplicating lifecycle listeners', async () => {
    const h = harness();
    await h.device.onStartup(true, 0);
    h.client.emit('close');
    await flush();
    assert.equal(h.device._started, false);
    assert.equal(h.values.get('locked'), null);
    h.remote.values[PropertyName.DeviceLocked] = false;
    h.client.emit('connect');
    await new Promise(setImmediate);
    assert.equal(h.device._started, true);
    assert.equal(h.values.get('locked'), false);
    assert.equal(h.calls.at(-1)[0], 'available');
    assert.equal(h.client.listenerCount('close'), 1);
    assert.equal(h.client.listenerCount('connect'), 1);
    assert.equal(h.client.listenerCount('device property changed'), 2);
    await h.device.onUninit();
    assert.equal(h.client.listenerCount('close'), 0);
    assert.equal(h.client.listenerCount('connect'), 0);
    assert.equal(h.client.listenerCount('device property changed'), 1);
});

test('unload or deletion during device lookup cancels lock startup before registration', async (t) => {
    for (const action of ['onUninit', 'onDeleted']) {
        await t.test(action, async () => {
            const h = harness();
            let releaseDevice;
            h.client.getDevice = () => new Promise((resolve) => { releaseDevice = resolve; });
            h.homey.app.setDevice = async () => h.calls.push(['register']);
            h.homey.app.removeDevice = () => {};
            const startup = h.device.onStartup();
            await new Promise(setImmediate);
            assert.equal(typeof releaseDevice, 'function');
            await h.device[action]();
            releaseDevice(h.remote);
            await startup;
            assert.equal(h.calls.some(([name]) => name === 'available'), false);
            assert.equal(h.calls.some(([name]) => name === 'register'), false);
            assert.equal(h.client.listenerCount('close'), 0);
            assert.equal(h.client.listenerCount('connect'), 0);
        });
    }
});

test('a late lock property event after deletion does not change stored state', async () => {
    const h = harness();
    h.homey.app.removeDevice = () => {};
    await h.device.onStartup();
    await h.device.onDeleted();
    const statesBefore = h.calls.filter(([name]) => name === 'state').length;
    await h.events.updateDeviceProperties(h.device, h.remote, PropertyName.DeviceLocked, false);
    assert.equal(h.calls.filter(([name]) => name === 'state').length, statesBefore);
    assert.equal(h.values.get('locked'), true);
});

test('idle station sleep preserves the last reported state and lock availability', async () => {
    const h = harness();
    await h.device.onStartup(true, 0);
    const unavailableCount = h.calls.filter(([name]) => name === 'unavailable').length;
    h.station.emit('close', h.station);
    await flush();
    assert.equal(h.device._started, true);
    assert.equal(h.values.get('locked'), true);
    assert.equal(h.calls.filter(([name]) => name === 'unavailable').length, unavailableCount);
});

test('lock and battery events update persistently without camera reset timers', async () => {
    const h = harness();
    await h.device.checkCapabilities();
    await h.events.updateDeviceProperties(h.device, h.remote, PropertyName.DeviceLocked, true);
    await h.events.updateDeviceProperties(h.device, h.remote, PropertyName.DeviceLowBatteryAlert, true);
    await h.events.updateDeviceProperties(h.device, h.remote, PropertyName.DeviceBattery, 0);
    await flush();
    assert.equal(h.values.get('locked'), true);
    assert.equal(h.values.get('alarm_battery'), true);
    assert.equal(h.values.get('measure_battery'), 0);
    assert.equal(h.timers.size, 0);
    await h.events.updateDeviceProperties(h.device, h.remote, PropertyName.DeviceLocked, false);
    await flush();
    assert.equal(h.values.get('locked'), false);
});

test('lock control stays pending until a matching client state confirmation', async () => {
    const h = harness();
    h.values.set('locked', false);
    h.remote.values[PropertyName.DeviceLocked] = false;
    let complete = false;
    const pending = h.device.onCapability_locked(true).then(() => { complete = true; });
    await flush();
    assert.equal(complete, false);
    assert.deepEqual(h.calls.filter(([name]) => name === 'command'), [['command', h.remote.getSerial(), PropertyName.DeviceLocked, true]]);
    assert.equal(h.values.get('locked'), false);
    h.client.emit('device property changed', eufyDevice({ serial: 'OTHER' }), PropertyName.DeviceLocked, true);
    h.client.emit('device property changed', h.remote, PropertyName.DeviceBattery, true);
    h.client.emit('device property changed', h.remote, PropertyName.DeviceLocked, false);
    h.station.emit('command result', h.station, resultFor(h));
    await flush();
    assert.equal(complete, false, 'queue/primary ack alone is insufficient');
    h.client.emit('device property changed', h.remote, PropertyName.DeviceLocked, true);
    await pending;
    assert.equal(complete, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.station.listenerCount('command result'), 0);
    assert.equal(h.station.listenerCount('secondary command result'), 0);
});

test('primary and secondary command failures reject without changing lock state', async (t) => {
    for (const event of ['command result', 'secondary command result']) {
        await t.test(event, async () => {
            const h = harness();
            h.values.set('locked', false);
            const pending = h.device.onCapability_locked(true);
            const rejected = assert.rejects(pending, /fail|reject|code|denied|error/i);
            await flush();
            h.station.emit(event, h.station, resultFor(h, { return_code: -1 }));
            await rejected;
            assert.equal(h.values.get('locked'), false);
            assert.equal(h.timers.size, 0);
            assert.equal(h.station.listenerCount(event), 0);
        });
    }
});

test('unrelated station/channel/property command results do not reject an active request', async () => {
    const h = harness();
    let complete = false;
    const pending = h.device.onCapability_locked(true).finally(() => { complete = true; });
    await flush();
    h.station.emit('command result', { getSerial: () => 'OTHER' }, resultFor(h, { return_code: -1 }));
    h.station.emit('command result', h.station, resultFor(h, { channel: 9, return_code: -1 }));
    h.station.emit('command result', h.station, resultFor(h, { customData: { property: { name: PropertyName.DeviceBattery, value: true } }, return_code: -1 }));
    await flush();
    assert.equal(complete, false);
    h.client.emit('device property changed', h.remote, PropertyName.DeviceLocked, true);
    await pending;
});

test('repeating the reported lock state still waits for a fresh command acknowledgment', async () => {
    const h = harness();
    h.values.set('locked', true);
    let complete = false;
    const pending = h.device.onCapability_locked(true).then(() => { complete = true; });
    await flush();
    assert.equal(complete, false, 'the cached locked value is not a new confirmation');
    assert.equal(h.calls.filter(([name]) => name === 'command').length, 1);
    h.station.emit('command result', h.station, resultFor(h));
    await pending;
    assert.equal(complete, true);
    assert.equal(h.timers.size, 0);
});

test('retrofit locks require their secondary acknowledgment when the state is unchanged', async (t) => {
    for (const type of [54, 58]) {
        await t.test(`type ${type}`, async () => {
            const h = harness({ type });
            let complete = false;
            const pending = h.device.onCapability_locked(true).then(() => { complete = true; });
            await flush();
            h.station.emit('command result', h.station, resultFor(h));
            await flush();
            assert.equal(complete, false, 'the primary retrofit response is insufficient');
            h.station.emit('secondary command result', h.station, resultFor(h));
            await pending;
            assert.equal(complete, true);
            assert.equal(h.timers.size, 0);
        });
    }
});

test('an acknowledgment cannot reuse a cached state that changed during the request', async () => {
    const h = harness();
    let complete = false;
    const pending = h.device.onCapability_locked(true).then(() => { complete = true; });
    await flush();
    h.remote.values[PropertyName.DeviceLocked] = false;
    h.station.emit('command result', h.station, resultFor(h));
    await flush();
    assert.equal(complete, false);
    h.remote.values[PropertyName.DeviceLocked] = true;
    h.client.emit('device property changed', h.remote, PropertyName.DeviceLocked, true);
    await pending;
});

test('command timeout cleans up listeners and permits retry', async () => {
    const h = harness();
    const pending = h.device.onCapability_locked(true);
    const rejected = assert.rejects(pending, /timed out|timeout|confirm/i);
    await flush();
    assert.equal(h.timers.size, 1);
    const timer = [...h.timers.values()][0];
    assert.equal(timer.delay, 20000);
    timer.fn();
    await rejected;
    assert.equal(h.timers.size, 0);
    assert.equal(h.station.listenerCount('command result'), 0);
    const retry = h.device.onCapability_locked(false);
    await flush();
    h.client.emit('device property changed', h.remote, PropertyName.DeviceLocked, false);
    await retry;
});

test('overlapping lock requests are rejected and unload cancels the first request', async () => {
    const h = harness();
    const pending = h.device.onCapability_locked(true);
    const rejected = assert.rejects(pending, /unload|stop|cancel|disconnect|shutting down/i);
    await flush();
    await assert.rejects(h.device.onCapability_locked(false), /pending|progress|already|wait/i);
    await h.device.onUninit();
    await rejected;
    assert.equal(h.timers.size, 0);
    assert.equal(h.station.listenerCount('command result'), 0);
    assert.equal(h.station.listenerCount('secondary command result'), 0);
});

test('unloading before queued dispatch prevents sending a command', async () => {
    const h = harness();
    const pending = h.device.onCapability_locked(true);
    const rejected = assert.rejects(pending, /shutting down|unload|cancel/i);
    await h.device.onUninit();
    await rejected;
    await flush();
    assert.equal(h.calls.some(([name]) => name === 'command'), false);
});

test('reconnect cancels pending control, refreshes status, and allows a new request', async () => {
    const h = harness();
    const pending = h.device.onCapability_locked(true);
    const rejected = assert.rejects(pending, /reconnect|cancel/i);
    await flush();
    await h.device.onStartup(false, 0);
    await rejected;
    assert.equal(h.device._started, true);
    assert.equal(h.timers.size, 0);
    const retry = h.device.onCapability_locked(false);
    await flush();
    h.client.emit('device property changed', h.remote, PropertyName.DeviceLocked, false);
    await retry;
});

test('revoked write permission makes an existing lock unavailable and prevents control', async () => {
    const h = harness({ writeable: false });
    await assert.rejects(h.device.onCapability_locked(true), /unavailable|support|permission/i);
    await h.device.onStartup(false, 0);
    assert.equal(h.device._started, false);
    assert.equal(h.calls.some(([name]) => name === 'available'), false);
    assert.equal(h.calls.some(([name]) => name === 'command'), false);
});

test('write failures and disconnection reject; nonboolean and unready commands are refused', async () => {
    const h = harness();
    await assert.rejects(h.device.onCapability_locked('true'), /boolean|invalid|true or false/i);
    h.client.setDeviceProperty = async () => { throw new Error('Permission denied'); };
    await assert.rejects(h.device.onCapability_locked(true), /Permission denied/);
    assert.equal(h.timers.size, 0);
    h.client.setDeviceProperty = async () => {};
    const pending = h.device.onCapability_locked(true);
    const rejected = assert.rejects(pending, /disconnect|closed|connection/i);
    await flush();
    h.client.emit('close');
    await rejected;
    h.device.EufyDevice = null;
    await assert.rejects(h.device.onCapability_locked(true), /ready|available|connect|initial/i);
});

test('existing contact, battery, guard mode, and camera motion event mappings remain intact', async () => {
    const h = harness();
    const seen = [];
    const existingDevice = {
        _image: {},
        getName: () => 'Existing device',
        hasCapability: () => true,
        onCapability_NTFY_TRIGGER: async (...args) => seen.push(args),
        set_alarm_arm_mode: async (value) => seen.push(['arm', value])
    };
    await h.events.updateDeviceProperties(existingDevice, h.remote, PropertyName.DeviceSensorOpen, true);
    await h.events.updateDeviceProperties(existingDevice, h.remote, PropertyName.DeviceBattery, 0);
    await h.events.updateDeviceProperties(existingDevice, h.remote, PropertyName.StationGuardMode, 1);
    await h.events.updateDeviceProperties(existingDevice, h.remote, PropertyName.DeviceMotionDetected, true);
    assert.deepEqual(seen[0].slice(0, 2), ['alarm_contact', true]);
    assert.deepEqual(seen[1].slice(0, 2), ['measure_battery', 0]);
    assert.equal(seen.some(([capability]) => capability === 'CMD_SET_ARMING'), true);
    assert.equal(seen.some(([capability, value]) => capability === 'NTFY_MOTION_DETECTION' && value === true), true);
});

test('the generated lock manifest retains native lock controls, shared login/repair, and real assets', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
    const compose = JSON.parse(fs.readFileSync(path.join(root, '.homeycompose/app.json'), 'utf8'));
    const driverCompose = JSON.parse(fs.readFileSync(path.join(root, 'drivers/driver_SMART_LOCK/driver.compose.json'), 'utf8'));
    const driver = manifest.drivers.find((item) => item.id === 'driver_SMART_LOCK');
    assert.ok(driver);
    assert.equal(manifest.version, compose.version);
    assert.equal(driver.class, 'lock');
    assert.deepEqual(driver.capabilities, ['locked']);
    assert.equal(driver.class, driverCompose.class);
    assert.deepEqual(driver.capabilities, driverCompose.capabilities);
    assert.deepEqual(driver.name, driverCompose.name);
    for (const views of [driver.pair, driver.repair]) {
        assert.ok(views.some(({ id }) => id === 'login_eufy'));
        assert.ok(views.some(({ id }) => id === 'login_captcha'));
        assert.ok(views.some(({ id }) => id === 'pincode'));
    }
    const settingIDs = driver.settings.flatMap(({ children }) => children.map(({ id }) => id));
    assert.deepEqual(settingIDs, ['STATION_SN', 'DEVICE_SN', 'LOCAL_STATION_IP']);
    for (const asset of [driver.icon, ...Object.values(driver.images)]) {
        assert.equal(fs.existsSync(path.join(root, asset.replace(/^\//, ''))), true, asset);
    }
});
