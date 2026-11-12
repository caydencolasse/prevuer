// The popup does the work; the service worker seeds defaults on install and keeps the
// YouTube embed rule in place. The Shift+Cmd+P / Ctrl+Shift+P shortcut is the built-in
// _execute_action command (see manifest).

import { DEFAULT_SETTINGS } from './lib/storage.js';

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
