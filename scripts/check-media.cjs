'use strict';

// Account-free integration check: generate H.264, use the production media
// manager's loopback relay, and decode its HTTP output with real FFmpeg.
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

async function decodeHttp(binary, url, label) {
    const proc = trackProcess(binary, ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '8000000',
        '-analyzeduration', '1000000', '-probesize', '262144', '-i', url,
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
    return image.length;
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
    const homey = { platformVersion: 2, app: { log() {}, error() {}, warn() {}, debug() {} },
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
    client.setCameraMaxLivestreamDuration = (seconds) => assert.equal(seconds, 300);
    client.startStationLivestream = async (serial) => {
        assert.equal(managerBinaryReady, true, 'P2P dispatch occurred before the media binary was ready');
        starts.set(serial, (starts.get(serial) || 0) + 1);
        assert.equal(starts.get(serial), 1, `duplicate synthetic upstream for ${serial}`);
        const camera = cameras.get(serial);
        assert.ok(camera, 'unexpected synthetic camera');
        const generator = trackProcess(binary, ['-hide_banner', '-loglevel', 'error', '-re',
            '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-an', '-c:v', 'libx264',
            '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline',
            '-g', '10', '-keyint_min', '10', '-sc_threshold', '0', '-threads', '1', '-t', '16', '-f', 'h264', 'pipe:1'], `generator ${serial}`);
        const audio = new PassThrough();
        generators.set(serial, { generator, audio });
        await manager.streamHandler(generator.stdout, audio, camera.EufyDevice, camera.EufyStation,
            { videoCodec: VideoCodec.H264, videoFPS: 10 });
    };
    client.stopStationLivestream = async (serial) => {
        const source = generators.get(serial);
        if (source) { source.generator.kill('SIGTERM'); source.audio.destroy(); generators.delete(serial); }
    };
    homey.app.eufyClient = client;
    manager = new CameraMediaManager(homey, {
        userdata: workspace, startTimeoutMs: 8000, snapshotTimeoutMs: 8000,
        idleTimeoutMs: 12000, maxDurationMs: 18000,
        resolveBinary: async () => { managerBinaryReady = true; return binary; },
        spawn: (command, args) => trackProcess(command, args, args.includes('image2pipe') ? 'snapshot decoder' : 'MPEG-TS muxer')
    });

    function camera(serial, station) {
        const device = { _started: true,
            EufyDevice: { getSerial: () => serial, getStationSerial: () => station,
                hasCommand: (name) => name === CommandName.DeviceStartLivestream,
                hasProperty: (name) => name === PropertyName.DeviceEnabled,
                getPropertyValue: (name) => name === PropertyName.DeviceEnabled ? true : undefined },
            EufyStation: { getSerial: () => station },
            async setCameraVideo(id, name, video) { assert.equal(id, 'main'); this.video = video; },
            async updateImage(type, sn) {
                assert.equal(type, 'snapshot');
                assert.equal(sn, serial);
                assertJpeg(await fs.readFile(path.join(workspace, `${serial}_snapshot.jpg`)), 'published snapshot');
                updates.push(serial);
            }
        };
        cameras.set(serial, device);
        return device;
    }

    const first = camera('GENERATED_A', 'FIXTURE_STATION_A');
    const independent = camera('GENERATED_B', 'FIXTURE_STATION_B');
    await manager.registerVideo(first);
    await manager.registerVideo(independent);
    const [firstUrl, independentUrl] = await Promise.all([first.video.listener(), independent.video.listener()]);
    assert.equal(starts.size, 0, 'registering a video should not start an upstream');
    const results = await Promise.all([
        decodeHttp(binary, firstUrl.url, 'shared viewer one'),
        decodeHttp(binary, firstUrl.url, 'shared viewer two'),
        decodeHttp(binary, independentUrl.url, 'independent viewer'),
        manager.requestSnapshot(first),
        manager.requestSnapshot(first)
    ]);
    assert.equal(results[3], true);
    assert.equal(results[4], true);
    assert.deepEqual([...starts].sort(), [['GENERATED_A', 1], ['GENERATED_B', 1]]);
    assert.deepEqual(updates, ['GENERATED_A']);
    assert.ok(manager.getStatus('GENERATED_A').bytes > 188);
    assert.ok(manager.getStatus('GENERATED_B').bytes > 188);
    await manager.stopStream('GENERATED_A');
    assert.equal(manager.getStatus('GENERATED_B').state, 'streaming', 'stopping one station interrupted the other');
    console.log(`Generated-media check passed: three real HTTP MPEG-TS viewers decoded JPEGs (${results.slice(0, 3).join(', ')} bytes), two cameras used one upstream each, and coalesced snapshot requests published one fresh image.`);
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
