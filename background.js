// The popup does the work; the service worker only seeds defaults on install.
// The Shift+Cmd+P / Ctrl+Shift+P shortcut is the built-in _execute_action command (see manifest).

import { DEFAULT_SETTINGS } from './lib/storage.js';

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS, history: [] });
});
