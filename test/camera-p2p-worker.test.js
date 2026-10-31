'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const filename = path.resolve(__dirname, '../lib/helpers/camera-p2p-worker.js');
const source = fs.readFileSync(filename, 'utf8');
const SECRET = 'synthetic-private-sdk-error';
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

// Run the production worker against public SDK-shaped factories without
// account access, sockets, footage, or a real worker's termination side effects.
function fixture(options = {}) {
    const messages = [], timers = new Set(), calls = []; let videoSource;
    const port = new EventEmitter(); port.postMessage = message => messages.push(structuredClone(message));
    const rawDevice = { device_sn: options.t8423 ? 'T8423FIXTURE_CAMERA' : 'FIXTURE_CAMERA',
        station_sn: options.t8423 ? 'T8423FIXTURE_BASE' : 'FIXTURE_BASE', device_channel: 1 };
    class Device {}
    class Camera extends Device {
        static async getInstance() { calls.push('device-create'); if (options.deviceGate) await options.deviceGate.promise; return new Camera(); }
        initialize() { calls.push('device-init'); if (options.failInitialize) throw Error(SECRET); }
        getSerial() { return rawDevice.device_sn; }
        getRawDevice() { return rawDevice; }
        getStationSerial() { return rawDevice.station_sn; }
        getChannel() { return rawDevice.device_channel; }
        isFloodLightT8423() { return options.t8423 === true; }
        hasCommand() { return true; }
        destroy() { calls.push('device-destroy'); }
    }
    class Station extends EventEmitter {
        static async getInstance() { calls.push('station-create'); return new Station(); }
        getSerial() { return options.foreignStation ? 'OTHER_STATION' : rawDevice.station_sn; }
        getRawStation() { return { station_sn: rawDevice.station_sn }; }
        initialize() { calls.push('station-init'); }
        setConnectionType() {}
        connect() { calls.push('connect'); this.connected = true; queueMicrotask(() => this.emit('connect', this)); return Promise.resolve(); }
        isConnected() { return this.connected; }
        startLivestream(device) {
            calls.push('start');
            videoSource = new PassThrough();
            this.emit('livestream start', this, device.getChannel(), { videoCodec: options.declaredCodec ?? 0, videoFPS: 15, token: SECRET },
                videoSource, new PassThrough());
        }
        stopLivestream(device) {
            calls.push('stop');
            this.emit('command result', this, { channel: device.getChannel(), return_code: 0,
                customData: { command: { name: 'stop' } } });
        }
        close() { calls.push('close'); this.connected = false; }
    }
    const packageFile = '/fixture/eufy/package.json';
    function requireFixture(request) {
        if (request === 'node:worker_threads') return { parentPort: port, workerData: {
            deviceConstructor: 'Camera', rawDevice, rawStation: { station_sn: rawDevice.station_sn }, config: { deviceConfig: {} }, connected: true,
        } };
        if (request === 'node:path') return path;
        if (request === './camera-video-codec.helper') return require('../lib/helpers/camera-video-codec.helper');
        if (request === packageFile) return { version: '4.2.6' };
        if (request === '/fixture/eufy/build/http/device.js') return { Device, Camera };
        if (request === '/fixture/eufy/build/http/station.js') return { Station };
        if (request === '/fixture/eufy/build/http/types.js') return { CommandName: { DeviceStartLivestream: 'start', DeviceStopLivestream: 'stop' } };
        if (request === '/fixture/eufy/build/p2p/types.js') return { VideoCodec: { H264: 0, H265: 1 }, P2PDataType: { VIDEO: 1 } };
        throw Error('Unexpected SDK dependency in the worker fixture.');
    }
    requireFixture.resolve = request => request.endsWith('/package.json') ? packageFile : '/fixture/eufy/build/index.js';
    const setTimer = (callback, delay) => { const timer = { callback, delay }; timers.add(timer); return timer; };
    vm.runInNewContext(source, { require: requireFixture, Buffer, Uint8Array, setTimeout: setTimer, clearTimeout: timer => timers.delete(timer) }, { filename });
    return { messages, calls, timers, phases: () => messages.filter(message => message.type === 'phase'),
        writeVideo: bytes => videoSource.write(bytes),
        acknowledge: sequence => port.emit('message', { type: 'ack', sequence }),
        async close() {
            port.emit('message', { type: 'close' }); await flush();
            for (const timer of [...timers]) if (timer.delay === 50) { timers.delete(timer); timer.callback(); }
            await flush();
        } };
}

