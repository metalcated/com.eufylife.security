'use strict';

function wall(homey) {
    if (!homey.app.cameraWall) {
        const CameraWall = require('./lib/helpers/camera-wall.helper');
        homey.app.cameraWall = new CameraWall(homey);
    }
    return homey.app.cameraWall;
}

// Authenticated Homey API only. Diagnostics contain neither media URLs nor cloud records.
module.exports = {
    async getCameraStatus({ homey }) {
        const manager = homey.app.FfmpegManager;
        return (homey.app.deviceList || []).filter(device => manager?.supports(device.EufyDevice)).map(device => ({
            name: device.getName(),
            id: device.getId(),
            videoRegistered: manager.videos.has(device.EufyDevice.getSerial()),
            ...manager.getStatus(device.EufyDevice.getSerial())
        }));
    },
    async getCameraWall({ homey }) { return wall(homey).status(); },
    async configureCameraWall({ homey, body }) { return wall(homey).configure(body?.key); },
    async offerCameraWall({ homey, params, body }) { return wall(homey).offer(params.id, body?.offerSdp); },
    async keepAliveCameraWall({ homey, params, body }) { return wall(homey).keepAlive(params.id, body?.handle); },
    async stopCameraWall({ homey, params, body }) { return wall(homey).stop(params.id, body?.handle); }
};
