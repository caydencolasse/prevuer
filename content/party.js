// prevueParty content script (all pages, all frames).
// 1. Top frame: spots a #prevueparty=<id> invite link and offers a "Join party" button.
// 2. Any frame with a <video>: once the side panel attaches it to a party, reports local
//    play / pause / seek and applies the party's playback state.

(() => {
  if (window.__prevuerParty) return;
  window.__prevuerParty = true;

  const PARAM = 'prevueparty'; // keep in sync with LINK_PARAM in lib/party.js
  const SEEK_TOLERANCE = 1.5; // seconds of drift before we jump the player
  const ECHO_GUARD_MS = 900; // ignore the events our own play()/pause()/seek cause

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);

  // ---------- invites ----------
  function readInvite(href) {
    try {
      const u = new URL(href);
      const fromHash = new URLSearchParams(u.hash.slice(1)).get(PARAM);
      return fromHash || u.searchParams.get(PARAM);
    } catch {
      return null;
    }
  }

  function showInvite(partyId) {
    if (document.getElementById('prevuer-invite')) return;
    const host = document.createElement('div');
    host.id = 'prevuer-invite';
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .box { font: 13px/1.35 system-ui, -apple-system, sans-serif; color: #1b1b1b; background: #fff;
               border-radius: 16px; box-shadow: 0 6px 24px rgba(0,0,0,.28); padding: 14px 16px; width: 250px; }
        .title { font-weight: 600; margin: 0 0 4px; }
        .msg { margin: 0 0 12px; color: #5c5c5c; }
        .row { display: flex; gap: 8px; }
        button { font: inherit; border: 0; border-radius: 999px; padding: 8px 14px; cursor: pointer; }
        .join { background: #000; color: #fff; flex: 1; }
        .join:hover { background: #333; }
        .later { background: #f3f3ff; color: #5c5c5c; }
      </style>
      <div class="box" role="dialog" aria-label="prevueParty invite">
        <p class="title">You're invited to a prevueParty</p>
        <p class="msg">Watch together with chat and synced playback.</p>
        <div class="row"><button class="join">Join party</button><button class="later">Not now</button></div>
      </div>`;
    root.querySelector('.later').addEventListener('click', () => host.remove());
    root.querySelector('.join').addEventListener('click', async () => {
      const res = await send({ type: 'party:join', partyId });
      if (res?.opened) {
        host.remove();
      } else {
        root.querySelector('.msg').textContent = 'Click the prevueR icon in your toolbar to open the party chat.';
        root.querySelector('.join').remove();
        root.querySelector('.later').textContent = 'OK';
      }
    });
    (document.body || document.documentElement).appendChild(host);
  }

  if (window === window.top) {
    // Record the invite straight away: streaming sites often redirect and drop the hash.
    const invite = readInvite(location.href);
    if (invite) send({ type: 'party:invite', partyId: invite });
    const offer = async () => {
      const partyId = invite || (await send({ type: 'party:invite?' }))?.partyId;
      if (partyId) showInvite(partyId);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', offer, { once: true });
    else offer();
  }

  // ---------- playback sync ----------
  let attached = false;
  let video = null;
  let guardUntil = 0;
  let pending = null;
  let poll = 0;

  // The main player is the biggest <video> on the page.
  function findVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  const onLocal = (e) => {
    if (!attached || Date.now() < guardUntil) return;
    // play/pause/seeked arrive in bursts (a seek fires pause, seeked, play); report the settled state.
    clearTimeout(pending);
    const event = e.type === 'seeked' ? 'seeked' : e.type;
    pending = setTimeout(() => {
      if (!video) return;
      send({ type: 'party:local', state: video.paused ? 'paused' : 'playing', time: video.currentTime, event });
    }, 250);
  };

  function bind() {
    const next = findVideo();
    if (next === video) return;
    for (const ev of ['play', 'pause', 'seeked']) {
      video?.removeEventListener(ev, onLocal);
      next?.addEventListener(ev, onLocal);
    }
    video = next;
  }

  function attach() {
    attached = true;
    bind();
    clearInterval(poll);
    poll = setInterval(bind, 1000); // players get swapped (next episode, ads, SPA navigation)
  }

  function detach() {
    attached = false;
    clearInterval(poll);
    for (const ev of ['play', 'pause', 'seeked']) video?.removeEventListener(ev, onLocal);
    video = null;
  }

  async function apply({ state, time, seek = true }) {
    bind();
    if (!video) return false;
    guardUntil = Date.now() + ECHO_GUARD_MS;
    if (seek && Math.abs(video.currentTime - time) > SEEK_TOLERANCE) video.currentTime = time;
    if (state === 'playing' && video.paused) await video.play().catch(() => {});
    if (state === 'paused' && !video.paused) video.pause();
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'party:attach') {
      attach();
      if (!video) return false; // let a frame that has the video answer
      sendResponse({ hasVideo: true, state: video.paused ? 'paused' : 'playing', time: video.currentTime });
    } else if (msg?.type === 'party:detach') {
      detach();
    } else if (msg?.type === 'party:apply') {
      bind();
      if (!video) return false;
      apply(msg).then((ok) => sendResponse({ ok, time: video?.currentTime }));
      return true;
    }
    return false;
  });
})();
