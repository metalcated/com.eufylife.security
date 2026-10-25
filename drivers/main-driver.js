'use strict';

const Homey = require('homey');
const { sleep } = require('../lib/utils.js');

module.exports = class mainDriver extends Homey.Driver {
    onInit() {
        this.homey.app.debug(`[Driver] - init: ${this.id} - type: ${this.driverType()}`);

        this.homey.app.setDevices(this.getDevices());
    }

    deviceType() {
        return this.homey.app.deviceTypes.OTHER;
    }

    driverType() {
        return 'devices';
    }

    matchesDevice(device) {
        return this.deviceType().some((model) => device.rawDevice.device_sn.includes(model));
    }

    async getDiscoveryDevices() {
        if (this.driverType() === 'stations') return this.homey.app.eufyClient.getStations();
        return this.homey.app.eufyClient.getDevices();
    }

    discoveryAttempts() {
        return 10;
    }

    backgroundDiscovery() {
        return false;
    }

    isPairingSessionActive(context) {
        return this._eufyPairingSession === context && !context.closed;
    }

    async onPair(session) {
        this.type = 'pair';
        return this.setPairingSession(session);
    }

    async onRepair(session) {
        this.type = 'repair';
        return this.setPairingSession(session);
    }

    async setPairingSession(session) {
        if (this._eufyPairingSession) this._eufyPairingSession.closed = true;
        const context = { type: this.type, closed: false, loadingGeneration: 0, loading: null };
        this._eufyPairingSession = context;
        const active = () => this.isPairingSessionActive(context);
        this.deviceError = false;
        this._devices = [];

        session.setHandler('disconnect', async () => {
            context.closed = true;
            context.loadingGeneration++;
            return true;
        });

        session.setHandler('showView', async (view) => {
            if (!active()) return true;
            if (view !== 'loading') {
                context.loadingGeneration++;
                context.loading = null;
            }
            try {
                this.homey.app.log(`[Driver] ${this.id} - currentView:`, { view, type: context.type, deviceError: this.deviceError });

                if (view === 'login_eufy' && this.id.includes('KEYPAD')) {
                    this.deviceError = this.homey.__('pair.keypad');

                    session.showView('error');
                    return true;
                }

                if (view === 'login_eufy') {
                    this.appSettings = this.homey.app.appSettings;

                    if (this.appSettings && this.appSettings.USERNAME && this.appSettings.PASSWORD) {
                        session.emit('set_user', this.appSettings.USERNAME);
                        session.emit('set_password', this.appSettings.PASSWORD);
                        session.emit('set_region', this.appSettings.REGION);
                    }
                }

                if (view === 'login_eufy' && context.type === 'pair' && !this.deviceError && this.homey.app.eufyClient && this.homey.app.eufyClient.isConnected()) {
                    session.showView('loading');
                    return true;
                }

                if (view === 'login_captcha' && this.homey.app.needCaptcha) {
                    await session.emit('set_captcha', this.homey.app.needCaptcha.captcha);
                }

                if (view === 'error' && this.deviceError) {
                    await session.emit('deviceError', this.deviceError);
                }

                if (view === 'loading') {
                    if (!context.loading) {
                        const generation = context.loadingGeneration;
                        const taskActive = () => active() && context.loadingGeneration === generation;
                        let task;
                        task = this.loadPairingDevices(session, context, taskActive).catch(async (error) => {
                            if (!taskActive()) return [];
                            this.homey.app.error(`[Driver] ${this.id} - Error:`, error);
                            if (this.backgroundDiscovery()) {
                                this.deviceError = this.deviceError || this.homey.__('pair.no_devices');
                                await session.showView('error');
                            }
                            return [];
                        }).finally(() => {
                            if (context.loading === task) context.loading = null;
                        });
                        context.loading = task;
                    }
                    if (this.backgroundDiscovery()) {
                        // Mega discovery may outlast Homey's ten-second pair-view
                        // acknowledgment. Keep that request separate from its work.
                        context.loading.catch((error) => this.homey.app.error(`[Driver] ${this.id} - Error:`, error));
                        return true;
                    }
                    return await context.loading;
                }
            } catch (error) {
                this.homey.app.error(`[Driver] ${this.id} - Error:`, error);
            }
        });

        session.setHandler('login', async (data) => {
            if (!active()) return true;
            const username = data.username;
            const password = data.password;

            const settings = this.homey.app.appSettings;
            const result = await this.homey.app.eufyLogin({ ...settings, USERNAME: username, PASSWORD: password, REGION: data.region });
            if (!active()) return true;

            if (result === false) {
                this.deviceError = this.homey.__('pair.no_data');
                return true;
            }

            return true;
        });

        session.setHandler('login_captcha', async (data) => {
            if (!active()) return true;
            this.homey.app.eufyCaptcha(data.captcha);

            this.deviceError = false;

            return true;
        });

        session.setHandler('pincode', async (data) => {
            if (!active()) return true;
            this.homey.app.eufy2FA(data.join(''));

            this.deviceError = false;

            return true;
        });

        session.setHandler('list_devices', async () => {
            if (!active()) return [];
            try {
                return this._devices;
            } catch (error) {
                this.homey.app.error(`[Driver] ${this.id} - Error:`, error);
                this.deviceError = error;

                session.showView('error');
            }
        });

    }

    async loadPairingDevices(session, context, active) {
        await sleep(3000);
        if (!active()) return [];
        this.homey.app.eufyClient.devicesLoaded = true;

        if (this.homey.app.needCaptcha) {
            this.homey.app.log(`[Driver] ${this.id} - needCaptcha`);
            await session.showView('login_captcha');
            return [];
        }
        if (this.homey.app.need2FA) {
            this.homey.app.log(`[Driver] ${this.id} - need2FA`);
            await session.showView('pincode');
            return [];
        }

        const devices = await this.waitForDiscovery(active);
        if (!active()) return [];
        this.deviceList = devices;

        if (devices.length) {
            const pairedDevices = await this.onDeviceListRequest(this.id);
            if (!active()) return [];
            this._devices = pairedDevices;
            this.homey.app.log(`[Driver] ${this.id} - Found new devices:`, this._devices);

            if (context.type === 'repair') {
                this.homey.app.initDevices();
                this.homey.app.log(`[Driver] ${this.id} - list_devices: repair mode -> Closing repair`);
                return session.showView('done');
            } else if (this._devices && this._devices.length) {
                await session.showView('list_devices');
            } else if (this.homey.app.eufyClientError) {
                this.deviceError = this.homey.app.eufyClientError;
                this.homey.app.eufyClientError = false;
                await session.showView('error');
            } else if (this._devices && !!this._devices.info) {
                this.deviceError = this._devices.info;
                await session.showView('error');
            } else {
                this.deviceError = this.homey.__('pair.no_devices');
                await session.showView('error');
            }
            return true;
        }

        if (this.homey.app.eufyClientError) {
            this.deviceError = this.homey.app.eufyClientError;
            this.homey.app.eufyClientError = false;
        } else {
            this.deviceError = this.deviceError || (context.type === 'repair' ? this.homey.__('pair.no_devices_repair') : this.homey.__('pair.no_devices'));
        }
        await session.showView('error');
        return [];
    }

    async waitForDiscovery(active) {
        const retry = this.discoveryAttempts();
        for (let i = 1; i <= retry; i++) {
            if (!active()) return [];
            this.homey.app.log(`[Driver] ${this.id} - eufyDeviceData - try: ${i}`);
            await sleep(1000);
            if (!active()) return [];
            const devices = await this.getDiscoveryDevices({ isActive: active });
            if (!active()) return [];
            if (devices.length) return devices;
        }
        return [];
    }

    // ---------------------------------------AUTO COMPLETE HELPERS----------------------------------------------------------
    async onDeviceListRequest(driverId) {
        try {
            const deviceList = await this.homey.app.deviceList;
            const pairedDevicesArray = deviceList.map((device) => {
                const data = device.getData();

                return data.device_sn;
            });

            this.homey.app.log(`[Driver] [onDeviceListRequest] ${driverId} - pairedDevicesArray`, pairedDevicesArray);

            const results = this.deviceList
                .filter((device) => !pairedDevicesArray.includes(device.rawDevice.device_sn))
                .filter((device) => this.matchesDevice(device))
                .map((d, i) => ({
                    name: d.rawDevice.device_name,
                    data: {
                        name: d.rawDevice.device_name,
                        index: i,
                        id: `${d.rawDevice.device_sn}-${d.rawDevice.device_id}`,
                        station_sn: d.rawDevice.station_sn,
                        device_sn: d.rawDevice.device_sn
                    },
                    settings: { STATION_SN: d.rawDevice.station_sn }
                }));

            this.homey.app.log(`[Driver] [onDeviceListRequest] ${driverId} - Found devices - `, results);

            return Promise.resolve(results);
        } catch (e) {
            this.homey.app.error('Error when trying to connect new device', e);

            if (typeof e === 'object') {
                return Promise.reject(JSON.stringify(e));
            }
        }
    }
};
