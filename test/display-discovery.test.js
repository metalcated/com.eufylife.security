'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);
const source = path.resolve(__dirname, '../lib/display-discovery.js');
const discovery = (options) => new (require(source).DisplayDiscovery)(options);

function e10(serial = 'T87A0DISPLAY1', overrides = {}) {
    return {
        device_sn: serial,
        device_name: 'Hallway Display',
        device_model: 'T87A0',
        device_type: 1,
        category: 'eufy_mega',
        parent_sn: 'T8030PARENT',
        params: [
            { param_type: 8001, param_value: '85' },
            { param_type: 8003, param_value: '2.9.05' },
            { param_type: 8004, param_value: 'T8030UNKNOWN' }
        ],
        ...overrides
    };
}

function legacyDisplay(serial = 'T87A0LEGACY') {
    return {
        rawDevice: { device_sn: serial, device_id: 'legacy-id', station_sn: 'LEGACY-PARENT' },
        getSerial: () => serial,
        getModel: () => 'T87A0',
        getName: () => 'Legacy display'
    };
}

function clientDouble({ legacy = [], houses = [], devices = {}, handler, valid = true } = {}) {
    const calls = [];
    const cameraRegistry = new Map([['EXISTING-CAMERA', Object.freeze({ serial: 'EXISTING-CAMERA' })]]);
    const client = {
        devices: cameraRegistry,
        getDevices: async () => legacy,
        connect: () => assert.fail('Display discovery must not connect or log in'),
        megaTransition: {
            getMegaApi: () => assert.fail('Display discovery must not initialize a new Mega session'),
            megaApi: {
                hasValidSession: () => valid,
                login: () => assert.fail('Display discovery must not log in'),
                getPersistentData: () => assert.fail('Display discovery must not export session data'),
                async callDecrypted(scope, endpoint, query) {
                    assert.equal(scope, 'house');
                    assert.ok(['/app/house/get_house_list', '/app/house/get_devs_list'].includes(endpoint), endpoint);
                    calls.push([endpoint, query]);
                    const shortEndpoint = endpoint.replace('/app/', '');
                    if (handler) return handler(shortEndpoint, query, calls.length);
                    if (shortEndpoint === 'house/get_house_list') return { house_infos: houses.map((house_id) => ({ house_id })) };
                    if (shortEndpoint === 'house/get_devs_list') return { devices: devices[query.house_id || 'bare'] || [] };
                    assert.fail(`Unexpected endpoint: ${endpoint}`);
                }
            }
        }
    };
    return { client, calls, cameraRegistry };
}

test('display discovery queries bare and each house scope, deduplicates E10 records, and preserves legacy objects', async () => {
    const legacy = legacyDisplay('T87A0DUPLICATE');
    const camera = { getSerial: () => 'T8416CAMERA', getModel: () => 'T8416' };
    const h = clientDouble({
        legacy: [legacy, camera],
        houses: ['HOUSE1', 'HOUSE2'],
        devices: {
            bare: [e10('T87A0DUPLICATE'), e10('T87A0BARE'), e10('T8416CAMERA', { device_model: 'T8416' })],
            HOUSE1: [e10('T87A0HOUSE1'), e10('T87A0BARE')],
            HOUSE2: [e10('T87A0HOUSE2')]
        }
    });
    const helper = discovery();
    const found = await helper.getDevices(h.client);
    assert.deepEqual(found.map((item) => item.getSerial()).sort(), ['T87A0BARE', 'T87A0DUPLICATE', 'T87A0HOUSE1', 'T87A0HOUSE2']);
    assert.equal(found.find((item) => item.getSerial() === 'T87A0DUPLICATE'), legacy);
    assert.deepEqual(h.calls, [
        ['/app/house/get_house_list', {}],
        ['/app/house/get_devs_list', {}],
        ['/app/house/get_devs_list', { house_id: 'HOUSE1' }],
        ['/app/house/get_devs_list', { house_id: 'HOUSE2' }]
    ]);
    assert.deepEqual(helper.getStatus(h.client), { complete: true });
    assert.equal(h.client.devices, h.cameraRegistry);
    assert.equal(h.cameraRegistry.size, 1);
});

