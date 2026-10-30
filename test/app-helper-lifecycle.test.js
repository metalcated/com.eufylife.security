'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

function appFixture() {
    const filename = path.resolve(__dirname, '../app.js'), module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require,module,exports){\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(name => name === 'homey' ? { App: class {}, manifest: { id: 'com.eufylife.security' } } : {}, module, module.exports);
    const app = new module.exports(), calls = [];
    app.warn = () => calls.push('warn');
    app.eufyEventsHelper = { dispose: () => calls.push('events') };
    app.eufyClient = { close: () => calls.push('client') };
    app.deviceList = [{ getName: () => 'Fixture', setUnavailable: () => calls.push('unavailable') }];
    app.homey = { __: () => 'Initializing' };
    return { app, calls };
}

test('an unavailable media helper cannot block the existing Eufy account reconnect workflow', async () => {
    const h = appFixture();
    h.app.FfmpegManager = { async reset() { h.calls.push('reset'); throw Object.assign(Error('unavailable'), { cameraHelper: true }); } };
    await h.app.resetEufyClient();
    assert.deepEqual(h.calls.filter(name => name !== 'warn'), ['events', 'reset', 'client', 'unavailable']);
    assert.equal(h.app.deviceList[0]._started, false);
});

test('unrelated media failures retain their existing account reset failure behavior', async () => {
    const h = appFixture(), failure = Error('Local cleanup failed');
    h.app.FfmpegManager = { async reset() { throw failure; } };
    await assert.rejects(h.app.resetEufyClient(), error => error === failure);
    assert.equal(h.calls.includes('client'), false);
});

test('shutdown closes the account and attempts local media cleanup even when the browser wall fails', async () => {
    const h = appFixture(), failure = Error('Wall cleanup failed');
    h.app.cameraWall = { async dispose() { h.calls.push('wall'); throw failure; } };
    h.app.FfmpegManager = { async dispose() { h.calls.push('media'); } };
    await assert.rejects(h.app.onUninit(), error => error === failure);
    assert.deepEqual(h.calls, ['events', 'wall', 'media', 'client']);
});
