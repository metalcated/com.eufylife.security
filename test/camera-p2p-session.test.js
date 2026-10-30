'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

const filename = path.resolve(__dirname, '../lib/helpers/camera-p2p-session.helper.js');
const SECRET = 'private-account-session-secret';
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(setImmediate); };

function harness(options = {}) {
    const workers = [], timers = new Set(), calls = [], streams = [], errors = [];
    let stops = 0;
    const rawStation = { station_sn: 'HOMEBASE_A', token: SECRET, member: { username: SECRET, admin_user_id: 'member-a' } };
    const rawDevice = { device_sn: 'CAMERA_A', station_sn: 'HOMEBASE_A', password: SECRET, channel: 1 };
    class Camera { getRawDevice() { return rawDevice; } }
    const device = new Camera();
    const originalStation = { getRawStation: () => rawStation, getConnectionType: () => 1 };
    const homeyDevice = { EufyDevice: device, EufyStation: originalStation };
    const api = {
        isConnected: () => true,
        getPublicKey: async (...args) => { calls.push(['getPublicKey', ...args]); return options.publicKey ? options.publicKey(...args) : 'public-key'; },
        getCipher: async (...args) => { calls.push(['getCipher', ...args]); return options.cipher ? options.cipher(...args) : undefined; },
        getVoices: async (...args) => { calls.push(['getVoices', ...args]); return options.voices ? options.voices(...args) : { one: { voice_id: 1, desc: 'voice', token: SECRET } }; },
        request: async (...args) => { calls.push(['request', ...args]); return options.request ? options.request(...args) : { status: 200, data: { code: 0,
            data: { dsk_keys: [{ station_sn: 'HOMEBASE_A', dsk_key: 'own-dsk', expiration: 100 }, { station_sn: 'OTHER', dsk_key: SECRET, expiration: 100 }], token: SECRET } } }; }
    };
    const client = { token: SECRET, getApi: () => api, getConfig: () => ({ username: SECRET, password: SECRET, cloudToken: SECRET,
        deviceConfig: { simultaneousDetections: true, token: SECRET }, stationIPAddresses: { HOMEBASE_A: '192.168.1.2', OTHER: SECRET }, enableEmbeddedPKCS1Support: true }) };
    class FakeWorker extends EventEmitter {
        constructor(file, config) {
            super();
            if (options.constructFailure) throw Error(SECRET);
            this.file = file; this.config = config; this.messages = []; this.terminateCalls = 0;
            this.stdout = new PassThrough(); this.stderr = new PassThrough();
            workers.push(this);
        }
        postMessage(message) { this.messages.push(structuredClone(message)); }
        terminate() {
            this.terminateCalls++;
            if (options.terminate) return options.terminate(this);
            queueMicrotask(() => this.emit('exit', 0));
            return Promise.resolve(0);
        }
        send(message) { this.emit('message', message); }
    }
    const setTimer = (fn, delay) => { const timer = { fn, delay, unref() { return this; } }; timers.add(timer); return timer; };
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require,module,exports,__dirname,setTimeout,clearTimeout) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(createRequire(filename), module, module.exports, path.dirname(filename), setTimer, timer => timers.delete(timer));
    const session = new module.exports({ client, homeyDevice, WorkerClass: FakeWorker, startupTimeoutMs: 101, shutdownTimeoutMs: 102, rpcTimeoutMs: 103, terminationTimeoutMs: 104,
        onStream(video, audio, metadata) { streams.push({ video, audio, metadata }); if (options.onStream) return options.onStream(video, audio, metadata); },
        onStop() { stops++; }, onError(error) { errors.push(error); } });
    return { session, workers, timers, calls, streams, errors, api, client, device, homeyDevice, originalStation, rawStation, rawDevice,
        stops: () => stops,
        fire(delay) {
            const selected = [...timers].filter(timer => timer.delay === delay);
            assert.ok(selected.length, `expected timer ${delay}`);
            for (const timer of selected) { timers.delete(timer); timer.fn(); }
        },
        async close() { const pending = session.close(); workers[0]?.send({ type: 'closed', stopConfirmed: true }); return pending; },
        async stream() {
            const pending = session.start();
            workers[0].send({ type: 'stream', metadata: { videoCodec: 0, videoFPS: 15, token: SECRET } });
            await pending; await flush(); return workers[0];
        }
    };
}

