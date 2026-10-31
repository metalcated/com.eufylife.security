'use strict';

const LIMIT = 64 * 1024;
const AVC_PROFILES = new Set([44, 66, 77, 83, 86, 88, 100, 110, 118, 122, 128, 134, 135, 138, 139, 244]);
const AVC_LEVELS = new Set([9, 10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62]);
const HEVC_LEVELS = new Set([30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186]);

function rbsp(data) {
    const bytes = [];
    for (let index = 0; index < data.length; index++) {
        if (index >= 2 && data[index] === 3 && data[index - 1] === 0 && data[index - 2] === 0) {
            if (index + 1 >= data.length || data[index + 1] > 3) return null;
            continue;
        }
        bytes.push(data[index]);
    }
    return bytes;
}

// Only bootstrap parameter sets establish a codec. Delta pictures, audio,
// arbitrary payloads and unknown headers never select a decoder. This is a
// bounded prefix recognizer, not a general bitstream decoder or format guess.
function classifyAnnexBCodec(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
    const length = Math.min(buffer.length, LIMIT), starts = [];
    for (let index = 0; index < length - 2;) {
        const prefix = buffer[index] === 0 && buffer[index + 1] === 0
            ? buffer[index + 2] === 1 ? 3 : index + 3 < length && buffer[index + 2] === 0 && buffer[index + 3] === 1 ? 4 : 0 : 0;
        if (prefix) { starts.push({ index, prefix }); index += prefix; }
        else index++;
    }
    if (!starts.length || buffer.subarray(0, starts[0].index).some(byte => byte !== 0)) return null;
    let detected = null;
    for (let index = 0; index < starts.length; index++) {
        const start = starts[index].index + starts[index].prefix, end = starts[index + 1]?.index ?? length;
        if (start >= end || buffer[start] & 0x80) return null;
        const avcType = buffer[start] & 31, hevcType = buffer[start] >> 1;
        let codec = null;
        if (avcType === 7) {
            if (!(buffer[start] & 0x60)) return null;
            const body = rbsp(buffer.subarray(start + 1, end));
            if (!body || body.length < 8 || !AVC_PROFILES.has(body[0]) || body[1] & 3 || !AVC_LEVELS.has(body[2])) return null;
            // seq_parameter_set_id is unsigned Exp-Golomb, limited to0..31.
            let leading = 0;
            while (leading < 6 && !(body[3] & (0x80 >> leading))) leading++;
            if (leading > 5) return null;
            let identifier = (1 << leading) - 1;
            for (let bit = 0; bit < leading; bit++) {
                const position = 24 + leading + 1 + bit;
                identifier += ((body[position >> 3] >> (7 - (position & 7))) & 1) << (leading - bit - 1);
            }
            if (identifier > 31) return null;
            codec = 0;
        } else if (hevcType === 32 || hevcType === 33) {
            if (start + 2 >= end || buffer[start] & 1 || buffer[start + 1] !== 1) return null;
            const body = rbsp(buffer.subarray(start + 2, end));
            const profile = hevcType === 32 ? 4 : 1;
            if (!body || body.length < (hevcType === 32 ? 18 : 16)
                || (body[profile] & 0xc0) || !(body[profile] & 31) || (body[profile] & 31) > 11
                || !HEVC_LEVELS.has(body[profile + 11])) return null;
            if (hevcType === 32) {
                if ((body[0] & 0x0f) !== 0x0c || (body[1] & 0xf0) || ((body[1] >> 1) & 7) > 6
                    || body[2] !== 255 || body[3] !== 255) return null;
            } else if (((body[0] >> 1) & 7) > 6 || !(body[0] & 1)) return null;
            codec = 1;
        }
        if (codec !== null) {
            if (detected !== null && detected !== codec) return null;
            detected = codec;
        }
    }
    return detected;
}

module.exports = classifyAnnexBCodec;
