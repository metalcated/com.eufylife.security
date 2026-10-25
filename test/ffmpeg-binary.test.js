'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const vm = require('node:vm');
const zlib = require('node:zlib');
const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 2000 }, fn);
const filename = path.resolve(__dirname, '../lib/helpers/ffmpeg-binary.helper.js');
const binary = Buffer.from('fixture ffmpeg binary bytes');
const archive = zlib.gzipSync(binary);

// Exercise real HTTP-response/decompression/writable stream behavior with only
// network requests, filesystem operations and the clock replaced. No file or
// executable is created, no process is spawned, and no account is contacted.
function harness(options = {}) {
    const events = [];
    const requests = [];
    const outputs = [];
    const files = new Map(options.files || []);
    const timers = new Map();
    let failWrites = options.failWrites || 0;

    class DownloadFile extends Writable {
        constructor(destination) {
            super();
            this.destination = destination;
            this.chunks = [];
        }
        _construct(callback) {
            queueMicrotask(() => {
                if (options.openError) return callback(new Error('Open denied'));
                files.set(this.destination, this);
                events.push(['open', this.destination]);
                this.emit('open', 123);
                callback();
            });
        }
        _write(chunk, encoding, callback) {
            if (failWrites > 0) {
                failWrites--;
                callback(new Error('Disk full'));
            } else {
                this.chunks.push(Buffer.from(chunk));
                callback();
            }
        }
        get contents() { return Buffer.concat(this.chunks); }
    }

    const fakeFs = {
        constants: { X_OK: 1 },
        createWriteStream(destination) {
            events.push(['create', destination]);
            const output = new DownloadFile(destination);
            outputs.push(output);
            return output;
        },
        promises: {
            async unlink(destination) {
                const output = files.get(destination);
                assert.ok(output?.closed, 'cleanup must wait until the owned output is closed');
                events.push(['unlink', destination]);
                files.delete(destination);
            }
        },
        accessSync(destination) {
            if (!files.has(destination)) throw new Error('Not found');
        },
        mkdirSync(destination, settings) { events.push(['mkdir', destination, settings]); },
        renameSync(from, to) {
            const output = files.get(from);
            assert.ok(output?.closed, 'a completed temporary file must close before promotion');
            events.push(['rename', from, to]);
            files.set(to, output);
            files.delete(from);
        },
        chmodSync(destination, mode) { events.push(['chmod', destination, mode]); }
    };

    const https = {
        get(address, settings, callback) {
            const request = new EventEmitter();
            const index = requests.length;
            const route = typeof options.route === 'function' ? options.route(index) : options.routes?.[index] || { status: 200, body: archive };
            const entry = { url: String(address), settings, request, response: null, deliver: callback };
            requests.push(entry);
            events.push(['request', entry.url]);
            request.destroyed = false;
            request.destroy = (error) => {
                if (request.destroyed) return request;
                request.destroyed = true;
                settings.signal.removeEventListener('abort', onAbort);
                entry.response?.destroy(error);
                if (error) queueMicrotask(() => request.emit('error', error));
                return request;
            };
            const onAbort = () => request.destroy(settings.signal.reason);
            settings.signal.addEventListener('abort', onAbort, { once: true });
            queueMicrotask(() => {
                if (settings.signal.aborted) return onAbort();
                if (route.error) return request.emit('error', new Error(route.error));
                if (route.hangHeaders) return;
                const response = entry.response = new PassThrough();
                response.statusCode = route.status || 200;
                response.headers = route.location ? { location: route.location } : {};
                response.once('close', () => settings.signal.removeEventListener('abort', onAbort));
                events.push(['response', response.statusCode]);
                callback(response);
                if (route.responseError) {
                    setImmediate(() => response.destroy(new Error(route.responseError)));
                } else if (!route.hangBody && !response.destroyed) {
                    response.end(route.body || Buffer.alloc(0));
                }
            });
            return request;
        }
    };

    const nativeRequire = require;
    const localRequire = (name) => {
        if (name === 'fs') return fakeFs;
        if (name === 'https') return https;
        if (name === 'os') return { platform: () => options.platform || 'linux', arch: () => options.arch || 'x64' };
        if (name === 'child_process') return { spawnSync(destination, args, settings) {
            events.push(['execute', destination, args, settings]);
            return { status: options.executableStatus ?? 0 };
        } };
        return nativeRequire(name);
    };
    const module = { exports: {} };
    const factory = vm.runInThisContext(`(function(require, module, __filename, __dirname, setTimeout, clearTimeout) {\n${fs.readFileSync(filename, 'utf8')}\n})`, { filename });
    factory(localRequire, module, filename, path.dirname(filename), (callback, delay) => {
        const timer = { callback, delay, unref() {} };
        timers.set(timer, timer);
        return timer;
    }, (timer) => timers.delete(timer));
    const resolver = new module.exports({ app: { log: () => {}, error: () => {} } });
    return { resolver, requests, outputs, files, events, timers };
}

