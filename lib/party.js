// prevueParty: watch parties with chat, emoji reactions and synced playback, stored in Firebase.
//
// parties/{id}/meta                       { name, url, hostUid, createdAt }
// parties/{id}/members/{uid}              { name, joinedAt, lastSeen }
// parties/{id}/messages/{msgId}           { uid, name, kind: 'text'|'emoji'|'system', text, ts }
// parties/{id}/reactions/{msgId}/{key}/{uid}: true
// parties/{id}/playback                   { state: 'playing'|'paused', time, at, by, name }

import { db, listen, getAuth, SERVER_TIME } from './firebase.js';

export const REACTIONS = [
  ['like', '👍'],
  ['love', '❤️'],
  ['laugh', '😂'],
  ['wow', '😮'],
  ['sad', '😢'],
];
export const LINK_PARAM = 'prevueparty'; // also read by content/party.js
export const MAX_MESSAGE = 500;
const ACTIVE_KEY = 'activeParty'; // chrome.storage.session: { id, name, link, tabId }
const HEARTBEAT_MS = 30_000;
const ONLINE_WINDOW_MS = 90_000;

export function newPartyId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => chars[b % chars.length]).join('');
}

// The link is the page being watched plus #prevueparty=<id>; prevueR on a friend's browser
// spots it and offers to join.
export function partyLink(url, id) {
  const u = new URL(url);
  const hash = u.hash.slice(1).split('&').filter((p) => p && !p.startsWith(`${LINK_PARAM}=`));
  hash.push(`${LINK_PARAM}=${id}`);
  u.hash = hash.join('&');
  u.searchParams.delete(LINK_PARAM);
  return u.toString();
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export async function getActiveParty() {
  const { [ACTIVE_KEY]: active } = await chrome.storage.session.get(ACTIVE_KEY);
  return active || null;
}
export const setActiveParty = (active) => chrome.storage.session.set({ [ACTIVE_KEY]: active });
export const clearActiveParty = () => chrome.storage.session.remove(ACTIVE_KEY);

export async function createParty({ name, url }) {
  const { uid } = await getAuth();
  const id = newPartyId();
  await db.set(`parties/${id}/meta`, { name, url, hostUid: uid, createdAt: SERVER_TIME });
  return id;
}

export const partyMeta = (id) => db.get(`parties/${id}/meta`);

// Joins party `id` and streams it. onUpdate(view) gets a plain snapshot every time anything
// changes; see `snapshot()` below for its shape.
export async function connectParty(id, { nickname, onUpdate, onError }) {
  const { uid } = await getAuth();
  const base = `parties/${id}`;
  const meta = await db.get(`${base}/meta`);
  if (!meta) throw Object.assign(new Error('That party link has expired or doesn’t exist'), { kind: 'api' });

  let name = nickname;
  let tree = null;
  let clockOffset = 0; // server time - local time, so playback positions line up across machines

  const touch = async () => {
    const sent = Date.now();
    const rec = await db.update(`${base}/members/${uid}`, { name, lastSeen: SERVER_TIME });
    if (typeof rec?.lastSeen === 'number') clockOffset = rec.lastSeen - (sent + Date.now()) / 2;
  };
  const wasMember = !!(await db.get(`${base}/members/${uid}/joinedAt`));
  await db.update(`${base}/members/${uid}`, { name, joinedAt: SERVER_TIME });
  await touch();
  if (!wasMember) await system(`${name} joined the party`);
  const heartbeat = setInterval(() => touch().catch(() => {}), HEARTBEAT_MS);

  function system(text) {
    return db.push(`${base}/messages`, { uid, name, kind: 'system', text, ts: SERVER_TIME });
  }

  const now = () => Date.now() + clockOffset;

  const snapshot = () => {
    const t = tree || {};
    const members = Object.entries(t.members || {})
      .map(([id2, m]) => ({ uid: id2, name: m.name, online: now() - (m.lastSeen || 0) < ONLINE_WINDOW_MS }));
    const messages = Object.entries(t.messages || {})
      .map(([mid, m]) => {
        const r = t.reactions?.[mid] || {};
        const reactions = REACTIONS.map(([key, emoji]) => {
          const who = Object.keys(r[key] || {});
          return { key, emoji, count: who.length, mine: who.includes(uid) };
        }).filter((x) => x.count);
        return { id: mid, ...m, mine: m.uid === uid, reactions };
      })
      .sort((a, b) => (a.ts || 0) - (b.ts || 0) || (a.id < b.id ? -1 : 1));
    return { id, uid, meta: t.meta || meta, members, messages, playback: t.playback || null };
  };

  const stop = listen(base, (next) => {
    tree = next;
    onUpdate(snapshot());
  }, onError);

  return {
    id,
    uid,
    snapshot,
    // Where the shared player should be right now, in seconds.
    expectedTime(pb) {
      if (!pb) return 0;
      return pb.state === 'playing' && pb.at ? pb.time + Math.max(0, now() - pb.at) / 1000 : pb.time;
    },
    async send(text) {
      const clean = String(text || '').trim().slice(0, MAX_MESSAGE);
      if (clean) await db.push(`${base}/messages`, { uid, name, kind: 'text', text: clean, ts: SERVER_TIME });
    },
    async sendEmoji(key) {
      const emoji = REACTIONS.find(([k]) => k === key)?.[1];
      if (emoji) await db.push(`${base}/messages`, { uid, name, kind: 'emoji', text: emoji, ts: SERVER_TIME });
    },
    async react(msgId, key) {
      const path = `${base}/reactions/${msgId}/${key}/${uid}`;
      if (tree?.reactions?.[msgId]?.[key]?.[uid]) await db.remove(path);
      else await db.set(path, true);
    },
    async setPlayback({ state, time, event }) {
      await db.set(`${base}/playback`, { state, time, at: SERVER_TIME, by: uid, name });
      const verb = event === 'seeked' ? 'jumped to' : state === 'playing' ? 'played at' : 'paused at';
      await system(`${name} ${verb} ${formatClock(time)}`);
    },
    async rename(next) {
      const old = name;
      name = next;
      await db.update(`${base}/members/${uid}`, { name });
      if (old !== next) await system(`${old} is now ${next}`);
    },
    async leave() {
      clearInterval(heartbeat);
      stop();
      await system(`${name} left the party`).catch(() => {});
      await db.remove(`${base}/members/${uid}`).catch(() => {});
    },
    close() {
      clearInterval(heartbeat);
      stop();
    },
  };
}
