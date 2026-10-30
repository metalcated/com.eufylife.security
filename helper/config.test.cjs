'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { readSecret } = require('./index.cjs');
const { validateMetadata, validRPC } = require('./service.cjs');

const data = () => ({ rawStation: { station_sn: 'BASE_A', member: { admin_user_id: 'ADMIN_A' } },
    rawDevice: { device_sn: 'CAMERA_A', station_sn: 'BASE_A', device_channel: 1, device_type: 1 },
    deviceConstructor: 'Camera', connectionType: 1, connected: true,
    config: { deviceConfig: {}, enableEmbeddedPKCS1Support: false } });

test('the service secret is read only from an owner-only regular file and accepts its trailing newline', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'eufy-helper-secret-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const filename = path.join(directory, 'secret');
    await fs.writeFile(filename, `${'a'.repeat(64)}\n`, { mode: 0o600 });
    assert.equal(await readSecret(filename), 'a'.repeat(64));
    await fs.chmod(filename, 0o644);
    await assert.rejects(readSecret(filename), error => !error.message.includes('a'.repeat(64)));
    await fs.chmod(filename, 0o600);
    const link = path.join(directory, 'link');
    await fs.symlink(filename, link);
    await assert.rejects(readSecret(link));
    await fs.writeFile(filename, 'wrong-format', { mode: 0o600 });
    await assert.rejects(readSecret(filename), /Invalid secret file/);
});

test('metadata cannot select an executable, carry account credentials, cross a base or omit real identity', () => {
    const original = data();
    assert.deepEqual(validateMetadata(original), original);
    for (const mutate of [
        value => { value.deviceConstructor = 'Function'; },
        value => { value.rawDevice.station_sn = 'OTHER'; },
        value => { delete value.rawStation.station_sn; delete value.rawDevice.station_sn; },
        value => { value.rawDevice.device_sn = null; },
        value => { value.rawDevice.auth_token = 'private-account-data'; },
        value => { value.rawStation.member.password = 'private-account-data'; },
        value => { value.ipAddress = 'http://127.0.0.1/admin'; },
        value => { value.ipAddress = 123; },
        value => { value.connected = false; },
        value => { value.config.command = '/bin/sh'; },
        value => { Object.defineProperty(value.rawDevice, '__proto__', { enumerable: true, value: {} }); },
    ]) {
        const value = data(); mutate(value);
        assert.throws(() => validateMetadata(value), error => error.status === 400 && error.message === 'Invalid camera metadata.');
    }
    assert.equal(original.rawDevice.auth_token, undefined);
});

test('only station-bound read operations can cross the reverse RPC channel', () => {
    const value = data();
    assert.equal(validRPC(value, 'getPublicKey', ['BASE_A', 2]), true);
    assert.equal(validRPC(value, 'getCipher', [65535, 'ADMIN_A']), true);
    assert.equal(validRPC(value, 'getVoices', ['CAMERA_A']), true);
    assert.equal(validRPC(value, 'getCipher', [65536, 'ADMIN_A']), false);
    assert.equal(validRPC(value, 'getCipher', [1, 'OTHER']), false);
    assert.equal(validRPC(value, 'getVoices', ['OTHER']), false);
    assert.equal(validRPC(value, 'setDeviceProperty', ['CAMERA_A', 'enabled', true]), false);
    const request = { method: 'post', endpoint: 'v1/app/equipment/get_dsk_keys', data: {
        invalid_dsks: { BASE_A: '' }, station_sns: ['BASE_A'], transaction: '1234567890000' } };
    assert.equal(validRPC(value, 'request', [request]), true);
    request.endpoint = 'https://example.com/account';
    assert.equal(validRPC(value, 'request', [request]), false);
});