test('private workers receive bounded camera metadata but no account credentials or inherited environment', async () => {
    const h = harness();
    const first = h.session.start();
    assert.equal(h.session.start(), first, 'duplicate start shares one worker and pending result');
    const worker = h.workers[0];
    assert.equal(path.basename(worker.file), 'camera-p2p-worker.js');
    assert.equal(JSON.stringify(worker.config).includes(SECRET), false);
    assert.deepEqual(worker.config.env, {});
    assert.deepEqual(worker.config.resourceLimits, { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4, codeRangeSizeMb: 4 });
    assert.equal(worker.config.workerData.rawDevice.device_sn, 'CAMERA_A');
    assert.equal(worker.config.workerData.rawStation.station_sn, 'HOMEBASE_A');
    assert.equal(worker.config.workerData.ipAddress, '192.168.1.2');
    assert.equal(h.rawStation.token, SECRET, 'sanitization does not mutate shared account metadata');
    assert.equal(h.homeyDevice.EufyStation, h.originalStation);
    const closed = h.close();
    await assert.rejects(first, error => error.mediaPublic && !error.message.includes(SECRET));
    assert.deepEqual(await closed, { stopConfirmed: true });
});

test('worker SDK version and distribution guards fail before SDK initialization or transport activity', () => {
    const workerFile = path.resolve(__dirname, '../lib/helpers/camera-p2p-worker.js');
    const source = fs.readFileSync(workerFile, 'utf8');
    const packageFile = '/fixture/node_modules/eufy-security-client/package.json';
    for (const mismatch of ['version', 'entrypoint', 'shape']) {
        const required = [], messages = [], initialized = [];
        const port = {
            postMessage(message) { messages.push(message); },
            on() { initialized.push('parent-listener'); }
        };
        function fixtureRequire(request) {
            required.push(request);
            if (request === 'node:worker_threads') return { parentPort: port, workerData: {} };
            if (request === 'node:path') return path;
            if (request === packageFile) return { version: mismatch === 'version' ? '4.2.7' : '4.2.6' };
            if (mismatch === 'shape') {
                if (request.endsWith('/http/device.js')) return { Device: class Device {} };
                if (request.endsWith('/http/station.js')) return { Station: class Station {
                    static getInstance() { initialized.push('station'); }
                } };
                if (request.endsWith('/http/types.js')) return { CommandName: { DeviceStartLivestream: 'start', DeviceStopLivestream: 'stop' } };
                if (request.endsWith('/p2p/types.js')) return { VideoCodec: { H264: 0 } };
            }
            throw Error(`Unexpected module load: ${request}`);
        }
        fixtureRequire.resolve = request => request.endsWith('/package.json') ? packageFile
            : `/fixture/node_modules/eufy-security-client/build/${mismatch === 'entrypoint' ? 'alternate' : 'index'}.js`;
        assert.throws(() => vm.runInNewContext(source, { require: fixtureRequire }, { filename: workerFile }), error => {
            assert.equal(error.message, mismatch === 'shape'
                ? 'The independent camera SDK shape is unsupported.'
                : 'The independent camera SDK version is unsupported.');
            return true;
        });
        assert.deepEqual(initialized, [], 'no parent channel, device or station is started');
        assert.deepEqual(messages, [], 'no API RPC or stream activity occurs');
        assert.equal(required.includes('eufy-security-client'), false, 'the SDK root barrel is never loaded');
        assert.equal(required.some(request => request.includes('dgram')), false);
        if (mismatch !== 'shape') assert.deepEqual(required, ['node:worker_threads', 'node:path', packageFile],
            'version and entrypoint mismatches stop before loading any SDK implementation');
    }
});

