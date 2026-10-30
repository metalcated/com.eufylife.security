'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CommandName, PropertyName, VideoCodec } = require('eufy-security-client');
const FfmpegBinaryResolver = require('./ffmpeg-binary.helper');
const CameraP2PSession = require('./camera-p2p-session.helper');
const cameraError = message => Object.assign(Error(message), { mediaPublic: true });

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    return { promise, resolve, reject };
};
const validRtsp = value => {
    try { return ['rtsp:', 'rtsps:'].includes(new URL(value).protocol); } catch { return false; }
};

// A single upstream per camera; Homey's built-in proxy supplies WebRTC to viewers.
// The media endpoint is loopback-only and uses a random, process-lifetime capability.
class CameraMediaManager {
    constructor(homey, options = {}) {
        this.homey = homey;
        this.spawn = options.spawn || spawn;
        this.createServer = options.createServer || http.createServer;
        this.resolveBinary = options.resolveBinary || (() => new FfmpegBinaryResolver(homey).resolve());
        this.createP2PSession = options.createP2PSession || (params => new CameraP2PSession(params));
        this.preferSharedP2P = options.preferSharedP2P !== false;
        this.memoryRetryMs = options.memoryRetryMs || 60000;
        this.privateRetryUntil = 0;
        this.userdata = options.userdata || '/userdata';
        this.maxSessions = options.maxSessions || 4;
        this.startTimeoutMs = options.startTimeoutMs || 25000;
        this.snapshotTimeoutMs = options.snapshotTimeoutMs || 15000;
        this.idleTimeoutMs = options.idleTimeoutMs || 5000;
        this.maxDurationMs = options.maxDurationMs || 290000;
        this.sessions = new Map();
        this.stationOwners = new Map();
        this.snapshots = new Map();
        this.videos = new Map();
        this.tokens = new Map();
        this.stopping = new Map();
        this.failedStopping = new Map();
        this.history = new Map();
        this.registrations = new Map();
        this.nativeWaiters = new Map();
        this.nativeProbes = new Map();
        this.nativeProbeProcesses = new Set();
        this.p2pFallback = new Set();
        this.stopGenerations = new Map();
        this.epoch = 0;
        this.disposed = false;
        this.memoryWarning = () => {
            // Release the newest private source first. Homey's memory warning
            // precedes app termination; preserve the account and device controls.
            const session = [...this.sessions.values()].reverse().find(candidate => candidate.isolated && this.active(candidate));
            if (session) {
                this.privateRetryUntil = Date.now() + this.memoryRetryMs;
                this.failSession(session, cameraError("Live video was stopped to stay within Homey's memory limit. Try fewer cameras."));
            }
        };
        this.homey.on?.('memwarn', this.memoryWarning);
    }

    getFFMPEGPath() {
        if (!this.binaryPromise) this.binaryPromise = Promise.resolve().then(this.resolveBinary).catch(error => { this.binaryPromise = null; throw error; });
        return this.binaryPromise;
    }

    isolatedP2P(homeyDevice) {
        const selected = this.homey.settings?.get?.('camera_isolated_p2p_devices');
        if (selected === true) return true;
        const id = homeyDevice.getId?.();
        return Array.isArray(selected) && typeof id === 'string' && selected.includes(id);
    }

    sourceCount() {
        return new Set([...this.sessions.keys(), ...this.stopping.keys()]).size;
    }

    supports(device) {
        return typeof device?.hasCommand === 'function' && device.hasCommand(CommandName.DeviceStartLivestream);
    }

    assertCamera(homeyDevice) {
        if (this.disposed) throw cameraError('Camera streaming is shutting down.');
        const device = homeyDevice.EufyDevice;
        if (!device || homeyDevice._started === false) throw cameraError('The camera is not ready. Reconnect Eufy and retry.');
        if (device.hasProperty(PropertyName.DeviceEnabled)) {
            const enabled = device.getPropertyValue(PropertyName.DeviceEnabled);
            if (enabled === false) throw cameraError('The camera is switched off or in privacy mode.');
            if (enabled !== true) throw cameraError('Eufy has not reported the camera privacy state. Reconnect the camera and retry.');
        }
        if (!this.nativeEnabled(device) && this.homey.app.eufyClient.isConnected?.() === false) throw cameraError('Eufy is disconnected. Reconnect and retry.');
        if (!this.supports(device)) throw cameraError('This camera does not expose a supported live stream.');
    }

