// prevueR lives in Chrome's side panel (popup/popup.html). The service worker opens the panel
// from the toolbar icon and the Shift+Cmd+P / Ctrl+Shift+P shortcut, seeds defaults on install
// and keeps the YouTube embed rule in place.

import { DEFAULT_SETTINGS } from './lib/storage.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// sidePanel.open needs the user gesture, so it must run synchronously inside the listener.
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-prevuer' && tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId });
});

// YouTube's embedded player refuses to play (error 153) when the frame request carries no
// Referer, and extension pages don't send one. This rule gives the popup's player frames one.
// It only matches sub-frames the extension itself opens, so other sites' embeds are untouched.
const EMBED_RULE_ID = 1;
const EMBED_REFERER = 'https://atitaninc.com/';

async function installEmbedRule() {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [EMBED_RULE_ID],
    addRules: [{
      id: EMBED_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Referer', operation: 'set', value: EMBED_REFERER }],
      },
      condition: {
        requestDomains: ['youtube-nocookie.com', 'youtube.com'],
        resourceTypes: ['sub_frame'],
        initiatorDomains: [chrome.runtime.id],
      },
    }],
  });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await installEmbedRule();
  if (reason !== 'install') return;
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, history: [] });
});