test('stream attachment and ordered video delivery use credit and remove the startup deadline', async () => {
    const h = harness();
    const worker = await h.stream();
    assert.equal(h.streams.length, 1);
    assert.equal(h.streams[0].audio, null);
    assert.deepEqual(h.streams[0].metadata, { videoCodec: 0, videoFPS: 15 });
    assert.equal([...h.timers].some(timer => timer.delay === 101), false);
    assert.deepEqual(worker.messages, [{ type: 'ack', sequence: 0 }]);
    const received = [];
    h.streams[0].video.on('data', bytes => received.push(Buffer.from(bytes)));
    worker.send({ type: 'video', sequence: 1, data: Uint8Array.from([1, 2, 3]) });
    worker.send({ type: 'video', sequence: 2, data: Uint8Array.from([4, 5]) });
    assert.deepEqual(Buffer.concat(received), Buffer.from([1, 2, 3, 4, 5]));
    assert.deepEqual(worker.messages.slice(-2), [{ type: 'ack', sequence: 1 }, { type: 'ack', sequence: 2 }]);
    await h.close();
    assert.equal(h.streams[0].video.destroyed, true);
    assert.equal(h.timers.size, 0);
});

test('close requests normal stop, is idempotent and does not settle before worker termination', async () => {
    const terminated = deferred();
    const h = harness({ terminate: () => terminated.promise });
    const start = h.session.start();
    const closed = h.session.close();
    assert.equal(h.session.close(), closed);
    await assert.rejects(start, /cancelled/i);
    assert.deepEqual(h.workers[0].messages, [{ type: 'close' }]);
    h.workers[0].send({ type: 'closed', stopConfirmed: true }); await flush();
    let done = false; closed.then(() => { done = true; });
    assert.equal(h.workers[0].terminateCalls, 1);
    assert.equal(done, false, 'a worker acknowledgement is not completion of resource cleanup');
    terminated.resolve(0);
    assert.deepEqual(await closed, { stopConfirmed: true });
    assert.equal(h.timers.size, 0);
});

test('unresponsive shutdown is bounded but still awaits termination and supports retry after termination rejection', async () => {
    let attempt = 0;
    const h = harness({ terminate: async () => { if (++attempt === 1) throw Error(SECRET); return 0; } });
    await h.stream();
    const first = h.session.close();
    h.fire(102);
    await assert.rejects(first);
    const retry = h.session.close();
    await flush();
    assert.deepEqual(await retry, { stopConfirmed: false });
    assert.equal(h.workers[0].terminateCalls, 2);
    assert.equal(h.timers.size, 0);
});

test('startup timeout, worker error and invalid chunks fail safely and always terminate the owned worker', async () => {
    for (const reason of ['timeout', 'error', 'bad-video']) {
        const h = harness();
        const start = h.session.start();
        if (reason === 'timeout') h.fire(101);
        else if (reason === 'error') h.workers[0].emit('error', Error(SECRET));
        else h.workers[0].send({ type: 'video', sequence: 1, data: new Uint8Array(65537) });
        await assert.rejects(start, error => error.mediaPublic && !error.message.includes(SECRET));
        h.workers[0].send({ type: 'closed', stopConfirmed: false });
        await h.session.close();
        assert.equal(h.workers[0].terminateCalls, 1);
        assert.equal(h.errors.length, 1);
        assert.equal(h.timers.size, 0);
    }
});

