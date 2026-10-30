'use strict';
const fs = require('node:fs');
const { configureRoute } = require('./install-app.cjs');
const APP = 'com.eufylife.security';
const VERSION = require('../app.json').version;

async function connectHelper({ homey, tokenFile, origin = 'http://127.0.0.1:8769', selection = true }) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin) || Number(new URL(origin).port) > 65535) throw Error('Invalid helper loopback address');
    if (selection !== true && (!Array.isArray(selection) || !selection.length
        || selection.some(id => !/^[a-f0-9-]{36}$/i.test(id)))) throw Error('Invalid helper camera selection');
    const file = await fs.promises.open(tokenFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let token;
    try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024) throw Error('The helper bootstrap key must be a private file');
        token = (await file.readFile('utf8')).trim();
    } finally { await file.close(); }
    if (!/^[a-f0-9]{64}$/.test(token)) throw Error('Invalid helper bootstrap key');
    const installed = await homey.apps.getApp({ id: APP, $cache: false, $socket: false });
    if (installed.state !== 'running' || installed.version !== VERSION) throw Error('Install the compatible Eufy fork before connecting its helper');
    const [devices, cameras] = await Promise.all([
        homey.devices.getDevices({ $cache: false, $socket: false }),
        homey.call({ method: 'GET', path: `/api/app/${APP}/cameras/status` }),
    ]);
    if (!Array.isArray(cameras) || !cameras.length || cameras.some(camera => !camera.videoRegistered
        || devices[camera.id]?.driverUri !== `homey:app:${APP}`)) throw Error('Eufy camera registrations are not ready');
    if (Array.isArray(selection) && selection.some(id => !cameras.some(camera => camera.id === id))) throw Error('A selected camera does not belong to this Eufy app');
    const name = 'camera_helper_connection';
    const [previous, previousSelection] = await Promise.all([
        homey.apps.getAppSetting({ id: APP, name }),
        homey.apps.getAppSetting({ id: APP, name: 'camera_helper_devices' }),
    ]);
    if (previous != null && (previous.protocol !== 1 || previous.url !== origin || previous.token !== token)) {
        throw Error('An existing helper identity differs; it was not overwritten');
    }
    let selected = false, selectionAttempted = false;
    try {
        if (previous == null) await homey.apps.setAppSetting({ id: APP, name, value: { protocol: 1, url: origin, token } });
        const health = await homey.call({ method: 'GET', path: `/api/app/${APP}/camera-helper` });
        if (health.available !== true || health.protocol !== 1 || health.sdk !== '4.2.6') throw Error('Homey could not verify the helper connection');
        selectionAttempted = true;
        await homey.apps.setAppSetting({ id: APP, name: 'camera_helper_devices', value: selection });
        selected = true;
        return { connected: true, protocol: health.protocol, helperVersion: health.version,
            selectedCameras: selection === true ? cameras.length : selection.length, nativeCameraRegistrationsPreserved: true };
    } finally {
        if (!selected) {
            try {
                if (selectionAttempted) {
                    if (previousSelection == null) await homey.apps.unsetAppSetting({ id: APP, name: 'camera_helper_devices' });
                    else await homey.apps.setAppSetting({ id: APP, name: 'camera_helper_devices', value: previousSelection });
                }
            } finally {
                if (previous == null) await homey.apps.unsetAppSetting({ id: APP, name });
            }
        }
    }
}

async function main() {
    const auth = require('homey/services/AthomApi');
    const selected = await auth.getSelectedHomey();
    if (!process.env.HOMEY_ID || selected?.id !== process.env.HOMEY_ID) throw Error('Select the intended Homey before connecting the helper');
    const homey = await auth.getActiveHomey();
    if (homey.id !== process.env.HOMEY_ID) throw Error('Connected Homey identity differs');
    await configureRoute(homey, process.env.HOMEY_INSTALL_URL);
    const result = await connectHelper({ homey, tokenFile: process.env.EUFY_MEDIA_TOKEN_FILE,
        origin: process.env.EUFY_MEDIA_ORIGIN || 'http://127.0.0.1:8769',
        selection: process.env.EUFY_MEDIA_DEVICE_IDS ? JSON.parse(process.env.EUFY_MEDIA_DEVICE_IDS) : true });
    console.log(JSON.stringify(result));
}
if (require.main === module) main().catch(() => { console.error('The helper connection could not be configured. Existing identities were retained.'); process.exitCode = 1; });
module.exports = { connectHelper };
