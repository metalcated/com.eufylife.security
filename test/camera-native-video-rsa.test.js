'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

const filename = path.resolve(__dirname, '../lib/helpers/camera-native-video-rsa.helper.js');
const SECRET = 'fixture-crypto-private-detail';
const generated = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const pem = generated.privateKey.export({ type: 'pkcs1', format: 'pem' });
const modulus = Buffer.from(generated.publicKey.export({ format: 'jwk' }).n, 'base64url');

function helper(overrides = {}) {
    const nativeRequire = createRequire(filename), module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require,module,exports) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(name => name === 'node:crypto' ? { ...crypto, ...overrides } : nativeRequire(name), module, module.exports);
    return module.exports;
}

function keyFixture(options = {}) {
    class ForgeRSA {
        constructor() { this.options = { encryptionScheme: 'pkcs1' }; this.legacyCalls = 0; this.privateKey = { fixture: true }; }
        exportKey(format) {
            assert.equal(format, 'pkcs1-private-pem');
            if (options.exportError) throw Error(SECRET);
            return options.pem ?? pem;
        }
        exportPublicComponents() { return { n: Uint8Array.from([0, ...modulus]), e: Uint8Array.from([1, 0, 1]) }; }
        decrypt(input) {
            this.legacyCalls++;
            return crypto.privateDecrypt({ key: generated.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, input);
        }
    }
    const key = new ForgeRSA();
    return Object.assign(key, options.fields);
}

const encrypt = plaintext => crypto.publicEncrypt({ key: generated.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, plaintext);

test('a native video wrapper preserves original key methods and public components while decrypting valid camera keys', () => {
    const { wrapVideoRSAKey, isNativeVideoRSAKey } = helper();
    const original = keyFixture(), originalDecrypt = original.decrypt, originalExport = original.exportKey;
    const components = original.exportPublicComponents();
    const wrapped = wrapVideoRSAKey(original);
    assert.notEqual(wrapped, original); assert.equal(isNativeVideoRSAKey(wrapped), true); assert.equal(isNativeVideoRSAKey(original), false);
    assert.equal(original.decrypt, originalDecrypt); assert.equal(original.exportKey, originalExport);
    assert.deepEqual(wrapped.exportPublicComponents(), components); assert.equal(wrapped.exportKey('pkcs1-private-pem'), pem);
    for (const length of [16, 24, 32]) {
        const plaintext = Buffer.alloc(length, length), ciphertext = encrypt(plaintext);
        assert.deepEqual(wrapped.decrypt(ciphertext), plaintext);
    }
    assert.equal(original.legacyCalls, 0, 'native video work never invokes the original Forge decrypt');
    assert.equal(original.options.encryptionScheme, 'pkcs1');
    assert.equal(original.privateKey.fixture, true);
});

test('wrapping is cached per key without changing unrelated download or control keys', () => {
    const { wrapVideoRSAKey, isNativeVideoRSAKey } = helper();
    const video = keyFixture(), unrelated = keyFixture(), unrelatedDecrypt = unrelated.decrypt;
    const wrapped = wrapVideoRSAKey(video);
    assert.equal(wrapVideoRSAKey(video), wrapped); assert.equal(wrapVideoRSAKey(wrapped), wrapped);
    assert.equal(unrelated.decrypt, unrelatedDecrypt); assert.equal(isNativeVideoRSAKey(unrelated), false);
    assert.equal(wrapVideoRSAKey(unrelated) === wrapped, false);
});

test('unsupported runtime capability leaves the exact original key and legacy behavior available', () => {
    const { wrapVideoRSAKey, isNativeVideoRSAKey } = helper({ privateDecrypt() { throw Error(SECRET); } });
    const original = keyFixture(), decrypt = original.decrypt;
    assert.equal(wrapVideoRSAKey(original), original);
    assert.equal(original.decrypt, decrypt); assert.equal(isNativeVideoRSAKey(original), false);
    const plaintext = Buffer.alloc(16, 7);
    assert.deepEqual(original.decrypt(encrypt(plaintext)), plaintext); assert.equal(original.legacyCalls, 1);
});

test('unsupported key shapes and export failures are unchanged and do not expose key details', () => {
    const { wrapVideoRSAKey, isNativeVideoRSAKey } = helper();
    const unsupported = [null, undefined, {}, { decrypt() {} }, keyFixture({ fields: { options: { encryptionScheme: 'pkcs1_oaep' } } }),
        keyFixture({ exportError: true }), keyFixture({ pem: SECRET })];
    for (const original of unsupported) {
        assert.equal(wrapVideoRSAKey(original), original);
        assert.equal(isNativeVideoRSAKey(original), false);
    }
});

test('acceleration stays limited to the pinned video key size and RSA key type', () => {
    for (const details of [
        { asymmetricKeyType: 'ec' }, { asymmetricKeyType: 'rsa-pss', asymmetricKeyDetails: { modulusLength: 1024 } },
        { asymmetricKeyType: 'rsa', asymmetricKeyDetails: { modulusLength: 2048 } }, { asymmetricKeyType: 'rsa' },
    ]) {
        const { wrapVideoRSAKey } = helper({ createPrivateKey: () => details,
            publicEncrypt() { assert.fail('unsupported key reached the native capability probe'); } });
        const original = keyFixture(); assert.equal(wrapVideoRSAKey(original), original);
    }
});

test('malformed camera inputs fail uniformly and never fall back to the original Forge decrypt', () => {
    const { wrapVideoRSAKey } = helper(); const original = keyFixture(), wrapped = wrapVideoRSAKey(original);
    const messages = [];
    for (const input of [null, undefined, 'ciphertext', new Uint8Array(128), Buffer.alloc(0), Buffer.alloc(127), Buffer.alloc(129)]) {
        assert.throws(() => wrapped.decrypt(input), error => {
            messages.push(error.message); assert.equal(error.message.includes(SECRET), false); return true;
        });
    }
    assert.equal(new Set(messages).size, 1);
    assert.equal(original.legacyCalls, 0);
});

test('an incoming native crypto failure stays generic and cannot trigger a per-frame downgrade', () => {
    let decryptCalls = 0;
    const { wrapVideoRSAKey, isNativeVideoRSAKey } = helper({
        privateDecrypt(...args) {
            if (++decryptCalls > 1) throw Error(SECRET);
            return crypto.privateDecrypt(...args);
        },
    });
    const original = keyFixture(), wrapped = wrapVideoRSAKey(original);
    assert.equal(isNativeVideoRSAKey(wrapped), true);
    assert.throws(() => wrapped.decrypt(encrypt(Buffer.alloc(16))), error => !error.message.includes(SECRET));
    assert.equal(original.legacyCalls, 0); assert.equal(isNativeVideoRSAKey(wrapped), true);
});
