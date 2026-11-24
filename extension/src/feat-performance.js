'use strict';
// Performance metrics, traces and short visual recordings (phase 5).
const perfTraces = new Set();
const perfRecordings = new Map();

async function perfCapture(id) {
  const shot = await handlers.screenshot({ tabId: id, format: 'jpeg', quality: 45, max_width: 960 });
  return shot.dataUrl;
}

api.tabs.onRemoved.addListener((id) => {
  const r = perfRecordings.get(id);
  if (r) clearInterval(r.timer);
  perfRecordings.delete(id);
  perfTraces.delete(id);
});

handlers.performance = async (p) => {
  const id = need(p);
  const action = p.action || 'metrics';
  if (action === 'metrics') {
    const page = unwrap((await run(id, function () {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paints = performance.getEntriesByType('paint');
      const fcp = paints.find((x) => x.name === 'first-contentful-paint');
      const lcp = performance.getEntriesByType('largest-contentful-paint').slice(-1)[0];
      const cls = performance.getEntriesByType('layout-shift').filter((x) => !x.hadRecentInput).reduce((n, x) => n + x.value, 0);
      return { ok: true, value: { url: location.href, navigation_ms: nav.duration || 0, dom_ms: nav.domContentLoadedEventEnd || 0,
        load_ms: nav.loadEventEnd || 0, fcp: fcp && fcp.startTime, lcp: lcp && lcp.startTime, cls, resources: performance.getEntriesByType('resource').length,
        heap: performance.memory && performance.memory.usedJSHeapSize } };
    }, [], { frameId: 0 }))[0]);
    if (HAS_CDP) {
      try {
        const m = await cdp(id, 'Performance.getMetrics');
        const heap = (m.metrics || []).find((x) => x.name === 'JSHeapUsedSize');
        if (heap) page.heap = heap.value;
      } catch (e) {}
    }
    return page;
  }
  if (action === 'trace_start') {
    if (!HAS_CDP) throw new Error('performance traces are not supported on Firefox: use action metrics or visual recording');
    if (perfTraces.has(id)) throw new Error('a performance trace is already running in this tab');
    await cdpPin(id, 'performance-trace');
    await cdp(id, 'Tracing.start', { categories: '-*,devtools.timeline,v8,blink.user_timing,loading,latencyInfo', transferMode: 'ReturnAsStream' });
    perfTraces.add(id);
    return { started: true };
  }
  if (action === 'trace_stop') {
    if (!perfTraces.has(id)) throw new Error('no performance trace is running in this tab');
    const complete = cdpEvent(id, 'Tracing.tracingComplete', clamp(p.timeout_ms || 30000, 1000, 120000));
    await cdp(id, 'Tracing.end');
    const done = await complete;
    if (!done || !done.stream) throw new Error('timed out waiting for the performance trace');
    let raw = '';
    try {
      for (;;) {
        const part = await cdp(id, 'IO.read', { handle: done.stream, size: 512 * 1024 });
        raw += part.base64Encoded ? atob(part.data) : part.data;
        if (raw.length > 30 * 1024 * 1024) throw new Error('the performance trace is larger than 30 MB; record a shorter trace');
        if (part.eof) break;
      }
    } finally {
      try { await cdp(id, 'IO.close', { handle: done.stream }); } catch (e) {}
      perfTraces.delete(id); cdpUnpin(id, 'performance-trace');
    }
    const bytes = new TextEncoder().encode(raw); let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    let events;
    try { events = (JSON.parse(raw).traceEvents || []).length; } catch (e) {}
    return { data: btoa(bin), events };
  }
  if (action === 'record_start') {
    if (perfRecordings.has(id)) throw new Error('a visual recording is already running in this tab');
    const interval_ms = clamp(p.interval_ms || 1000, 250, 5000);
    const max_frames = clamp(p.max_frames || 20, 1, 60);
    const rec = { frames: [], interval_ms, max_frames, started: Date.now(), busy: false, timer: null };
    if (HAS_CDP) await cdpPin(id, 'performance-record');
    const take = async () => {
      if (rec.busy || rec.frames.length >= rec.max_frames) return;
      rec.busy = true;
      try { rec.frames.push({ at: Date.now() - rec.started, dataUrl: await perfCapture(id) }); } catch (e) {}
      rec.busy = false;
    };
    rec.take = take;
    await take();
    rec.timer = setInterval(take, interval_ms);
    perfRecordings.set(id, rec);
    return { interval_ms, max_frames };
  }
  if (action === 'record_stop') {
    const rec = perfRecordings.get(id);
    if (!rec) throw new Error('no visual recording is running in this tab');
    clearInterval(rec.timer);
    for (let i = 0; rec.busy && i < 50; i++) await sleep(20);
    // Background timers can be heavily throttled in a headed browser. Always attempt a final frame at stop so a
    // short recording contains both its initial and final state even when no interval callback got CPU time.
    if (rec.frames.length < rec.max_frames) await rec.take();
    perfRecordings.delete(id);
    if (HAS_CDP) cdpUnpin(id, 'performance-record');
    return { frames: rec.frames, interval_ms: rec.interval_ms, duration_ms: Date.now() - rec.started };
  }
  throw new Error('action must be metrics, trace_start, trace_stop, record_start or record_stop');
};