test('the production worker reports its seven public phase transitions using enum-only messages', async () => {
    const h = fixture(); await flush();
    assert.equal(h.phases().some(message => message.phase === 'stream'), false, 'metadata callback alone cannot claim video bytes');
    h.writeVideo(Buffer.from([1, 2, 3])); await flush();
    assert.deepEqual(h.phases().map(message => message.phase), ['device-create', 'device-init', 'station-create', 'station-init', 'connect', 'start', 'stream']);
    assert.equal(h.phases().every(message => Object.keys(message).sort().join(',') === 'phase,type'), true);
    assert.equal(JSON.stringify(h.messages).includes(SECRET), false, 'SDK metadata leaked through progress or stream setup');
    assert.deepEqual(h.calls.slice(0, 6), ['device-create', 'device-init', 'station-create', 'station-init', 'connect', 'start']);
    assert.equal(h.messages.some(message => message.type === 'video'), false, 'credit is still required after first-byte progress');
    h.acknowledge(0);
    assert.deepEqual(h.messages.find(message => message.type === 'video').data, Uint8Array.from([1, 2, 3]));
    await h.close();
    assert.equal(h.messages.at(-1).type, 'closed'); assert.equal(h.messages.at(-1).stopConfirmed, true);
    assert.equal(h.timers.size, 0);
});

test('closing during a pending public factory prevents later progress and station allocation', async () => {
    const deviceGate = deferred(), h = fixture({ deviceGate }); await flush();
    assert.deepEqual(h.phases(), [{ type: 'phase', phase: 'device-create' }]);
    await h.close(); const count = h.messages.length;
    deviceGate.resolve(); await flush();
    assert.equal(h.messages.length, count);
    assert.deepEqual(h.calls, ['device-create']);
    assert.equal(h.timers.size, 0);
});

test('an SDK factory error reports only its known phase and preserves bounded worker shutdown', async () => {
    const h = fixture({ failInitialize: true }); await flush();
    assert.deepEqual(h.phases(), [{ type: 'phase', phase: 'device-create' }, { type: 'phase', phase: 'device-init' }]);
    assert.deepEqual(h.messages.find(message => message.type === 'error'), { type: 'error', phase: 'device-init' });
    assert.equal(JSON.stringify(h.messages).includes(SECRET), false);
    await h.close(); assert.equal(h.timers.size, 0);
});

const H264_BOOTSTRAP = Buffer.from('000000016742c00ada0a36c044000003000400000300223c489a80', 'hex');
const HEVC_BOOTSTRAP = Buffer.from('0000000140010c01ffff01600000030090000003000003001e959409', 'hex');

test('owned T8423 metadata waits for the first video bytes and corrects only a definite contrary codec without bypassing credit', async () => {
    for (const [declared, actual, bytes] of [[0, 1, HEVC_BOOTSTRAP], [1, 0, H264_BOOTSTRAP]]) {
        const h = fixture({ t8423: true, declaredCodec: declared }); await flush();
        assert.equal(h.messages.some(message => message.type === 'stream'), false, 'the parent chose a decoder before codec evidence arrived');
        h.writeVideo(bytes); await flush();
        const corrections = h.messages.filter(message => message.type === 'codec-correction');
        assert.deepEqual(corrections, [{ type: 'codec-correction', from: declared, to: actual }]);
        assert.equal(h.messages.find(message => message.type === 'stream').metadata.videoCodec, actual);
        assert.ok(h.messages.findIndex(message => message.type === 'codec-correction') < h.messages.findIndex(message => message.type === 'stream'));
        assert.equal(h.messages.some(message => message.type === 'video'), false);
        h.acknowledge(0);
        assert.deepEqual(Buffer.from(h.messages.find(message => message.type === 'video').data), bytes);
        h.writeVideo(declared === 0 ? H264_BOOTSTRAP : HEVC_BOOTSTRAP); await flush();
        assert.equal(h.messages.filter(message => message.type === 'stream').length, 1, 'metadata changed mid-stream');
        assert.equal(h.messages.filter(message => message.type === 'codec-correction').length, 1);
        await h.close(); assert.equal(h.timers.size, 0);
    }
});

test('matching or unknown first-byte codecs preserve declared metadata and never emit a correction', async () => {
    for (const bytes of [H264_BOOTSTRAP, Buffer.from([1, 2, 3]), Buffer.from('0000000165abcd', 'hex')]) {
        const h = fixture({ t8423: true }); await flush(); h.writeVideo(bytes); await flush();
        assert.equal(h.messages.find(message => message.type === 'stream').metadata.videoCodec, 0);
        assert.equal(h.messages.some(message => message.type === 'codec-correction'), false);
        h.acknowledge(0); await h.close();
    }
});

test('other camera models and mismatched owned-station identity keep immediate unmodified stream metadata', async () => {
    for (const options of [{}, { t8423: true, foreignStation: true }]) {
        const h = fixture(options); await flush();
        assert.equal(h.messages.find(message => message.type === 'stream').metadata.videoCodec, 0);
        h.writeVideo(HEVC_BOOTSTRAP); await flush();
        assert.equal(h.messages.some(message => message.type === 'codec-correction'), false);
        h.acknowledge(0); await h.close();
    }
});
