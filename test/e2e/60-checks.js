'use strict';
module.exports = async (t) => {
  t.route('/checks/page', '<!doctype html><html lang="en"><head><title>Checks</title><style>#space{height:1800px}#card{color:rgb(10,20,30);padding:12px}</style></head><body><form id="form"><label>Name <input id="name"></label><label>Role <select id="role"><option>Admin</option><option>User</option></select></label><button>Save</button></form><ul><li>Alpha</li><li>Beta</li></ul><div id="card" data-id="42">Visible card</div><div id="space"></div><p id="bottom">Bottom marker</p></body></html>');
  const tab = await t.open('/checks/page');
  let r = await t.call('verify', { tab, kind: 'element', selector: '#card' });
  t.check('verify confirms a visible element', !r.isError && r.text.includes('verified:'), r.text);
  r = await t.call('verify', { tab, kind: 'text', text: 'visible card' });
  t.check('verify confirms visible text case-insensitively', !r.isError, r.text);
  r = await t.call('verify', { tab, kind: 'list', selector: 'li', texts: ['Alpha', 'Beta'] });
  t.check('verify confirms a visible list', !r.isError, r.text);
  r = await t.call('verify', { tab, kind: 'text', text: 'not on page' });
  t.check('verify failure is a tool error', r.isError && r.text.includes('text not visible'), r.text);

  r = await t.call('fill_form', { tab, fields: [{ selector: '#name', value: 'Ada' }, { selector: '#role', value: 'User' }] });
  const values = await t.evaluate(tab, "document.querySelector('#name').value+'|'+document.querySelector('#role').value");
  t.check('fill_form fills several field types', !r.isError && r.text === 'filled 2 field(s)' && values === 'Ada|User', r.text + '\n' + values);
  r = await t.call('verify', { tab, kind: 'value', selector: '#name', value: 'Ada' });
  t.check('verify confirms a field value', !r.isError, r.text);

  const attrs = await t.call('inspect', { tab, what: 'attributes', selector: '#card' });
  const box = await t.call('inspect', { tab, what: 'box', selector: '#card' });
  const locator = await t.call('inspect', { tab, what: 'locator', selector: '#card' });
  const styles = await t.call('inspect', { tab, what: 'styles', selector: '#card' });
  t.check('inspect returns attributes, box, locator and styles', attrs.text.includes('"data-id": "42"') && box.text.includes('"visible": true') && locator.text === '#card' && styles.text.includes('rgb(10, 20, 30)'), [attrs.text, box.text, locator.text, styles.text].join('\n'));

  r = await t.call('scroll', { tab, selector: '#bottom' });
  const y = Number(await t.evaluate(tab, 'scrollY'));
  t.check('scroll brings an element into view', !r.isError && y > 500, r.text + '\n' + y);
  r = await t.call('scroll', { tab, direction: 'top' });
  t.check('scroll moves to an edge', !r.isError && Number(await t.evaluate(tab, 'scrollY')) === 0, r.text);

  r = await t.call('highlight', { tab, selector: '#card', label: 'target' });
  const shown = await t.evaluate(tab, "!!document.getElementById('__browzat_highlight')");
  const hidden = await t.call('highlight', { tab, action: 'hide' });
  t.check('highlight show and hide manage one overlay', !r.isError && shown === 'true' && hidden.text === 'highlight hidden', r.text + '\n' + hidden.text);

  r = await t.call('audit', { tab });
  t.check('audit runs local page checks', !r.isError && /\d+ passed, 0 issue\(s\)/.test(r.text), r.text);

  r = await t.call('logpoints', { tab, action: 'list' });
  t.check('logpoints lists none or explains the Firefox limit', (t.chromium && r.text === 'no logpoints in this tab') || (!t.chromium && r.isError && r.text.includes('not supported on Firefox')), r.text);
};
