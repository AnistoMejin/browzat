'use strict';
const fs = require('fs');
const path = require('path');

module.exports = async (t) => {
  t.route('/performance/page', '<!doctype html><title>Performance test</title><h1>Metrics</h1><button id="b">work</button><script>b.onclick=()=>{let n=0;for(let i=0;i<200000;i++)n+=Math.sqrt(i);document.body.dataset.n=n}</script>');
  const tab = await t.open('/performance/page');
  const cleanup = [];
  try {
    let r = await t.call('performance', { tab, action: 'metrics' });
    t.check('performance metrics reports navigation and resources', !r.isError && r.text.includes('navigation:') && r.text.includes('resources:') && r.text.includes(t.base), r.text);

    r = await t.call('performance', { tab, action: 'record_start', interval_ms: 250, max_frames: 4 });
    await t.call('click', { tab, selector: '#b' });
    await t.sleep(800);
    r = await t.call('performance', { tab, action: 'record_stop' });
    const player = (/^saved: (.+index\.html)$/m.exec(r.text) || [])[1];
    if (player) cleanup.push(path.dirname(player));
    const count = Number((/^frames: (\d+)$/m.exec(r.text) || [])[1]);
    t.check('visual recording writes frames and an HTML player', !r.isError && player && fs.existsSync(player) && count >= 2 && fs.existsSync(path.join(path.dirname(player), 'frame-001.jpg')), r.text);

    const none = await t.call('performance', { tab, action: 'record_stop' });
    t.check('recording stop reports when none is active', none.isError && none.text.includes('no visual recording'), none.text);

    if (t.chromium) {
      r = await t.call('performance', { tab, action: 'trace_start' });
      await t.call('click', { tab, selector: '#b' });
      const stopped = await t.call('performance', { tab, action: 'trace_stop', timeout_ms: 30000 });
      const file = (/^saved: (.+\.json)/m.exec(stopped.text) || [])[1];
      if (file) cleanup.push(file);
      let trace = null;
      try { trace = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
      t.check('performance trace saves DevTools JSON', !r.isError && !stopped.isError && file && trace && Array.isArray(trace.traceEvents) && trace.traceEvents.length > 0, stopped.text);
    } else {
      r = await t.call('performance', { tab, action: 'trace_start' });
      t.check('performance trace explains the Firefox limit', r.isError && r.text.includes('not supported on Firefox'), r.text);
    }
  } finally {
    await t.call('performance', { tab, action: 'record_stop' }).catch(() => {});
    if (t.chromium) await t.call('performance', { tab, action: 'trace_stop', timeout_ms: 2000 }).catch(() => {});
    for (const file of cleanup) { try { fs.rmSync(file, { recursive: true, force: true }); } catch (e) {} }
  }
};
