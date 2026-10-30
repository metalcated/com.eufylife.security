'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { HelperServer } = require('./service.cjs');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    return { promise, resolve, reject };
}
async function flush() { await new Promise(setImmediate); }

function fixture(t, options = {}) {
    const entries = [], handlers = new Map();
    let now = 1000;
    const manager = {
        sessions: new Map(), statuses: new Map(),
        async getSession(hd) {
            const serial = hd.EufyDevice.getSerial();
            if (this.sessions.has(serial)) return this.sessions.get(serial);
            const session = { ready: deferred(), consumers: new Set() };
            this.sessions.set(serial, session);
            sourceOptions.createP2PSession({ homeyDevice: hd, onStream() {}, onStop() {},
                onError: error => session.ready.reject(error) });
            return session;
        },
        getStatus(serial) { return this.statuses.get(serial) || {}; },
        async stopStream(serial) {
            if (this.failClose) throw Error('PRIVATE_CLOSE_DATA');
            this.sessions.get(serial)?.ready.reject(Error('PRIVATE_CANCEL_DATA'));
            this.sessions.delete(serial);
        },
        async dispose() { this.failClose = false; for (const serial of this.sessions.keys()) await this.stopStream(serial); },
    };
    let sourceOptions;
    const helper = new HelperServer({ secret: 'd'.repeat(64), runtime: { sdk: { CommandName: {}, PropertyName: {} } },
        now: () => now, rpcTimeoutMs: 10,
        managerFactory(homey, config) { sourceOptions = config; return manager; },
        createP2PSession: params => { handlers.set(params.homeyDevice.EufyDevice.getSerial(), params); return { start() {}, close() {} }; },
        onDiagnostic: entry => entries.push(entry), ...options });
    const epoch = randomUUID();
    t.after(() => { manager.failClose = false; return helper.close(); });
    const open = async (serial = 'PRIVATE_SERIAL') => {
        const result = await helper.createSession({ owner: 'com.eufylife.security', epoch, requestId: randomUUID(), deviceId: randomUUID(),
            metadata: { rawStation: { station_sn: 'PRIVATE_BASE', member: { admin_user_id: 'PRIVATE_ADMIN' } },
                rawDevice: { station_sn: 'PRIVATE_BASE', device_sn: serial, device_channel: 1, device_type: 1 },
                deviceConstructor: 'Camera', connectionType: 1, connected: true,
                config: { deviceConfig: {}, enableEmbeddedPKCS1Support: false } } });
        const record = helper.records.get(result.id);
        await record.startPromise;
        return record;
    };
    return { helper, manager, handlers, entries, epoch, open,
        connect: () => helper.connect({ owner: 'com.eufylife.security', epoch, protocol: 1, sdk: '4.2.6' }),
        advance: amount => { now += amount; } };
}

test('startup timeout and P2P failures emit only fixed public categories once per source attempt', async t => {
    const f = fixture(t); await f.connect();
    const timeout = await f.open();
    const error = Object.assign(Error('The camera did not deliver independent video in time.'), { mediaPublic: true });
    f.handlers.get(timeout.serial).onError(error);
    await flush();
    assert.equal(f.entries.filter(entry => entry.event === 'source.start_timeout').length, 1);
    const failed = await f.open('PRIVATE_SECOND_SERIAL');
    f.handlers.get(failed.serial).onError(Object.assign(Error('PRIVATE_SDK_ERROR https://secret/ PRIVATE_TOKEN'),
        { mediaPublic: true, metadata: 'PRIVATE_METADATA' }));
    await flush();
    assert.equal(f.entries.filter(entry => entry.event === 'p2p.failed').length, 1);
    assert.ok(f.entries.every(entry => Object.keys(entry).sort().join(',') === 'event,message'));
    assert.doesNotMatch(JSON.stringify(f.entries), /PRIVATE_|https:|\/v1\/media|[a-f0-9]{48}/);
});

test('first media readiness and source replacement status use source timing rather than lease timing', async t => {
    const f = fixture(t); await f.connect();
    const record = await f.open();
    f.manager.sessions.get(record.serial).ready.resolve(); await flush();
    assert.equal(f.entries.filter(entry => entry.event === 'source.ready').length, 1);
    f.manager.statuses.set(record.serial, { state: 'streaming', bytes: 900, startedAt: 1100, firstFrameAt: 1200 });
    const initial = f.helper.status(record);
    assert.equal(initial.leaseStartedAt, 1000); assert.equal(initial.startedAt, 1100); assert.equal(initial.firstFrameAt, 1200);
    f.manager.statuses.set(record.serial, { state: 'starting', bytes: 0, startedAt: 5000 });
    const restarted = f.helper.status(record);
    assert.equal(restarted.id, initial.id); assert.equal(restarted.leaseStartedAt, 1000);
    assert.equal(restarted.startedAt, 5000); assert.equal(restarted.bytes, 0); assert.equal(restarted.firstFrameAt, undefined);
});

