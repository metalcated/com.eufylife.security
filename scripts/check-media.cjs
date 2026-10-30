'use strict';

// Account-free integration check: generate H.264 and oversized H.265, use the
// production loopback relay, and require H.264 decoding of its HTTP output.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CommandName, PropertyName, VideoCodec } = require('eufy-security-client');
const CameraMediaManager = require('../lib/helpers/camera-media.helper');
const FfmpegBinaryResolver = require('../lib/helpers/ffmpeg-binary.helper');

const processes = new Set();
const diagnostics = [];
const generators = new Map();
let manager;
let workspace;
let cleaning;
let finished = false;

function trackProcess(command, args, label) {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    processes.add(proc);
    const diagnostic = { label, stderr: '', code: null };
    diagnostics.push(diagnostic);
    proc.stderr.on('data', (bytes) => { diagnostic.stderr = (diagnostic.stderr + bytes.toString()).slice(-1800); });
    proc.on('exit', (code) => { diagnostic.code = code; processes.delete(proc); });
    // Every caller has its own completion/error path. This listener prevents a
    // failed spawn from becoming an unhandled EventEmitter error during cleanup.
    proc.on('error', () => {});
    proc.stdin.on('error', () => {});
    return proc;
}

function assertJpeg(bytes, label) {
    assert.ok(bytes.length > 100, `${label} did not contain a useful decoded image`);
    assert.equal(bytes.readUInt16BE(0), 0xffd8, `${label} is missing the JPEG start marker`);
    assert.equal(bytes.readUInt16BE(bytes.length - 2), 0xffd9, `${label} is missing the JPEG end marker`);
}

function jpegDimensions(bytes) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        const marker = bytes[offset + 1];
        offset += 2;
        const length = bytes.readUInt16BE(offset);
        if (length < 2 || offset + length > bytes.length) break;
        if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
        offset += length;
    }
    throw new Error('The decoded JPEG did not report its dimensions');
}

async function decodeHttp(binary, url, label) {
    const proc = trackProcess(binary, ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '8000000',
        '-analyzeduration', '1000000', '-probesize', '262144', '-c:v', 'h264', '-i', url,
        '-frames:v', '1', '-an', '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], label);
    const chunks = [];
    let size = 0;
    proc.stdout.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) proc.kill('SIGTERM');
        else chunks.push(chunk);
    });
    await new Promise((resolve, reject) => {
        proc.once('error', reject);
        proc.once('close', (code) => code === 0 ? resolve() : reject(Error(`${label} decoder exited with code ${code}`)));
    });
    const image = Buffer.concat(chunks);
    assertJpeg(image, label);
    return { bytes: image.length, ...jpegDimensions(image) };
}

async function cleanup() {
    if (cleaning) return cleaning;
    cleaning = (async () => {
        if (manager) await manager.dispose().catch(() => {});
        for (const proc of processes) proc.kill('SIGKILL');
        if (workspace) await fs.rm(workspace, { recursive: true, force: true });
    })();
    return cleaning;
}

