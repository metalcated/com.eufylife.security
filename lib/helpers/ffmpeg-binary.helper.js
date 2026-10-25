const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');

// Release of https://github.com/eugeneware/ffmpeg-static that provides raw,
// gzip-compressed static ffmpeg binaries per platform/arch (no tar/zip needed).
const FFMPEG_STATIC_RELEASE = 'b6.1.1';
const FFMPEG_STATIC_BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_RELEASE}`;

// platform/arch combinations that ffmpeg-static publishes prebuilt binaries for
const SUPPORTED_DOWNLOAD_TARGETS = {
    darwin: ['x64', 'arm64'],
    freebsd: ['x64'],
    linux: ['x64', 'ia32', 'arm64', 'arm'],
    win32: ['x64', 'ia32'],
};

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 60000;

// Resolves a working ffmpeg binary for the machine this app is actually running on.
// Homey Pro hardware ships with binaries bundled inside the app (bin/ffmpeg-arm*),
// but a self-hosted Homey server can run on other OS/CPU combinations (eg. x64 Linux)
// for which no binary is bundled, or on a libc that the bundled binary can't run on.
// In that case we download a matching static build once and cache it in userdata.
class FfmpegBinaryResolver {
    constructor(homey) {
        this.homey = homey;
        this.downloadDir = path.join(path.resolve(__dirname, '/userdata/'), 'bin');
    }

    log(...args) {
        if (this.homey?.app?.log) this.homey.app.log(...args);
    }

    error(...args) {
        if (this.homey?.app?.error) this.homey.app.error(...args);
    }

    // Binaries shipped inside the app, built for official Homey Pro hardware.
    getBundledPath() {
        if (os.platform() !== 'linux') return null;

        if (os.arch() === 'arm64') return path.join(__dirname, '../../bin', 'ffmpeg-arm64'); // HP23
        if (os.arch() === 'arm') return path.join(__dirname, '../../bin', 'ffmpeg-arm32'); // HP19

        return null;
    }

    isExecutable(binPath) {
        try {
            fs.accessSync(binPath, fs.constants.X_OK);
            const result = spawnSync(binPath, ['-version'], { timeout: 5000 });
            return result.status === 0;
        } catch (error) {
            return false;
        }
    }

    getDownloadTarget() {
        const platform = os.platform();
        const arch = os.arch();

        if (!SUPPORTED_DOWNLOAD_TARGETS[platform]?.includes(arch)) return null;

        return { platform, arch };
    }

    getDownloadedPath({ platform, arch }) {
        const ext = platform === 'win32' ? '.exe' : '';
        return path.join(this.downloadDir, `ffmpeg-${platform}-${arch}${ext}`);
    }

    async download(url, destPath, redirectsLeft = MAX_REDIRECTS) {
        const controller = new AbortController();
        // One deadline covers redirects, headers, body decompression and writing.
        const timeout = setTimeout(() => controller.abort(new Error('Timed out downloading ffmpeg binary')), DOWNLOAD_TIMEOUT_MS);
        timeout.unref?.();
        let file;
        let fileOpened = false;

        const getResponse = (address, remaining) => new Promise((resolve, reject) => {
            const target = new URL(address);
            if (target.protocol !== 'https:') throw new Error('FFmpeg binary downloads require HTTPS');
            const request = https.get(target, {
                headers: { 'User-Agent': 'homey-eufy-security' },
                signal: controller.signal
            }, (response) => {
                // Also handle errors before the resolved response reaches pipeline().
                response.on('error', reject);
                if (controller.signal.aborted) {
                    response.destroy();
                    reject(controller.signal.reason);
                    return;
                }
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                    if (remaining <= 0) {
                        reject(new Error('Too many redirects while downloading ffmpeg binary'));
                        response.destroy();
                        return;
                    }
                    try {
                        resolve(getResponse(new URL(response.headers.location, target), remaining - 1));
                    } catch (error) {
                        reject(error);
                    }
                    response.destroy();
                    return;
                }
                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(`Failed to download ffmpeg binary: HTTP ${response.statusCode}`));
                    return;
                }
                resolve(response);
            });
            request.on('error', reject);
        });

        try {
            const response = await getResponse(url, redirectsLeft);
            if (controller.signal.aborted) throw controller.signal.reason;
            const gunzip = zlib.createGunzip();
            // Redirects never create or unlink a file. Only the final successful
            // response opens the caller's temporary download, exactly once.
            file = fs.createWriteStream(destPath);
            file.once('open', () => { fileOpened = true; });
            await pipeline(response, gunzip, file, { signal: controller.signal });
        } catch (error) {
            const failure = controller.signal.aborted ? controller.signal.reason : error;
            controller.abort(failure);
            // Wait for the owned temporary file to close before unlinking it or
            // allowing a retry to reuse its path.
            if (file && !file.closed) {
                await new Promise((resolve) => {
                    file.once('close', resolve);
                    file.destroy();
                });
            }
            if (fileOpened) await fs.promises.unlink(destPath).catch(() => {});
            throw failure;
        } finally {
            clearTimeout(timeout);
        }
    }

    async downloadBinary(target) {
        const destPath = this.getDownloadedPath(target);

        if (this.isExecutable(destPath)) {
            this.log('[FfmpegBinaryResolver] - Using previously downloaded ffmpeg binary:', destPath);
            return destPath;
        }

        fs.mkdirSync(this.downloadDir, { recursive: true });

        const { platform, arch } = target;
        const url = `${FFMPEG_STATIC_BASE_URL}/ffmpeg-${platform}-${arch}.gz`;
        const tmpPath = `${destPath}.download`;

        this.log(`[FfmpegBinaryResolver] - Detected ${platform}/${arch}, downloading matching ffmpeg binary from`, url);

        await this.download(url, tmpPath);
        fs.renameSync(tmpPath, destPath);
        fs.chmodSync(destPath, 0o755);

        if (!this.isExecutable(destPath)) {
            throw new Error(`Downloaded ffmpeg binary for ${platform}/${arch} is not runnable on this system`);
        }

        this.log('[FfmpegBinaryResolver] - Downloaded working ffmpeg binary to:', destPath);

        return destPath;
    }

    async resolve() {
        const bundledPath = this.getBundledPath();

        if (bundledPath) {
            if (this.isExecutable(bundledPath)) {
                this.log('[FfmpegBinaryResolver] - Using bundled ffmpeg binary:', bundledPath);
                return bundledPath;
            }

            this.log(
                '[FfmpegBinaryResolver] - Bundled ffmpeg binary does not run on this system, falling back to download:',
                bundledPath
            );
        }

        const target = this.getDownloadTarget();
        if (!target) {
            throw new Error(`Unsupported platform/architecture for ffmpeg: ${os.platform()}/${os.arch()}`);
        }

        return this.downloadBinary(target);
    }
}

module.exports = FfmpegBinaryResolver;