test('source capacity, lease expiry and failed cleanup remain distinct without exposing identities', async t => {
    const f = fixture(t, { maxSessions: 1 }); await f.connect();
    const record = await f.open();
    await assert.rejects(f.open('PRIVATE_OTHER'), error => error.status === 429);
    assert.ok(f.entries.some(entry => entry.event === 'capacity.sources'));
    f.advance(75001); f.manager.failClose = true;
    await assert.rejects(f.helper.prune());
    assert.ok(f.entries.some(entry => entry.event === 'lease.expired'));
    assert.ok(f.entries.some(entry => entry.event === 'source.close_failed'));
    assert.ok(f.helper.records.has(record.id));
    f.manager.failClose = false; await f.helper.closeRecord(record);
    assert.ok(f.entries.some(entry => entry.event === 'source.closed'));
    assert.equal(f.helper.records.size, 0);
    assert.doesNotMatch(JSON.stringify(f.entries), /PRIVATE_|[a-f0-9]{48}/);
});

test('reverse RPC refusal, pending capacity, timeout and app failure have bounded public diagnostics', async t => {
    const f = fixture(t); await f.connect();
    const record = await f.open();
    await assert.rejects(f.helper.rpc(record, 'setDeviceProperty', ['PRIVATE_SERIAL', 'enabled', true]));
    assert.ok(f.entries.some(entry => entry.event === 'rpc.refused'));
    const calls = Array.from({ length: 4 }, (_, index) => f.helper.rpc(record, 'getCipher', [index, 'PRIVATE_ADMIN']));
    for (const call of calls) call.catch(() => {});
    await assert.rejects(f.helper.rpc(record, 'getCipher', [5, 'PRIVATE_ADMIN']));
    assert.ok(f.entries.some(entry => entry.event === 'capacity.rpc'));
    f.helper.reply(record, { id: 1, error: 'PRIVATE_ACCOUNT_TOKEN_AND_SDK_ERROR' });
    await Promise.allSettled(calls);
    assert.ok(f.entries.some(entry => entry.event === 'rpc.failed'));
    assert.ok(f.entries.some(entry => entry.event === 'rpc.timeout'));
    assert.doesNotMatch(JSON.stringify(f.entries), /PRIVATE_|getCipher|setDeviceProperty/);
});

test('diagnostics accept only known fixed events and emit at most 64 entries plus one notice per minute', async t => {
    const f = fixture(t);
    f.helper.diagnostic('PRIVATE_SECRET'); f.helper.diagnostic('__proto__');
    assert.equal(f.entries.length, 0);
    for (let index = 0; index < 1000; index++) f.helper.diagnostic('capacity.sources');
    assert.equal(f.entries.length, 65);
    assert.equal(f.entries.at(-1).event, 'diagnostics.suppressed');
    assert.ok(f.entries.every(entry => Object.isFrozen(entry)));
    f.advance(60000); f.helper.diagnostic('source.starting');
    assert.equal(f.entries.length, 66); assert.equal(f.entries.at(-1).event, 'source.starting');
});

test('diagnostic sink failures never interrupt source cleanup', async t => {
    const f = fixture(t, { onDiagnostic() { throw Error('PRIVATE_SINK_FAILURE'); } });
    await f.connect(); const record = await f.open();
    await f.helper.closeRecord(record);
    assert.equal(f.helper.records.size, 0);
});

test('late readiness and SDK failures after cancellation do not report a false source failure', async t => {
    const f = fixture(t); await f.connect(); const record = await f.open();
    const source = f.manager.sessions.get(record.serial);
    await f.helper.cancel(record.requestId, { owner: record.owner, epoch: record.epoch, deviceId: record.deviceId });
    f.handlers.get(record.serial).onError(Object.assign(Error('PRIVATE_LATE_SDK_ERROR'), { mediaPublic: true }));
    source.ready.resolve(); await flush();
    assert.ok(f.entries.some(entry => entry.event === 'lease.cancelled'));
    assert.ok(f.entries.some(entry => entry.event === 'source.closed'));
    assert.ok(!f.entries.some(entry => ['source.failed', 'source.start_timeout', 'p2p.failed', 'source.ready'].includes(entry.event)));
});

test('an asynchronously rejected diagnostic sink is observed and never interrupts cleanup', async t => {
    const f = fixture(t, { onDiagnostic: () => Promise.reject(Error('PRIVATE_ASYNC_SINK_FAILURE')) });
    await f.connect(); const record = await f.open();
    await f.helper.closeRecord(record); await flush();
    assert.equal(f.helper.records.size, 0);
});