    nativeEnabled(device) {
        return !this.p2pFallback.has(device.getSerial()) && this.nativeConfigured(device);
    }

    nativeConfigured(device) {
        return device.hasProperty(PropertyName.DeviceRTSPStream) && typeof device.isRTSPStreamEnabled === 'function' && device.isRTSPStreamEnabled();
    }

    async nativeUrl(homeyDevice) {
        this.assertCamera(homeyDevice);
        const device = homeyDevice.EufyDevice;
        if (!this.nativeEnabled(device)) throw cameraError('Native RTSP is disabled in Eufy. Reopen the camera after enabling it or reconnect the device for P2P streaming.');
        const client = this.homey.app.eufyClient;
        const serial = device.getSerial();
        const epoch = this.epoch;
        const registration = this.registrations.get(serial);
        const ready = deferred();
        if (!this.nativeWaiters.has(serial)) this.nativeWaiters.set(serial, new Set());
        const waiters = this.nativeWaiters.get(serial);
        waiters.add(ready);
        const onProperty = (changed, property, value) => {
            if (changed.getSerial() === serial && property === PropertyName.DeviceRTSPStreamUrl && validRtsp(value)) ready.resolve(value);
        };
        const onClose = () => ready.reject(cameraError('Eufy disconnected while starting RTSP.'));
        client.on('device property changed', onProperty);
        client.on('close', onClose);
        const timeout = setTimeout(() => ready.reject(cameraError('Eufy did not provide a usable RTSP address. Enable NAS/RTSP in Eufy and retry.')), this.startTimeoutMs);
        try {
            homeyDevice.EufyStation.startRTSPStream(device);
            const cached = device.getPropertyValue(PropertyName.DeviceRTSPStreamUrl);
            if (validRtsp(cached)) ready.resolve(cached);
            const url = await ready.promise;
            this.assertCamera(homeyDevice);
            if (epoch !== this.epoch || client !== this.homey.app.eufyClient || homeyDevice.EufyDevice !== device || registration !== this.registrations.get(serial)) {
                throw cameraError('Camera startup was cancelled. Reconnect and retry.');
            }
            return url;
        } finally {
            clearTimeout(timeout);
            client.removeListener('device property changed', onProperty);
            client.removeListener('close', onClose);
            waiters.delete(ready);
            if (!waiters.size && this.nativeWaiters.get(serial) === waiters) this.nativeWaiters.delete(serial);
        }
    }

    assertNativeProbe(probe) {
        this.assertCamera(probe.homeyDevice);
        if (probe.cancelled || !this.nativeConfigured(probe.device) || this.nativeProbes.get(probe.serial) !== probe || probe.epoch !== this.epoch
            || probe.client !== this.homey.app.eufyClient || probe.device !== probe.homeyDevice.EufyDevice
            || probe.registration !== this.registrations.get(probe.serial) || probe.client.isConnected?.() === false) {
            throw cameraError('Camera startup was cancelled. Reconnect and retry.');
        }
    }

    async batteryNativeUrl(homeyDevice) {
        this.assertCamera(homeyDevice);
        const device = homeyDevice.EufyDevice;
        const serial = device.getSerial();
        if (this.p2pFallback.has(serial)) return null;
        const existing = this.nativeProbes.get(serial);
        if (existing) {
            this.assertNativeProbe(existing);
            if (existing.homeyDevice === homeyDevice && existing.device === device) return existing.ready.promise;
            existing.cancel(cameraError('Camera startup was cancelled. Reconnect and retry.'));
        }
        if (this.nativeProbes.size >= 4 || this.nativeProbeProcesses.size >= 4) throw cameraError('Four camera connections are being checked. Wait a moment and retry.');
        const probe = { serial, homeyDevice, device, client: this.homey.app.eufyClient, epoch: this.epoch,
            registration: this.registrations.get(serial), ready: deferred(), cancelled: false };
        const cleanup = () => {
            probe.client.removeListener('close', onClose);
            if (this.nativeProbes.get(serial) === probe) this.nativeProbes.delete(serial);
        };
        probe.cancel = error => {
            if (probe.cancelled) return;
            probe.cancelled = true;
            probe.finish?.(error);
            probe.ready.reject(error);
            cleanup();
        };
        const onClose = () => probe.cancel(cameraError('Eufy disconnected while checking camera video.'));
        this.nativeProbes.set(serial, probe);
        probe.client.on('close', onClose);
        const check = async () => {
            this.assertNativeProbe(probe);
            let url;
            try { url = await this.nativeUrl(homeyDevice); }
            catch (_) { this.assertNativeProbe(probe); }
            this.assertNativeProbe(probe);
            let usable = false;
            if (url) {
                const binary = await this.getFFMPEGPath();
                this.assertNativeProbe(probe);
                usable = await this.probeNativeFrame(probe, binary, url);
                this.assertNativeProbe(probe);
            }
            if (usable) return url;
            this.p2pFallback.add(serial);
            return null;
        };
        check().then(url => { cleanup(); probe.ready.resolve(url); }, error => { cleanup(); probe.ready.reject(error); });
        return probe.ready.promise;
    }

