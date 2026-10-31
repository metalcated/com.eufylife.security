'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { normalizeRemoteLines } = require('../lib/utils');

function harness(options = {}) {
    const filename = path.resolve(__dirname, '../app.js');
    const fetched = [], attempts = [], delivered = [], saved = [], logs = [];
    const module = { exports: {} };
    const unusedHelper = class { constructor() { assert.fail('Notifications must not initialize device or media helpers'); } };
    const stubs = {
        homey: { App: class {}, manifest: { id: 'com.eufylife.security', version: 'test' } },
        'eufy-security-client': { EufySecurity: {}, LogLevel: {}, PhoneModels: {} },
        './constants/device_types.js': { DEVICE_TYPES: {} },
        './lib/flow/actions.js': {},
        './lib/flow/conditions.js': {},
        './lib/flow/triggers.js': {},
        './lib/helpers/eufy-events.helper': unusedHelper,
        './lib/helpers/camera-media.helper': unusedHelper,
        './lib/helpers/camera-stream-limit.helper': require('../lib/helpers/camera-stream-limit.helper'),
        './lib/helpers/eufy-logger.helper': {},
        './lib/display-discovery': { DisplayDiscovery: unusedHelper },
        './lib/utils': {
            normalizeRemoteLines,
            async fetchRemoteText(file) {
                fetched.push(file);
                if (options.fetch) return options.fetch(file);
                assert.equal(file, 'notifications.txt', 'Broadcast warning text must not be fetched');
                return options.text || '';
            },
            sleep: () => assert.fail('Notification tests must not start connection timers'),
            randomNumber: () => assert.fail('Notification tests must not initialize a client')
        }
    };
    const factory = vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory((request) => {
        assert.ok(Object.hasOwn(stubs, request), `Unexpected notification dependency: ${request}`);
        return stubs[request];
    }, module, module.exports, filename, path.dirname(filename));
    const app = new module.exports();
    for (const name of ['trace', 'debug', 'info', 'log', 'warn', 'error', 'fatal']) app[name] = (...args) => logs.push([name, ...args]);
    app.appSettings = { REGION: 'US', NOTIFICATIONS: options.ids === undefined ? [] : options.ids,
        customSetting: { preserved: true } };
    app.eufyClient = new EventEmitter();
    app.need2FA = null;
    app.needCaptcha = null;
    app.homey = {
        app,
        settings: { set(key, value) { saved.push({ key, value: JSON.parse(JSON.stringify(value)) }); } },
        notifications: { async createNotification(notification) {
            attempts.push({ ...notification });
            if (options.deliver) await options.deliver(notification, attempts.length);
            delivered.push({ ...notification });
        } }
    };
    return { app, fetched, attempts, delivered, saved, logs };
}

test('remote notices fetch only notifications.txt and persist new IDs once without changing other settings', async () => {
    const originalIds = ['already-sent', 'keep-this-id'];
    const h = harness({ ids: originalIds, text: `
        # Notices already acknowledged remain skipped.
        already-sent | Old notice
        new-one | First new notice
        new-one | Duplicate ID must stay skipped
        invalid line without a separator
        | Missing ID
        missing-message |
        new-two | Message with a | separator
    ` });
    await h.app.sendNotifications();
    assert.deepEqual(h.fetched, ['notifications.txt']);
    assert.deepEqual(h.delivered, [{ excerpt: 'First new notice' }, { excerpt: 'Message with a | separator' }]);
    assert.deepEqual(originalIds, ['already-sent', 'keep-this-id']);
    assert.deepEqual(h.app.appSettings, { REGION: 'US', NOTIFICATIONS: ['already-sent', 'keep-this-id', 'new-one', 'new-two'],
        customSetting: { preserved: true } });
    assert.deepEqual(h.saved, [{ key: 'com.eufylife.security.settings', value: h.app.appSettings }]);

    await h.app.sendNotifications();
    assert.deepEqual(h.fetched, ['notifications.txt', 'notifications.txt']);
    assert.equal(h.attempts.length, 2);
    assert.equal(h.saved.length, 1);
});