const tick = () => new Promise(setImmediate);
const temporary = '/userdata/bin/ffmpeg-linux-x64.download';
const origin = 'https://github.example/releases/ffmpeg.gz';

test('redirects resolve before one temporary file opens and relative locations remain supported', async () => {
    const h = harness({ routes: [
        { status: 301, location: '/download' },
        { status: 307, location: 'https://cdn.example/ffmpeg.gz' },
        { status: 200, body: archive }
    ] });
    await h.resolver.download(origin, temporary);
    assert.deepEqual(h.requests.map((entry) => entry.url), [origin, 'https://github.example/download', 'https://cdn.example/ffmpeg.gz']);
    assert.equal(h.outputs.length, 1);
    assert.deepEqual(h.outputs[0].contents, binary);
    assert.equal(h.outputs[0].closed, true);
    assert.equal(h.events.filter(([name]) => name === 'unlink').length, 0);
    assert.ok(h.events.findIndex(([name]) => name === 'create') > h.events.findLastIndex(([name]) => name === 'response'));
    assert.equal(h.requests.every((entry) => entry.settings.signal === h.requests[0].settings.signal), true);
    assert.equal(h.requests[0].response.destroyed, true);
    assert.equal(h.requests[1].response.destroyed, true);
    assert.equal(h.timers.size, 0);
});

test('download promotion keeps the pinned release, cache path and executable verification', async () => {
    const h = harness();
    const result = await h.resolver.downloadBinary({ platform: 'linux', arch: 'x64' });
    assert.equal(result, '/userdata/bin/ffmpeg-linux-x64');
    assert.equal(h.requests[0].url, 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-x64.gz');
    assert.deepEqual(h.events.find(([name]) => name === 'rename'), ['rename', temporary, result]);
    assert.deepEqual(h.events.find(([name]) => name === 'chmod'), ['chmod', result, 0o755]);
    assert.deepEqual(h.events.find(([name]) => name === 'execute'), ['execute', result, ['-version'], { timeout: 5000 }]);
    assert.deepEqual(h.files.get(result).contents, binary);
    assert.equal(h.files.has(temporary), false);
});

test('a cached executable is reused without downloads or filesystem changes', async () => {
    const cached = '/userdata/bin/ffmpeg-linux-x64';
    const h = harness({ files: [[cached, Buffer.from('existing executable')]] });
    assert.equal(await h.resolver.resolve(), cached);
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.events.map(([name]) => name), ['execute']);
});

test('a runnable bundled ARM binary still wins over network fallback', async () => {
    const bundled = path.resolve(path.dirname(filename), '../../bin/ffmpeg-arm64');
    const h = harness({ arch: 'arm64', files: [[bundled, Buffer.from('bundled executable')]] });
    assert.equal(await h.resolver.resolve(), bundled);
    assert.equal(h.requests.length, 0);
});

test('redirect limits, HTTPS-only redirects and failed HTTP status do not create a file', async (t) => {
    for (const [name, options, expected, limit] of [
        ['redirect limit', { route: () => ({ status: 302, location: '/again' }) }, /Too many redirects/, 1],
        ['invalid redirect protocol', { routes: [{ status: 302, location: 'http://cdn.example/ffmpeg.gz' }] }, /HTTPS/],
        ['HTTP failure', { routes: [{ status: 503 }] }, /HTTP 503/],
        ['missing redirect location', { routes: [{ status: 302 }] }, /HTTP 302/]
    ]) {
        await t.test(name, async () => {
            const h = harness(options);
            await assert.rejects(h.resolver.download(origin, temporary, limit), expected);
            assert.equal(h.outputs.length, 0);
            assert.equal(h.events.some(([event]) => event === 'unlink'), false);
            assert.equal(h.timers.size, 0);
        });
    }
});

