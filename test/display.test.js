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
const PropertyName = Object.freeze({
    Model: 'model',
    SoftwareVersion: 'softwareVersion',
    HardwareVersion: 'hardwareVersion',
    DeviceBattery: 'battery',
    DeviceLocked: 'locked',
    DevicePicture: 'picture',
    DevicePictureUrl: 'hidden-pictureUrl'
});

// Homey and the Eufy runtime are unavailable locally. Exercise the real display
// modules with isolated runtime doubles and no account or network connection.
function loadIntegration() {
    const cache = new Map();
    const mocks = {
        homey: { Device: class {}, Driver: class {} },
        'eufy-security-client': { PropertyName, AlarmEvent: {} }
    };
    const utils = { ...require('../lib/utils'), sleep: async () => {} };

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

function eufyDisplay({ model = 'T87A0', serial = 'T87A0TEST0001', battery, firmware = '1.2.3', hardware = '1.0', name = 'Hallway Display' } = {}) {
    const info = { model, serial, battery, firmware, hardware };
    return {
        rawDevice: { device_sn: serial, device_name: name, device_id: 87, station_sn: 'DISPLAY-STATION' },
        getModel: () => info.model,
        getSerial: () => serial,
        getName: () => name,
        getStationSerial: () => 'DISPLAY-STATION',
        getSoftwareVersion: () => info.firmware,
        getHardwareVersion: () => info.hardware,
        getRawProperty: (parameter) => parameter === 8001 ? info.battery : undefined,
        info
    };
}

function harness(options = {}) {
    const modules = loadIntegration();
    const Display = modules.load(path.join(root, 'drivers/main-display.js'));
    const Events = modules.load(path.join(root, 'lib/helpers/eufy-events.helper.js'));
    const device = new Display();
    const remote = eufyDisplay(options);
    const client = new EventEmitter();
    client.pushService = new EventEmitter();
    client.isConnected = () => true;
    const calls = [];
    const values = new Map();
    const settings = {};
    const data = { device_sn: remote.getSerial(), station_sn: remote.getStationSerial() };
    const noop = () => {};
    const homey = {
        __: (name) => name,
        app: {
            eufyClient: client,
            deviceList: [device],
            log: noop, debug: noop, error: noop,
            setDevice: async (added) => calls.push(['register', added]),
            removeDevice: (serial) => calls.push(['remove', serial])
        },
        images: { createImage: () => assert.fail('An information-only display must not create camera images') }
    };
    client.getDevice = async () => remote;
    client.getStation = async () => assert.fail('Display information must not require a station connection');
    client.setDeviceProperty = async () => assert.fail('Display information must not send device commands');
    client.setStationProperty = async () => assert.fail('Display information must not send station commands');
    Object.assign(device, {
        homey,
        driver: { id: 'driver_SMART_DISPLAY', manifest: { id: 'driver_SMART_DISPLAY', capabilities: [] } },
        HomeyDevice: data,
        getData: () => data,
        getName: () => 'Hallway Display',
        getCapabilities: () => [...values.keys()],
        hasCapability: (name) => values.has(name),
        getCapabilityValue: (name) => values.get(name),
        setCapabilityValue: async (name, value) => { values.set(name, value); calls.push(['state', name, value]); },
        addCapability: async (name) => { values.set(name, null); calls.push(['capability', name]); },
        removeCapability: async (name) => values.delete(name),
        getSettings: () => ({ ...settings }),
        setSettings: async (updated) => { Object.assign(settings, updated); calls.push(['settings', updated]); },
        setUnavailable: async (reason) => calls.push(['unavailable', reason]),
        setAvailable: async () => calls.push(['available']),
        unsetWarning: async () => {},
        setImage: async () => assert.fail('Display must not create camera snapshots'),
        setVideo: async () => assert.fail('Display must not create camera streams')
    });
    const events = new Events(homey);
    homey.app.eufyEventsHelper = events;
    return { ...modules, device, remote, client, calls, values, settings, events };
}

test('display discovery recognizes E10 model or serial and never guesses from its name', () => {
    const { load } = loadIntegration();
    const { isSupportedDisplay } = load(path.join(root, 'lib/display-support.js'));
    assert.equal(isSupportedDisplay(eufyDisplay()), true);
    assert.equal(isSupportedDisplay(eufyDisplay({ model: 't87a0', serial: 'ALTERNATE-SERIAL' })), true);
    assert.equal(isSupportedDisplay(eufyDisplay({ model: '', serial: 'T87A0123456789' })), true);
    assert.equal(isSupportedDisplay(eufyDisplay({ model: 'T8416', serial: 'T8416CAMERA', name: 'Smart Display E10' })), false);
    assert.equal(isSupportedDisplay(eufyDisplay({ model: 'T87A1', serial: 'T87A1UNKNOWN' })), false);
    assert.equal(isSupportedDisplay({}), false);
});

test('display pairing reuses account device discovery and excludes already paired serials', async () => {
    const { load } = loadIntegration();
    const Driver = load(path.join(root, 'drivers/driver_SMART_DISPLAY/driver.js'));
    const driver = new Driver();
    driver.id = 'driver_SMART_DISPLAY';
    driver.homey = { app: {
        deviceTypes: { OTHER: ['UNKNOWN'] },
        deviceList: [{ getData: () => ({ device_sn: 'T87A0PAIRED' }) }],
        log: () => {}, error: () => {}
    } };
    driver.deviceList = [
        eufyDisplay({ serial: 'T87A0PAIRED' }),
        eufyDisplay({ serial: 'T87A0NEW' }),
        eufyDisplay({ model: 'T8416', serial: 'T8416CAMERA' })
    ];
    const found = await driver.onDeviceListRequest(driver.id);
    assert.equal(found.length, 1);
    assert.equal(found[0].data.device_sn, 'T87A0NEW');
    assert.equal(found[0].data.id, 'T87A0NEW-87');
});

test('display startup exposes getter-backed identity and firmware without camera or station operations', async () => {
    const h = harness();
    await h.device.onStartup(true, 0);
    assert.equal(h.settings.MODEL, 'T87A0');
    assert.equal(h.settings.FIRMWARE_VERSION, '1.2.3');
    assert.equal(h.settings.HARDWARE_VERSION, '1.0');
    assert.equal(h.settings.DEVICE_SN, h.remote.getSerial());
    assert.equal(h.settings.STATION_SN, h.remote.getStationSerial());
    assert.equal(h.calls.some(([name]) => name === 'available'), true);
    assert.deepEqual(h.device.getCapabilities(), []);
});

test('missing display firmware and hardware values are labeled as unreported', async () => {
    const h = harness({ firmware: '', hardware: null });
    await h.device.onStartup(true, 0);
    assert.equal(h.settings.FIRMWARE_VERSION, 'Not reported by Eufy');
    assert.equal(h.settings.HARDWARE_VERSION, 'Not reported by Eufy');
});

test('only valid integer display battery percentages create a reading', async (t) => {
    for (const battery of [0, 57, 100, '0', '57', '100']) {
        await t.test(String(battery), async () => {
            const h = harness({ battery });
            await h.device.onStartup(true, 0);
            assert.equal(h.values.get('measure_battery'), Number(battery));
            assert.deepEqual(h.device.getCapabilities(), ['measure_battery']);
        });
    }
});

test('unknown, malformed, and out-of-range display battery values stay unreported', async (t) => {
    for (const battery of [undefined, null, '', ' ', '57%', '2.5', 2.5, -1, 101, NaN, Infinity, true, false, {}, []]) {
        await t.test(`${typeof battery}:${String(battery)}`, async () => {
            const h = harness({ battery });
            await h.device.onStartup(true, 0);
            assert.equal(h.values.has('measure_battery'), false);
        });
    }
});

test('display repair refreshes firmware and existing battery state without sending commands', async () => {
    const h = harness({ battery: 80 });
    await h.device.onStartup(true, 0);
    h.remote.info.firmware = '1.2.4';
    h.remote.info.battery = '0';
    await h.device.onStartup(false, 0);
    assert.equal(h.settings.FIRMWARE_VERSION, '1.2.4');
    assert.equal(h.values.get('measure_battery'), 0);
});

test('a later display battery parameter adds the capability and preserves zero readings', async () => {
    const h = harness();
    await h.device.onStartup(true, 0);
    assert.equal(h.values.has('measure_battery'), false);
    h.remote.info.battery = '55';
    h.client.emit('device raw property changed', h.remote, 8001, '55');
    await new Promise(setImmediate);
    assert.equal(h.values.get('measure_battery'), 55);
    h.remote.info.battery = 0;
    h.client.emit('device raw property changed', h.remote, 8001, 0);
    await new Promise(setImmediate);
    assert.equal(h.values.get('measure_battery'), 0);
    assert.equal(h.calls.filter(([name]) => name === 'capability').length, 1);
});

test('display raw events ignore other devices and parameters; invalid battery clears the reading', async () => {
    const h = harness({ battery: 50 });
    await h.device.onStartup(true, 0);
    h.client.emit('device raw property changed', eufyDisplay({ serial: 'T87A0OTHER' }), 8001, 70);
    h.client.emit('device raw property changed', h.remote, 8002, 99);
    await new Promise(setImmediate);
    assert.equal(h.values.get('measure_battery'), 50);
    h.remote.info.battery = 'unknown';
    h.client.emit('device raw property changed', h.remote, 8001, 'unknown');
    await new Promise(setImmediate);
    assert.equal(h.values.get('measure_battery'), null);
    assert.equal(h.values.has('measure_battery'), true);
});

test('display metadata events refresh settings while camera battery events cannot overwrite its reading', async () => {
    const h = harness({ battery: 42 });
    await h.device.onStartup(true, 0);
    h.remote.info.firmware = '1.2.5';
    h.remote.info.hardware = '2.0';
    await h.events.updateDeviceProperties(h.device, h.remote, PropertyName.SoftwareVersion, '1.2.5');
    await h.events.updateDeviceProperties(h.device, h.remote, PropertyName.HardwareVersion, '2.0');
    assert.equal(h.settings.FIRMWARE_VERSION, '1.2.5');
    assert.equal(h.settings.HARDWARE_VERSION, '2.0');
    await h.events.updateDeviceProperties(h.device, h.remote, PropertyName.DeviceBattery, 99);
    assert.equal(h.values.get('measure_battery'), 42);
    assert.equal(h.values.has('locked'), false);
});

test('display disconnect and reconnect refresh info without duplicating event subscriptions', async () => {
    const h = harness({ battery: 75 });
    await h.device.onStartup(true, 0);
    h.client.emit('close');
    await new Promise(setImmediate);
    assert.match(h.calls.filter(([name]) => name === 'unavailable').at(-1)[1], /connect|lost/i);
    h.remote.info.firmware = '1.2.6';
    h.remote.info.battery = 74;
    h.client.emit('connect');
    await new Promise(setImmediate);
    assert.equal(h.settings.FIRMWARE_VERSION, '1.2.6');
    assert.equal(h.values.get('measure_battery'), 74);
    assert.equal(h.calls.at(-1)[0], 'available');
    assert.equal(h.client.listenerCount('close'), 1);
    assert.equal(h.client.listenerCount('connect'), 1);
    assert.equal(h.client.listenerCount('device raw property changed'), 1);
    await h.device.onUninit();
    assert.equal(h.client.listenerCount('close'), 0);
    assert.equal(h.client.listenerCount('connect'), 0);
    assert.equal(h.client.listenerCount('device raw property changed'), 0);
});

test('display deletion removes event subscriptions and app device bookkeeping', async () => {
    const h = harness();
    await h.device.onStartup(true, 0);
    await h.device.onDeleted();
    assert.equal(h.client.listenerCount('close'), 0);
    assert.equal(h.client.listenerCount('connect'), 0);
    assert.equal(h.client.listenerCount('device raw property changed'), 0);
    assert.deepEqual(h.calls.find(([name]) => name === 'remove'), ['remove', h.remote.getSerial()]);
});

test('unload or deletion during device lookup cancels display startup before registration', async (t) => {
    for (const action of ['onUninit', 'onDeleted']) {
        await t.test(action, async () => {
            const h = harness();
            let releaseDevice;
            h.client.getDevice = () => new Promise((resolve) => { releaseDevice = resolve; });
            const startup = h.device.onStartup();
            await new Promise(setImmediate);
            assert.equal(typeof releaseDevice, 'function');
            await h.device[action]();
            releaseDevice(h.remote);
            await startup;
            assert.equal(h.calls.some(([name]) => name === 'available'), false);
            assert.equal(h.calls.some(([name]) => name === 'register'), false);
            assert.equal(h.client.listenerCount('device raw property changed'), 0);
            assert.equal(h.client.listenerCount('close'), 0);
            assert.equal(h.client.listenerCount('connect'), 0);
        });
    }
});

test('a late display firmware event after deletion does not update device settings', async () => {
    const h = harness();
    await h.device.onStartup();
    await h.device.onDeleted();
    const settingsBefore = h.calls.filter(([name]) => name === 'settings').length;
    h.remote.info.firmware = '9.9.9';
    await h.events.updateDeviceProperties(h.device, h.remote, PropertyName.SoftwareVersion, '9.9.9');
    assert.equal(h.calls.filter(([name]) => name === 'settings').length, settingsBefore);
    assert.equal(h.settings.FIRMWARE_VERSION, '1.2.3');
});

test('client loss during a slow display refresh prevents startup from marking it available', async () => {
    const h = harness();
    let releaseRefresh;
    h.device.refreshInfo = () => new Promise((resolve) => { releaseRefresh = resolve; });
    const startup = h.device.onStartup();
    await new Promise(setImmediate);
    assert.equal(typeof releaseRefresh, 'function');
    h.client.emit('close');
    releaseRefresh();
    await startup;
    assert.equal(h.calls.some(([name]) => name === 'available'), false);
    assert.equal(h.device._started, false);
});

test('display startup does not mark cached device information available on a disconnected client', async () => {
    const h = harness();
    h.client.isConnected = () => false;
    await h.device.onStartup();
    assert.equal(h.calls.some(([name]) => name === 'available'), false);
    assert.equal(h.device._started, false);
});

test('a different device family never becomes an available display', async () => {
    const h = harness({ model: 'T8416', serial: 'T8416CAMERA' });
    await h.device.onStartup(true, 0);
    assert.equal(h.calls.some(([name]) => name === 'available'), false);
    assert.equal(h.calls.some(([name]) => name === 'unavailable'), true);
});

test('the generated display manifest provides information and shared account pairing', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
    const compose = JSON.parse(fs.readFileSync(path.join(root, 'drivers/driver_SMART_DISPLAY/driver.compose.json'), 'utf8'));
    const driver = manifest.drivers.find(({ id }) => id === 'driver_SMART_DISPLAY');
    assert.ok(driver);
    assert.deepEqual(driver.capabilities, []);
    assert.deepEqual(driver.capabilities, compose.capabilities);
    assert.equal(driver.class, compose.class);
    const settingIDs = driver.settings.flatMap(({ children }) => children.map(({ id }) => id));
    for (const setting of ['MODEL', 'FIRMWARE_VERSION', 'HARDWARE_VERSION', 'DEVICE_SN', 'STATION_SN']) {
        assert.ok(settingIDs.includes(setting), setting);
    }
    for (const views of [driver.pair, driver.repair]) {
        assert.ok(views.some(({ id }) => id === 'login_eufy'));
        assert.ok(views.some(({ id }) => id === 'pincode'));
    }
    for (const asset of [driver.icon, ...Object.values(driver.images)]) {
        assert.equal(fs.existsSync(path.join(root, asset.replace(/^\//, ''))), true, asset);
    }
});