test('an empty remote notice list does not overwrite saved acknowledgments', async () => {
    const h = harness({ ids: ['existing'], text: '# Nothing new\n\ninvalid\n|no id\nno-message|\n' });
    await h.app.sendNotifications();
    assert.deepEqual(h.fetched, ['notifications.txt']);
    assert.deepEqual(h.app.appSettings.NOTIFICATIONS, ['existing']);
    assert.equal(h.attempts.length, 0);
    assert.equal(h.saved.length, 0);
});

test('older settings without an acknowledgment array can record a successfully delivered notice', async () => {
    const h = harness({ ids: null, text: 'new-id | Available update' });
    await h.app.sendNotifications();
    assert.deepEqual(h.fetched, ['notifications.txt']);
    assert.deepEqual(h.delivered, [{ excerpt: 'Available update' }]);
    assert.deepEqual(h.app.appSettings.NOTIFICATIONS, ['new-id']);
    assert.equal(h.saved.length, 1);
});

test('failed notification delivery never acknowledges unsent IDs and a later retry can deliver them', async () => {
    let fail = true;
    const h = harness({ ids: ['existing'], text: 'first | First notice\nsecond | Second notice',
        deliver: async () => { if (fail) throw Error('Fixture notification failure'); } });
    await h.app.sendNotifications();
    assert.deepEqual(h.fetched, ['notifications.txt']);
    assert.deepEqual(h.attempts, [{ excerpt: 'First notice' }]);
    assert.equal(h.delivered.length, 0);
    assert.equal(h.saved.length, 0);
    assert.deepEqual(h.app.appSettings.NOTIFICATIONS, ['existing']);

    fail = false;
    await h.app.sendNotifications();
    assert.deepEqual(h.delivered, [{ excerpt: 'First notice' }, { excerpt: 'Second notice' }]);
    assert.deepEqual(h.app.appSettings.NOTIFICATIONS, ['existing', 'first', 'second']);
    assert.equal(h.saved.length, 1);
});

test('failed remote notice retrieval leaves notification acknowledgments untouched', async () => {
    const h = harness({ ids: ['existing'], fetch: async () => { throw Error('Fixture fetch failure'); } });
    await h.app.sendNotifications();
    assert.deepEqual(h.fetched, ['notifications.txt']);
    assert.deepEqual(h.app.appSettings.NOTIFICATIONS, ['existing']);
    assert.equal(h.attempts.length, 0);
    assert.equal(h.saved.length, 0);
});

test('actual two-factor and CAPTCHA handlers notify once per pending challenge and can notify for a new challenge', async () => {
    const h = harness({ ids: ['existing-notice'] });
    const loginOptions = [];
    let persistentWrites = 0;
    h.app.checkLogin = async (options) => { loginOptions.push(options); return true; };
    h.app.eufyClient.writePersistentData = () => { persistentWrites++; };
    h.app.connectEufyClientHandlers();

    h.app.eufyClient.emit('tfa request');
    h.app.eufyClient.emit('tfa request');
    h.app.eufyClient.emit('captcha request', 'first-challenge', 'first-image');
    h.app.eufyClient.emit('captcha request', 'current-challenge', 'current-image');
    await new Promise(setImmediate);
    assert.equal(h.app.need2FA, true);
    assert.deepEqual(h.app.needCaptcha, { id: 'current-challenge', captcha: 'current-image' });
    assert.deepEqual(h.delivered, [{ excerpt: 'Eufy Security - 2FA required' }, { excerpt: 'Eufy Security - Captcha required' }]);
    assert.deepEqual(h.fetched, []);
    assert.deepEqual(h.app.appSettings.NOTIFICATIONS, ['existing-notice']);

    assert.equal(await h.app.eufy2FA('fixture-code'), true);
    assert.equal(await h.app.eufyCaptcha('fixture-answer'), true);
    assert.equal(h.app.need2FA, null);
    assert.equal(h.app.needCaptcha, null);
    assert.deepEqual(loginOptions, [{ verifyCode: 'fixture-code' }, { captcha: { captchaCode: 'fixture-answer', captchaId: 'current-challenge' } }]);
    assert.equal(persistentWrites, 2);

    h.app.eufyClient.emit('tfa request');
    h.app.eufyClient.emit('captcha request', 'new-challenge', 'new-image');
    await new Promise(setImmediate);
    assert.deepEqual(h.delivered.slice(2), [{ excerpt: 'Eufy Security - 2FA required' }, { excerpt: 'Eufy Security - Captcha required' }]);
    assert.equal(h.saved.length, 0);
});
