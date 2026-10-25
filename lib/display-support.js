'use strict';

exports.isSupportedDisplay = function (device) {
    try {
        const model = device.getModel();
        const serial = device.getSerial();
        return (typeof model === 'string' && model.toUpperCase() === 'T87A0') ||
            (typeof serial === 'string' && serial.toUpperCase().startsWith('T87A0'));
    } catch (error) {
        return false;
    }
};

// E10 uses its own 8000-series parameter space, not camera battery parameter 1101.
// The 8001 battery identification is documented at https://mega-yfue.github.io/smart-display.
exports.parseBatteryPercentage = function (value) {
    if (typeof value === 'string') {
        if (!/^\d{1,3}$/.test(value)) return null;
        value = Number(value);
    }
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
};
