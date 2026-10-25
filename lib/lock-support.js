'use strict';

const { DeviceType, PropertyName } = require('eufy-security-client');

// Match the implemented Station.lockDevice branches in the pinned client.
// LOCK_8531 and LOCK_85D0 expose metadata but have no command implementation.
const supportedTypes = new Set([
    DeviceType.LOCK_BLE,
    DeviceType.LOCK_WIFI,
    DeviceType.LOCK_BLE_NO_FINGER,
    DeviceType.LOCK_WIFI_NO_FINGER,
    DeviceType.LOCK_8503,
    DeviceType.LOCK_8530,
    DeviceType.LOCK_8504,
    DeviceType.LOCK_8502,
    DeviceType.LOCK_8506,
    DeviceType.LOCK_85L0,
    DeviceType.LOCK_85V0,
    DeviceType.LOCK_85P0
].filter(Number.isInteger));

exports.isSupportedLock = function (device) {
    try {
        return supportedTypes.has(device.getDeviceType()) &&
            device.hasProperty(PropertyName.DeviceLocked) &&
            device.getPropertyMetadata(PropertyName.DeviceLocked).writeable === true;
    } catch (error) {
        return false;
    }
};
