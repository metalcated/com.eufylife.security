'use strict';

// Account-free equivalence and CPU check using the pinned SDK's real Forge key.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const build = path.dirname(require.resolve('eufy-security-client'));
const { getNewRSAPrivateKey } = require(path.join(build, 'p2p/utils.js'));
const { wrapVideoRSAKey, isNativeVideoRSAKey } = require('../lib/helpers/camera-native-video-rsa.helper.js');
const original = getNewRSAPrivateKey(false), binaryKey = getNewRSAPrivateKey(false);
const originalDecrypt = original.decrypt, binaryDecrypt = binaryKey.decrypt;
const originalPEM = original.exportKey('pkcs1-private-pem');
const components = original.exportPublicComponents();
const publicKey = crypto.createPublicKey(originalPEM);
const native = wrapVideoRSAKey(original);
assert.notEqual(native, original);
assert.equal(isNativeVideoRSAKey(native), true);
assert.equal(original.decrypt, originalDecrypt);
assert.equal(binaryKey.decrypt, binaryDecrypt);
assert.equal(isNativeVideoRSAKey(binaryKey), false);
assert.equal(original.exportKey('pkcs1-private-pem'), originalPEM);
assert.deepEqual(native.exportPublicComponents(), components);
assert.equal(wrapVideoRSAKey(original), native);
for (const length of [16, 24, 32]) {
    const plaintext = Buffer.alloc(length, length);
    const ciphertext = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, plaintext);
    assert.deepEqual(original.decrypt(ciphertext), plaintext);
    assert.deepEqual(native.decrypt(ciphertext), plaintext);
}
for (const input of [Buffer.alloc(0), Buffer.alloc(127), Buffer.alloc(129), 'ciphertext', new Uint8Array(128)]) {
    assert.throws(() => native.decrypt(input));
}
const plaintext = Buffer.alloc(16, 1);
const ciphertext = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, plaintext);
for (let index = 0; index < 30; index++) { original.decrypt(ciphertext); native.decrypt(ciphertext); }
function measure(decrypt) {
    const cpu = process.cpuUsage(), wall = process.hrtime.bigint();
    for (let index = 0; index < 500; index++) assert.deepEqual(decrypt(ciphertext), plaintext);
    const used = process.cpuUsage(cpu);
    return { cpuMs: (used.user + used.system) / 1000, wallMs: Number(process.hrtime.bigint() - wall) / 1e6 };
}
const forge = measure(value => original.decrypt(value)), accelerated = measure(value => native.decrypt(value));
assert.ok(accelerated.cpuMs < forge.cpuMs / 2, 'native video decrypt did not reduce CPU by at least half in the pinned SDK fixture');
console.log(JSON.stringify({ result: 'PASS', node: process.version, openssl: process.versions.openssl,
    sdk: require('eufy-security-client/package.json').version, forgeVersion: require('node-forge/package.json').version,
    decryptions: 500, forgeDecrypt: forge, native: accelerated, cpuRatio: forge.cpuMs / accelerated.cpuMs,
    unchangedOriginalAndBinary: true, videoKeyLengths: [16, 24, 32], wirePublicModulusUnchanged: true }));
