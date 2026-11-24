'use strict';
// PDF output and per-tab environment emulation (phase 4).
const outStates = new Map();
const outFirefoxHeaders = new Map();
const OUT_PRESETS = {
  iphone: { width: 393, height: 852, ratio: 3, mobile: true, touch: true, user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' },
  android: { width: 412, height: 915, ratio: 2.625, mobile: true, touch: true, user_agent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0 Mobile Safari/537.36' },
  ipad: { width: 820, height: 1180, ratio: 2, mobile: true, touch: true, user_agent: 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1' },
};

function outMediaFeatures(m) {
  const list = [];
  if (m.scheme) list.push({ name: 'prefers-color-scheme', value: m.scheme });
  if (m.motion) list.push({ name: 'prefers-reduced-motion', value: m.motion });
  if (m.forced) list.push({ name: 'forced-colors', value: m.forced });
  if (m.contrast) list.push({ name: 'prefers-contrast', value: m.contrast });
  return list;
}

function outSummary(s, firefox) {
  const on = [];
  const v = s.viewport;
  if (v && v.width && v.height) on.push(`viewport ${v.width}x${v.height}` + (v.ratio ? ` @${v.ratio}x` : '') + (v.mobile ? ' mobile' : '') + (v.touch ? ' touch' : '') + (v.landscape ? ' landscape' : '') + (firefox ? ' (window resized)' : ''));
  if (s.user_agent) on.push(`user agent ${JSON.stringify(s.user_agent.slice(0, 60))}${s.user_agent.length > 60 ? '…' : ''}`);
  if (s.locale) on.push('language ' + s.locale);
  if (s.timezone) on.push('time zone ' + s.timezone);
  if (s.geo) on.push(`location ${s.geo.latitude}, ${s.geo.longitude} (±${s.geo.accuracy} m)`);
  if (s.media) {
    if (s.media.scheme) on.push('colour scheme ' + s.media.scheme);
    if (s.media.motion) on.push('reduced motion ' + s.media.motion);
    if (s.media.forced) on.push('forced colours ' + s.media.forced);
    if (s.media.contrast) on.push('contrast ' + s.media.contrast);
    if (s.media.type) on.push(s.media.type + ' media');
  }
  if (s.cpu) on.push(`cpu ${s.cpu}x slower`);
  if (s.headers) on.push('headers: ' + Object.entries(s.headers).map(([k, v]) => `${k} ${v == null ? 'removed' : 'set'}`).join(', '));
  return on;
}

async function outClearCdp(id) {
  const calls = [
    ['Emulation.clearDeviceMetricsOverride'], ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Emulation.setUserAgentOverride', { userAgent: '' }], ['Emulation.setLocaleOverride', { locale: '' }],
    ['Emulation.setTimezoneOverride', { timezoneId: '' }], ['Emulation.clearGeolocationOverride'],
    ['Emulation.setEmulatedMedia', { media: '', features: [] }], ['Emulation.setCPUThrottlingRate', { rate: 1 }],
  ];
  for (const [method, params] of calls) { try { await cdp(id, method, params); } catch (e) {} }
}

async function outSetHeaders(id, headers) {
  if (IS_FIREFOX) {
    if (headers && Object.keys(headers).length) outFirefoxHeaders.set(id, headers); else outFirefoxHeaders.delete(id);
    return;
  }
  const ruleId = 1000000 + id;
  const removeRuleIds = [ruleId];
  const addRules = [];
  if (headers && Object.keys(headers).length) {
    addRules.push({ id: ruleId, priority: 1, action: { type: 'modifyHeaders', requestHeaders: Object.entries(headers).map(([header, value]) =>
      value == null ? { header, operation: 'remove' } : { header, operation: 'set', value }) }, condition: { tabIds: [id], resourceTypes: ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'] } });
  }
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
}

if (IS_FIREFOX && api.webRequest && api.webRequest.onBeforeSendHeaders) {
  api.webRequest.onBeforeSendHeaders.addListener((d) => {
    const wanted = outFirefoxHeaders.get(d.tabId);
    if (!wanted) return {};
    const headers = (d.requestHeaders || []).filter((h) => !Object.keys(wanted).some((n) => n.toLowerCase() === h.name.toLowerCase()));
    for (const [name, value] of Object.entries(wanted)) if (value != null) headers.push({ name, value });
    return { requestHeaders: headers };
  }, { urls: ['<all_urls>'] }, ['blocking', 'requestHeaders']);
}

api.tabs.onRemoved.addListener((id) => {
  outStates.delete(id);
  outFirefoxHeaders.delete(id);
  if (!IS_FIREFOX && api.declarativeNetRequest) api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1000000 + id] }).catch(() => {});
});

handlers.pdf = async (p) => {
  const id = need(p);
  if (IS_FIREFOX) throw new Error('pdf is not supported on Firefox: its extension API can only open a save dialog that a person has to answer (tabs.saveAsPDF) and cannot write the file by itself. Use a Chrome or Edge tab for PDFs, or screenshot with full_page: true for an image of the whole page.');
  const paper = { a4: [8.2677, 11.6929], letter: [8.5, 11], legal: [8.5, 14], a3: [11.6929, 16.5354], a5: [5.8268, 8.2677], tabloid: [11, 17] }[p.paper || 'a4'];
  const mm = Number(p.margin_mm == null ? 10 : p.margin_mm) / 25.4;
  let r;
  try {
    await cdpPin(id, 'output-pdf');
    r = await cdp(id, 'Page.printToPDF', { landscape: !!p.landscape, displayHeaderFooter: !!p.header_footer, printBackground: p.background !== false,
      scale: Number(p.scale || 1), paperWidth: paper[0], paperHeight: paper[1], marginTop: mm, marginBottom: mm, marginLeft: mm, marginRight: mm,
      pageRanges: p.pages || '', preferCSSPageSize: true, transferMode: 'ReturnAsBase64' });
  } catch (e) {
    throw new Error('could not print the page to PDF: ' + String((e && e.message) || e));
  } finally { cdpUnpin(id, 'output-pdf'); }
  if (!r || !r.data) throw new Error('the browser returned no PDF');
  if (r.data.length > 42 * 1024 * 1024) throw new Error('the PDF is larger than 30 MB; print fewer pages (pages) or use a smaller scale');
  const tab = await api.tabs.get(id);
  return { data: r.data, title: tab.title || '', url: tab.url || '' };
};

handlers.emulate = async (p) => {
  const id = need(p);
  const old = outStates.get(id) || {};
  let state = p.reset ? {} : Object.assign({}, old);
  const had = !!Object.keys(old).length;
  const notes = [];
  if (IS_FIREFOX) {
    const unsupported = ['device', 'user_agent', 'locale', 'timezone', 'geo', 'media', 'cpu'].filter((x) => p[x] != null);
    if (p.viewport && Object.keys(p.viewport).some((x) => !['width', 'height'].includes(x))) unsupported.push('device options');
    if (unsupported.length) throw new Error('emulate: not supported on Firefox: ' + unsupported.join(', ') + '. Firefox can only set width and height by resizing the browser window, and headers.');
    if (p.reset && old.window) { try { await api.windows.update(old.window.id, { width: old.window.width, height: old.window.height }); } catch (e) {} }
    if (p.viewport) {
      const tab = await api.tabs.get(id); const win = await api.windows.get(tab.windowId);
      if (win.state === 'minimized') throw new Error('emulate: the browser window of this tab is minimised; restore it first');
      if (!state.window) state.window = { id: win.id, width: win.width, height: win.height };
      const current = unwrap((await run(id, function () { return { ok: true, value: { w: innerWidth, h: innerHeight } }; }, [], { frameId: 0 }))[0]);
      const width = p.viewport.width || current.w; const height = p.viewport.height || current.h;
      await api.windows.update(win.id, { width: win.width + width - current.w, height: win.height + height - current.h });
      await sleep(200);
      const actual = unwrap((await run(id, function () { return { ok: true, value: { w: innerWidth, h: innerHeight } }; }, [], { frameId: 0 }))[0]);
      state.viewport = { width: actual.w, height: actual.h };
      notes.push('the browser window that holds this tab was resized, with every tab in it; reset puts it back');
      if (Math.abs(actual.w - width) > 2 || Math.abs(actual.h - height) > 2) notes.push(`Firefox could not make the page exactly ${width}x${height}; it is ${actual.w}x${actual.h}`);
    }
    if (p.headers != null) { await outSetHeaders(id, p.headers); state.headers = Object.keys(p.headers).length ? p.headers : undefined; }
  } else {
    if (p.reset) { await outClearCdp(id); await outSetHeaders(id, {}); cdpUnpin(id, 'output-emulate'); }
    const preset = p.device ? OUT_PRESETS[p.device] : null;
    if (preset) {
      state.viewport = { width: preset.width, height: preset.height, ratio: preset.ratio, mobile: preset.mobile, touch: preset.touch };
      state.user_agent = preset.user_agent;
    }
    if (p.viewport) state.viewport = Object.assign({}, state.viewport || {}, p.viewport);
    for (const key of ['user_agent', 'locale', 'timezone', 'geo', 'media', 'cpu']) if (p[key] != null) state[key] = p[key];
    if (p.headers != null) { await outSetHeaders(id, p.headers); state.headers = Object.keys(p.headers).length ? p.headers : undefined; }
    const needsCdp = ['viewport', 'user_agent', 'locale', 'timezone', 'geo', 'media', 'cpu'].some((x) => state[x] != null);
    if (needsCdp) {
      await cdpPin(id, 'output-emulate');
      const v = state.viewport;
      if (v) {
        let width = v.width || 1280; let height = v.height || 720;
        if (v.landscape && height > width) [width, height] = [height, width];
        await cdp(id, 'Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: v.ratio || 1, mobile: !!v.mobile, screenWidth: width, screenHeight: height });
        await cdp(id, 'Emulation.setTouchEmulationEnabled', { enabled: !!v.touch, maxTouchPoints: v.touch ? 5 : 1 });
        state.viewport = Object.assign({}, v, { width, height });
      }
      if (state.user_agent || state.locale) await cdp(id, 'Emulation.setUserAgentOverride', { userAgent: state.user_agent || navigator.userAgent, acceptLanguage: state.locale || undefined });
      if (state.locale) await cdp(id, 'Emulation.setLocaleOverride', { locale: state.locale });
      if (state.timezone) {
        try { await cdp(id, 'Emulation.setTimezoneOverride', { timezoneId: state.timezone }); }
        catch (e) { notes.push('this browser does not allow extensions to override the time zone'); }
      }
      if (state.geo) await cdp(id, 'Emulation.setGeolocationOverride', state.geo);
      if (state.media) await cdp(id, 'Emulation.setEmulatedMedia', { media: state.media.type || '', features: outMediaFeatures(state.media) });
      if (state.cpu) await cdp(id, 'Emulation.setCPUThrottlingRate', { rate: state.cpu });
      notes.push('the debugging bar stays while emulation is on; call emulate with reset: true when you are done');
    }
  }
  state = Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined));
  if (Object.keys(state).length) outStates.set(id, state); else outStates.delete(id);
  if (p.device || p.user_agent || p.locale || p.headers) notes.unshift('reload the page so the site sees the new device, user agent, language or headers from the start');
  if (p.geo) notes.push("the site still needs the browser's location permission; if the page asks, the user has to allow it");
  return { on: outSummary(state, IS_FIREFOX), reset: p.reset ? (had ? 'removed' : 'nothing') : '', notes };
};
