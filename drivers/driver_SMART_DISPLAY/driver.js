'use strict';

const mainDriver = require('../main-driver');
const { isSupportedDisplay } = require('../../lib/display-support');

module.exports = class driver_SMART_DISPLAY extends mainDriver {
    async setPairingSession(session) {
        await super.setPairingSession(session);
        session.setHandler('display_discovery_status', async () => this.homey.app.getSmartDisplayStatus());
    }

    async getDiscoveryDevices() {
        const devices = await this.homey.app.getSmartDisplayDevices();
        this.deviceError = !devices.length && this.homey.app.getSmartDisplayStatus().error
            ? 'Homey could not read smart displays from your Eufy account. Repair the Eufy login or retry later.'
            : false;
        return devices;
    }

    matchesDevice(device) {
        return isSupportedDisplay(device);
    }
};