test('the worker RPC bridge admits only own-camera metadata operations and filters their results', async () => {
    const h = harness(); h.session.start();
    const worker = h.workers[0];
    for (const message of [
        { id: 1, method: 'getPublicKey', args: ['OTHER', 2] },
        { id: 2, method: 'getPublicKey', args: ['HOMEBASE_A', 1] },
        { id: 3, method: 'getVoices', args: ['OTHER'] },
        { id: 4, method: 'setGuardMode', args: ['HOMEBASE_A', 0] },
        { id: 5, method: 'request', args: [{ method: 'post', endpoint: 'v1/app/equipment/set_device', data: {} }] },
        { id: 6, method: 'request', args: [{ method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys', data: {
            invalid_dsks: { OTHER: '' }, station_sns: ['OTHER'], transaction: '1000000000000' } }] },
    ]) worker.send({ type: 'rpc', ...message });
    await flush();
    assert.equal(h.calls.length, 0);
    assert.equal(worker.messages.filter(message => message.type === 'rpc-result').every(message => typeof message.error === 'string'), true);
    worker.send({ type: 'rpc', id: 7, method: 'getPublicKey', args: ['HOMEBASE_A', 2] }); await flush();
    worker.send({ type: 'rpc', id: 8, method: 'getVoices', args: ['CAMERA_A'] }); await flush();
    worker.send({ type: 'rpc', id: 9, method: 'request', args: [{ method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys', data: {
        invalid_dsks: { HOMEBASE_A: '' }, station_sns: ['HOMEBASE_A'], transaction: '1000000000000' } }] }); await flush();
    assert.deepEqual(h.calls.map(([method]) => method), ['getPublicKey', 'getVoices', 'request']);
    assert.equal(worker.messages.find(message => message.id === 7).value, 'public-key');
    const safe = worker.messages.filter(message => message.id >= 7);
    assert.equal(JSON.stringify(safe).includes(SECRET), false);
    assert.deepEqual(worker.messages.find(message => message.id === 8).value, { one: { voice_id: 1, desc: 'voice' } });
    assert.deepEqual(worker.messages.find(message => message.id === 9).value.data.data.dsk_keys,
        [{ station_sn: 'HOMEBASE_A', dsk_key: 'own-dsk', expiration: 100 }]);
    await h.close();
});

test('RPC concurrency and timeouts are bounded and late cloud responses after close are ignored', async () => {
    const cloud = deferred();
    const h = harness({ publicKey: () => cloud.promise }); h.session.start();
    const worker = h.workers[0];
    for (let id = 1; id <= 5; id++) worker.send({ type: 'rpc', id, method: 'getPublicKey', args: ['HOMEBASE_A', 2] });
    await flush();
    assert.equal(h.calls.length, 4);
    assert.match(worker.messages.find(message => message.id === 5).error, /refused/i);
    h.fire(103); await flush();
    assert.equal(worker.messages.filter(message => message.type === 'rpc-result').length, 5);
    worker.send({ type: 'rpc', id: 6, method: 'getPublicKey', args: ['HOMEBASE_A', 2] }); await flush();
    const closing = h.close(); await closing;
    const replies = worker.messages.length;
    cloud.resolve('late-public-key'); await flush();
    assert.equal(worker.messages.length, replies);
    assert.equal(h.timers.size, 0);
});

test('video credit pauses at parent backpressure and resumes only after its consumer drains', async () => {
    const h = harness(); const worker = await h.stream();
    let blockedSequence;
    for (let sequence = 1; sequence <= 16; sequence++) {
        worker.send({ type: 'video', sequence, data: new Uint8Array(65536) });
        if (!worker.messages.some(message => message.type === 'ack' && message.sequence === sequence)) { blockedSequence = sequence; break; }
    }
    assert.ok(blockedSequence, 'the parent must stop granting credit to an unread consumer');
    const video = h.streams[0].video;
    assert.ok(video.readableLength + video.writableLength <= 512 * 1024);
    const received = [];
    video.on('data', bytes => received.push(Buffer.from(bytes))); await flush();
    assert.equal(worker.messages.at(-1).sequence, blockedSequence);
    assert.equal(Buffer.concat(received).length, blockedSequence * 65536);
    await h.close();
});

test('malformed or out-of-order live chunks cannot bypass bounded typed video delivery', async () => {
    for (const data of [
        { sequence: 2, data: Uint8Array.from([1]) }, { sequence: 1, data: [1] },
        { sequence: 1, data: new Uint8Array() }, { sequence: 1, data: new Uint8Array(65537) }
    ]) {
        const h = harness(); const worker = await h.stream();
        worker.send({ type: 'video', ...data }); await flush();
        assert.equal(h.errors.length, 1);
        assert.equal(h.errors[0].mediaPublic, true);
        assert.equal(h.streams[0].video.destroyed, true);
        worker.send({ type: 'closed', stopConfirmed: false }); await h.session.close();
        assert.equal(worker.terminateCalls, 1);
    }
});

test('worker construction failures are redacted and cannot leave timers or a transport behind', async () => {
    const h = harness({ constructFailure: true });
    await assert.rejects(h.session.start(), error => error.mediaPublic && !error.message.includes(SECRET));
    await h.session.close();
    assert.equal(h.workers.length, 0);
    assert.equal(h.errors.length, 1);
    assert.equal(h.timers.size, 0);
});

