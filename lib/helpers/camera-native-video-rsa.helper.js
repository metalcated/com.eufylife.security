'use strict';

const crypto = require('node:crypto');

const wrapped = new WeakMap();
const nativeKeys = new WeakSet();
const failure = () => new Error('The camera video key could not be decrypted.');

// The pinned SDK uses 1024-bit PKCS#1 v1.5 RSA for the ephemeral VIDEO key.
// Prefer OpenSSL only when its supported padding implementation passes a local
// round trip. No raw RSA or application padding decoder is used here.
function wrapVideoRSAKey(original) {
    if (!original || typeof original !== 'object') return original;
    if (nativeKeys.has(original)) return original;
    if (wrapped.has(original)) return wrapped.get(original);
    let result = original;
    try {
        if (typeof original.decrypt !== 'function' || typeof original.exportKey !== 'function'
            || typeof original.exportPublicComponents !== 'function' || original.options?.encryptionScheme !== 'pkcs1') throw new Error();
        const pem = original.exportKey('pkcs1-private-pem');
        if (typeof pem !== 'string' || pem.length > 32768) throw new Error();
        const key = crypto.createPrivateKey(pem);
        if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength !== 1024) throw new Error();
        const options = { key, padding: crypto.constants.RSA_PKCS1_PADDING };
        const probe = Buffer.from('HomeyVideoRSAKey');
        const ciphertext = crypto.publicEncrypt(options, probe);
        const plaintext = crypto.privateDecrypt(options, ciphertext);
        if (plaintext.length !== probe.length || !crypto.timingSafeEqual(plaintext, probe)) throw new Error();

        // Inherit all public key/export methods without modifying the original
        // object, which may still be referenced by another SDK message state.
        result = Object.create(original);
        Object.defineProperty(result, 'decrypt', { value: encrypted => {
            try {
                if (!Buffer.isBuffer(encrypted) || encrypted.length !== 128) throw failure();
                return crypto.privateDecrypt(options, encrypted);
            } catch { throw failure(); }
        } });
        nativeKeys.add(result);
    } catch { /* Keep the SDK implementation when native PKCS#1 is unavailable. */ }
    wrapped.set(original, result);
    return result;
}

module.exports = { wrapVideoRSAKey, isNativeVideoRSAKey: key => nativeKeys.has(key) };
