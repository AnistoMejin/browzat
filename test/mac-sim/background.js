'use strict';
// Does what Multi-Account Containers does for a site assigned to a container: cancels the request made
// outside the container, reopens the URL in a "Work" container tab, and closes the original tab if it was new.
browser.webRequest.onBeforeRequest.addListener(
  async (d) => {
    if (d.tabId < 0 || d.cookieStoreId !== 'firefox-default') return {};
    const [work] = await browser.contextualIdentities.query({ name: 'Work' });
    if (!work) return {};
    const tab = await browser.tabs.get(d.tabId);
    await browser.tabs.create({ url: d.url, cookieStoreId: work.cookieStoreId, active: false, index: tab.index + 1 });
    if (tab.url === 'about:blank' || tab.url === 'about:newtab') browser.tabs.remove(d.tabId);
    return { cancel: true };
  },
  { urls: ['*://127.0.0.1/*reopen-in-container*'], types: ['main_frame'] },
  ['blocking']
);