test('known worker failure phases expose only their fixed public diagnostic text', async () => {
    const phases = {
        'device-create': 'The independent camera connection failed while preparing the camera (device-create).',
        'device-init': 'The independent camera connection failed while initializing the camera (device-init).',
        'station-create': 'The independent camera connection failed while preparing its station (station-create).',
        'station-init': 'The independent camera connection failed while initializing its station (station-init).',
        connect: 'The independent camera connection failed while connecting to its station (connect).',
        start: 'The independent camera connection failed while starting video (start).',
        stream: 'The independent camera connection failed while receiving video (stream).',
    };
    for (const [phase, expected] of Object.entries(phases)) {
        const h = harness(); const start = h.session.start();
        h.workers[0].send({ type: 'error', phase, message: SECRET, error: { message: SECRET }, code: SECRET, details: SECRET, stack: SECRET });
        await assert.rejects(start, error => error.mediaPublic === true && error.message === expected);
        assert.equal(h.errors.length, 1); assert.equal(h.errors[0].message, expected);
        assert.equal(JSON.stringify(h.errors).includes(SECRET), false);
        await h.close();
        assert.equal(h.workers[0].terminateCalls, 1); assert.equal(h.timers.size, 0);
    }
});

test('unknown or arbitrary worker phase fields never enter a public error or carry over from another message', async () => {
    for (const phase of [undefined, null, false, 42, SECRET, '__proto__', 'constructor', 'toString', 'connect\n' + SECRET, { phase: 'connect', message: SECRET }, ['connect']]) {
        const h = harness(); const start = h.session.start();
        h.workers[0].send({ type: 'phase', phase: 'connect', message: SECRET });
        h.workers[0].send({ type: 'error', phase, message: SECRET, error: SECRET, details: { token: SECRET } });
        await assert.rejects(start, error => error.mediaPublic === true && error.message === 'The independent camera connection failed. Check the camera and retry.');
        assert.equal(h.errors[0].message.includes(SECRET), false);
        await h.close();
        assert.equal(h.timers.size, 0);
    }
});

test('a worker that never finishes termination fails within its deadline and can recover only with cleanup proof', async () => {
    for (const proof of ['exit', 'retry']) {
        const firstTermination = deferred();
        const h = harness({ terminate: worker => worker.terminateCalls === 1 ? firstTermination.promise : Promise.resolve(0) });
        await h.stream();
        const closing = h.session.close();
        h.workers[0].send({ type: 'closed', stopConfirmed: true }); await flush();
        assert.equal(h.workers[0].terminateCalls, 1);
        h.fire(104);
        await assert.rejects(closing, error => error.mediaPublic === true && !error.message.includes(SECRET));
        assert.equal(h.session.exited === true, false, 'the stop acknowledgement does not prove worker termination');
        assert.equal(h.timers.size, 0);
        if (proof === 'exit') h.workers[0].emit('exit', 0);
        const recovered = await h.session.close();
        assert.deepEqual(recovered, { stopConfirmed: true });
        assert.equal(h.workers[0].terminateCalls, proof === 'exit' ? 1 : 2);
        firstTermination.reject(Error(SECRET)); await flush();
        assert.equal(h.timers.size, 0, 'late termination rejection remains observed after recovery');
    }
});

test('cipher lookup accepts only an own-station uint16 handshake and returns only bounded transport keys', async () => {
    const h = harness({ cipher: async id => id === 0 ? undefined : { private_key: 'own-private-key', ecc_private_key: 'own-ecc-key',
        cipher_id: 65535, user_id: SECRET, token: SECRET, headers: { Authorization: SECRET }, raw: { message: SECRET } } });
    h.session.start(); const worker = h.workers[0];
    worker.send({ type: 'rpc', id: 1, method: 'getCipher', args: [0, 'member-a'] }); await flush();
    assert.equal(worker.messages.find(message => message.id === 1).value, undefined, 'the SDK fallback may receive no cipher');
    worker.send({ type: 'rpc', id: 2, method: 'getCipher', args: [65535, 'member-a'] }); await flush();
    assert.deepEqual(h.calls, [['getCipher', 0, 'member-a'], ['getCipher', 65535, 'member-a']]);
    assert.deepEqual(worker.messages.find(message => message.id === 2).value, { private_key: 'own-private-key', ecc_private_key: 'own-ecc-key' });
    assert.equal(JSON.stringify(worker.messages).includes(SECRET), false);
    assert.equal(JSON.stringify(worker.config.workerData).includes('own-private-key'), false, 'cipher material is not preloaded into worker metadata');
    await h.close();
});

