'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const api = require('../api');
const manifest = require('../.homeycompose/app.json');

test('camera diagnostics and wall routes require Homey authentication and use explicit methods', () => {
    assert.deepEqual(manifest.api.getCameraStatus, { method: 'GET', path: '/cameras/status', public: false });
    assert.equal(Object.values(manifest.api).every(route => route.public === false), true);
    assert.equal(manifest.api.offerCameraWall.method, 'POST');
    assert.equal(manifest.api.configureCameraWall.method, 'POST');
});

test('diagnostics include only registered camera health without cloud metadata or media references', async () => {
    const secret = 'private-camera-url-token';
    const camera = { getName: () => 'Door camera', getId: () => 'HOMEY-DEVICE', EufyDevice: { getSerial: () => 'CAMERA' } };
    const lock = { EufyDevice: { getSerial: () => 'LOCK' } };
    const homey = { app: { deviceList: [camera, lock], FfmpegManager: {
        supports: remote => remote === camera.EufyDevice,
        videos: new Map([['CAMERA', { url: secret, token: secret, metadata: secret }]]),
        getStatus: () => ({ state: 'streaming', source: 'p2p', bytes: 188, consumers: 1, startedAt: 123 })
    } } };
    const status = await api.getCameraStatus({ homey });
    assert.deepEqual(status, [{ name: 'Door camera', id: 'HOMEY-DEVICE', videoRegistered: true, state: 'streaming', source: 'p2p', bytes: 188, consumers: 1, startedAt: 123 }]);
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.deepEqual(await api.getCameraStatus({ homey: { app: {} } }), []);
});
