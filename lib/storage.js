// Persistent state for prevueR. API keys stay in chrome.storage.local (never synced).

export const DEFAULT_SETTINGS = {
  theme: 'light',            // 'light' | 'dark'
  aiProvider: 'localai',     // 'localai' | 'openai' | 'anthropic' | 'gemini' | 'llama'
  aiKey: '',
  aiBaseUrl: '',             // blank = provider default
  aiModel: '',               // blank = auto-pick from the provider's model list
  youtubeKey: '',
  traktClientId: '',
  traktUsername: '',
};

const HISTORY_LIMIT = 500;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getHistory() {
  const { history } = await chrome.storage.local.get('history');
  return Array.isArray(history) ? history : [];
}

export async function getHistoryEntry(id) {
  return (await getHistory()).find((h) => h.id === id) || null;
}

export async function addHistory(entry) {
  const history = await getHistory();
  const record = {
    id: crypto.randomUUID(),
    date: Date.now(),
    ...entry,
  };
  history.unshift(record);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
  return record;
}

export async function updateHistory(id, patch) {
  const history = await getHistory();
  const i = history.findIndex((h) => h.id === id);
  if (i === -1) return null;
  history[i] = { ...history[i], ...patch };
  await chrome.storage.local.set({ history });
  return history[i];
}

// Last thing autofill detected, so the Create Search form can fall back to it
// when the current tab has nothing recognisable.
export async function getLastDetected() {
  const { lastDetected } = await chrome.storage.local.get('lastDetected');
  return lastDetected || null;
}

export async function setLastDetected(media) {
  await chrome.storage.local.set({ lastDetected: { ...media, at: Date.now() } });
}
