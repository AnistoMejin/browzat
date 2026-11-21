'use strict';
// Firefox only (listed in manifest.firefox.json): runs at document_start in every page, before the page's own
// scripts, so console messages from the very start of a page are recorded. It then asks the background whether this
// tab is one the agent works in; if not, the hook is removed at once and nothing recorded is kept.
// Chrome and Edge do not need this: they read the console history through the debugger.
(function () {
  if (window !== window.top) return;
  bmcpConsole({ op: 'install' });
  Promise.resolve(browser.runtime.sendMessage({ type: 'bmcp-watched' }))
    .then((r) => { if (!r || !r.watched) bmcpConsole({ op: 'uninstall' }); })
    .catch(() => bmcpConsole({ op: 'uninstall' }));
})();