async function main() {
    const starts = new Map();
    const updates = [];
    const homey = { platformVersion: 2, settings: { get: key => key === 'camera_isolated_p2p_devices' ? true : undefined },
        app: { log() {}, error() {}, warn() {}, debug() {} },
        videos: { async createVideoOther(options) {
            assert.equal(options.demuxer, 'mpegts');
            return { registerVideoUrlListener(listener) { this.listener = listener; }, async unregister() {} };
        } }
    };
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-eufy-media-check-'));
    const resolver = new FfmpegBinaryResolver(homey);
    // A fallback download belongs to this fixture rather than an account's userdata.
    resolver.downloadDir = path.join(workspace, 'bin');
    const binary = await resolver.resolve();
    let managerBinaryReady = false;
    const cameras = new Map();
    const client = new EventEmitter();
    client.startStationLivestream = async () => { throw Error('The isolated fixture must not start the shared Station'); };
    client.stopStationLivestream = async () => { throw Error('The isolated fixture must not stop the shared Station'); };
    const startSource = async (serial, onStream) => {
        assert.equal(managerBinaryReady, true, 'P2P dispatch occurred before the media binary was ready');
        starts.set(serial, (starts.get(serial) || 0) + 1);
        assert.equal(starts.get(serial), 1, `duplicate synthetic upstream for ${serial}`);
        const camera = cameras.get(serial);
        assert.ok(camera, 'unexpected synthetic camera');
        const h265 = camera.sourceCodec === VideoCodec.H265;
        const frameRate = h265 ? 15 : 10;
        const size = h265 ? '1920x1080' : '160x120';
        const encoding = h265
            ? ['-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'pools=1:frame-threads=1:wpp=0:log-level=error:keyint=15:min-keyint=15:scenecut=0:repeat-headers=1']
            : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-g', '10', '-keyint_min', '10', '-sc_threshold', '0'];
        const generator = trackProcess(binary, ['-hide_banner', '-loglevel', 'error', '-re',
            '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${frameRate}`, '-an', ...encoding,
            '-threads', '1', '-t', '16', '-f', h265 ? 'hevc' : 'h264', 'pipe:1'], `generator ${serial}`);
        const audio = new PassThrough();
        generators.set(serial, { generator, audio });
        await onStream(generator.stdout, audio, { videoCodec: camera.sourceCodec, videoFPS: frameRate });
    };
    const stopSource = async (serial) => {
        const source = generators.get(serial);
        if (source) { source.generator.kill('SIGTERM'); source.audio.destroy(); generators.delete(serial); }
    };
    homey.app.eufyClient = client;
    manager = new CameraMediaManager(homey, {
        preferSharedP2P: false, // Exercise all synthetic private sources in the codec fixture.
        userdata: workspace, startTimeoutMs: 8000, snapshotTimeoutMs: 8000,
        idleTimeoutMs: 12000, maxDurationMs: 18000,
        createP2PSession: ({ homeyDevice, onStream }) => {
            const serial = homeyDevice.EufyDevice.getSerial();
            return { start: () => startSource(serial, onStream), close: () => stopSource(serial) };
        },
        resolveBinary: async () => { managerBinaryReady = true; return binary; },
        spawn: (command, args) => trackProcess(command, args, args.includes('image2pipe') ? 'snapshot decoder' : 'MPEG-TS muxer')
    });

    function camera(serial, station, sourceCodec = VideoCodec.H264) {
        const device = { _started: true, sourceCodec,
            EufyDevice: { getSerial: () => serial, getStationSerial: () => station,
                hasCommand: (name) => name === CommandName.DeviceStartLivestream,
                hasProperty: (name) => name === PropertyName.DeviceEnabled,
                getPropertyValue: (name) => name === PropertyName.DeviceEnabled ? true : undefined },
            EufyStation: { getSerial: () => station },
            async setCameraVideo(id, name, video) { assert.equal(id, 'main'); this.video = video; },
            async updateImage(type, sn) {
                assert.equal(type, 'snapshot');
                assert.equal(sn, serial);
                const image = await fs.readFile(path.join(workspace, `${serial}_snapshot.jpg`));
                assertJpeg(image, 'published snapshot');
                if (sourceCodec === VideoCodec.H265) {
                    const dimensions = jpegDimensions(image);
                    assert.ok(dimensions.width <= 1280 && dimensions.height <= 720, 'The converted snapshot exceeded 720p');
                }
                updates.push(serial);
            }
        };
        cameras.set(serial, device);
        return device;
    }

    const first = camera('GENERATED_A', 'FIXTURE_STATION_A');
    const independent = camera('GENERATED_B', 'FIXTURE_STATION_A');
    const converted = camera('GENERATED_HEVC', 'FIXTURE_STATION_A', VideoCodec.H265);
    await manager.registerVideo(first);
    await manager.registerVideo(independent);
    await manager.registerVideo(converted);
    const [firstUrl, independentUrl, convertedUrl] = await Promise.all([first.video.listener(), independent.video.listener(), converted.video.listener()]);
    assert.equal(starts.size, 0, 'registering a video should not start an upstream');
    const results = await Promise.all([
        decodeHttp(binary, firstUrl.url, 'shared viewer one'),
        decodeHttp(binary, firstUrl.url, 'shared viewer two'),
        decodeHttp(binary, independentUrl.url, 'independent viewer'),
        decodeHttp(binary, convertedUrl.url, 'HEVC to H264 viewer'),
        manager.requestSnapshot(first),
        manager.requestSnapshot(first),
        manager.requestSnapshot(converted)
    ]);
    assert.equal(results[4], true);
    assert.equal(results[5], true);
    assert.equal(results[6], true);
    for (const frame of results.slice(0, 3)) assert.deepEqual({ width: frame.width, height: frame.height }, { width: 160, height: 120 });
    assert.ok(results[3].width <= 1280 && results[3].height <= 720, 'The H264 viewer output exceeded 720p');
    assert.deepEqual([...starts].sort(), [['GENERATED_A', 1], ['GENERATED_B', 1], ['GENERATED_HEVC', 1]]);
    assert.deepEqual(updates.sort(), ['GENERATED_A', 'GENERATED_HEVC']);
    assert.ok(manager.getStatus('GENERATED_A').bytes > 188);
    assert.ok(manager.getStatus('GENERATED_B').bytes > 188);
    assert.ok(manager.getStatus('GENERATED_HEVC').bytes > 188);
    await manager.stopStream('GENERATED_A');
    assert.equal(manager.getStatus('GENERATED_B').state, 'streaming', 'stopping one camera interrupted its peer on the same synthetic HomeBase');
    console.log(`Generated-media check passed: four real HTTP MPEG-TS viewers required H264 decoding (${results.slice(0, 4).map(frame => `${frame.width}x${frame.height}/${frame.bytes} bytes`).join(', ')}); 1920x1080 HEVC was converted within 720p, three cameras on one synthetic HomeBase used one upstream each, and coalesced snapshots published fresh H264/HEVC-source images.`);
}

const deadline = setTimeout(() => {
    if (finished) return;
    console.error('Generated-media check exceeded its 20-second deadline.');
    cleanup().finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 2000).unref();
}, 20000);

main().catch((error) => {
    process.exitCode = 1;
    console.error(`Generated-media check failed: ${error.message}`);
    for (const diagnostic of diagnostics) if (diagnostic.stderr) console.error(`[${diagnostic.label}] ${diagnostic.stderr}`);
}).finally(async () => {
    await cleanup();
    finished = true;
    clearTimeout(deadline);
});
