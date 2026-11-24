'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../../server/common');

module.exports = async (t) => {
  t.route('/comfort/page', '<!doctype html><title>Comfort</title><p>policy page</p>');
  const tab = await t.open('/comfort/page');
  const secret = 'audit-secret-' + Date.now();
  await t.call('evaluate', { tab, code: JSON.stringify(secret) });
  const auditFile = path.join(C.HOME, 'audit.jsonl');
  const audit = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : '';
  t.check('audit log records calls without argument secrets', audit.includes('"tool":"evaluate"') && audit.includes('"duration_ms":') && !audit.includes(secret), audit.slice(-500));

  const opened = await t.call('tabs', { action: 'new', browser: t.browser, url: t.base + '/comfort/page' });
  if (t.chromium) t.check('new Chromium tabs join the browzat group', opened.text.includes('group: browzat'), opened.text);
  else t.check('new Firefox tabs remain usable without tab groups', /^tab: firefox/m.test(opened.text), opened.text);

  const cleaned = await t.call('tabs', { action: 'cleanup', browser: t.browser });
  t.check('tabs cleanup closes every tab opened in the session', /^closed \d+ tab\(s\):/.test(cleaned.text) && cleaned.text.includes(tab), cleaned.text);
};
