'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const test = require('node:test');

const filename = path.resolve(__dirname, '../lib/helpers/camera-video-codec.helper.js');
const classify = require(filename);
const MAX_SCAN = 64 * 1024;
const H264 = 0, H265 = 1;

// Generated offline by FFmpeg for 160x96 test video. These are complete
// encoder bootstrap NALs, rather than guessed model/codec identifiers.
const SPS264 = Buffer.from('000000016742c00ada0a36c044000003000400000300223c489a80', 'hex');
const PPS264 = Buffer.from('0000000168ce0fc8', 'hex');
const VPS265 = Buffer.from('0000000140010c01ffff01600000030090000003000003001e959409', 'hex');
const SPS265 = Buffer.from('0000000142010101600000030090000003000003001ea01420616595952930bc05a02000000300200000030081', 'hex');
const PPS265 = Buffer.from('000000014401c073c089', 'hex');
const annexb = (bytes) => Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from(bytes)]);
const shortPrefix = (data) => Buffer.concat([Buffer.from([0, 0, 1]), data.subarray(4)]);
const changed = (data, index, value) => { const copy = Buffer.from(data); copy[index] = value; return copy; };

test('classifies genuine H264 SPS and HEVC VPS/SPS with three- or four-byte Annex B prefixes', () => {
    for (const data of [SPS264, shortPrefix(SPS264), Buffer.concat([SPS264, PPS264])]) assert.equal(classify(data), H264);
    for (const data of [VPS265, SPS265, shortPrefix(VPS265), shortPrefix(SPS265), Buffer.concat([VPS265, SPS265, PPS265])]) {
        assert.equal(classify(data), H265);
    }
});

test('AUD and SEI preludes do not hide a definite later bootstrap', () => {
    const aud264 = annexb([0x09, 0xf0]), sei264 = annexb([0x06, 0x05, 0x01, 0x80]);
    const aud265 = annexb([0x46, 0x01, 0x50]), sei265 = annexb([0x4e, 0x01, 0x05, 0x01, 0x80]);
    for (const prelude of [aud264, sei264, Buffer.concat([aud264, sei264])]) {
        assert.equal(classify(Buffer.concat([prelude, SPS264, PPS264])), H264);
    }
    for (const prelude of [aud265, sei265, Buffer.concat([aud265, sei265])]) {
        assert.equal(classify(Buffer.concat([prelude, VPS265, SPS265, PPS265])), H265);
    }
});

test('delta, IDR/IRAP alone, PPS, AUD and SEI without a codec bootstrap stay unknown', () => {
    for (const data of [PPS264, PPS265, annexb([0x61, 0x88, 0x20]), annexb([0x65, 0x88, 0x84, 0x21]),
        annexb([0x09, 0xf0]), annexb([0x06, 0x05, 0x01, 0x80]), annexb([0x02, 0x01, 0x80]),
        annexb([0x26, 0x01, 0x80]), annexb([0x46, 0x01, 0x50]), annexb([0x4e, 0x01, 0x80])]) {
        assert.equal(classify(data), null, data.toString('hex'));
    }
});

test('conflicting codec bootstraps and malformed bootstrap candidates never produce a guess', () => {
    for (const data of [Buffer.concat([SPS264, VPS265]), Buffer.concat([SPS265, SPS264]),
        Buffer.concat([SPS264, SPS265, PPS264]), Buffer.concat([VPS265, SPS264, SPS265]),
        Buffer.concat([SPS264, annexb([0x67, 0x42])]), Buffer.concat([VPS265, annexb([0x42, 0x01])])]) {
        assert.equal(classify(data), null);
    }
    const fake264 = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x67]), VPS265.subarray(6)]);
    const fake265 = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x42, 0x01]), SPS264.subarray(5)]);
    assert.equal(classify(fake264), null, 'a bootstrap NAL type is not enough without the matching body');
    assert.equal(classify(fake265), null);
});

test('malformed H264 forbidden/reference/profile/reserved/level fields are rejected', () => {
    for (const data of [changed(SPS264, 4, 0xe7), changed(SPS264, 4, 0x07), changed(SPS264, 5, 0),
        changed(SPS264, 5, 0xff), changed(SPS264, 6, SPS264[6] | 3), changed(SPS264, 7, 0), changed(SPS264, 7, 0xff),
        annexb([0x67, ...Buffer.alloc(20)])]) {
        assert.equal(classify(data), null);
    }
    for (const header of [0x27, 0x47, 0x67]) assert.equal(classify(changed(SPS264, 4, header)), H264);
});

