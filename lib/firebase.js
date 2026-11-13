// Minimal Firebase Realtime Database client over REST + EventSource streaming, with Anonymous
// sign-in through the Identity Toolkit REST API. No SDK, so nothing needs bundling.
// https://firebase.google.com/docs/reference/rest/database
// https://firebase.google.com/docs/reference/rest/auth

import { PrevueRError, fetchJson } from './errors.js';
import { FIREBASE } from './config.js';

const SERVICE = 'prevueParty';
const AUTH_KEY = 'fbAuth'; // chrome.storage.local: { uid, idToken, refreshToken, expiresAt }

export const SERVER_TIME = { '.sv': 'timestamp' };

export function firebaseConfigured() {
  return !!(FIREBASE.apiKey && FIREBASE.databaseURL);
}

function authUrl(host, path) {
  const base = FIREBASE.authEmulator ? `${FIREBASE.authEmulator.replace(/\/+$/, '')}/${host}` : `https://${host}`;
  return `${base}${path}?key=${encodeURIComponent(FIREBASE.apiKey)}`;
}

let authPromise = null;

// Signs in anonymously once per install and refreshes the 1-hour ID token as needed.
export function getAuth({ force = false } = {}) {
  if (!authPromise || force) {
    authPromise = (async () => {
      if (!firebaseConfigured()) {
        throw new PrevueRError('prevueParty isn’t set up yet: add your Firebase config in lib/config.js', { service: SERVICE });
      }
      const { [AUTH_KEY]: saved } = await chrome.storage.local.get(AUTH_KEY);
      if (saved?.idToken && !force && saved.expiresAt - Date.now() > 60_000) return saved;

      let auth;
      if (saved?.refreshToken) {
        try {
          const { body } = await fetchJson(authUrl('securetoken.googleapis.com', '/v1/token'), {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved.refreshToken }),
          }, SERVICE);
          auth = { uid: body.user_id, idToken: body.id_token, refreshToken: body.refresh_token, expiresIn: body.expires_in };
        } catch { /* refresh token revoked: sign in again below */ }
      }
      if (!auth) {
        const { body } = await fetchJson(authUrl('identitytoolkit.googleapis.com', '/v1/accounts:signUp'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ returnSecureToken: true }),
        }, SERVICE);
        auth = { uid: body.localId, idToken: body.idToken, refreshToken: body.refreshToken, expiresIn: body.expiresIn };
      }
      const record = {
        uid: auth.uid,
        idToken: auth.idToken,
        refreshToken: auth.refreshToken,
        expiresAt: Date.now() + Number(auth.expiresIn || 3600) * 1000,
      };
      await chrome.storage.local.set({ [AUTH_KEY]: record });
      return record;
    })().catch((err) => {
      authPromise = null;
      throw err;
    });
  }
  return authPromise;
}

function dbUrl(path, idToken) {
  const u = new URL(FIREBASE.databaseURL);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}.json`;
  u.searchParams.set('auth', idToken);
  return u.toString();
}

async function request(method, path, data) {
  const run = async (auth) => {
    const init = { method, headers: { 'content-type': 'application/json' } };
    if (data !== undefined) init.body = JSON.stringify(data);
    return (await fetchJson(dbUrl(path, auth.idToken), init, SERVICE)).body;
  };
  try {
    return await run(await getAuth());
  } catch (err) {
    if (err.kind !== 'missing-key') throw err; // 401/403: token may have expired, retry once
    return run(await getAuth({ force: true }));
  }
}

export const db = {
  get: (path) => request('GET', path),
  set: (path, data) => request('PUT', path, data),
  update: (path, data) => request('PATCH', path, data),
  push: (path, data) => request('POST', path, data).then((r) => r?.name),
  remove: (path) => request('DELETE', path),
};

// Streams `path`, keeping a local copy of the tree and calling onChange(tree, changedPath).
// Reconnects with a fresh token when Firebase revokes it. Returns a function that stops it.
export function listen(path, onChange, onError) {
  let tree = null;
  let source = null;
  let stopped = false;
  let retry = 0;

  const setAt = (root, parts, value, merge) => {
    if (!parts.length) {
      if (merge && root && typeof root === 'object' && value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          if (v === null) delete root[k];
          else root[k] = v;
        }
        return root;
      }
      return value;
    }
    const node = root && typeof root === 'object' ? root : {};
    const [head, ...rest] = parts;
    const next = setAt(node[head], rest, value, merge);
    if (next === null || next === undefined) delete node[head];
    else node[head] = next;
    return node;
  };

  const open = async () => {
    if (stopped) return;
    let auth;
    try {
      auth = await getAuth({ force: retry > 0 });
    } catch (err) {
      onError?.(err);
      return;
    }
    if (stopped) return;
    source = new EventSource(dbUrl(path, auth.idToken));
    const apply = (merge) => (e) => {
      retry = 0;
      const { path: p, data } = JSON.parse(e.data);
      tree = setAt(tree, p.split('/').filter(Boolean), data, merge);
      onChange(tree, p);
    };
    source.addEventListener('put', apply(false));
    source.addEventListener('patch', apply(true));
    source.addEventListener('auth_revoked', () => reconnect());
    source.addEventListener('cancel', () => {
      source.close();
      onError?.(new PrevueRError('This party is no longer available', { service: SERVICE }));
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) reconnect();
    };
  };
  const reconnect = () => {
    source?.close();
    retry += 1;
    setTimeout(open, Math.min(30_000, 1000 * 2 ** Math.min(retry, 5)));
  };

  open();
  return () => {
    stopped = true;
    source?.close();
  };
}
