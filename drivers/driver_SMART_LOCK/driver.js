'use strict';

const mainDriver = require('../main-driver');
const { isSupportedLock } = require('../../lib/lock-support');

module.exports = class driver_SMART_LOCK extends mainDriver {
    matchesDevice(device) {
        return isSupportedLock(device);
    }
};