test('the bounded H264 Exp-Golomb identifier check rejects values above31', () => {
    const maximum = Buffer.from(SPS264); maximum[8] = 0x04; maximum[9] = 0;
    const tooLarge = Buffer.from(SPS264); tooLarge[8] = 0x07; tooLarge[9] = 0xe0;
    assert.equal(classify(SPS264), H264, 'encoder SPS uses identifier0');
    assert.equal(classify(maximum), H264, 'prefix for identifier31 is within the supported range');
    assert.equal(classify(tooLarge), null, 'identifier62 shares five leading zero bits but is outside0..31');
});

test('malformed HEVC forbidden/layer/temporal and bootstrap body fields are rejected', () => {
    for (const data of [changed(VPS265, 4, 0xc0), changed(SPS265, 4, 0xc2), changed(VPS265, 4, 0x41),
        changed(SPS265, 5, 0x09), changed(VPS265, 5, 0), changed(SPS265, 5, 2),
        changed(VPS265, 8, 0), changed(VPS265, 9, 0), annexb([0x40, 1, ...Buffer.alloc(24)]),
        annexb([0x42, 1, ...Buffer.alloc(24)])]) {
        assert.equal(classify(data), null);
    }
});

test('partial prefixes, headers and short bootstrap bodies stay unknown instead of fixing metadata', () => {
    for (const data of [SPS264, VPS265, SPS265]) for (let length = 0; length < 9; length++) {
        assert.equal(classify(data.subarray(0, length)), null, `truncated ${data[4]} at ${length}`);
    }
    for (const data of [SPS264.subarray(2), VPS265.subarray(3), SPS265.subarray(4)]) assert.equal(classify(data), null);
});

test('invalid and truncated emulation-prevention sequences cannot establish a codec', () => {
    for (const data of [SPS264, VPS265, SPS265]) {
        assert.equal(classify(Buffer.concat([data, Buffer.from([0, 0, 3])])), null);
        assert.equal(classify(Buffer.concat([data, Buffer.from([0, 0, 3, 4])])), null);
    }
});

test('AVCC, leading junk, non-Buffer input and private nonvideo bytes are unknown', () => {
    const avcc = Buffer.alloc(SPS264.length); avcc.writeUInt32BE(SPS264.length - 4); SPS264.copy(avcc, 4, 4);
    for (const data of [undefined, null, {}, [], new Uint8Array(SPS264), SPS264.toString('hex'),
        Buffer.from('fixture-private-account-data'), avcc, Buffer.concat([Buffer.from([0x12]), SPS264]),
        Buffer.concat([annexb([0x80, 0x20]), SPS264])]) assert.equal(classify(data), null);
});

test('the 64 KiB scan includes a complete boundary bootstrap but never reads a later one', () => {
    const seiPrefix = annexb([0x06, 0x05]);
    const padded = (padding, tail) => Buffer.concat([seiPrefix, Buffer.alloc(padding, 0x55), tail]);
    const fits = padded(MAX_SCAN - seiPrefix.length - SPS264.length, SPS264);
    assert.equal(fits.length, MAX_SCAN);
    assert.equal(classify(fits), H264);
    assert.equal(classify(Buffer.concat([fits, VPS265])), H264, 'conflicting evidence beyond the budget is ignored');
    assert.equal(classify(padded(MAX_SCAN - seiPrefix.length, SPS264)), null);
    assert.equal(classify(padded(MAX_SCAN - seiPrefix.length - 2, SPS264)), null, 'a prefix split at the scan boundary is not evidence');
    assert.equal(classify(padded(MAX_SCAN - seiPrefix.length - 7, SPS264)), null, 'an incomplete bootstrap at the boundary stays unknown');
    assert.equal(classify(Buffer.concat([SPS264, seiPrefix, Buffer.alloc(2 * MAX_SCAN, 0x55), VPS265])), H264);
});

test('classification is pure, bounded by caller input and emits no payload or diagnostics', () => {
    const module = { exports: {} };
    const forbidden = () => assert.fail('codec classification must not log video or private payloads');
    const context = { module, exports: module.exports, Buffer, require: createRequire(filename),
        console: { log: forbidden, debug: forbidden, info: forbidden, warn: forbidden, error: forbidden } };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    for (const data of [SPS264, VPS265, SPS265, Buffer.from('fixture-private-account-data')]) {
        const original = Buffer.from(data);
        assert.equal(module.exports(data), classify(data));
        assert.deepEqual(data, original);
    }
});
