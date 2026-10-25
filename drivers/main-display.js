'use strict';

const Homey = require('homey');
const { PropertyName } = require('eufy-security-client');
const { isSupportedDisplay, parseBatteryPercentage } = require('../lib/display-support');

const displayBatteryParameter = 8001;
const metadataProperties = new Set([PropertyName.Model, PropertyName.SoftwareVersion, PropertyName.HardwareVersion]);
const reportedText = (value) => typeof value === 'string' && value.trim() ? value.trim() : 'Not reported by Eufy';

module.exports = class mainDisplay extends Homey.Device {
    async onInit() {
        this.HomeyDevice = this.getData();
        this._started = false;
        await this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`);
    }

    async onStartup() {
        const client = this.homey.app.eufyClient;
        const token = this._displayStartupToken = (this._displayStartupToken || 0) + 1;
        this._displayDisposed = false;
        const active = () => !this._displayDisposed && this._displayStartupToken === token && this.homey.app.eufyClient === client;
        const step = async (operation) => {
            if (!active()) throw new Error('Display startup cancelled.');
            const result = await operation();
            if (!active()) throw new Error('Display startup cancelled.');
            return result;
        };
        this.cleanupDisplayListeners();
        this._started = false;
        try {
            await step(() => this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`));
            this.EufyDevice = await step(() => this.homey.app.eufyClient.getDevice(this.HomeyDevice.device_sn));
            if (!isSupportedDisplay(this.EufyDevice)) throw new Error('This device is not an E10 smart display.');
            this.HomeyDevice.station_sn = this.EufyDevice.getStationSerial();
            await step(() => this.homey.app.setDevice(this));
            this.setDisplayListeners();
            await step(() => this.refreshInfo());
            if (!client.isConnected()) throw new Error('Connection to Eufy was lost during display startup.');
            this._started = true;
            await step(() => this.setAvailable());
        } catch (error) {
            if (!active()) return;
            this._started = false;
            await this.setUnavailable('Eufy did not provide the smart display. Check account access and repair the device.');
            this.homey.app.error(error);
        }
    }

    async onAdded() {
        await this.onStartup();
    }

    async refreshInfo() {
        if (this._displayDisposed) return;
        // main_sw_version is verified cloud metadata. Raw display parameter 8003
        // has no verified meaning and must not be presented as firmware.
        await this.setSettings({
            MODEL: reportedText(this.EufyDevice.getModel()),
            FIRMWARE_VERSION: reportedText(this.EufyDevice.getSoftwareVersion()),
            HARDWARE_VERSION: reportedText(this.EufyDevice.getHardwareVersion()),
            DEVICE_SN: reportedText(this.EufyDevice.getSerial()),
            STATION_SN: reportedText(this.EufyDevice.getStationSerial())
        });
        await this.updateBattery(this.EufyDevice.getRawProperty(displayBatteryParameter));
    }

    async updateBattery(rawValue) {
        if (this._displayDisposed) return;
        const value = parseBatteryPercentage(rawValue);
        if (value !== null && !this.hasCapability('measure_battery')) await this.addCapability('measure_battery');
        if (this.hasCapability('measure_battery')) await this.setCapabilityValue('measure_battery', value);
    }

    async onEufyPropertyChanged(device, name) {
        if (this._displayDisposed) return;
        try {
            if (device.getSerial() === this.HomeyDevice.device_sn && metadataProperties.has(name)) await this.refreshInfo();
        } catch (error) {
            this.homey.app.error(error);
        }
    }

    setDisplayListeners() {
        const client = this.homey.app.eufyClient;
        const onRawProperty = (device, type, value) => {
            if (device.getSerial() === this.HomeyDevice.device_sn && type === displayBatteryParameter) {
                this.updateBattery(value).catch((error) => this.homey.app.error(error));
            }
        };
        const onClose = () => {
            this._displayStartupToken = (this._displayStartupToken || 0) + 1;
            this._started = false;
            this.setUnavailable('Connection to Eufy was lost.').catch((error) => this.homey.app.error(error));
            if (this.hasCapability('measure_battery')) this.setCapabilityValue('measure_battery', null).catch((error) => this.homey.app.error(error));
        };
        const onConnect = () => {
            if (!this._started) this.onStartup().catch((error) => this.homey.app.error(error));
        };
        client.on('device raw property changed', onRawProperty);
        client.on('close', onClose);
        client.on('connect', onConnect);
        this._displayCleanup = () => {
            client.removeListener('device raw property changed', onRawProperty);
            client.removeListener('close', onClose);
            client.removeListener('connect', onConnect);
        };
    }

    cleanupDisplayListeners() {
        if (this._displayCleanup) this._displayCleanup();
        this._displayCleanup = null;
    }

    async onUninit() {
        this._displayDisposed = true;
        this._displayStartupToken = (this._displayStartupToken || 0) + 1;
        this._started = false;
        this.cleanupDisplayListeners();
    }

    onDeleted() {
        this._displayDisposed = true;
        this._displayStartupToken = (this._displayStartupToken || 0) + 1;
        this._started = false;
        this.cleanupDisplayListeners();
        this.homey.app.removeDevice(this.HomeyDevice.device_sn);
    }
};