test('network failure before a response cannot remove an existing cached binary', async () => {
    const cached = '/userdata/bin/ffmpeg-linux-x64';
    const existing = Buffer.from('existing binary');
    const h = harness({ routes: [{ error: 'Connection failed' }], files: [[cached, existing]] });
    await assert.rejects(h.resolver.download(origin, temporary), /Connection failed/);
    assert.equal(h.files.get(cached), existing);
    assert.equal(h.outputs.length, 0);
    assert.equal(h.timers.size, 0);
});

test('corrupt gzip and response abort close and clean only the owned temporary file', async (t) => {
    for (const [name, route, expected] of [
        ['corrupt gzip', { status: 200, body: Buffer.from('not gzip') }, /header|compression|gzip|data/i],
        ['aborted body', { status: 200, responseError: 'Response aborted' }, /Response aborted/]
    ]) {
        await t.test(name, async () => {
            const h = harness({ routes: [route] });
            await assert.rejects(h.resolver.download(origin, temporary), expected);
            assert.equal(h.outputs[0].closed, true);
            assert.equal(h.files.has(temporary), false);
            assert.deepEqual(h.events.filter(([event]) => event === 'unlink'), [['unlink', temporary]]);
            assert.equal(h.timers.size, 0);
        });
    }
});

test('a failed write cleans up before retry reuses the temporary path', async () => {
    const h = harness({ failWrites: 1 });
    await assert.rejects(h.resolver.download(origin, temporary), /Disk full/);
    assert.equal(h.outputs[0].closed, true);
    assert.equal(h.files.has(temporary), false);
    await h.resolver.download(origin, temporary);
    assert.equal(h.outputs.length, 2);
    assert.deepEqual(h.outputs[1].contents, binary);
    const secondOpen = h.events.findLastIndex(([event]) => event === 'open');
    assert.ok(h.events.findIndex(([event]) => event === 'unlink') < secondOpen);
    assert.equal(h.events.filter(([event]) => event === 'unlink').length, 1);
});

test('an output that never opened is not unlinked after permission failure', async () => {
    const h = harness({ openError: true });
    await assert.rejects(h.resolver.download(origin, temporary), /Open denied/);
    assert.equal(h.events.some(([event]) => event === 'unlink'), false);
    assert.equal(h.timers.size, 0);
});

test('one deadline aborts stalled headers or body and settles the download once', async (t) => {
    for (const [name, route] of [
        ['headers', { hangHeaders: true }],
        ['body', { status: 200, hangBody: true }]
    ]) {
        await t.test(name, async () => {
            const h = harness({ routes: [route] });
            let settled = 0;
            const pending = h.resolver.download(origin, temporary).finally(() => { settled++; });
            const rejected = assert.rejects(pending, /Timed out/);
            await tick();
            assert.equal(h.timers.size, 1);
            const timer = [...h.timers.values()][0];
            assert.equal(timer.delay, 60000);
            timer.callback();
            await rejected;
            await tick();
            assert.equal(settled, 1);
            assert.equal(h.requests[0].request.destroyed, true);
            assert.equal(h.files.has(temporary), false);
            assert.equal(h.timers.size, 0);
            if (name === 'body') assert.equal(h.outputs[0].closed, true);
        });
    }
});

test('an unusable downloaded executable still fails verification after promotion', async () => {
    const h = harness({ executableStatus: 1 });
    await assert.rejects(h.resolver.downloadBinary({ platform: 'linux', arch: 'x64' }), /not runnable/);
    assert.equal(h.events.some(([event]) => event === 'execute'), true);
});

test('a late response after timeout cannot reopen a file or keep its response stream alive', async () => {
    const h = harness({ routes: [{ hangHeaders: true }] });
    const rejected = assert.rejects(h.resolver.download(origin, temporary), /Timed out/);
    await tick();
    [...h.timers.values()][0].callback();
    await rejected;
    const response = new PassThrough();
    response.statusCode = 200;
    response.headers = {};
    h.requests[0].deliver(response);
    await tick();
    assert.equal(response.destroyed, true);
    assert.equal(h.outputs.length, 0);
    assert.equal(h.timers.size, 0);
});