test('cipher RPC rejects unrelated admins, invalid numeric IDs, extra arguments and broader cipher methods', async () => {
    const h = harness(); h.session.start(); const worker = h.workers[0];
    h.rawStation.member.admin_user_id = 'other-admin';
    const cases = [
        ['getCipher', [-1, 'member-a']], ['getCipher', [65536, 'member-a']], ['getCipher', [1.5, 'member-a']],
        ['getCipher', ['1', 'member-a']], ['getCipher', [NaN, 'member-a']], ['getCipher', [Infinity, 'member-a']],
        ['getCipher', [1, 'other-admin']], ['getCipher', [1, '']], ['getCipher', [1, 'member-a', SECRET]],
        ['getCipher', [1]], ['getCiphers', [[1], 'member-a']], ['getCipher', [{ value: 1 }, 'member-a']],
    ];
    cases.forEach(([method, args], index) => worker.send({ type: 'rpc', id: index + 1, method, args }));
    await flush();
    assert.equal(h.calls.length, 0);
    assert.equal(worker.messages.length, cases.length);
    assert.equal(worker.messages.every(message => message.error === 'Camera API request refused.'), true);
    assert.equal(JSON.stringify(worker.messages).includes(SECRET), false);
    worker.send({ type: 'rpc', id: 20, method: 'getCipher', args: [1, 'member-a'] }); await flush();
    assert.deepEqual(h.calls, [['getCipher', 1, 'member-a']], 'the parent pins its original admin identity instead of accepting later metadata claims');
    await h.close();
});

test('cipher results enforce key limits, preserve empty fallback and never expose response or exception details', async () => {
    for (const [reply, accepted] of [
        [{}, true], [{ private_key: 'x'.repeat(16384) }, true], [{ ecc_private_key: 'x'.repeat(16384) }, true],
        [{ private_key: 'x'.repeat(16385) }, false], [{ ecc_private_key: 'x'.repeat(16385) }, false],
        [{ private_key: 1 }, false], [{ private_key: null }, false], [null, false], [['private-key'], false],
    ]) {
        const h = harness({ cipher: async () => reply }); h.session.start(); const worker = h.workers[0];
        worker.send({ type: 'rpc', id: 1, method: 'getCipher', args: [42, 'member-a'] }); await flush();
        const result = worker.messages[0];
        if (accepted) {
            assert.equal(Object.hasOwn(result, 'error'), false);
            assert.deepEqual(result.value, Object.keys(reply).length ? reply : undefined);
        } else assert.equal(result.error, 'Camera API request failed.');
        await h.close();
    }
    const h = harness({ cipher: async () => { throw Error(SECRET); } }); h.session.start();
    h.workers[0].send({ type: 'rpc', id: 1, method: 'getCipher', args: [42, 'member-a'] }); await flush();
    assert.equal(h.workers[0].messages[0].error, 'Camera API request failed.');
    assert.equal(JSON.stringify(h.workers[0].messages).includes(SECRET), false);
    await h.close();
});

test('late cipher replies after close are discarded and cannot reenter the closed worker', async () => {
    const cipher = deferred();
    const h = harness({ cipher: () => cipher.promise }); h.session.start();
    const worker = h.workers[0];
    worker.send({ type: 'rpc', id: 1, method: 'getCipher', args: [7, 'member-a'] }); await flush();
    assert.deepEqual(h.calls, [['getCipher', 7, 'member-a']]);
    await h.close();
    const count = worker.messages.length;
    cipher.resolve({ private_key: SECRET, token: SECRET }); await flush();
    assert.equal(worker.messages.length, count);
    assert.equal(h.timers.size, 0);
});
