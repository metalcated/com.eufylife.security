'use strict';

const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { HelperServer } = require('./service.cjs');

async function readSecret(filename) {
    if (!filename || !path.isAbsolute(filename)) throw new Error('A secret file is required.');
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024) throw new Error('Invalid secret file.');
        const secret = (await file.readFile('utf8')).trim();
        if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid secret file.');
        return secret;
    } finally { await file.close(); }
}

async function main() {
    const secret = await readSecret(process.env.EUFY_MEDIA_SECRET_FILE);
    const port = Number(process.env.EUFY_MEDIA_PORT || 8769);
    const service = new HelperServer({ secret, port, host: process.env.EUFY_MEDIA_BIND || '127.0.0.1',
        mediaDir: process.env.EUFY_MEDIA_CACHE_DIR || '/tmp/eufy-media', ffmpeg: process.env.EUFY_MEDIA_FFMPEG || '/usr/bin/ffmpeg' });
    let stopping;
    const stop = failed => {
        if (stopping) return stopping;
        const timer = setTimeout(() => process.exit(1), 10000); timer.unref();
        stopping = service.close().then(() => process.exit(failed ? 1 : 0), () => process.exit(1));
        return stopping;
    };
    process.once('SIGTERM', () => stop(false)); process.once('SIGINT', () => stop(false));
    process.once('uncaughtException', () => { console.error('Camera media helper stopped after an internal error.'); stop(true); });
    process.once('unhandledRejection', () => { console.error('Camera media helper stopped after an internal error.'); stop(true); });
    await service.listen();
    console.log('Camera media helper started.');
    return service;
}

if (require.main === module) main().catch(() => { console.error('Camera media helper could not start.'); process.exitCode = 1; });
module.exports = { main, readSecret };