test('E10 discovery requires explicit model, model parameter, or serial evidence rather than numeric type or human name', async () => {
    const h = clientDouble({ devices: { bare: [
        e10('SERIAL-WITH-MODEL'),
        e10('SERIAL-WITH-PARAM', { device_model: '', params: [{ param_type: 8006, param_value: 'T87A0' }] }),
        e10('T87A0SERIAL-ONLY', { device_model: '', params: [] }),
        e10('TYPE1-CAMERA', { device_model: 'T8111', device_name: 'Smart Display E10', params: [] }),
        e10('NAME-ONLY', { device_model: '', device_name: 'Smart Display E10', params: [{ param_type: 8005, param_value: 'Smart Display E10' }] }),
        e10('WRONG-MODEL', { device_model: 'T87A1', params: [] })
    ] } });
    const found = await discovery().getDevices(h.client);
    assert.deepEqual(found.map((item) => item.getSerial()).sort(), ['SERIAL-WITH-MODEL', 'SERIAL-WITH-PARAM', 'T87A0SERIAL-ONLY']);
    assert.equal(found.every((item) => item.getModel() === 'T87A0'), true);
});

test('display adapters expose verified metadata and battery without interpreting unknown parameters or leaking cloud records', async () => {
    const h = clientDouble({ devices: { bare: [e10('T87A0INFO', {
        main_sw_version: 'root-firmware',
        main_hw_version: 'root-hardware',
        station_sn: 'FALLBACK-PARENT',
        deviceParams: { main_sw_version: 'nested-firmware', main_hw_version: 'nested-hardware' },
        access_token: 'not-for-device-store',
        private_metadata: { account: 'not-for-device-store' }
    }), e10('T87A0UNKNOWN', { parent_sn: '', station_sn: '' }),
    e10('T87A0SELF', { parent_sn: 'T87A0SELF', station_sn: 'T8030FALLBACK' })] } });
    const helper = discovery();
    const found = await helper.getDevices(h.client);
    const info = found.find((item) => item.getSerial() === 'T87A0INFO');
    assert.equal(info.getSoftwareVersion(), 'nested-firmware');
    assert.equal(info.getHardwareVersion(), 'nested-hardware');
    assert.equal(info.getStationSerial(), 'T8030PARENT');
    assert.equal(info.getRawProperty(8001), '85');
    assert.equal(JSON.stringify(info.rawDevice).includes('not-for-device-store'), false);
    assert.equal(Object.hasOwn(info.rawDevice, 'access_token'), false);
    const unknown = found.find((item) => item.getSerial() === 'T87A0UNKNOWN');
    assert.ok(!unknown.getSoftwareVersion(), 'version-shaped parameter 8003 must not become firmware');
    assert.ok(!unknown.getHardwareVersion());
    assert.notEqual(unknown.getStationSerial(), 'T8030UNKNOWN', 'parameter 8004 must not become a parent serial');
    assert.equal(found.find((item) => item.getSerial() === 'T87A0SELF').getStationSerial(), 'T8030FALLBACK');
    assert.equal((await helper.getDevice(h.client, 'T87A0INFO')), info);
});

test('root explicit firmware fields remain usable when nested fields are empty', async () => {
    const h = clientDouble({ devices: { bare: [e10('T87A0ROOT-INFO', {
        main_sw_version: '1.2.3', main_hw_version: '2.0',
        deviceParams: { main_sw_version: '', main_hw_version: ' ' }
    })] } });
    const [found] = await discovery().getDevices(h.client);
    assert.equal(found.getSoftwareVersion(), '1.2.3');
    assert.equal(found.getHardwareVersion(), '2.0');
});

test('only existing valid Mega sessions are used and failures preserve legacy displays without exposing backend details', async () => {
    const legacy = legacyDisplay();
    for (const valid of [false, true]) {
        const h = clientDouble({ legacy: [legacy], valid, handler: () => { throw Error('sensitive account backend detail'); } });
        const helper = discovery();
        assert.deepEqual(await helper.getDevices(h.client), [legacy]);
        const status = helper.getStatus(h.client);
        assert.equal(status.complete, false);
        assert.equal(typeof status.error, 'string');
        assert.equal(status.error.includes('sensitive account backend detail'), false);
        if (!valid) assert.equal(h.calls.length, 0);
    }
    const h = clientDouble({ legacy: [legacy] });
    delete h.client.megaTransition.megaApi;
    const helper = discovery();
    assert.deepEqual(await helper.getDevices(h.client), [legacy]);
    assert.equal(h.calls.length, 0);
    assert.equal(helper.getStatus(h.client).complete, false);
    const failedLogin = clientDouble({ legacy: [legacy] });
    failedLogin.client.megaTransition.megaLoginFailed = true;
    assert.deepEqual(await discovery().getDevices(failedLogin.client), [legacy]);
    assert.equal(failedLogin.calls.length, 0);
});

