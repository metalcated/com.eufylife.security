'use strict';

const { isSupportedDisplay } = require('./display-support');

const discoveryError = 'Smart display discovery is unavailable. Please retry later.';
const houseListPath = '/app/house/get_house_list';
const deviceListPath = '/app/house/get_devs_list';
const textValue = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

class MegaDisplayDevice {
    constructor(raw, model, battery) {
        const metadata = raw.deviceParams && typeof raw.deviceParams === 'object' && !Array.isArray(raw.deviceParams) ? raw.deviceParams : {};
        const id = textValue(raw.device_id) || (typeof raw.device_id === 'number' && Number.isFinite(raw.device_id) ? raw.device_id : 'mega');
        const parent = textValue(raw.parent_sn);
        // Retain only the fields this information-only driver can display or pair.
        // In particular, neither the complete inventory nor its transport credentials belong here.
        this.rawDevice = {
            device_sn: raw.device_sn,
            device_name: textValue(raw.device_name) || 'Smart Display E10',
            device_id: id,
            station_sn: parent && parent !== raw.device_sn ? parent : textValue(raw.station_sn) || '',
            device_model: model,
            main_sw_version: textValue(metadata.main_sw_version) || textValue(raw.main_sw_version) || '',
            main_hw_version: textValue(metadata.main_hw_version) || textValue(raw.main_hw_version) || ''
        };
        this._battery = typeof battery === 'string' || typeof battery === 'number' ? battery : undefined;
    }

    getSerial() { return this.rawDevice.device_sn; }
    getName() { return this.rawDevice.device_name; }
    getModel() { return this.rawDevice.device_model; }
    getSoftwareVersion() { return this.rawDevice.main_sw_version; }
    getHardwareVersion() { return this.rawDevice.main_hw_version; }
    getStationSerial() { return this.rawDevice.station_sn; }
    getRawProperty(type) { return type === 8001 ? this._battery : undefined; }
}

function displayFromRecord(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const serial = textValue(raw.device_sn);
    if (!serial) return null;
    let modelCode;
    let battery;
    if (Array.isArray(raw.params)) {
        for (const param of raw.params) {
            if (!param || typeof param !== 'object') continue;
            if (param.param_type === 8006) modelCode = textValue(param.param_value);
            if (param.param_type === 8001) battery = param.param_value;
        }
    }
    const model = textValue(raw.device_model);
    if (model?.toUpperCase() !== 'T87A0' && modelCode?.toUpperCase() !== 'T87A0' && !serial.toUpperCase().startsWith('T87A0')) return null;
    return new MegaDisplayDevice({ ...raw, device_sn: serial }, 'T87A0', battery);
}

class DisplayDiscovery {
    constructor({ now = Date.now, ttlMs = 30000 } = {}) {
        this.now = now;
        this.ttlMs = ttlMs;
        this.clients = new WeakMap();
    }

    stateFor(client) {
        if (!client || (typeof client !== 'object' && typeof client !== 'function')) return null;
        if (!this.clients.has(client)) {
            this.clients.set(client, {
                legacy: [],
                mega: new Map(),
                attempted: false,
                updatedAt: 0,
                pending: null,
                status: { complete: false }
            });
        }
        return this.clients.get(client);
    }

    mergedDevices(state) {
        const devices = new Map();
        for (const device of state.legacy) {
            const serial = device.getSerial();
            if (typeof serial === 'string' && serial) devices.set(serial, device);
        }
        for (const [serial, device] of state.mega) {
            if (!devices.has(serial)) devices.set(serial, device);
        }
        return [...devices.values()];
    }

    async getDevices(client, { refresh = false } = {}) {
        const state = this.stateFor(client);
        if (!state) return [];
        if (state.pending) return state.pending;
        if (!refresh && state.attempted && this.now() - state.updatedAt < this.ttlMs) return this.mergedDevices(state);
        state.pending = this.refreshDevices(client, state).finally(() => {
            state.attempted = true;
            state.updatedAt = this.now();
            state.pending = null;
        });
        return state.pending;
    }

    async getDevice(client, serial, options) {
        const devices = await this.getDevices(client, options);
        const device = devices.find((candidate) => candidate.getSerial() === serial);
        if (!device) throw new Error('Eufy smart display was not found.');
        return device;
    }

    getStatus(client) {
        const state = this.stateFor(client);
        return state ? { ...state.status } : { complete: false, error: discoveryError };
    }

    async refreshDevices(client, state) {
        let legacyComplete = true;
        try {
            const devices = await client.getDevices();
            if (!Array.isArray(devices)) throw new Error();
            state.legacy = devices.filter(isSupportedDisplay);
        } catch (error) {
            legacyComplete = false;
        }

        let complete = true;
        const fresh = new Map();
        try {
            // Reuse only the already-created, authenticated v6 transport. Discovery must
            // never initialize a new transport or start another login/challenge sequence.
            const transition = client.megaTransition;
            const mega = transition?.megaApi;
            if (transition?.megaLoginFailed === true || !mega || typeof mega.hasValidSession !== 'function' || typeof mega.callDecrypted !== 'function' || !mega.hasValidSession()) throw new Error();
            const query = async (path, body, key) => {
                try {
                    const result = await mega.callDecrypted('house', path, body);
                    if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result[key])) throw new Error();
                    return result[key];
                } catch (error) {
                    complete = false;
                    return [];
                }
            };
            const houses = await query(houseListPath, {}, 'house_infos');
            const houseIds = new Set();
            for (const house of houses) {
                const id = house && textValue(house.house_id);
                if (!id) complete = false;
                else houseIds.add(id);
            }
            const bodies = [{}, ...[...houseIds].map((house_id) => ({ house_id }))];
            for (const body of bodies) {
                const records = await query(deviceListPath, body, 'devices');
                for (const raw of records) {
                    const display = displayFromRecord(raw);
                    if (display) fresh.set(display.getSerial(), display);
                }
            }
        } catch (error) {
            complete = false;
        }
        if (complete) state.mega = fresh;
        else for (const [serial, device] of fresh) state.mega.set(serial, device);
        state.status = complete && legacyComplete ? { complete: true } : { complete: false, error: discoveryError };
        return this.mergedDevices(state);
    }
}

module.exports = { DisplayDiscovery };
