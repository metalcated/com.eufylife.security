'use strict';

const mainDriver = require('../main-driver');
const { isSupportedDisplay } = require('../../lib/display-support');

module.exports = class driver_SMART_DISPLAY extends mainDriver {
    matchesDevice(device) {
        return isSupportedDisplay(device);
    }
};