    probeNativeFrame(probe, binary, url) {
        this.assertNativeProbe(probe);
        if (this.nativeProbeProcesses.size >= 4) throw cameraError('Four camera connections are being checked. Wait a moment and retry.');
        return new Promise((resolve, reject) => {
            let proc, timer, finished = false, frame = false, pending = '';
            const finish = (error, usable = false) => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                probe.finish = null;
                if (proc) this.killProcess(proc);
                if (error) reject(error); else resolve(usable);
            };
            probe.finish = finish;
            try {
                proc = this.spawn(binary, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
                    '-rtsp_transport', 'tcp', '-i', url, '-map', '0:v:0',
                    '-frames:v', '1', '-an', '-threads', '1', '-progress', 'pipe:1', '-nostats', '-f', 'null', '-'],
                { stdio: ['ignore', 'pipe', 'ignore'] });
                this.nativeProbeProcesses.add(proc);
                proc.stdout.on('data', chunk => {
                    if (finished) return;
                    pending = (pending + chunk.toString('utf8')).slice(-8192);
                    const lines = pending.split(/\r?\n/);
                    pending = lines.pop();
                    if (lines.some(line => /^frame=\s*[1-9]\d*\s*$/.test(line))) frame = true;
                });
                proc.once('error', () => { this.nativeProbeProcesses.delete(proc); finish(null, false); });
                proc.once('close', code => { this.nativeProbeProcesses.delete(proc); finish(null, code === 0 && frame); });
                timer = setTimeout(() => finish(null, false), 5000);
            } catch (_) { finish(null, false); }
        });
    }

    async registerVideo(homeyDevice) {
        if (!this.supports(homeyDevice.EufyDevice) || this.homey.platformVersion !== 2) return;
        const serial = homeyDevice.EufyDevice.getSerial();
        const device = homeyDevice.EufyDevice;
        const native = Boolean(this.nativeConfigured(device));
        const batteryNative = native && typeof device.hasBattery === 'function' && device.hasBattery() === true;
        const client = this.homey.app.eufyClient;
        const existing = this.videos.get(serial);
        if (existing?.device === homeyDevice && existing.eufyDevice === device && existing.native === native && existing.batteryNative === batteryNative
            && existing.client === client && existing.epoch === this.epoch) return;
        this.nativeProbes.get(serial)?.cancel(cameraError('Camera startup was cancelled. Reconnect and retry.'));
        const generation = (this.registrations.get(serial) || 0) + 1;
        this.registrations.set(serial, generation);
        const epoch = this.epoch;
        const active = () => !this.disposed && this.epoch === epoch && this.registrations.get(serial) === generation && this.homey.app.eufyClient === client && homeyDevice.EufyDevice === device;
        if ((!native || batteryNative) && typeof this.homey.videos?.createVideoOther !== 'function') {
            this.homey.app.warn('This Homey version does not support proxied camera video. Update Homey to use live viewing.');
            return;
        }
        const video = native && !batteryNative ? await this.homey.videos.createVideoRTSP()
            : batteryNative ? await this.homey.videos.createVideoOther() : await this.homey.videos.createVideoOther({ demuxer: 'mpegts' });
        if (!active()) { await video.unregister?.(); return; }
        const entry = { device: homeyDevice, eufyDevice: device, native, batteryNative, client, epoch, video, token: crypto.randomBytes(24).toString('hex') };
        const assertActive = () => {
            this.assertCamera(homeyDevice);
            if (!active()) throw cameraError('Camera startup was cancelled. Reconnect and retry.');
        };
        video.registerVideoUrlListener(async () => {
            let stopGeneration = this.stopGenerations.get(serial) || 0;
            const assertRequest = () => {
                assertActive();
                if ((this.stopGenerations.get(serial) || 0) !== stopGeneration) throw cameraError('Camera startup was cancelled. Reopen the camera to retry.');
            };
            assertRequest();
            if (batteryNative) {
                const url = await this.batteryNativeUrl(homeyDevice);
                assertRequest();
                if (url) return { url };
                if (this.sessions.get(serial)?.native) {
                    await this.stopStream(serial);
                    stopGeneration++;
                }
                assertRequest();
            } else if (native) {
                const url = await this.nativeUrl(homeyDevice);
                assertRequest();
                return { url };
            }
            await this.ensureServer();
            assertRequest();
            return { url: `http://127.0.0.1:${this.server.address().port}/live/${entry.token}.ts` };
        });
        await homeyDevice.setCameraVideo('main', 'Live', video);
        if (!active()) { await video.unregister?.(); return; }
        this.videos.set(serial, entry);
        this.tokens.set(entry.token, entry);
        if (existing) {
            this.tokens.delete(existing.token);
            if (typeof existing.video.unregister === 'function') await existing.video.unregister();
        }
    }

    async ensureServer() {
        if (this.disposed) throw cameraError('Camera streaming is shutting down.');
        if (this.serverPromise) return this.serverPromise;
        this.serverPromise = new Promise((resolve, reject) => {
            const server = this.server = this.createServer((request, response) => {
                this.serve(request, response).catch(() => { if (!response.headersSent) response.writeHead(503); response.end(); });
            });
            server.on('error', reject);
            server.maxConnections = 32;
            server.listen(0, '127.0.0.1', resolve);
        }).catch(error => { this.serverPromise = null; throw error; });
        return this.serverPromise;
    }

    async serve(request, response) {
        const token = /^\/live\/([a-f0-9]{48})\.ts$/.exec(request.url || '')?.[1];
        const entry = token && this.tokens.get(token);
        if (!entry || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
        this.assertCamera(entry.device);
        const session = await this.getSession(entry.device);
        session.consumers.add(response);
        clearTimeout(session.idleTimer);
        response.on('close', () => this.releaseConsumer(session, response));
        await session.ready.promise;
        if (response.destroyed) return;
        response.writeHead(200, { 'Content-Type': 'video/MP2T', 'Cache-Control': 'no-store', 'Connection': 'close', 'X-Content-Type-Options': 'nosniff' });
        response._eufyReady = true;
        for (const chunk of session.replay) this.writeConsumer(session, response, chunk);
    }

    async getSession(homeyDevice) {
        this.assertCamera(homeyDevice);
        const device = homeyDevice.EufyDevice;
        const serial = device.getSerial();
        const epoch = this.epoch;
        const client = this.homey.app.eufyClient;
        const registration = this.registrations.get(serial);
        const stopGeneration = this.stopGenerations.get(serial) || 0;
        const assertRequest = () => {
            this.assertCamera(homeyDevice);
            if (epoch !== this.epoch || client !== this.homey.app.eufyClient || device !== homeyDevice.EufyDevice
                || registration !== this.registrations.get(serial) || stopGeneration !== (this.stopGenerations.get(serial) || 0)) {
                throw cameraError('Camera startup was cancelled. Reconnect and retry.');
            }
        };
        if (this.stopping.has(serial)) await this.stopping.get(serial);
        assertRequest();
        if (this.sessions.has(serial)) return this.sessions.get(serial);
        if (this.sourceCount() >= this.maxSessions) throw cameraError(`There are already ${this.maxSessions} active camera streams. Stop one and retry.`);
        if (this.nativeEnabled(device) && typeof device.hasBattery === 'function' && device.hasBattery() === true) {
            await this.batteryNativeUrl(homeyDevice);
            assertRequest();
            // Another viewer may have opened this source while the shared check ran.
            if (this.sessions.has(serial)) return this.sessions.get(serial);
            if (this.sourceCount() >= this.maxSessions) throw cameraError(`There are already ${this.maxSessions} active camera streams. Stop one and retry.`);
        }
        const native = Boolean(this.nativeEnabled(homeyDevice.EufyDevice));
        const station = homeyDevice.EufyDevice.getStationSerial();
        // Reuse the account Station's video slot before allocating another SDK
        // worker. Additional cameras still own independent connections, and a
        // running private camera is never moved or restarted when that slot frees.
        const occupied = this.stationOwners.has(station) && this.stationOwners.get(station) !== serial;
        const isolated = !native && this.isolatedP2P(homeyDevice) && (!this.preferSharedP2P || occupied);
        // Frontend reconnect timers must not immediately recreate a worker
        // after Homey asks the app to release memory.
        if (isolated && Date.now() < this.privateRetryUntil) throw cameraError("Live video was stopped to stay within Homey's memory limit. Try fewer cameras.");
        if (!native && !isolated && this.stationOwners.has(station) && this.stationOwners.get(station) !== serial) throw cameraError('Another camera on this HomeBase is using P2P streaming. Stop it first, or enable native RTSP for simultaneous viewing.');
        const session = { serial, station, native, isolated, device: homeyDevice, remote: device, originalStation: homeyDevice.EufyStation,
            registration, client: this.homey.app.eufyClient,
            epoch: this.epoch, ready: deferred(), consumers: new Set(), replay: [], replayBytes: 0,
            tail: Buffer.alloc(0), bytes: 0, startedAt: Date.now(), stopped: false };
        this.sessions.set(serial, session);
        this.history.delete(serial);
        if (!native && !isolated) this.stationOwners.set(station, serial);
        const emitter = homeyDevice.EufyStation;
        if (!native && !isolated && typeof emitter?.on === 'function') {
            const channel = homeyDevice.EufyDevice.getChannel();
            const onError = (source, failedChannel) => {
                if (failedChannel === channel) this.failSession(session, cameraError('Eufy could not open the camera stream. Check its Wi-Fi bridge or HomeBase connection and retry.'));
            };
            const onResult = (source, result) => {
                if (result?.channel === channel && result.customData?.command?.name === CommandName.DeviceStartLivestream && result.return_code !== 0) {
                    this.failSession(session, cameraError(`Eufy rejected camera streaming (code ${Number.isInteger(result.return_code) ? result.return_code : 'unknown'}).`));
                }
            };
            emitter.on('livestream error', onError);
            emitter.on('command result', onResult);
            session.removeListeners = () => {
                emitter.removeListener('livestream error', onError);
                emitter.removeListener('command result', onResult);
            };
        }
        session.startTimer = setTimeout(() => this.failSession(session, cameraError('The camera did not deliver video in time. Check its connection and retry.')), this.startTimeoutMs);
        this.startSession(session).catch(error => this.failSession(session, error));
        return session;
    }

    active(session) { return !this.disposed && !session.stopped && session.epoch === this.epoch && this.sessions.get(session.serial) === session; }

    async startSession(session) {
        const binary = await this.getFFMPEGPath();
        if (!this.active(session)) return;
        session.binary = binary;
        if (session.native) {
            const url = await this.nativeUrl(session.device);
            if (this.active(session)) this.startMux(session, ['-rtsp_transport', 'tcp', '-i', url]);
        } else if (session.isolated) {
            if (session.client !== this.homey.app.eufyClient || session.remote !== session.device.EufyDevice
                || session.originalStation !== session.device.EufyStation || session.registration !== this.registrations.get(session.serial)) {
                throw cameraError('Camera startup was cancelled. Reconnect and retry.');
            }
            let adapter;
            const owns = () => {
                if (!adapter || session.p2p !== adapter || !this.active(session)) return false;
                if (session.client !== this.homey.app.eufyClient || session.remote !== session.device.EufyDevice
                    || session.originalStation !== session.device.EufyStation || session.registration !== this.registrations.get(session.serial)) {
                    this.failSession(session, cameraError('Camera startup was cancelled. Reconnect and retry.'));
                    return false;
                }
                return true;
            };
            adapter = this.createP2PSession({ client: session.client, homeyDevice: session.device,
                onStream: (video, audio, metadata) => {
                    if (!owns()) { video?.destroy(); audio?.destroy(); return; }
                    return this.streamHandler(video, audio, session.remote, session.originalStation, metadata, adapter)
                        .catch(error => this.failSession(session, error));
                },
                onStop: () => { if (owns()) this.failSession(session, cameraError('The camera stream ended.')); },
                onError: error => { if (owns()) this.failSession(session, error); }
            });
            session.p2p = adapter;
            if (!adapter || typeof adapter.start !== 'function' || typeof adapter.close !== 'function') {
                throw cameraError('The private camera connection is unavailable.');
            }
            if (!this.active(session)) { await adapter.close(); return; }
            await adapter.start();
        } else {
            // The client's duration setting is global. Keep it fixed for all requests;
            // individual snapshot and viewer lifetimes are managed below.
            session.client.setCameraMaxLivestreamDuration(300);
            session.dispatched = true;
            await session.client.startStationLivestream(session.serial);
        }
    }

    async streamHandler(video, audio, device, station, metadata = {}, owner) {
        const session = this.sessions.get(device.getSerial());
        if (!session || !this.active(session) || session.native || session.input
            || (session.isolated ? !owner || owner !== session.p2p : owner !== undefined || station !== session.originalStation)) {
            video?.destroy(); audio?.destroy(); return;
        }
        session.input = video;
        session.audio = audio;
        // Unsupported/raw audio is not sent as AAC. H265 video is converted for
        // browsers that only offer H264; the camera's own settings stay unchanged.
        audio?.on('error', () => {});
        audio?.resume();
        const codec = metadata.videoCodec === VideoCodec.H265 ? 'hevc' : metadata.videoCodec === VideoCodec.H264 ? 'h264' : null;
        if (!codec) { this.failSession(session, cameraError('The camera reported an unsupported video codec.')); return; }
        const fps = Number.isFinite(metadata.videoFPS) && metadata.videoFPS >= 1 && metadata.videoFPS <= 60 ? metadata.videoFPS : 15;
        try { this.startMux(session, ['-r', String(fps), '-f', codec, '-i', 'pipe:0'], { transcodeH265: codec === 'hevc', fps }); }
        catch (error) { this.failSession(session, error); return; }
        video.on('error', () => this.failSession(session, cameraError('The Eufy camera stream failed.')));
        video.pipe(session.process.stdin);
    }

    async sourceStopped(station, device) {
        const session = this.sessions.get(device.getSerial());
        if (!session || !this.active(session) || session.native || session.isolated || station !== session.originalStation) return;
        await this.stopStream(session.serial);
    }

    startMux(session, inputArgs, { transcodeH265 = false, fps = 15 } = {}) {
        const outputFps = Math.min(15, fps);
        const gop = Math.max(1, Math.min(30, Math.round(outputFps * 2)));
        const outputArgs = transcodeH265 ? [
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '1',
            '-vf', `fps=${outputFps},scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`,
            '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-level:v', '3.1',
            '-crf', '23', '-maxrate', '2000k', '-bufsize', '4000k',
            '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-x264-params', 'repeat-headers=1'
        ] : ['-c:v', 'copy'];
        const proc = session.process = this.spawn(session.binary, ['-hide_banner', '-loglevel', 'error', '-fflags', '+genpts', '-threads', '1', '-probesize', '262144', '-analyzeduration', '1000000',
            ...(transcodeH265 ? ['-filter_threads', '1'] : []), ...inputArgs, '-map', '0:v:0', ...outputArgs, '-an', '-f', 'mpegts', '-mpegts_flags', 'resend_headers+pat_pmt_at_frames', '-flush_packets', '1', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
        proc.stdin.on('error', () => {});
        proc.stderr.on('data', () => {}); // FFmpeg diagnostics may include credential-bearing input URLs.
        proc.stdout.on('data', chunk => this.onData(session, chunk));
        proc.on('error', () => this.failSession(session, cameraError('The camera media process could not start.')));
        proc.on('exit', (code) => {
            if (this.active(session)) this.failSession(session, cameraError(code ? `The camera media process failed (code ${code}).` : 'The camera stream ended.'));
        });
    }

    onData(session, chunk) {
        if (!this.active(session)) return;
        const bytes = session.tail.length ? Buffer.concat([session.tail, chunk]) : chunk;
        const length = bytes.length - bytes.length % 188;
        session.tail = Buffer.from(bytes.subarray(length));
        if (!length) return;
        const data = Buffer.from(bytes.subarray(0, length));
        if (data[0] !== 0x47) { this.failSession(session, cameraError('The camera returned invalid transport data.')); return; }
        session.bytes += data.length;
        const replayLimit = Math.floor(1024 * 1024 / 188) * 188;
        const replay = data.length > replayLimit ? Buffer.from(data.subarray(data.length - replayLimit)) : data;
        session.replay.push(replay);
        session.replayBytes += replay.length;
        while (session.replayBytes > replayLimit) session.replayBytes -= session.replay.shift().length;
        if (!session.firstFrameAt) {
            session.firstFrameAt = Date.now();
            clearTimeout(session.startTimer);
            session.durationTimer = setTimeout(() => this.failSession(session, cameraError('The Eufy viewing session reached its time limit. Reopen the camera to continue.')), this.maxDurationMs);
            session.ready.resolve();
        }
        for (const consumer of session.consumers) if (consumer._eufyReady) this.writeConsumer(session, consumer, data);
    }

    writeConsumer(session, consumer, data) {
        if (consumer.destroyed || consumer.writableLength > 2 * 1024 * 1024) {
            consumer.destroy(); this.releaseConsumer(session, consumer); return;
        }
        consumer.write(data);
    }

    releaseConsumer(session, consumer) {
        session.consumers.delete(consumer);
        if (this.active(session) && !session.consumers.size) {
            clearTimeout(session.idleTimer);
            session.idleTimer = setTimeout(() => this.stopStream(session.serial), this.idleTimeoutMs);
        }
    }

    async startVideo(homeyDevice) {
        const session = await this.getSession(homeyDevice);
        await session.ready.promise;
        if (!session.consumers.size) this.releaseConsumer(session, null);
        return true;
    }

    async requestSnapshot(homeyDevice) {
        this.assertCamera(homeyDevice);
        const serial = homeyDevice.EufyDevice.getSerial();
        if (this.snapshots.has(serial)) return this.snapshots.get(serial);
        const request = this.makeSnapshot(homeyDevice);
        this.snapshots.set(serial, request);
        try { return await request; }
        finally { if (this.snapshots.get(serial) === request) this.snapshots.delete(serial); }
    }

    async makeSnapshot(homeyDevice) {
        const session = await this.getSession(homeyDevice);
        const hold = { destroy() {}, _eufyReady: false };
        session.consumers.add(hold);
        clearTimeout(session.idleTimer);
        let input, temporary;
        let ownsTemporary = false;
        try {
            await session.ready.promise;
            const jpeg = await new Promise((resolve, reject) => {
                const proc = this.spawn(session.binary, ['-hide_banner', '-loglevel', 'error', '-threads', '1', '-f', 'mpegts', '-i', 'pipe:0',
                    '-frames:v', '1', '-an', '-threads', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
                input = proc.stdin;
                input._eufyReady = true;
                const chunks = [];
                let size = 0, finished = false;
                const finish = (error) => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    this.releaseConsumer(session, input);
                    this.killProcess(proc);
                    if (error) reject(error); else resolve(Buffer.concat(chunks));
                };
                const timer = setTimeout(() => finish(cameraError('The camera did not provide a fresh snapshot in time.')), this.snapshotTimeoutMs);
                hold.destroy = () => finish(cameraError('The snapshot was cancelled because the camera disconnected.'));
                proc.on('error', () => finish(cameraError('The snapshot media process could not start.')));
                proc.stderr.on('data', () => {});
                input.on('error', () => {});
                proc.stdout.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) finish(cameraError('The snapshot exceeded the supported size.')); else chunks.push(chunk); });
                proc.on('close', code => finish(code === 0 && size ? null : cameraError('The camera snapshot could not be decoded.')));
                session.consumers.add(input);
                for (const chunk of session.replay) this.writeConsumer(session, input, chunk);
            });
            if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) throw cameraError('The camera returned an invalid snapshot.');
            if (!this.active(session)) throw cameraError('The snapshot was cancelled because the camera disconnected.');
            const serial = session.serial;
            if (!/^[a-zA-Z0-9_-]+$/.test(serial)) throw cameraError('Invalid camera identity.');
            const destination = path.join(this.userdata, `${serial}_snapshot.jpg`);
            temporary = `${destination}.${crypto.randomBytes(8).toString('hex')}.tmp`;
            const file = await fs.promises.open(temporary, 'wx', 0o600);
            ownsTemporary = true;
            try { await file.writeFile(jpeg); }
            finally { await file.close(); }
            if (!this.active(session)) throw cameraError('The snapshot was cancelled because the camera disconnected.');
            await fs.promises.rename(temporary, destination);
            ownsTemporary = false;
            if (!this.active(session)) throw cameraError('The snapshot was cancelled because the camera disconnected.');
            await homeyDevice.updateImage('snapshot', serial);
            return true;
        } finally {
            if (ownsTemporary) await fs.promises.unlink(temporary).catch(() => {});
            this.releaseConsumer(session, hold);
            if (input) this.releaseConsumer(session, input);
        }
    }

    failSession(session, error) {
        if (!this.active(session)) return;
        const safe = error?.mediaPublic ? error : cameraError('The camera stream failed. Check its connection and retry.');
        this.history.set(session.serial, { state: 'stopped', error: safe.message, bytes: session.bytes, updatedAt: Date.now() });
        this.stopStream(session.serial, safe).catch(() => {});
    }

    killProcess(proc) {
        if (!proc) return;
        proc.kill('SIGTERM');
        if (proc.exitCode === null && proc.signalCode === null) {
            const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
            timer.unref?.();
            proc.once('exit', () => clearTimeout(timer));
        }
    }

    closeSource(session) {
        const serial = session.serial;
        const recovering = this.failedStopping.get(serial) === session;
        if (recovering) this.failedStopping.delete(serial);
        const stopping = Promise.resolve().then(() => session.isolated ? session.p2p?.close?.()
            : session.dispatched ? session.client.stopStationLivestream(serial) : undefined).catch(() => {
            if (!session.isolated) return;
            const error = cameraError('The private camera connection could not be closed. Reconnect Eufy before opening another stream.');
            this.failedStopping.set(serial, session);
            this.history.set(serial, { state: 'stopped', error: error.message, bytes: session.bytes, updatedAt: Date.now() });
            throw error;
        }).then(() => {
            if (this.stopping.get(serial) === stopping) this.stopping.delete(serial);
            if (recovering) this.history.set(serial, { state: 'stopped', bytes: session.bytes, updatedAt: Date.now() });
            if (!session.isolated && this.stationOwners.get(session.station) === serial) this.stationOwners.delete(session.station);
        });
        this.stopping.set(serial, stopping);
        // The rejected promise remains a reservation until an explicit cleanup
        // retries it. Keep it observed even when no caller is waiting anymore.
        stopping.catch(() => {});
        return stopping;
    }

    async stopStream(device, error = cameraError('The camera stream was stopped.')) {
        if (device == null) {
            const results = await Promise.allSettled([...new Set([...this.videos.keys(), ...this.sessions.keys(), ...this.stopping.keys(),
                ...this.nativeWaiters.keys(), ...this.nativeProbes.keys()])].map(serial => this.stopStream(serial, error)));
            const failed = results.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
            return;
        }
        const serial = typeof device === 'string' ? device : device.getSerial();
        this.stopGenerations.set(serial, (this.stopGenerations.get(serial) || 0) + 1);
        this.nativeProbes.get(serial)?.cancel(error);
        for (const waiter of this.nativeWaiters.get(serial) || []) waiter.reject(error);
        this.nativeWaiters.delete(serial);
        const session = this.sessions.get(serial);
        if (!session) {
            const failed = this.failedStopping.get(serial);
            return failed ? this.closeSource(failed) : this.stopping.get(serial);
        }
        // Reserve the source through shutdown, including synchronous consumer
        // close callbacks that may immediately request this camera again.
        const stopping = this.closeSource(session);
        session.stopped = true;
        session.removeListeners?.();
        this.sessions.delete(serial);
        for (const timer of ['startTimer', 'idleTimer', 'durationTimer']) clearTimeout(session[timer]);
        session.ready.reject(error);
        this.killProcess(session.process);
        session.input?.destroy(); session.audio?.destroy();
        for (const consumer of session.consumers) consumer.destroy();
        session.consumers.clear(); session.replay = []; session.replayBytes = 0;
        await stopping;
    }

    async releaseDevice(serial) {
        if (typeof serial !== 'string' || !serial) return;
        this.registrations.set(serial, (this.registrations.get(serial) || 0) + 1);
        await this.stopStream(serial);
        const entry = this.videos.get(serial);
        if (entry) {
            this.videos.delete(serial); this.tokens.delete(entry.token);
            if (typeof entry.video.unregister === 'function') await entry.video.unregister();
        }
    }

    getStatus(serial) {
        const session = this.sessions.get(serial);
        return session ? { state: session.firstFrameAt ? 'streaming' : 'starting', source: session.native ? 'rtsp' : 'p2p',
            bytes: session.bytes, consumers: session.consumers.size, startedAt: session.startedAt }
            : this.history.get(serial) || { state: 'idle' };
    }

    async reset() { this.epoch++; await this.stopStream(); this.privateRetryUntil = 0; this.p2pFallback.clear(); this.stopGenerations.clear(); }
    async dispose() {
        this.disposed = true;
        this.homey.removeListener?.('memwarn', this.memoryWarning);
        await this.reset();
        for (const serial of [...this.videos.keys()]) await this.releaseDevice(serial);
        if (this.serverPromise) await this.serverPromise.catch(() => {});
        if (this.server) await new Promise(resolve => this.server.close(resolve));
    }
}

module.exports = CameraMediaManager;
