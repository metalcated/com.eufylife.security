'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '../settings/camera-wall.js'), 'utf8');
const stylesheet = fs.readFileSync(path.join(__dirname, '../settings/camera-wall.css'), 'utf8');
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(setImmediate); };

// A small browser fixture executes the actual page script against the actual
// HTML. It intentionally supplies no browser storage, prompts, real cameras,
// API credentials or network. Timers and bridge callbacks are controlled below.
function page(options = {}) {
  let document;
  let nextTimer = 0;
  const timers = new Map();
  const peers = [];
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, callback) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    emit(type, detail = {}) {
      const event = { type, target: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...detail };
      for (const callback of [...(this.listeners.get(type) || [])]) callback(event);
      return event;
    }
  }
  const matches = (node, selector) => selector.split(',').some((part) => {
    part = part.trim();
    if (part.includes(':not(:disabled)') && node.disabled) return false;
    part = part.replace(':not(:disabled)', '');
    const tag = /^[\w-]+/.exec(part)?.[0];
    if (tag && node.tagName !== tag.toUpperCase()) return false;
    const id = /#([\w-]+)/.exec(part)?.[1];
    if (id && node.id !== id) return false;
    for (const item of part.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(item[1])) return false;
    for (const item of part.matchAll(/\[([^=\]]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
      if (!node.hasAttribute(item[1])) return false;
      if (item[2] !== undefined && node.getAttribute(item[1]) !== item[2]) return false;
    }
    return true;
  });
  class Element extends Target {
    constructor(tag) {
      super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentElement = null;
      this.attributes = new Map(); this.dataset = {}; this._text = ''; this.value = ''; this.checked = false;
      this.classList = {
        contains: (name) => this.className.split(/\s+/).includes(name),
        add: (name) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), name])].join(' '); },
        remove: (name) => { this.className = this.className.split(/\s+/).filter((value) => value !== name).join(' '); },
      };
      if (tag === 'template') this.content = new Element('fragment');
      if (tag === 'video') { this.play = async () => {}; this.pause = () => {}; }
    }
    get id() { return this.getAttribute('id') || ''; }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get hidden() { return this.hasAttribute('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get disabled() { return this.hasAttribute('disabled'); }
    set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
    get inert() { return this.hasAttribute('inert'); }
    set inert(value) { if (value) this.setAttribute('inert', ''); else this.removeAttribute('inert'); }
    get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.replaceChildren(); }
    get firstElementChild() { return this.children[0] || null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    remove() {
      if (!this.parentElement) return;
      const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null;
    }
    replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (matches(node, selector)) return node; return null; }
    cloneNode(deep) {
      const copy = new Element(this.tagName.toLowerCase()); copy.attributes = new Map(this.attributes); copy._text = this._text;
      if (deep) copy.append(...this.children.map((child) => child.cloneNode(true)));
      return copy;
    }
    focus() { document.activeElement = this; }
    click() { if (!this.disabled) { this.focus(); this.emit('click'); } }
  }
  document = new Target();
  const root = new Element('document');
  const stack = [root];
  for (const token of html.replace(/<!--[\s\S]*?-->/g, '').match(/<[^>]+>|[^<]+/g)) {
    if (/^<!/.test(token)) continue;
    if (/^<\//.test(token)) { stack.pop(); continue; }
    if (!token.startsWith('<')) { stack.at(-1)._text += token; continue; }
    const tag = /^<([\w-]+)/.exec(token)?.[1];
    if (!tag) continue;
    const node = new Element(tag);
    for (const attr of token.slice(tag.length + 1, -1).matchAll(/([^\s=/>]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) {
      node.setAttribute(attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '');
    }
    stack.at(-1).append(node);
    if (!/^(meta|link|input|br|hr|img)$/.test(tag) && !token.endsWith('/>')) stack.push(node.content || node);
  }
  document.body = root.querySelector('body'); document.activeElement = document.body; document.hidden = false;
  document.getElementById = (id) => root.querySelector(`#${id}`);
  document.createElement = (tag) => new Element(tag);
  const window = new Target();
  class Peer extends Target {
    constructor() { super(); this.iceGatheringState = 'complete'; this.closed = 0; peers.push(this); }
    addTransceiver() {}
    async createOffer() { return { type: 'offer', sdp: 'fixture-offer' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription(value) { this.remoteDescription = value; }
    close() { this.closed++; }
  }
  class Stream {
    constructor() { this.tracks = []; }
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
  }
  window.RTCPeerConnection = Peer; window.MediaStream = Stream;
  const calls = [], writes = [], hooks = [], events = new Map();
  const backend = { maxStreams: options.limit === undefined ? 4 : options.limit, saved: options.saved ?? false,
    applyStatus: options.applyStatus || 'applied', configured: options.configured ?? false,
    selection: options.selection === undefined ? undefined : [...options.selection],
    cameras: Array.from({ length: options.cameras ?? 8 }, (_, i) => ({ id: `camera-${i + 1}`, name: `Camera ${i + 1}`, available: true, videoRegistered: true,
      ...(options.native?.includes(i + 1) ? { usesStreamLimit: false } : {}) })) };
  const settings = () => ({ maxStreams: backend.maxStreams, defaultMaxStreams: 4, saved: backend.saved, applyStatus: backend.applyStatus, message: 'Fixed server message.' });
  const Homey = {
    ready() {},
    on(name, callback) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(callback); },
    get(name, callback) { assert.equal(name, 'camera_wall_selection'); callback(null, clone(backend.selection)); },
    set(name, value, callback) { writes.push({ name, value: clone(value) }); backend.selection = clone(value); callback(null); },
    api(method, route, body, callback) {
      const request = { method, route, body: clone(body), callback }; calls.push(request);
      const hook = hooks.findIndex((entry) => entry.method === method && entry.route === route);
      if (hook !== -1) { const [entry] = hooks.splice(hook, 1); entry.request = request; return; }
      if (method === 'GET' && route === '/camera-settings') return callback(null, settings());
      if (method === 'PUT' && route === '/camera-settings') {
        backend.maxStreams = body.maxStreams; backend.saved = true; return callback(null, settings());
      }
      if (method === 'GET' && route === '/camera-wall') return callback(null, { configured: backend.configured, maxViews: backend.maxStreams, cameras: clone(backend.cameras) });
      if (method === 'POST' && route === '/camera-wall/configure') { backend.configured = true; return callback(null, { configured: true }); }
      if (route.endsWith('/offer')) return callback(null, { handle: 'fixture-handle', answerSdp: 'fixture-answer' });
      if (route.endsWith('/stop') || route.endsWith('/keepalive')) return callback(null, {});
      throw Error(`Unexpected route ${method} ${route}`);
    },
  };
  const context = { window, document, RTCPeerConnection: Peer, MediaStream: Stream, console,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    prompt() { throw Error('Browser prompt is forbidden'); }, alert() { throw Error('Browser alert is forbidden'); }, confirm() { throw Error('Browser confirm is forbidden'); },
  };
  Object.defineProperty(context, 'localStorage', { get() { throw Error('Browser storage is forbidden'); } });
  Object.defineProperty(window, 'localStorage', { get() { throw Error('Browser storage is forbidden'); } });
  vm.runInNewContext(source, context, { filename: 'camera-wall.js' });
  window.onHomeyReady(Homey);
  const get = (id) => document.getElementById(id);
  return { backend, window, document, peers, calls, writes, timers, get, settings,
    async open() { get('setup-button').click(); await flush(); },
    input(value) { get('stream-limit').value = value; get('stream-limit').emit('input'); },
    async save() { get('camera-settings-form').emit('submit'); await flush(); },
    hold(method, route) { const hook = { method, route, request: null }; hooks.push(hook); return hook; },
    event(name, payload) { for (const callback of events.get(name) || []) callback(payload); },
    run(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay && timers.delete(id)) timer.callback(); },
    dispose() { window.emit('pagehide', { persisted: false }); },
  };
}

async function ready(t, options) { const p = page(options); t.after(() => p.dispose()); await flush(); return p; }

test('page styling stays inside its owned body boundary, including dark, mobile and form controls', async (t) => {
  const p = await ready(t);
  assert.equal(p.document.body.id, 'eufy-camera-wall-page');
  const selectors = [], declarations = new Map();
  const rules = (css) => {
    let cursor = 0;
    while (cursor < css.length) {
      const opening = css.indexOf('{', cursor);
      if (opening < 0) break;
      const selector = css.slice(cursor, opening).trim();
      let closing = opening + 1, depth = 1;
      while (closing < css.length && depth) {
        if (css[closing] === '{') depth++;
        else if (css[closing] === '}') depth--;
        closing++;
      }
      assert.equal(depth, 0, 'stylesheet rules must close');
      if (selector.startsWith('@media')) rules(css.slice(opening + 1, closing - 1));
      else for (const value of selector.split(',').map((item) => item.trim())) {
        selectors.push(value); declarations.set(value, css.slice(opening + 1, closing - 1));
      }
      cursor = closing;
    }
  };
  rules(stylesheet.replace(/\/\*[\s\S]*?\*\//g, ''));
  assert.ok(selectors.length > 80, 'check the full stylesheet, including media queries');
  for (const selector of selectors) assert.match(selector, /^body#eufy-camera-wall-page(?:\s|\.|$)/, selector);
  for (const control of ['.button-primary', '.button-icon svg', '.settings-switch', '.settings-switch[aria-checked="true"]', 'label', '.settings-input']) {
    assert.ok(selectors.includes(`body#eufy-camera-wall-page ${control}`), `missing bridge-resistant control style: ${control}`);
  }
  const scrollLock = selectors.find((selector) => selector.endsWith('.modal-open'));
  assert.equal(scrollLock, 'body#eufy-camera-wall-page.modal-open');
  assert.match(declarations.get(scrollLock), /overflow:\s*hidden\s*;/);
  assert.equal(p.document.body.closest(scrollLock), null);
  await p.open();
  assert.equal(p.document.body.closest(scrollLock), p.document.body, 'the scroll lock selector must match the actual body class');
  p.get('cancel-camera-settings').click();
  assert.equal(p.document.body.closest(scrollLock), null, 'closing restores body scrolling');
});

test('camera settings use Homey authentication without the separate wall API key; save, reopen and cancel use shared values', async (t) => {
  const p = await ready(t, { configured: false });
  assert.equal(p.get('setup-notice').hidden, false);
  assert.equal(p.get('play-selected').disabled, true);
  await p.open();
  assert.equal(p.get('stream-limit').value, '4');
  assert.match(p.get('camera-settings-status').textContent, /default/);
  p.input('9'); await p.save();
  assert.deepEqual(p.calls.find((call) => call.method === 'PUT').body, { maxStreams: 9 });
  assert.equal(p.get('camera-settings-modal').hidden, true);
  assert.match(p.get('page-message').textContent, /web, iOS and Android/);
  assert.equal(p.backend.configured, false);
  assert.equal(p.calls.some((call) => call.route === '/camera-wall/configure'), false);
  await p.open(); assert.equal(p.get('stream-limit').value, '9');
  p.input('12'); p.get('cancel-camera-settings').click();
  await p.open(); assert.equal(p.get('stream-limit').value, '9');
  assert.equal(p.calls.filter((call) => call.method === 'PUT').length, 1);
});

test('No limit saves null and allows all cameras without the former four-camera cap', async (t) => {
  const p = await ready(t, { limit: 6, cameras: 11 });
  assert.equal(p.get('camera-grid').children.length, 6);
  assert.equal(p.get('camera-options').querySelectorAll('input').filter((input) => input.disabled).length, 5);
  await p.open(); p.get('stream-no-limit').click();
  assert.equal(p.get('stream-limit').disabled, true);
  await p.save();
  assert.equal(p.backend.maxStreams, null);
  assert.deepEqual(p.calls.find((call) => call.method === 'PUT').body, { maxStreams: null });
  for (const input of p.get('camera-options').querySelectorAll('input')) {
    assert.equal(input.disabled, false); input.checked = true; input.emit('change');
  }
  await flush();
  assert.equal(p.get('camera-grid').children.length, 11);
  assert.equal(p.writes.at(-1).value.length, 11);
  await p.open();
  assert.equal(p.get('stream-no-limit').getAttribute('aria-checked'), 'true');
  p.get('stream-no-limit').click(); p.input('7'); await p.save();
  assert.equal(p.backend.maxStreams, 7);
  assert.equal(p.get('camera-grid').children.length, 11, 'lowering must not trim saved choices');
});

test('a saved No limit is honored on first load without browser-side truncation', async (t) => {
  const p = await ready(t, { limit: null, saved: true, cameras: 14 });
  assert.equal(p.get('camera-grid').children.length, 14);
  assert.equal(p.get('camera-options').querySelectorAll('input').every((input) => input.checked && !input.disabled), true);
  assert.match(p.get('selection-count').textContent, /14 selected.*No limit/);
});

test('native RTSP selections do not consume finite relayed-camera slots and remain selectable at capacity', async (t) => {
  const p = await ready(t, { limit: 2, cameras: 7, native: [1, 3, 7] });
  const input = (number) => p.get('camera-options').querySelectorAll('input').find((item) => item.value === `camera-${number}`);
  const choose = (number, checked) => { const node = input(number); node.checked = checked; node.emit('change'); };
  assert.deepEqual(p.get('camera-options').querySelectorAll('input').filter((item) => item.checked).map((item) => item.value),
    ['camera-1', 'camera-2', 'camera-3', 'camera-4', 'camera-7'], 'autoselection includes all native cameras plus two limited cameras');
  assert.equal(input(5).disabled, true, 'an absent catalog flag defaults to using the limit');
  choose(1, false);
  assert.equal(input(1).disabled, false, 'native camera remains available when relayed slots are full');
  assert.equal(input(5).disabled, true, 'deselecting a native camera does not free a relayed slot');
  choose(1, true); assert.equal(input(1).checked, true);
  choose(2, false);
  assert.equal(input(5).disabled, false, 'deselecting a relayed camera frees its slot');
  choose(5, true); assert.equal(input(6).disabled, true);
  await flush();
  assert.equal(p.writes.at(-1).value.length, 5, 'all native and relayed choices are persisted');
  await p.open(); p.get('stream-no-limit').click(); await p.save();
  assert.equal(input(2).disabled, false); assert.equal(input(6).disabled, false);
  choose(2, true); choose(6, true); await flush();
  assert.equal(p.get('camera-grid').children.length, 7);
  await p.open(); p.get('stream-no-limit').click(); p.input('1'); await p.save();
  assert.equal(p.get('camera-grid').children.length, 7, 'lowering retains every existing choice');
  p.get('refresh-button').click(); await flush();
  assert.equal(p.get('camera-grid').children.length, 7, 'catalog refresh does not trim restored mixed choices');
});

test('restored selections above the limit survive catalog refresh and lowering does not stop active feeds', async (t) => {
  const ids = Array.from({ length: 7 }, (_, i) => `camera-${i + 1}`);
  const p = await ready(t, { limit: 6, configured: true, selection: ids });
  assert.equal(p.get('camera-grid').children.length, 7);
  p.get('play-selected').click(); await flush();
  assert.equal(p.peers.length, 7);
  await p.open(); p.input('2'); await p.save();
  assert.equal(p.get('camera-grid').children.length, 7);
  assert.equal(p.peers.filter((peer) => peer.closed).length, 0);
  assert.equal(p.calls.filter((call) => call.route.endsWith('/stop')).length, 0);
  p.get('refresh-button').click(); await flush();
  assert.equal(p.get('camera-grid').children.length, 7);
  assert.equal(p.peers.filter((peer) => peer.closed).length, 0);
  const inputs = p.get('camera-options').querySelectorAll('input');
  assert.equal(inputs.filter((input) => input.checked).every((input) => !input.disabled), true);
  assert.equal(inputs.at(-1).disabled, true);
});

test('numeric validation is inline, accepts positive safe integers and makes no invalid writes', async (t) => {
  const p = await ready(t); await p.open();
  assert.equal(p.get('camera-settings-form').hasAttribute('novalidate'), true);
  for (const value of ['', '0', '-1', '1.5', '1e2', '9007199254740992', 'not a number']) {
    p.input(value); await p.save();
    assert.equal(p.get('camera-settings-error').hidden, false, value);
    assert.equal(p.get('stream-limit').getAttribute('aria-invalid'), 'true');
    assert.equal(p.document.activeElement, p.get('stream-limit'));
  }
  assert.equal(p.calls.some((call) => call.method === 'PUT'), false);
  p.input('9007199254740991'); await p.save();
  assert.equal(p.backend.maxStreams, Number.MAX_SAFE_INTEGER);
});

test('pending helper application is saved, shown honestly and reloaded from Homey', async (t) => {
  const p = await ready(t, { applyStatus: 'pending' }); await p.open();
  p.input('8'); await p.save();
  assert.equal(p.backend.maxStreams, 8);
  assert.match(p.get('page-message').textContent, /saved.*apply when/);
  await p.open();
  assert.equal(p.get('stream-limit').value, '8');
  assert.equal(p.get('camera-settings-status').dataset.tone, 'pending');
});

test('load failure disables saving, offers retry and permission errors do not demand the camera-wall API key', async (t) => {
  const p = await ready(t, { applyStatus: 'pending' });
  await p.open(); p.get('cancel-camera-settings').click();
  const pending = p.hold('GET', '/camera-settings');
  p.get('setup-button').click(); await flush();
  assert.equal(p.get('save-camera-settings').disabled, true);
  pending.request.callback({ statusCode: 403, message: 'SECRET forbidden' }); await flush();
  assert.equal(p.get('camera-settings-status').dataset.tone, 'info', 'a previous pending banner must not leave an empty styled box');
  assert.equal(p.get('retry-camera-settings').hidden, false);
  assert.match(p.get('camera-settings-error').textContent, /access to this Homey/);
  assert.doesNotMatch(p.get('camera-settings-error').textContent, /API key|SECRET/);
  p.get('retry-camera-settings').click(); await flush();
  assert.equal(p.get('stream-limit').value, '4');
  assert.equal(p.get('save-camera-settings').disabled, false);
});

test('a failed save preserves the draft and retry succeeds; saving blocks duplicate writes and closing', async (t) => {
  const p = await ready(t); await p.open(); p.input('10');
  const pending = p.hold('PUT', '/camera-settings');
  p.get('camera-settings-form').emit('submit'); await flush();
  assert.equal(p.get('save-camera-settings').disabled, true);
  assert.equal(p.get('close-camera-settings').disabled, true);
  p.document.emit('keydown', { key: 'Escape' });
  p.get('camera-settings-form').emit('submit');
  assert.equal(p.get('camera-settings-modal').hidden, false);
  assert.equal(p.calls.filter((call) => call.method === 'PUT').length, 1);
  pending.request.callback({ message: 'SECRET private details' }); await flush();
  assert.equal(p.get('stream-limit').value, '10');
  assert.equal(p.get('camera-settings-modal').hidden, false);
  assert.match(p.get('camera-settings-error').textContent, /could not be confirmed/);
  assert.doesNotMatch(p.get('camera-settings-error').textContent, /SECRET/);
  await p.save(); assert.equal(p.backend.maxStreams, 10);
});

test('an unconfirmed timeout can be reopened and a late successful write refreshes canonical state', async (t) => {
  const p = await ready(t); await p.open(); p.input('13');
  const pending = p.hold('PUT', '/camera-settings');
  p.get('camera-settings-form').emit('submit'); await flush(); p.run(30000); await flush();
  assert.equal(p.get('camera-settings-modal').hidden, false);
  assert.equal(p.get('stream-limit').value, '13');
  assert.match(p.get('camera-settings-error').textContent, /could not be confirmed/);
  p.backend.maxStreams = 13; p.backend.saved = true;
  pending.request.callback(null, p.settings()); await flush();
  assert.match(p.get('selection-count').textContent, /Stream limit 13/);
  p.get('cancel-camera-settings').click(); await p.open();
  assert.equal(p.get('stream-limit').value, '13');
});

test('external settings events debounce without assuming payloads and never replace an unsaved draft', async (t) => {
  const p = await ready(t); await p.open(); p.input('10');
  const before = p.calls.filter((call) => call.route === '/camera-settings').length;
  p.backend.maxStreams = null; p.backend.saved = true;
  p.event('settings.set', null); p.event('settings.unset', { unexpected: 'shape' }); p.run(200); await flush();
  assert.equal(p.calls.filter((call) => call.route === '/camera-settings').length, before + 1);
  assert.equal(p.get('stream-limit').value, '10');
  assert.equal(p.get('stream-no-limit').getAttribute('aria-checked'), 'false');
  assert.match(p.get('camera-settings-status').textContent, /Changed on another device/);
  assert.match(p.get('selection-count').textContent, /No limit/);
  p.get('cancel-camera-settings').click(); await p.open();
  assert.equal(p.get('stream-no-limit').getAttribute('aria-checked'), 'true');
  p.backend.maxStreams = 15; p.window.emit('focus'); await flush();
  assert.equal(p.get('stream-limit').value, '15');
});

test('older GET and catalog replies cannot overwrite a newer applied save', async (t) => {
  const p = await ready(t); await p.open(); p.input('12');
  const oldSettings = p.hold('GET', '/camera-settings'), oldCatalog = p.hold('GET', '/camera-wall');
  p.get('refresh-button').click(); await flush();
  await p.save();
  oldSettings.request.callback(null, { maxStreams: 4, defaultMaxStreams: 4, saved: true, applyStatus: 'pending' });
  oldCatalog.request.callback(null, { maxViews: 4, configured: false, cameras: clone(p.backend.cameras) });
  await flush();
  assert.match(p.get('selection-count').textContent, /Stream limit 12/);
  await p.open();
  assert.equal(p.get('stream-limit').value, '12');
  assert.equal(p.get('camera-settings-status').dataset.tone, 'info');
});

test('keyboard focus is trapped and restored, with the existing API-key setup still separate and functional', async (t) => {
  const p = await ready(t); await p.open();
  assert.equal(p.document.activeElement, p.get('stream-limit'));
  assert.equal(p.get('camera-wall').inert, true);
  p.get('close-camera-settings').focus(); p.document.emit('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(p.document.activeElement, p.get('wall-key-setup'));
  p.document.emit('keydown', { key: 'Tab' });
  assert.equal(p.document.activeElement, p.get('close-camera-settings'));
  p.document.emit('keydown', { key: 'Escape' });
  assert.equal(p.get('camera-settings-modal').hidden, true);
  assert.equal(p.get('camera-wall').inert, false);
  assert.equal(p.document.activeElement, p.get('setup-button'));
  await p.open(); p.get('wall-key-setup').click();
  assert.equal(p.get('camera-settings-modal').hidden, true);
  assert.equal(p.get('setup-modal').hidden, false);
  assert.equal(p.document.activeElement, p.get('api-key'));
  p.get('api-key').value = 'fixture-only-not-a-real-secret'; p.get('setup-form').emit('submit'); await flush();
  assert.equal(p.get('api-key').value, '');
  assert.equal(p.backend.configured, true);
  assert.equal(p.get('setup-modal').hidden, true);
  assert.equal(p.get('play-selected').disabled, false);
  assert.equal(p.calls.find((call) => call.route === '/camera-wall/configure').body.key, 'fixture-only-not-a-real-secret');
});

test('settings refresh is queued during a save and late callbacks after leaving cannot mutate the UI', async (t) => {
  const p = await ready(t); await p.open(); p.input('6');
  const put = p.hold('PUT', '/camera-settings'); p.get('camera-settings-form').emit('submit'); await flush();
  const count = p.calls.length;
  p.event('settings.set', 'any payload'); p.run(200); await flush();
  assert.equal(p.calls.length, count);
  p.backend.maxStreams = 6; p.backend.saved = true; put.request.callback(null, p.settings()); await flush();
  assert.equal(p.calls.at(-1).method, 'GET'); assert.equal(p.calls.at(-1).route, '/camera-settings');
  const late = p.hold('GET', '/camera-settings'); p.window.emit('focus'); await flush();
  const previous = p.get('selection-count').textContent;
  p.dispose(); late.request.callback(null, { maxStreams: null, defaultMaxStreams: 4, saved: true, applyStatus: 'applied' });
  p.event('settings.unset'); p.run(200); await flush();
  assert.equal(p.get('selection-count').textContent, previous);
  assert.equal([...p.timers.values()].some((timer) => timer.delay === 200), false);
});
