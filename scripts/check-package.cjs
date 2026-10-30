'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { gunzipSync } = require('node:zlib');
const { installApp } = require('./install-app.cjs');
const root = path.resolve(__dirname, '..');

async function main() {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json')));
    let checked = false;
    await installApp({ root, homey: {
        name: 'Packaging verification',
        apps: { async getApp() { return { id: manifest.id, version: manifest.version, state: 'running', enabled: true }; } },
        devkit: { async runApp({ app: stream, clean, debug }) {
            assert.equal(clean, false);
            assert.equal(debug, false);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const archive = gunzipSync(Buffer.concat(chunks));
            const files = [];
            for (let offset = 0; offset + 512 <= archive.length;) {
                const header = archive.subarray(offset, offset + 512);
                const name = header.subarray(0, 100).toString().replace(/\0.*$/, '');
                if (!name) break;
                const prefix = header.subarray(345, 500).toString().replace(/\0.*$/, '');
                const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, '').trim(), 8) || 0;
                files.push((prefix ? `${prefix}/${name}` : name).replace(/^\.\//, ''));
                offset += 512 + Math.ceil(size / 512) * 512;
            }
            for (const required of ['app.json', 'app.js', 'drivers/main-lock.js', 'drivers/main-display.js',
                'lib/lock-support.js', 'lib/display-support.js', 'lib/display-discovery.js', 'assets/icon.svg',
                'api.js', 'lib/helpers/camera-media.helper.js', 'lib/helpers/camera-wall.helper.js',
                'lib/helpers/camera-p2p-session.helper.js', 'lib/helpers/camera-p2p-worker.js',
                'lib/helpers/camera-p2p-owned-session.helper.js',
                'lib/helpers/camera-native-video-rsa.helper.js',
                'lib/helpers/camera-helper-client.helper.js',
                'settings/index.html', 'settings/camera-wall.js', 'settings/camera-wall.css',
                'node_modules/eufy-security-client/build/index.js', 'node_modules/homey-api/index.js']) {
                assert(files.includes(required), `Missing runtime file: ${required}`);
            }
            for (const id of ['driver_SMART_LOCK', 'driver_SMART_DISPLAY']) {
                for (const view of ['pair', 'repair']) {
                    assert(files.includes(`drivers/${id}/${view}/login_eufy.html`), `${id} ${view} login is missing`);
                }
            }
            assert(files.some(file => /^node_modules\/eufy-security-client\/build\/.*\.proto$/.test(file)), 'Client protocol assets are missing');
            assert(files.some(file => /^node_modules\/eufy-security-client\/build\/.*\.crt$/.test(file)), 'Client certificate assets are missing');
            assert(!files.some(file => /^(test|scripts|helper|deploy|\.homeybuild|\.github|\.git|\.homey|\.homeycompose)\//.test(file)), 'Source or installer files leaked into the package');
            const installerFiles = files.filter(file => /^node_modules\/(sharp|inquirer|dockerode|copyfiles)\//.test(file));
            assert.equal(installerFiles.length, 0, `Installer dependencies leaked into the package: ${installerFiles.slice(0, 4).join(', ')}`);
            // Homey injects its runtime SDK shim into this directory.
            const sdkFiles = ['index.js', 'package.json'];
            assert(files.filter(file => file.startsWith('node_modules/homey/')).every(file =>
                file === 'node_modules/homey/' || sdkFiles.some(name => file === `node_modules/homey/${name}`)), 'Only the Homey SDK shim may enter the package');
            const sdkTemplate = path.join(path.dirname(require.resolve('homey/package.json')), 'assets/homey');
            for (const name of sdkFiles) {
                assert(files.includes(`node_modules/homey/${name}`), `The SDK shim is missing ${name}`);
                assert(fs.readFileSync(path.join(root, '.homeybuild/node_modules/homey', name)).equals(fs.readFileSync(path.join(sdkTemplate, name))), 'The Homey SDK shim differs from the pinned CLI template');
            }
            for (const excluded of ['Dockerfile', '.dockerignore', '.gitignore', '.homeyignore', '.npmrc', '.env', 'env.json']) {
                assert(!files.includes(excluded), `${excluded} must not enter the package`);
            }
            // Existing camera support ships 126 MiB of FFmpeg binaries.
            assert(archive.length < 256 * 1024 * 1024, 'The runtime archive is unexpectedly large');
            console.log(`Verified installation archive: ${files.length} entries, ${archive.length} bytes unpacked`);
            checked = true;
            return { appId: manifest.id };
        } }
    } });
    assert(checked, 'The actual installation archive was not verified');
    await assert.rejects(installApp({ root, homey: {
        name: 'Rejected upload verification',
        devkit: { async runApp({ app: stream }) { stream.destroy(); throw new Error('Intentional upload rejection'); } },
        apps: { getApp() { assert.fail('An existing app must not hide an upload rejection'); } }
    } }), /Intentional upload rejection/);
    console.log('Upload rejection propagates before runtime verification');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
