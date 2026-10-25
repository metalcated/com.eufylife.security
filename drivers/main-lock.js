'use strict';

const mainSensor = require('./main-sensor');
const { DeviceType, PropertyName } = require('eufy-security-client');
const { isSupportedLock } = require('../lib/lock-support');

const properties = new Map([
    [PropertyName.DeviceLocked, 'locked'],
    [PropertyName.DeviceBattery, 'measure_battery'],
    [PropertyName.DeviceLowBatteryAlert, 'alarm_battery'],
    [PropertyName.DeviceBatteryTemp, 'measure_temperature']
]);

module.exports = class mainLock extends mainSensor {
    async onStartup() {
        const client = this.homey.app.eufyClient;
        const token = this._lockStartupToken = (this._lockStartupToken || 0) + 1;
        this._lockDisposed = false;
        const active = () => !this._lockDisposed && this._lockStartupToken === token && this.homey.app.eufyClient === client;
        const step = async (operation) => {
            if (!active()) throw new Error('Lock startup cancelled.');
            const result = await operation();
            if (!active()) throw new Error('Lock startup cancelled.');
            return result;
        };
        this.cancelLockCommand(new Error('The lock is reconnecting. Please retry when it is available.'));
        this.cleanupLockConnectionListeners();
        this._started = false;
        this._lockNeedsState = false;

        try {
            await step(() => this.setUnavailable(`${this.getName()} ${this.homey.__('device.init')}`));
            await step(() => this.setCapabilityValue('locked', null));
            this.EufyDevice = await step(() => this.homey.app.eufyClient.getDevice(this.HomeyDevice.device_sn));
            if (!isSupportedLock(this.EufyDevice)) {
                throw new Error('This lock is not supported by the installed Eufy client.');
            }

            this.HomeyDevice.station_sn = this.EufyDevice.getStationSerial();
            this.HomeyDevice.isStandAlone = this.HomeyDevice.device_sn === this.HomeyDevice.station_sn;
            this.EufyStation = await step(() => this.homey.app.eufyClient.getStation(this.HomeyDevice.station_sn));

            this.setLockConnectionListeners();
            await step(() => this.homey.app.setDevice(this));
            await step(() => this.checkCapabilities());
            await step(() => this.resetCapabilities());
            await step(() => this.setCapabilitiesListeners());
            await step(() => this.setSettings({
                LOCAL_STATION_IP: this.EufyStation.getLANIPAddress(),
                STATION_SN: this.EufyStation.getSerial(),
                DEVICE_SN: this.EufyDevice.getSerial()
            }));

            if (!client.isConnected()) throw new Error('Connection to Eufy was lost during lock startup.');
            this._started = true;
            await step(() => this.setAvailable());
        } catch (error) {
            if (!active()) return;
            this._started = false;
            await this.setUnavailable(this._lockNeedsState ? 'Waiting for Eufy to report the lock state.' : this.homey.__('device.serial_failure'));
            this.homey.app.error(error);
        }
    }

    setLockConnectionListeners() {
        const client = this.homey.app.eufyClient;
        const onClose = () => {
            this._lockStartupToken = (this._lockStartupToken || 0) + 1;
            this._started = false;
            this._lockNeedsState = false;
            this.cancelLockCommand(new Error('Connection to Eufy was lost. Please reconnect and retry.'));
            this.setUnavailable('Connection to Eufy was lost.').catch((error) => this.homey.app.error(error));
            this.setCapabilityValue('locked', null).catch((error) => this.homey.app.error(error));
        };
        const onProperty = (device, name, value) => {
            if (this._lockNeedsState && device.getSerial() === this.HomeyDevice.device_sn &&
                name === PropertyName.DeviceLocked && typeof value === 'boolean') {
                this.onStartup().catch((error) => this.homey.app.error(error));
            }
        };
        const onConnect = () => {
            if (!this._started) this.onStartup().catch((error) => this.homey.app.error(error));
        };
        client.on('close', onClose);
        client.on('connect', onConnect);
        client.on('device property changed', onProperty);
        this._lockConnectionCleanup = () => {
            client.removeListener('close', onClose);
            client.removeListener('connect', onConnect);
            client.removeListener('device property changed', onProperty);
        };
    }

    cleanupLockConnectionListeners() {
        if (this._lockConnectionCleanup) this._lockConnectionCleanup();
        this._lockConnectionCleanup = null;
    }

    async checkCapabilities() {
        const desired = [...properties]
            .filter(([property]) => this.EufyDevice.hasProperty(property))
            .map(([, capability]) => capability);

        for (const capability of this.getCapabilities()) {
            if (!desired.includes(capability)) await this.removeCapability(capability);
        }
        for (const capability of desired) {
            if (!this.hasCapability(capability)) await this.addCapability(capability);
        }
    }

    async resetCapabilities() {
        if (typeof this.EufyDevice.getPropertyValue(PropertyName.DeviceLocked) !== 'boolean') {
            this._lockNeedsState = true;
            throw new Error('Eufy has not reported a valid lock state.');
        }
        for (const [property] of properties) {
            if (this.EufyDevice.hasProperty(property)) {
                const value = this.EufyDevice.getPropertyValue(property);
                if (value !== undefined && value !== null) {
                    await this.homey.app.eufyEventsHelper.updateDeviceProperties(this, this.EufyDevice, property, value);
                }
            }
        }
    }

    async setCapabilitiesListeners() {
        this.registerCapabilityListener('locked', this.onCapability_locked.bind(this));
    }

    async onCapability_NTFY_TRIGGER(capability, value) {
        if (this._lockDisposed) return;
        if (this.hasCapability(capability)) await this.setCapabilityValue(capability, value);
    }

    async onCapability_locked(value) {
        if (typeof value !== 'boolean') throw new TypeError('Lock state must be true or false.');
        if (!this._started || !this.EufyDevice || !this.EufyStation || !isSupportedLock(this.EufyDevice)) {
            throw new Error('The lock is unavailable. Reconnect it and retry.');
        }
        if (this._pendingLockCommand) throw new Error('A lock command is still pending. Please wait for its result.');

        const client = this.homey.app.eufyClient;
        const station = this.EufyStation;
        const serial = this.EufyDevice.getSerial();
        const stationSerial = station.getSerial();
        const channel = this.EufyDevice.getChannel();
        const alreadyReported = this.EufyDevice.getPropertyValue(PropertyName.DeviceLocked) === value;
        const needsSecondaryResult = [DeviceType.LOCK_8503, DeviceType.LOCK_8504].includes(this.EufyDevice.getDeviceType());

        // setDeviceProperty resolves on dispatch. Wait for the client's reported
        // state, including the secondary response used by retrofit locks.
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const finish = (error) => {
                if (settled) return;
                settled = true;
                this.homey.clearTimeout(timer);
                client.removeListener('device property changed', onProperty);
                client.removeListener('close', onClose);
                station.removeListener('command result', onPrimaryResult);
                station.removeListener('secondary command result', onSecondaryResult);
                station.removeListener('close', onClose);
                this._pendingLockCommand = null;
                if (error) reject(error);
                else resolve();
            };
            const onProperty = (device, name, reportedValue) => {
                if (device.getSerial() === serial && name === PropertyName.DeviceLocked && reportedValue === value) finish();
            };
            const onResult = (resultStation, result, secondary) => {
                if (!resultStation || !result) return;
                const property = result.customData && result.customData.property;
                if (resultStation.getSerial() === stationSerial && result.channel === channel &&
                    property && property.name === PropertyName.DeviceLocked && property.value === value) {
                    if (result.return_code !== 0) {
                        finish(new Error(`Eufy rejected the lock command (code ${result.return_code}).`));
                    } else if (alreadyReported && secondary === needsSecondaryResult &&
                        this.EufyDevice.getPropertyValue(PropertyName.DeviceLocked) === value) {
                        // The client suppresses property events for unchanged values.
                        // Still require a fresh success response for repeated commands.
                        finish();
                    }
                }
            };
            const onPrimaryResult = (resultStation, result) => onResult(resultStation, result, false);
            const onSecondaryResult = (resultStation, result) => onResult(resultStation, result, true);
            const onClose = () => finish(new Error('Connection to the lock was lost. Please reconnect and retry.'));

            this._pendingLockCommand = finish;
            client.on('device property changed', onProperty);
            client.on('close', onClose);
            station.on('command result', onPrimaryResult);
            station.on('secondary command result', onSecondaryResult);
            station.on('close', onClose);
            timer = this.homey.setTimeout(() => finish(new Error('Eufy did not confirm the lock state. Check the lock before retrying.')), 20000);

            Promise.resolve().then(() => {
                if (!settled) return client.setDeviceProperty(serial, PropertyName.DeviceLocked, value);
            }).catch(finish);
        });
    }

    cancelLockCommand(error) {
        if (this._pendingLockCommand) this._pendingLockCommand(error);
    }

    async onUninit() {
        this._lockDisposed = true;
        this._lockStartupToken = (this._lockStartupToken || 0) + 1;
        this._started = false;
        this._lockNeedsState = false;
        this.cancelLockCommand(new Error('The lock device is shutting down.'));
        this.cleanupLockConnectionListeners();
    }

    onDeleted() {
        this._lockDisposed = true;
        this._lockStartupToken = (this._lockStartupToken || 0) + 1;
        this._started = false;
        this._lockNeedsState = false;
        this.cancelLockCommand(new Error('The lock was removed from Homey.'));
        this.cleanupLockConnectionListeners();
        super.onDeleted();
    }
};
