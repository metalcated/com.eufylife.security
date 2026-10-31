'use strict';

// Homey's settings bridge supplies authentication. Keys, media URLs, and SDP
// stay out of the DOM, browser storage, and logs.
(() => {
  const KEEPALIVE_MS = 20000;
  const ICE_TIMEOUT_MS = 12000;
  const CONNECT_TIMEOUT_MS = 60000;
  const state = { homey: null, cameras: new Map(), selected: new Set(), tiles: new Map(), views: new Map(),
    configured: false, maxViews: null, limitKnown: false, limitRevision: 0, selectionInitialized: false, loading: false, catalogGeneration: 0,
    modalOpen: false, saving: false, previousFocus: null, settingsOpen: false, settingsSaving: false, settingsLoading: false,
    settingsLoaded: false, settingsDirty: false, settingsGeneration: 0, settingsPreviousFocus: null, settingsValue: undefined,
    settingsRefreshPending: false, settingsEventTimer: null,
    disposed: false, selectionWrites: Promise.resolve() };
  const $ = (id) => document.getElementById(id);
  const validLimit = (value) => value === null || Number.isSafeInteger(value) && value > 0;
  function hasSelectionRoom(camera) {
    if (camera?.usesStreamLimit === false || !state.limitKnown || state.maxViews === null) return true;
    let limited = 0;
    for (const id of state.selected) if (state.cameras.get(id)?.usesStreamLimit !== false && ++limited >= state.maxViews) return false;
    return true;
  }

  function api(method, route, body, timeout = 30000, onLateResult = null) {
    return new Promise((resolve, reject) => {
      let settled = false, timedOut = false;
      const finish = (error, result) => {
        if (settled) {
          if (timedOut && !error && onLateResult) { onLateResult(result); onLateResult = null; }
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => { timedOut = true; finish({ code: 'TIMEOUT' }); }, timeout);
      try { state.homey.api(method, route, body, finish); }
      catch (error) { finish(error); }
    });
  }

  function message(text = '', tone = 'info') {
    const notice = $('page-message');
    notice.textContent = text;
    notice.dataset.tone = tone;
    notice.hidden = !text;
  }

  function safeError(error, purpose) {
    const detail = `${error?.code || ''} ${error?.statusCode || ''} ${error?.message || ''}`.toLowerCase();
    if (/busy|homebase|maximum|limit/.test(detail)) return 'This camera or its HomeBase is busy. Stop another feed, then retry.';
    if (/privacy|disabled/.test(detail)) return 'This camera is in privacy mode or disabled. Enable it in Eufy, then retry.';
    if (/401|403|permission|forbidden|unauthori|connect a read-only|check its api key|not.?configured/.test(detail)) return 'Check the saved API key and its device read access in Camera wall setup.';
    if (purpose === 'configure') return 'The key could not be saved. Check its device read access, then try again.';
    if (/unavailable|offline|not.?ready/.test(detail)) return 'The camera is unavailable. Check its connection and refresh cameras.';
    if (purpose === 'catalog') return 'Your cameras could not be loaded. Check the Homey connection, then select Refresh cameras.';
    return 'The camera could not connect. Check its connection, then select Retry.';
  }

  function current(view) { return !state.disposed && state.views.get(view.id) === view; }
  function canPlay(camera) { return camera?.available && camera?.videoRegistered; }
  function route(id, action) { return `/camera-wall/${encodeURIComponent(id)}/${action}`; }

  function settingsCall(method, ...args) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish({ code: 'TIMEOUT' }), 5000);
      try { state.homey[method](...args, finish); }
      catch (error) { finish(error); }
    });
  }

  function saveSelection() {
    const ids = [...state.selected].filter((id) => state.cameras.has(id));
    // Serialize preference writes so an earlier choice cannot overwrite a later one.
    state.selectionWrites = state.selectionWrites.catch(() => {}).then(() => settingsCall('set', 'camera_wall_selection', ids)).catch(() => {
      if (!state.disposed) message('Camera choices could not be saved. They will be kept for this visit.');
    });
  }

  async function restoreSelection() {
    try {
      const ids = await settingsCall('get', 'camera_wall_selection');
      if (state.disposed || !Array.isArray(ids)) return;
      state.selected = new Set(ids.filter((id) => typeof id === 'string' && id));
      state.selectionInitialized = true;
    } catch (_) { /* Cameras still load if the saved preference is unavailable. */ }
  }

  function setTile(id, phase, text) {
    const tile = state.tiles.get(id);
    if (!tile) return;
    const camera = state.cameras.get(id);
    tile.dataset.state = phase;
    tile.querySelector('.camera-status').textContent = text;
    tile.querySelector('.live-label').hidden = phase !== 'live';
    tile.querySelector('.placeholder-label').textContent = phase === 'connecting' ? 'Connecting to your camera…' : phase === 'error' ? 'Camera needs attention' : 'Ready when you are';
    const button = tile.querySelector('.feed-toggle');
    button.textContent = phase === 'connecting' || phase === 'live' ? 'Stop' : phase === 'error' ? 'Retry' : 'Play';
    button.disabled = !(phase === 'connecting' || phase === 'live') && (!state.configured || !canPlay(camera) || state.disposed);
    updateControls();
  }

  function stoppedText(camera) {
    if (!camera.available) return 'Unavailable in Homey. Check the camera connection.';
    if (!camera.videoRegistered) return 'Video is not ready. Refresh cameras to check again.';
    if (!state.configured) return 'Set up the camera wall to play this feed.';
    return 'Select Play to connect.';
  }

  function updateControls() {
    const playable = [...state.selected].some((id) => canPlay(state.cameras.get(id)) && !state.views.has(id));
    $('play-selected').disabled = !state.configured || !playable || state.disposed;
    $('stop-all').disabled = state.views.size === 0;
    $('refresh-button').disabled = state.loading;
    $('selection-count').textContent = `${state.selected.size} selected${state.limitKnown ? state.maxViews === null ? ' · No limit' : ` · Stream limit ${state.maxViews}` : ''}`;
    $('setup-notice').hidden = state.configured;
    for (const input of $('camera-options').querySelectorAll('input')) input.disabled = !input.checked && !hasSelectionRoom(state.cameras.get(input.value));
  }

  function createTile(camera) {
    const tile = $('camera-tile-template').content.firstElementChild.cloneNode(true);
    tile.dataset.cameraId = camera.id;
    tile.querySelector('.camera-name').textContent = camera.name;
    const video = tile.querySelector('video');
    video.muted = true;
    tile.querySelector('.feed-toggle').addEventListener('click', () => {
      if (state.views.has(camera.id)) stopView(camera.id);
      else startView(camera.id);
    });
    video.addEventListener('playing', () => {
      const view = state.views.get(camera.id);
      if (!view || view.video !== video) return;
      clearTimeout(view.connectTimer);
      setTile(camera.id, 'live', 'Live video · Sound off');
    });
    const fullscreen = tile.querySelector('.feed-fullscreen');
    fullscreen.hidden = !tile.requestFullscreen;
    fullscreen.setAttribute('aria-label', `Show ${camera.name} fullscreen`);
    fullscreen.addEventListener('click', () => showFullscreen(tile));
    state.tiles.set(camera.id, tile);
    return tile;
  }

  function renderCameras() {
    const options = $('camera-options');
    options.replaceChildren();
    for (const camera of state.cameras.values()) {
      const label = document.createElement('label');
      label.className = 'camera-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = camera.id;
      input.checked = state.selected.has(camera.id);
      input.addEventListener('change', () => {
        if (input.checked && hasSelectionRoom(camera)) state.selected.add(camera.id);
        else { input.checked = false; state.selected.delete(camera.id); stopView(camera.id); }
        renderGrid();
        saveSelection();
      });
      const name = document.createElement('span');
      name.textContent = camera.name;
      label.append(input, name);
      if (!canPlay(camera)) {
        const unavailable = document.createElement('span');
        unavailable.className = 'option-unavailable';
        unavailable.textContent = camera.available ? 'Video not ready' : 'Unavailable';
        label.append(unavailable);
      }
      options.append(label);
    }
    renderGrid();
  }

  function renderGrid() {
    const grid = $('camera-grid');
    for (const [id, tile] of state.tiles) {
      if (!state.selected.has(id) || !state.cameras.has(id)) { tile.remove(); state.tiles.delete(id); }
    }
    for (const id of state.selected) {
      const camera = state.cameras.get(id);
      if (!camera) continue;
      const tile = state.tiles.get(id) || createTile(camera);
      tile.querySelector('.camera-name').textContent = camera.name;
      grid.append(tile);
      if (!state.views.has(id)) setTile(id, 'stopped', stoppedText(camera));
    }
    grid.dataset.count = String(state.selected.size);
    $('empty-state').hidden = state.selected.size !== 0;
    updateControls();
  }

  async function loadCameras() {
    const generation = ++state.catalogGeneration;
    const limitRevision = state.limitRevision;
    state.loading = true;
    updateControls();
    try {
      const result = await api('GET', '/camera-wall', null);
      if (state.disposed || generation !== state.catalogGeneration) return;
      if (!result || !Array.isArray(result.cameras) || typeof result.configured !== 'boolean') throw Error('Invalid inventory');
      state.configured = result.configured;
      if (validLimit(result.maxViews) && limitRevision === state.limitRevision) applyLimit(result.maxViews);
      const cameras = new Map();
      for (const item of result.cameras) if (item && typeof item.id === 'string' && item.id && !cameras.has(item.id)) {
        cameras.set(item.id, { id: item.id, name: typeof item.name === 'string' && item.name ? item.name : 'Camera',
          available: item.available === true, videoRegistered: item.videoRegistered === true, usesStreamLimit: item.usesStreamLimit !== false });
      }
      state.cameras = cameras;
      for (const id of state.selected) if (!cameras.has(id)) { state.selected.delete(id); stopView(id); }
      for (const [id] of state.views) if (!state.configured || !canPlay(cameras.get(id))) stopView(id);
      if (!state.selectionInitialized) {
        const candidates = [...cameras.values()].sort((a, b) => Number(canPlay(b)) - Number(canPlay(a)));
        for (const camera of candidates) if (hasSelectionRoom(camera)) state.selected.add(camera.id);
        state.selectionInitialized = true;
      }
      const available = [...cameras.values()].filter(canPlay).length;
      $('inventory-status').textContent = cameras.size ? `${available} of ${cameras.size} cameras ready for live view` : 'No cameras are ready for this wall yet';
      message(cameras.size ? '' : 'Pair a camera with Eufy Security in Homey, then refresh this page.');
      renderCameras();
      return true;
    } catch (error) {
      if (!state.disposed && generation === state.catalogGeneration) {
        $('inventory-status').textContent = 'Camera list unavailable';
        message(safeError(error, 'catalog'), 'error');
      }
      return false;
    } finally {
      if (generation === state.catalogGeneration) { state.loading = false; updateControls(); }
    }
  }

  function waitForIce(view) {
    return new Promise((resolve, reject) => {
      const pc = view.pc;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', changed);
        view.cancelIce = null;
        if (error) reject(error); else resolve();
      };
      const changed = () => { if (pc.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(() => finish({ code: 'ICE_TIMEOUT' }), ICE_TIMEOUT_MS);
      view.cancelIce = () => finish({ code: 'CANCELLED' });
      pc.addEventListener('icegatheringstatechange', changed);
      changed();
    });
  }

  function stopRemote(id, handle) { return api('POST', route(id, 'stop'), { handle }, 10000).catch(() => {}); }

  function stopView(id, options = {}) {
    const view = state.views.get(id);
    if (view) {
      state.views.delete(id);
      clearTimeout(view.keepaliveTimer);
      clearTimeout(view.connectTimer);
      clearTimeout(view.disconnectTimer);
      view.cancelIce?.();
      view.pc.ontrack = null;
      view.pc.onconnectionstatechange = null;
      view.pc.close();
      for (const track of view.stream.getTracks()) track.stop();
      view.video.pause();
      view.video.srcObject = null;
      if (view.handle) stopRemote(id, view.handle);
    }
    const camera = state.cameras.get(id);
    if (camera) setTile(id, options.phase || 'stopped', options.message || stoppedText(camera));
    updateControls();
  }

  function stopAll(options) { for (const id of [...state.views.keys()]) stopView(id, options); }

  function failView(view, text) {
    if (current(view)) stopView(view.id, { phase: 'error', message: text });
  }

  function scheduleKeepalive(view) {
    if (!current(view)) return;
    view.keepaliveTimer = setTimeout(async () => {
      if (!current(view)) return;
      try {
        await api('POST', route(view.id, 'keepalive'), { handle: view.handle }, 12000);
        if (current(view)) scheduleKeepalive(view);
      } catch (error) { failView(view, safeError(error, 'keepalive')); }
    }, KEEPALIVE_MS);
  }

  async function startView(id) {
    const camera = state.cameras.get(id);
    if (state.disposed || state.views.has(id) || !state.selected.has(id) || !canPlay(camera)) return;
    if (!state.configured) { openSetup(); return; }
    if (!window.RTCPeerConnection || !window.MediaStream) {
      setTile(id, 'error', 'This browser does not support live camera video. Open the wall in a current browser.');
      return;
    }
    let view;
    try {
      const pc = new RTCPeerConnection();
      const video = state.tiles.get(id).querySelector('video');
      view = { id, pc, video, stream: new MediaStream(), handle: null };
      state.views.set(id, view);
      video.srcObject = view.stream;
      video.muted = true;
      // Muted playback begins from this user gesture; retry when the first track arrives.
      video.play().catch(() => {});
      setTile(id, 'connecting', 'Connecting to the camera…');
      view.connectTimer = setTimeout(() => failView(view, 'The camera took too long to provide video. Select Retry to reconnect.'), CONNECT_TIMEOUT_MS);
      pc.ontrack = (event) => {
        if (!current(view)) return;
        if (!view.stream.getTracks().some((track) => track.id === event.track.id)) view.stream.addTrack(event.track);
        event.track.addEventListener('ended', () => failView(view, 'The camera feed ended. Select Retry to reconnect.'), { once: true });
        video.play().catch(() => failView(view, 'Playback was blocked by this browser. Select Retry to start the feed.'));
      };
      pc.onconnectionstatechange = () => {
        if (!current(view)) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') failView(view, 'The camera connection ended. Select Retry to reconnect.');
        else if (pc.connectionState === 'disconnected') {
          clearTimeout(view.disconnectTimer);
          view.disconnectTimer = setTimeout(() => failView(view, 'The camera connection was interrupted. Select Retry to reconnect.'), 8000);
        } else clearTimeout(view.disconnectTimer);
      };
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      await pc.setLocalDescription(await pc.createOffer());
      if (!current(view)) return;
      await waitForIce(view);
      if (!current(view)) return;
      const offerSdp = pc.localDescription?.sdp;
      if (typeof offerSdp !== 'string' || !offerSdp) throw Error('Missing offer');
      const result = await api('POST', route(id, 'offer'), { offerSdp }, 40000, (late) => {
        if (typeof late?.handle === 'string' && late.handle) stopRemote(id, late.handle);
      });
      const handle = typeof result?.handle === 'string' && result.handle ? result.handle : null;
      if (!current(view)) { if (handle) stopRemote(id, handle); return; }
      view.handle = handle;
      if (!handle || typeof result.answerSdp !== 'string' || !result.answerSdp) throw Error('Invalid answer');
      // Match Homey's browser player: its camera answer must send to recvonly transceivers.
      await pc.setRemoteDescription({ type: 'answer', sdp: result.answerSdp.replace(/^a=sendrecv(?=\r?$)/gm, 'a=sendonly') });
      if (!current(view)) return;
      scheduleKeepalive(view);
    } catch (error) {
      if (view) failView(view, safeError(error, 'offer'));
      else setTile(id, 'error', safeError(error, 'offer'));
    }
  }

  async function showFullscreen(element) {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await element.requestFullscreen();
    } catch (_) { message('Fullscreen is not available in this Homey window. You can keep watching here.'); }
  }

  function applyLimit(value) {
    state.maxViews = value; state.limitKnown = true; state.limitRevision++;
    updateControls();
  }

  function settingsResult(result) {
    return result && validLimit(result.maxStreams) && Number.isSafeInteger(result.defaultMaxStreams) && result.defaultMaxStreams > 0
      && typeof result.saved === 'boolean' && ['applied', 'pending'].includes(result.applyStatus);
  }

  function settingsStatus(result) {
    const pending = result.applyStatus === 'pending';
    $('camera-settings-status').dataset.tone = pending ? 'pending' : 'info';
    $('camera-settings-status').textContent = pending
      ? 'This setting will apply when camera streaming reconnects or is updated.'
      : result.saved ? 'Shared across your Eufy camera views in Homey.' : 'Using the default stream limit. Save to change it for all your Eufy camera views.';
  }

  function settingsError(error, saving) {
    const detail = `${error?.code || ''} ${error?.statusCode || ''} ${error?.message || ''}`.toLowerCase();
    if (/401|403|permission|forbidden|unauthori/.test(detail)) return 'Check your access to this Homey, then try again.';
    return saving ? 'The change could not be confirmed. Check the Homey connection, then try again or reopen Camera settings.'
      : 'Camera settings could not be loaded. Check the Homey connection, then retry.';
  }

  function updateSettingsControls() {
    const busy = state.settingsSaving || state.settingsLoading;
    $('stream-limit').disabled = busy || !state.settingsLoaded || $('stream-no-limit').getAttribute('aria-checked') === 'true';
    $('stream-no-limit').disabled = busy || !state.settingsLoaded;
    $('save-camera-settings').disabled = busy || !state.settingsLoaded;
    for (const id of ['cancel-camera-settings', 'close-camera-settings', 'wall-key-setup', 'retry-camera-settings']) $(id).disabled = state.settingsSaving;
    $('camera-settings-dialog').setAttribute('aria-busy', String(busy));
  }

  async function loadCameraSettings({ dialog = false } = {}) {
    if (state.disposed || state.settingsSaving) return false;
    const generation = ++state.settingsGeneration;
    if (dialog && !state.settingsDirty) {
      state.settingsLoading = true; state.settingsLoaded = false;
      $('camera-settings-status').dataset.tone = 'info';
      $('camera-settings-status').textContent = 'Loading camera settings…';
      $('camera-settings-error').hidden = true; $('retry-camera-settings').hidden = true;
      updateSettingsControls();
    }
    try {
      const result = await api('GET', '/camera-settings', null);
      if (state.disposed || generation !== state.settingsGeneration) return false;
      if (!settingsResult(result)) throw Error('Invalid camera settings');
      const changedElsewhere = state.settingsValue !== undefined && state.settingsValue !== result.maxStreams;
      state.settingsValue = result.maxStreams;
      applyLimit(result.maxStreams);
      if (state.settingsOpen && !state.settingsDirty) {
        $('stream-no-limit').setAttribute('aria-checked', String(result.maxStreams === null));
        $('stream-limit').value = String(result.maxStreams ?? result.defaultMaxStreams);
        $('stream-limit').removeAttribute('aria-invalid');
        state.settingsLoaded = true; settingsStatus(result);
        $('camera-settings-error').hidden = true; $('retry-camera-settings').hidden = true;
      } else if (state.settingsOpen && state.settingsDirty && changedElsewhere) {
        $('camera-settings-status').dataset.tone = 'info';
        $('camera-settings-status').textContent = 'Changed on another device. Save your choice or Cancel to keep the saved setting.';
      }
      return true;
    } catch (error) {
      if (!state.disposed && generation === state.settingsGeneration && state.settingsOpen && dialog) {
        $('camera-settings-status').dataset.tone = 'info';
        $('camera-settings-status').textContent = '';
        $('camera-settings-error').textContent = settingsError(error, false);
        $('camera-settings-error').hidden = false; $('retry-camera-settings').hidden = false;
      }
      return false;
    } finally {
      if (generation === state.settingsGeneration) {
        state.settingsLoading = false; updateSettingsControls();
        if (state.settingsOpen && document.activeElement === $('camera-settings-dialog')) {
          (state.settingsLoaded ? $('stream-no-limit').getAttribute('aria-checked') === 'true' ? $('stream-no-limit') : $('stream-limit') : $('retry-camera-settings')).focus();
        }
      }
    }
  }

  function openCameraSettings() {
    if (state.settingsOpen || state.modalOpen || state.disposed) return;
    state.settingsPreviousFocus = document.activeElement;
    state.settingsOpen = true; state.settingsDirty = false; state.settingsLoaded = false;
    $('camera-settings-modal').hidden = false; $('camera-wall').inert = true;
    document.body.classList.add('modal-open'); $('camera-settings-dialog').focus();
    loadCameraSettings({ dialog: true });
  }

  function closeCameraSettings() {
    if (state.settingsSaving) return;
    state.settingsOpen = false; state.settingsDirty = false; ++state.settingsGeneration;
    state.settingsLoading = false;
    $('camera-settings-modal').hidden = true; $('camera-wall').inert = false;
    document.body.classList.remove('modal-open'); state.settingsPreviousFocus?.focus();
  }

  async function saveCameraSettings(event) {
    event.preventDefault();
    if (state.settingsSaving || state.settingsLoading || !state.settingsLoaded) return;
    const raw = $('stream-limit').value.trim();
    const unlimited = $('stream-no-limit').getAttribute('aria-checked') === 'true';
    const value = unlimited ? null : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!validLimit(value)) {
      $('camera-settings-error').textContent = 'Enter a whole number greater than zero, or choose No limit.';
      $('camera-settings-error').hidden = false; $('stream-limit').setAttribute('aria-invalid', 'true'); $('stream-limit').focus(); return;
    }
    state.settingsSaving = true; ++state.settingsGeneration;
    $('camera-settings-error').hidden = true; $('save-camera-settings').textContent = 'Saving…';
    $('camera-settings-status').dataset.tone = 'info';
    $('camera-settings-status').textContent = 'Saving camera settings…'; updateSettingsControls();
    try {
      const result = await api('PUT', '/camera-settings', { maxStreams: value }, 30000, () => { if (!state.disposed) loadCameraSettings(); });
      if (state.disposed) return;
      if (!settingsResult(result) || result.saved !== true || result.maxStreams !== value) throw Error('Camera settings not confirmed');
      state.settingsValue = result.maxStreams;
      applyLimit(result.maxStreams);
      state.settingsSaving = false; closeCameraSettings();
      message(result.applyStatus === 'pending'
        ? 'Stream limit saved. It will apply when camera streaming reconnects or is updated.'
        : 'Eufy stream limit saved for web, iOS and Android. Current feeds keep playing.');
    } catch (error) {
      if (!state.disposed) {
        $('camera-settings-status').dataset.tone = 'info';
        $('camera-settings-status').textContent = '';
        $('camera-settings-error').textContent = settingsError(error, true); $('camera-settings-error').hidden = false;
      }
    } finally {
      state.settingsSaving = false; $('save-camera-settings').textContent = 'Save'; updateSettingsControls();
      if (state.settingsOpen) $('save-camera-settings').focus();
      if (state.settingsRefreshPending) { state.settingsRefreshPending = false; loadCameraSettings(); }
    }
  }

  function refreshSettingsSoon() {
    if (state.disposed) return;
    clearTimeout(state.settingsEventTimer);
    state.settingsEventTimer = setTimeout(() => {
      state.settingsEventTimer = null;
      if (state.disposed) return;
      if (state.settingsSaving) state.settingsRefreshPending = true;
      else loadCameraSettings({ dialog: state.settingsOpen });
    }, 200);
  }

  function openSetup() {
    if (state.modalOpen || state.settingsOpen || state.disposed) return;
    state.previousFocus = document.activeElement;
    state.modalOpen = true;
    $('api-key').value = '';
    $('setup-error').hidden = true;
    $('setup-error').textContent = '';
    $('setup-modal').hidden = false;
    $('camera-wall').inert = true;
    document.body.classList.add('modal-open');
    $('api-key').focus();
  }

  function closeSetup() {
    if (state.saving) return;
    state.modalOpen = false;
    $('api-key').value = '';
    $('setup-modal').hidden = true;
    $('camera-wall').inert = false;
    document.body.classList.remove('modal-open');
    state.previousFocus?.focus();
  }

  async function saveSetup(event) {
    event.preventDefault();
    if (state.saving) return;
    let key = $('api-key').value.trim();
    if (!key) { $('api-key').focus(); return; }
    state.saving = true;
    $('setup-error').hidden = true;
    $('save-setup').textContent = 'Saving…';
    for (const id of ['save-setup', 'cancel-setup', 'close-setup', 'api-key']) $(id).disabled = true;
    try {
      const pending = api('POST', '/camera-wall/configure', { key });
      key = '';
      $('api-key').value = '';
      const result = await pending;
      if (result?.configured !== true) throw Error('Configuration unavailable');
      state.configured = true;
      stopAll();
      state.saving = false;
      closeSetup();
      const loaded = await loadCameras();
      if (loaded && !state.disposed) message('Camera wall connected. Choose your cameras and select Play selected.');
    } catch (error) {
      if (!state.disposed) {
        $('setup-error').textContent = safeError(error, 'configure');
        $('setup-error').hidden = false;
      }
    } finally {
      key = '';
      state.saving = false;
      $('save-setup').textContent = 'Save key';
      for (const id of ['save-setup', 'cancel-setup', 'close-setup', 'api-key']) $(id).disabled = false;
      updateControls();
      if (state.modalOpen) $('api-key').focus();
    }
  }

  function handleModalKeys(event) {
    if (!state.modalOpen && !state.settingsOpen) return;
    const modal = $(state.settingsOpen ? 'camera-settings-modal' : 'setup-modal');
    if (event.key === 'Escape') { event.preventDefault(); if (state.settingsOpen) closeCameraSettings(); else closeSetup(); }
    if (event.key !== 'Tab') return;
    const focusable = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')].filter((node) => !node.closest('[hidden]'));
    if (!focusable.length) { event.preventDefault(); modal.querySelector('[role="dialog"]').focus(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  window.onHomeyReady = (Homey) => {
    if (state.homey) return;
    state.homey = Homey;
    $('setup-button').addEventListener('click', openCameraSettings);
    $('close-camera-settings').addEventListener('click', closeCameraSettings);
    $('cancel-camera-settings').addEventListener('click', closeCameraSettings);
    $('camera-settings-form').addEventListener('submit', saveCameraSettings);
    $('stream-no-limit').addEventListener('click', () => {
      const on = $('stream-no-limit').getAttribute('aria-checked') !== 'true';
      $('stream-no-limit').setAttribute('aria-checked', String(on)); state.settingsDirty = true;
      $('stream-limit').removeAttribute('aria-invalid'); updateSettingsControls();
      if (!on) $('stream-limit').focus();
    });
    $('stream-limit').addEventListener('input', () => { state.settingsDirty = true; $('stream-limit').removeAttribute('aria-invalid'); });
    $('retry-camera-settings').addEventListener('click', () => { state.settingsDirty = false; loadCameraSettings({ dialog: true }); });
    $('wall-key-setup').addEventListener('click', () => { closeCameraSettings(); openSetup(); });
    $('connect-button').addEventListener('click', openSetup);
    $('close-setup').addEventListener('click', closeSetup);
    $('cancel-setup').addEventListener('click', closeSetup);
    $('setup-form').addEventListener('submit', saveSetup);
    $('refresh-button').addEventListener('click', () => { loadCameras(); loadCameraSettings({ dialog: state.settingsOpen }); });
    $('play-selected').addEventListener('click', () => { message(); for (const id of state.selected) startView(id); });
    $('stop-all').addEventListener('click', () => stopAll());
    $('wall-fullscreen').hidden = !$('camera-grid').requestFullscreen;
    $('wall-fullscreen').addEventListener('click', () => showFullscreen($('camera-grid')));
    document.addEventListener('keydown', handleModalKeys);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.views.size) { stopAll(); message('Feeds paused while this page was in the background. Select Play selected to resume.'); }
      else if (!document.hidden) loadCameraSettings({ dialog: state.settingsOpen });
    });
    window.addEventListener('focus', () => { if (!document.hidden) loadCameraSettings({ dialog: state.settingsOpen }); });
    if (typeof Homey.on === 'function') {
      Homey.on('settings.set', refreshSettingsSoon);
      Homey.on('settings.unset', refreshSettingsSoon);
    }
    window.addEventListener('pagehide', (event) => {
      stopAll();
      $('api-key').value = '';
      if (!event.persisted) { state.disposed = true; ++state.catalogGeneration; ++state.settingsGeneration; clearTimeout(state.settingsEventTimer); }
    });
    Homey.ready();
    restoreSelection().then(() => { if (!state.disposed) { loadCameras(); loadCameraSettings(); } });
  };
})();