test('malformed house and device envelopes cannot be mistaken for a complete empty result', async (t) => {
    for (const [name, houses, devices] of [
        ['missing house envelope', {}, { devices: [] }],
        ['invalid house collection', { house_infos: 'wrong' }, { devices: [] }],
        ['invalid house identity', { house_infos: [{ house_id: 42 }] }, { devices: [] }],
        ['missing device envelope', { house_infos: [] }, {}],
        ['invalid device collection', { house_infos: [] }, { devices: 'wrong' }]
    ]) {
        await t.test(name, async () => {
            const h = clientDouble({ handler: (endpoint) => endpoint === 'house/get_house_list' ? houses : devices });
            const helper = discovery();
            assert.deepEqual(await helper.getDevices(h.client), []);
            assert.equal(helper.getStatus(h.client).complete, false);
            assert.equal(typeof helper.getStatus(h.client).error, 'string');
        });
    }
});

test('concurrent display discovery coalesces requests and honors TTL and explicit refresh', async () => {
    let time = 0;
    let release;
    const h = clientDouble({ handler: async (endpoint) => {
        if (endpoint === 'house/get_house_list') {
            await new Promise((resolve) => { release = resolve; });
            return { house_infos: [] };
        }
        return { devices: [e10()] };
    } });
    const helper = discovery({ now: () => time, ttlMs: 100 });
    const first = helper.getDevices(h.client);
    const second = helper.getDevices(h.client, { refresh: true });
    await new Promise(setImmediate);
    assert.equal(h.calls.length, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a[0], b[0]);
    assert.equal(h.calls.length, 2);
    await helper.getDevices(h.client);
    assert.equal(h.calls.length, 2);
    time = 101;
    const expired = helper.getDevices(h.client);
    await new Promise(setImmediate);
    release();
    await expired;
    assert.equal(h.calls.length, 4);
    const forced = helper.getDevices(h.client, { refresh: true });
    await new Promise(setImmediate);
    release();
    await forced;
    assert.equal(h.calls.length, 6);
});

test('empty and failed discovery attempts are cached for the TTL', async () => {
    for (const fails of [false, true]) {
        let time = 0;
        const h = clientDouble({ handler: (endpoint) => {
            if (fails) throw Error('unavailable');
            return endpoint === 'house/get_house_list' ? { house_infos: [] } : { devices: [] };
        } });
        const helper = discovery({ now: () => time, ttlMs: 100 });
        await helper.getDevices(h.client);
        const attempted = h.calls.length;
        await helper.getDevices(h.client);
        assert.equal(h.calls.length, attempted);
        time = 101;
        await helper.getDevices(h.client);
        assert.ok(h.calls.length > attempted);
    }
});

test('partial discovery retains prior displays while a complete empty refresh removes absent Mega displays', async () => {
    let phase = 'initial';
    const legacy = legacyDisplay();
    const h = clientDouble({ legacy: [legacy], handler: (endpoint, query) => {
        if (endpoint === 'house/get_house_list') return { house_infos: [{ house_id: 'HOUSE1' }] };
        if (phase === 'partial' && query.house_id) throw Error('house scope failed');
        if (phase === 'initial') return { devices: query.house_id ? [e10('T87A0PRIOR')] : [] };
        if (phase === 'partial') return { devices: [e10('T87A0FRESH')] };
        return { devices: [] };
    } });
    const helper = discovery();
    assert.equal((await helper.getDevices(h.client)).some((item) => item.getSerial() === 'T87A0PRIOR'), true);
    phase = 'partial';
    const partial = await helper.getDevices(h.client, { refresh: true });
    assert.deepEqual(partial.map((item) => item.getSerial()).sort(), ['T87A0FRESH', 'T87A0LEGACY', 'T87A0PRIOR']);
    assert.equal(helper.getStatus(h.client).complete, false);
    phase = 'empty';
    assert.deepEqual(await helper.getDevices(h.client, { refresh: true }), [legacy]);
    assert.deepEqual(helper.getStatus(h.client), { complete: true });
});

test('client replacement cannot reuse another client session cache or inventory', async () => {
    const first = clientDouble({ devices: { bare: [e10('T87A0FIRST')] } });
    const replacement = clientDouble({ devices: { bare: [e10('T87A0SECOND')] } });
    const helper = discovery();
    assert.deepEqual((await helper.getDevices(first.client)).map((item) => item.getSerial()), ['T87A0FIRST']);
    assert.deepEqual((await helper.getDevices(replacement.client)).map((item) => item.getSerial()), ['T87A0SECOND']);
    assert.equal(first.calls.length, 2);
    assert.equal(replacement.calls.length, 2);
});
