'use strict';

const SETTING_KEY = 'camera_stream_limit';
const DEFAULT_MAX_STREAMS = 4;
const validLimit = value => value === null || Number.isSafeInteger(value) && value > 0;
const invalidSetting = () => Object.assign(new Error('Choose a positive whole-number stream limit or No limit.'),
    { status: 400, statusCode: 400, cameraSettingsPublic: true });

function validate(value) {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
            || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'maxStreams')) throw invalidSetting();
        const maxStreams = value.maxStreams;
        if (!validLimit(maxStreams)) throw invalidSetting();
        return { maxStreams };
    } catch { throw invalidSetting(); }
}

function getSettings(homey) {
    try { return { ...validate(homey.settings.get(SETTING_KEY)), saved: true }; }
    catch { return { maxStreams: DEFAULT_MAX_STREAMS, saved: false }; }
}

const getStreamLimit = homey => getSettings(homey).maxStreams;

function isAtCapacity(count, maxStreams) {
    if (!Number.isSafeInteger(count) || count < 0 || !validLimit(maxStreams)) return true;
    return maxStreams !== null && count >= maxStreams;
}

const format = maxStreams => maxStreams === null ? 'No limit' : String(validLimit(maxStreams) ? maxStreams : DEFAULT_MAX_STREAMS);

module.exports = { SETTING_KEY, DEFAULT_MAX_STREAMS, getStreamLimit, read: getStreamLimit, getSettings, validate, isAtCapacity, format };
