'use strict';

// Account-free, network-none check of the pinned SDK's T8423 header codec.
// All video is generated here. No Station constructor, account or socket runs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const classify = require('../lib/helpers/camera-video-codec.helper');
assert.equal(require('eufy-security-client/package.json').version, '4.2.6');
const build = path.dirname(require.resolve('eufy-security-client'));
const { P2PClientProtocol } = require(path.join(build, 'p2p/session.js'));
const { P2PDataType, CommandType, VideoCodec } = require(path.join(build, 'p2p/types.js'));
const binary = [process.env.FFMPEG_PATH, '/usr/bin/ffmpeg', '/app/bin/ffmpeg-arm64'].filter(Boolean)
    .find(candidate => spawnSync(candidate, ['-version'], { timeout: 5000, stdio: 'ignore' }).status === 0);
assert.ok(binary, 'A preinstalled FFmpeg binary is required.');

function ffmpeg(args, input) {
    const result = spawnSync(binary, ['-hide_banner', '-loglevel', 'error', ...args],
        { input, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 0, 'The generated codec fixture must encode and decode successfully.');
    return result.stdout;
}
function units(bytes) {
    const starts = [];
    for (let index = 0; index < bytes.length - 3;) {
        if (bytes[index] === 0 && bytes[index + 1] === 0 && (bytes[index + 2] === 1 || bytes[index + 2] === 0 && bytes[index + 3] === 1)) {
            starts.push(index); index += bytes[index + 2] === 1 ? 3 : 4;
        } else index++;
    }
    return starts.map((start, index) => bytes.subarray(start, starts[index + 1] ?? bytes.length));
}
function sdkVideo(nals, declared) {
    const transport = Object.create(P2PClientProtocol.prototype); EventEmitter.call(transport);
    transport.rawStation = { station_sn: 'T8423FIXTURE' }; transport.currentMessageState = {};
    transport.initializeMessageState(P2PDataType.VIDEO);
    transport.waitForStreamData = () => {}; transport.MAX_VIDEO_PACKET_BYTES = 1024 * 1024;
    const state = transport.currentMessageState[P2PDataType.VIDEO];
    state.p2pStreamFirstAudioDataReceived = true;
    const chunks = []; let metadata;
    state.videoStream = { push(bytes) { if (bytes) chunks.push(Buffer.from(bytes)); } };
    transport.on('livestream started', (channel, info) => { metadata = info; });
    nals.forEach((nal, index) => {
        const data = Buffer.alloc(22 + nal.length);
        data.writeUInt32LE(nal.length); data[4] = 1; data[5] = declared === VideoCodec.H264 ? 1 : 2;
        data.writeUInt16LE(index, 6); data.writeUInt16LE(4, 8); data.writeUInt16LE(160, 10); data.writeUInt16LE(96, 12); nal.copy(data, 22);
        transport.handleDataBinaryAndVideo({ dataType: P2PDataType.VIDEO, commandId: CommandType.CMD_VIDEO_FRAME,
            channel: 0, signCode: 0, data });
    });
    assert.equal(transport.isIFrame, P2PClientProtocol.prototype.isIFrame, 'The original SDK keyframe method was changed.');
    return { metadata, chunks, bytes: Buffer.concat(chunks) };
}

for (const [format, actual, declared] of [['h264', VideoCodec.H264, VideoCodec.H265], ['hevc', VideoCodec.H265, VideoCodec.H264]]) {
    const encoder = format === 'h264'
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '2', '-keyint_min', '2', '-sc_threshold', '0', '-x264-params', 'repeat-headers=1']
        : ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1:wpp=0:log-level=error:keyint=2:min-keyint=2:scenecut=0:repeat-headers=1'];
    const encoded = ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x96:rate=4', '-frames:v', '4', '-an', ...encoder, '-threads', '1', '-f', format, 'pipe:1']);
    const received = sdkVideo(units(encoded), declared);
    assert.equal(received.metadata.videoCodec, declared, 'The pinned SDK no longer reproduces the header declaration.');
    assert.ok(received.chunks.length > 0); assert.equal(classify(received.chunks[0]), actual);
    const unchanged = sdkVideo(units(encoded), actual);
    assert.equal(classify(unchanged.chunks[0]), unchanged.metadata.videoCodec);
    const output = actual === VideoCodec.H264 ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '1', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline'];
    const ts = ffmpeg(['-r', '4', '-f', format, '-i', 'pipe:0', '-map', '0:v:0', ...output, '-an', '-f', 'mpegts', 'pipe:1'], received.bytes);
    assert.ok(ts.length > 188 && ts[0] === 0x47, 'Normalized input did not produce MPEG-TS.');
    ffmpeg(['-f', 'mpegts', '-c:v', 'h264', '-i', 'pipe:0', '-frames:v', '1', '-f', 'null', '-'], ts);
}
console.log('T8423 codec normalization verified: actual pinned SDK wrong-header declarations, generated H264/HEVC bootstrap recognition, corrected MPEG-TS/H264 decoding, matching-codec preservation, and unchanged original keyframe methods.');
