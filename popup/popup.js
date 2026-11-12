// prevueR popup: screens, navigation and search flow.

import { getSettings, saveSettings, getHistory, getHistoryEntry, addHistory } from '../lib/storage.js';
import { PROVIDERS, providerNeedsKey, generateSummary } from '../lib/ai.js';
import { searchVideos } from '../lib/youtube.js';
import { getWatchedPage } from '../lib/trakt.js';
import { detectFromActiveTab } from '../lib/autofill.js';
import { parseQuery, episodeCode, describe, formatDate } from '../lib/media.js';
import { PrevueRError } from '../lib/errors.js';

const LINKS = {
  privacy: 'https://atitaninc.com/prevuer/privacypolicy',
  faq: 'https://atitaninc.com/prevuer/faq',
  supportEmail: 'info@atitaninc.com',
  shortcuts: 'chrome://extensions/shortcuts',
};
const KEY_LINKS = {
  youtube: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
  trakt: 'https://trakt.tv/oauth/applications',
};
const HISTORY_PREVIEW_ROWS = 8;

// The Figma frame is 350 x 500. Chrome caps popups at 800 x 600, so the window can grow
// up to that; the frame zooms to fit the tighter axis and stretches along the other.
const WIN = { w: 350, h: 500, maxW: 800, maxH: 600 };
const SIZE_PRESETS = [
  ['compact', 'Compact', 350, 500],
  ['large', 'Large', 420, 600],
  ['wide', 'Wide', 800, 600],
];
const SIZE_CACHE = 'prevuer.size'; // localStorage copy so the popup opens at the right size before storage loads

const app = document.getElementById('app');
const asset = (name) => `../assets/${name}`;
let settings = null;
let renderToken = 0; // bumps on every navigation so late async results don't paint stale screens
let winSize = [WIN.w, WIN.h];

// ---------- tiny DOM helpers ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
const $ = (root, sel) => root.querySelector(sel);
const $$ = (root, sel) => [...root.querySelectorAll(sel)];

function openTab(url) {
  chrome.tabs.create({ url });
}

// ---------- shared fragments ----------
const logo = (extra = '') =>
  `<span class="logo ${extra}"><img class="logo-dot" src="${asset('logo-ellipse-dark.svg')}" alt=""><img class="logo-img" src="${asset('logo.png')}" alt=""></span>`;

const brandBar = () => `<div class="brand"><p class="brand-name">prevueR</p>${logo()}</div>`;

const supportFooter = () => `
  <footer class="ftr">
    <a class="support" href="mailto:${LINKS.supportEmail}" target="_blank" rel="noopener">
      <span class="support-label">Contact Support</span>
      <span class="support-mail"><img src="${asset('icon-email.svg')}" alt="">${LINKS.supportEmail}</span>
    </a>
  </footer>`;

const homeButton = (cls) =>
  `<button class="nav-home ${cls}" data-go="home" aria-label="Home"><img class="ico" src="${asset('icon-home.svg')}" alt=""></button>`;

const typeIcon = (type) => {
  if (type === 'tv') return `<img class="t-tv" src="${asset('icon-tv.svg')}" alt="TV">`;
  if (type === 'sport') return `<img class="t-sport" src="${asset('icon-sport.svg')}" alt="Sport">`;
  return `<img class="t-movie" src="${asset('icon-movie.svg')}" alt="Movie">`;
};

function historyRow(item, idx) {
  return `
    <div class="hrow">
      <div class="hrow-data">
        ${typeIcon(item.type)}
        <span class="c-title" title="${esc(item.title)}">${esc(item.title)}</span>
        <span class="c-code">${esc(episodeCode(item))}</span>
        <span class="c-date">${esc(formatDate(item.date))}</span>
      </div>
      <button class="btn-dark view-btn" data-view="${idx}">View</button>
    </div>`;
}

const columnHeads = () => `
  <div class="colheads">
    <span class="tag col-type">Type</span>
    <span class="tag col-title">Title</span>
    <span class="tag col-code">S#E##</span>
    <span class="tag col-date">Date</span>
  </div>`;

// ---------- navigation ----------
const screens = {};

async function go(name, params = {}) {
  renderToken += 1;
  closeDialog();
  const node = await screens[name](params, renderToken);
  node.dataset.screen = name;
  app.replaceChildren(node);
  node.addEventListener('click', (e) => {
    const target = e.target.closest('[data-go]');
    if (target) {
      e.preventDefault();
      go(target.dataset.go);
    }
  });
  const focus = $(node, '[autofocus]');
  if (focus) focus.focus();
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'light';
}

// ---------- window size ----------
function clampSize(w, h) {
  const clamp = (v, min, max, dflt) => Math.round(Math.min(max, Math.max(min, Number(v) || dflt)));
  return [clamp(w, WIN.w, WIN.maxW, WIN.w), clamp(h, WIN.h, WIN.maxH, WIN.h)];
}

function applySize(w, h) {
  winSize = clampSize(w, h);
  const [cw, ch] = winSize;
  const scale = Math.min(cw / WIN.w, ch / WIN.h);
  const root = document.documentElement.style;
  root.setProperty('--win-w', `${cw}px`);
  root.setProperty('--win-h', `${ch}px`);
  root.setProperty('--scale', String(scale));
  root.setProperty('--frame-w', `${cw / scale}px`);
  root.setProperty('--frame-h', `${ch / scale}px`);
  return winSize;
}

async function saveSize(w, h) {
  const [cw, ch] = applySize(w, h);
  try { localStorage.setItem(SIZE_CACHE, JSON.stringify([cw, ch])); } catch { /* storage blocked */ }
  settings = await saveSettings({ windowW: cw, windowH: ch });
  syncSizeButtons();
}

function syncSizeButtons() {
  $$(document, '[data-size]').forEach((b) => {
    const [, , w, h] = SIZE_PRESETS.find((p) => p[0] === b.dataset.size);
    b.setAttribute('aria-pressed', String(w === winSize[0] && h === winSize[1]));
  });
}

// Bottom-left corner grip: Chrome anchors the popup's top-right to the toolbar icon,
// so the window grows left and down.
function mountResizeGrip() {
  const grip = el(`<div class="resize-grip" role="separator" tabindex="0" aria-label="Resize window"
    title="Drag to resize · double-click to reset"></div>`);
  let start = null;
  let next = null;
  let frame = 0;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    start = { x: e.screenX, y: e.screenY, w: winSize[0], h: winSize[1] };
    next = [...winSize];
    document.documentElement.classList.add('is-resizing');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!start) return;
    next = [start.w - (e.screenX - start.x), start.h + (e.screenY - start.y)];
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => applySize(...next));
  });
  const end = () => {
    if (!start) return;
    start = null;
    cancelAnimationFrame(frame);
    document.documentElement.classList.remove('is-resizing');
    saveSize(...next);
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('dblclick', () => saveSize(WIN.w, WIN.h));
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 50 : 10;
    const d = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowDown: [0, step], ArrowUp: [0, -step] }[e.key];
    if (!d) return;
    e.preventDefault();
    saveSize(winSize[0] + d[0], winSize[1] + d[1]);
  });
  document.body.appendChild(grip);
}

// ---------- error dialog ----------
function closeDialog() {
  document.querySelectorAll('.modal, .player').forEach((m) => m.remove());
}

function showError(err) {
  closeDialog();
  const missing = err?.kind === 'missing-key';
  const msg = missing && /API Keys? have not been set/i.test(err.message)
    ? 'Your API Keys have not been set<br>visit “API’s” in Settings'
    : esc(err?.message || 'Something went wrong. Please try again.');
  const long = msg.length > 70;
  const modal = el(`
    <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-m">
      <div class="dialog">
        <p class="dialog-title" id="dlg-t">ERROR:</p>
        <p class="dialog-msg ${long ? 'is-long' : ''}" id="dlg-m">${msg}</p>
        <button class="dialog-btn">Visit API Settings</button>
      </div>
    </div>`);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeDialog();
  });
  $(modal, '.dialog-btn').addEventListener('click', () => go('settingsApi'));
  app.firstElementChild?.appendChild(modal);
  $(modal, '.dialog-btn').focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.modal, .player')) {
    e.preventDefault();
    closeDialog();
  }
});

// ---------- in-popup YouTube player ----------
function openPlayer(video) {
  closeDialog();
  const id = encodeURIComponent(video.id);
  const player = el(`
    <div class="player" role="dialog" aria-modal="true" aria-label="${esc(video.title)}">
      <div class="player-box">
        <div class="player-bar">
          <p class="player-title" title="${esc(video.title)}">${esc(video.title)}</p>
          <button class="player-close" aria-label="Close video">&times;</button>
        </div>
        <iframe class="player-frame" src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1"
          title="${esc(video.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
        <div class="player-foot">
          <span class="player-channel">${esc(video.channel)}</span>
          <a class="btn-dark player-open" href="https://www.youtube.com/watch?v=${id}" target="_blank" rel="noopener">Open on YouTube</a>
        </div>
      </div>
    </div>`);
  player.addEventListener('click', (e) => {
    if (e.target === player) closeDialog();
  });
  $(player, '.player-close').addEventListener('click', closeDialog);
  app.firstElementChild?.appendChild(player);
  $(player, '.player-close').focus();
}

// ---------- search flow ----------
async function runSearch(media) {
  settings = await getSettings();
  if (!media.title) return;
  if (providerNeedsKey(settings) && !settings.aiKey) {
    showError(new PrevueRError('Your API Keys have not been set', { kind: 'missing-key' }));
    return;
  }
  await go('result', { media, loading: true });
  const token = renderToken;

  const [sum, vids] = await Promise.allSettled([
    generateSummary(media, settings),
    settings.youtubeKey ? searchVideos(media, settings) : Promise.resolve(null),
  ]);
  if (token !== renderToken) return; // user navigated away

  const summary = sum.status === 'fulfilled' ? sum.value : null;
  const videos = vids.status === 'fulfilled' ? vids.value : null;
  const screen = app.firstElementChild;
  fillSummary(screen, summary, sum.status === 'rejected');
  fillVideos(screen, videos, { failed: vids.status === 'rejected', missingKey: !settings.youtubeKey });

  if (summary || (videos && videos.length)) {
    await addHistory({
      title: media.title,
      season: media.season ?? null,
      episode: media.episode ?? null,
      type: media.type || 'movie',
      summary: summary || '',
      videos: videos || [],
    });
  }
  const failure = [sum, vids].find((r) => r.status === 'rejected');
  if (failure) showError(failure.reason);
}

function fillSummary(screen, summary, failed) {
  const card = $(screen, '.card-summary');
  const text = $(card, '.summary-text');
  const btn = $(card, '.more-btn');
  text.classList.remove('is-loading-text');
  if (summary) {
    text.textContent = summary;
    text.dataset.filled = '';
    requestAnimationFrame(() => syncMoreButtons(screen));
  } else {
    text.textContent = failed ? 'The AI summary could not be generated for this search.' : 'No summary saved for this search.';
    btn.disabled = true;
  }
}

function fillVideos(screen, videos, { failed = false, missingKey = false } = {}) {
  const card = $(screen, '.card-trailers');
  const gallery = $(card, '.gallery');
  const btn = $(card, '.more-btn');
  if (videos && videos.length) {
    gallery.replaceChildren(
      ...videos.map((v, i) =>
        el(`<a class="vid" data-vid="${i}" href="https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}" target="_blank" rel="noopener" title="${esc(v.title)}${v.channel ? ` · ${esc(v.channel)}` : ''}">
              <img src="${esc(v.thumb)}" alt="${esc(v.title)}" loading="lazy">
            </a>`),
      ),
    );
    // Plain click plays inside the popup; Cmd/Ctrl/middle-click still opens a YouTube tab.
    gallery.onclick = (e) => {
      const a = e.target.closest('[data-vid]');
      if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      openPlayer(videos[Number(a.dataset.vid)]);
    };
    gallery.dataset.count = String(videos.length);
    requestAnimationFrame(() => syncMoreButtons(screen));
    return;
  }
  btn.disabled = true;
  let note = 'No trailers or clips found.';
  if (missingKey) note = 'Add a YouTube API Key in <button data-go="settingsApi">Settings › API’s</button> to see trailers &amp; clips.';
  else if (failed) note = 'Trailers &amp; clips could not be loaded.';
  gallery.replaceChildren(el(`<p class="card-note">${note}</p>`));
}

// "Read More" / "View More" only enable when there's something hidden, which depends on window width.
function syncMoreButtons(screen = app.firstElementChild) {
  if (!screen) return;
  const text = $(screen, '.card-summary:not(.is-open) .summary-text[data-filled]');
  if (text) $(screen, '[data-toggle="summary"]').disabled = text.scrollHeight <= text.clientHeight + 1;
  const gallery = $(screen, '.card-trailers:not(.is-open) .gallery[data-count]');
  if (gallery) {
    const perRow = Math.max(1, Math.floor((gallery.clientWidth + 8) / 96)); // 88px tile + 8px gap
    $(screen, '[data-toggle="trailers"]').disabled = Number(gallery.dataset.count) <= perRow;
  }
}

function resultCards() {
  return `
    <section class="card card-summary">
      <h2 class="card-title">Summary</h2>
      <p class="summary-text is-loading-text">Generating your prevueR summary…</p>
      <button class="btn-dark more-btn" data-toggle="summary" aria-expanded="false">Read More</button>
    </section>
    <section class="card card-trailers">
      <h2 class="card-title">Trailers &amp; Clips</h2>
      <div class="gallery">
        <span class="vid is-loading"></span><span class="vid is-loading"></span><span class="vid is-loading"></span>
      </div>
      <button class="btn-dark more-btn" data-toggle="trailers" aria-expanded="false">View More</button>
    </section>`;
}

function wireResultToggles(node) {
  $(node, '[data-toggle="summary"]').addEventListener('click', (e) => {
    const card = $(node, '.card-summary');
    const open = card.classList.toggle('is-open');
    e.currentTarget.textContent = open ? 'Read Less' : 'Read More';
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  $(node, '[data-toggle="trailers"]').addEventListener('click', (e) => {
    const card = $(node, '.card-trailers');
    const open = card.classList.toggle('is-open');
    e.currentTarget.textContent = open ? 'View Less' : 'View More';
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
}

// ---------- Home ----------
screens.home = async () => {
  const node = el(`
    <main class="screen">
      <header class="hdr hdr-home">
        ${logo('logo-center')}
        <h1 class="home-title">prevueR</h1>
        <p class="home-tagline">Previewing Your Favorite Movies,<br>Series &amp; TV Shows Made Easy</p>
        <button class="home-settings" data-go="settings" aria-label="Settings"><img src="${asset('icon-settings.svg')}" alt=""></button>
      </header>
      <div class="main">
        <div class="home-actions">
          <form class="search-pill" role="search">
            <img src="${asset('icon-search.svg')}" alt="">
            <input type="search" name="q" placeholder="Enter Movie or Show Title" aria-label="Enter movie or show title" autocomplete="off" autofocus>
          </form>
          <button class="home-btn home-btn--auto" data-action="auto"><img src="${asset('icon-auto-search.svg')}" alt=""><span class="lbl">Auto Search</span></button>
          <button class="home-btn home-btn--history" data-go="history"><img src="${asset('icon-history.svg')}" alt=""><span class="lbl">History</span></button>
          <button class="home-btn home-btn--watched" data-go="watched"><img src="${asset('icon-watched.svg')}" alt=""><span class="lbl">Watched</span></button>
        </div>
      </div>
      ${supportFooter()}
    </main>`);
  $(node, 'form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.currentTarget.q.value.trim();
    if (!q) return;
    const p = parseQuery(q);
    runSearch({ title: p.title || q, season: p.season, episode: p.episode, type: p.type });
  });
  $(node, '[data-action="auto"]').addEventListener('click', () => go('create', { autofill: true }));
  return node;
};

// ---------- Create Search ----------
screens.create = async (params) => {
  const node = el(`
    <main class="screen">
      <header class="hdr">${brandBar()}</header>
      <div class="main">
        ${homeButton('create-nav-home')}
        <span class="nav-title create-title"><img class="nav-ico ico" src="${asset('icon-history-small.svg')}" alt="">Create Search</span>
        <form class="panel form-card" novalidate>
          <button type="button" class="autofill-btn" data-action="autofill" title="Fill the form from the page you're viewing">
            <img src="${asset('icon-autofill.svg')}" alt=""><span>Autofill Search</span>
          </button>
          <span class="autofill-status" role="status"></span>

          <div class="field field-title">
            <span class="tag">Title</span><span class="field-req">*required</span>
            <input class="input" name="title" placeholder=" Movie or Show Title" aria-label="Title" autocomplete="off">
          </div>
          <div class="field field-season">
            <span class="tag">Season</span><span class="field-req">*required</span>
            <input class="input" name="season" type="number" min="0" inputmode="numeric" placeholder="Season Number" aria-label="Season number">
            <button type="button" class="na-btn" data-na="season" aria-pressed="false">N/A</button>
          </div>
          <div class="field field-episode">
            <span class="tag">Episode</span><span class="field-req">*required</span>
            <input class="input" name="episode" type="number" min="0" inputmode="numeric" placeholder="Episode Number" aria-label="Episode number">
            <button type="button" class="na-btn" data-na="episode" aria-pressed="false">N/A</button>
          </div>
          <div class="field field-type">
            <span class="tag">Type</span><span class="field-req">*required</span>
            <div class="type-options" role="group" aria-label="Media type">
              <button type="button" class="type-opt type-opt--movie" data-type="movie" aria-pressed="false" aria-label="Movie"><img class="opt-art" src="${asset('option-movie.svg')}" alt=""></button>
              <button type="button" class="type-opt type-opt--tv" data-type="tv" aria-pressed="false" aria-label="TV show"><img class="opt-art" src="${asset('option-tv.svg')}" alt=""></button>
              <button type="button" class="type-opt type-opt--sport" data-type="sport" aria-pressed="false" aria-label="Sport or event"><img src="${asset('icon-sport.svg')}" alt=""></button>
            </div>
          </div>
          <button type="submit" class="btn-dark form-submit">Search prevueR</button>
        </form>
      </div>
      ${supportFooter()}
    </main>`);

  const form = $(node, 'form');
  const status = $(node, '.autofill-status');
  const state = { type: null };

  const setNA = (field, on) => {
    const btn = $(form, `[data-na="${field}"]`);
    btn.setAttribute('aria-pressed', String(on));
    form[field].disabled = on;
    if (on) form[field].value = '';
    $(form, `.field-${field}`).classList.remove('is-invalid');
  };
  const setType = (type) => {
    state.type = type;
    $$(form, '.type-opt').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.type === type)));
    $(form, '.field-type').classList.remove('is-invalid');
  };

  $$(form, '[data-na]').forEach((b) =>
    b.addEventListener('click', () => setNA(b.dataset.na, b.getAttribute('aria-pressed') !== 'true')),
  );
  $$(form, '.type-opt').forEach((b) => b.addEventListener('click', () => setType(b.dataset.type)));
  form.addEventListener('input', (e) => e.target.closest('.field')?.classList.remove('is-invalid'));

  const autofill = async () => {
    const btn = $(form, '.autofill-btn');
    btn.classList.add('is-busy');
    status.textContent = 'Reading this tab…';
    const media = await detectFromActiveTab();
    btn.classList.remove('is-busy');
    if (!media) {
      status.textContent = 'Nothing to autofill on this tab';
      return;
    }
    form.title.value = media.title;
    if (media.season != null) { setNA('season', false); form.season.value = media.season; } else if (media.type && media.type !== 'tv') setNA('season', true);
    if (media.episode != null) { setNA('episode', false); form.episode.value = media.episode; } else if (media.type && media.type !== 'tv') setNA('episode', true);
    if (media.type) setType(media.type);
    status.textContent = media.source === 'cache' ? 'Filled from your last detected title' : `Filled from ${media.source}`;
  };
  $(form, '[data-action="autofill"]').addEventListener('click', autofill);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = form.title.value.trim();
    const read = (f) => {
      if (form[f].disabled) return { ok: true, value: null };
      const v = form[f].value.trim();
      return { ok: /^\d+$/.test(v), value: v === '' ? null : Number(v) };
    };
    const season = read('season');
    const episode = read('episode');
    const checks = { title: !!title, season: season.ok, episode: episode.ok, type: !!state.type };
    Object.entries(checks).forEach(([k, ok]) => $(form, `.field-${k}`).classList.toggle('is-invalid', !ok));
    if (!Object.values(checks).every(Boolean)) {
      status.textContent = 'Fill in the required fields, or tap N/A';
      return;
    }
    runSearch({ title, season: season.value, episode: episode.value, type: state.type });
  });

  if (params.autofill) setTimeout(autofill, 0);
  return node;
};

// ---------- Search Result ----------
screens.result = async ({ media }) => {
  const node = el(`
    <main class="screen">
      <header class="hdr hdr-result">
        ${brandBar()}
        ${homeButton('result-home')}
        <form class="result-pill" role="search">
          <img src="${asset('icon-search.svg')}" alt="">
          <input type="search" name="q" value="${esc(describe(media))}" aria-label="Search again" autocomplete="off">
        </form>
      </header>
      <div class="main scroll result-main">${resultCards()}</div>
    </main>`);
  wireResultToggles(node);
  $(node, '.result-pill').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.currentTarget.q.value.trim();
    if (!q) return;
    const p = parseQuery(q);
    const sameTitle = p.title.toLowerCase() === media.title.toLowerCase();
    runSearch({ title: p.title || q, season: p.season, episode: p.episode, type: p.type || (sameTitle ? media.type : null) });
  });
  return node;
};

// ---------- Past Search ----------
screens.past = async ({ id, from = 'history' }) => {
  const entry = await getHistoryEntry(id);
  if (!entry) return screens.history();
  const node = el(`
    <main class="screen">
      <header class="hdr hdr-result">
        ${brandBar()}
        <div class="past-nav">
          <button class="nav-back-btn" data-go="${from}" aria-label="Back"><img class="ico" src="${asset('icon-back-small.svg')}" alt=""></button>
          <img class="past-ico ico" src="${asset('icon-history-nav.svg')}" alt="">
          <span class="past-title" title="${esc(describe(entry))}">${esc(describe(entry))}</span>
        </div>
      </header>
      <div class="main scroll result-main">${resultCards()}</div>
    </main>`);
  wireResultToggles(node);
  fillSummary(node, entry.summary, false);
  fillVideos(node, entry.videos, {});
  return node;
};

// ---------- History (recent) ----------
screens.history = async () => {
  const items = (await getHistory()).slice(0, HISTORY_PREVIEW_ROWS);
  const node = el(`
    <main class="screen">
      <header class="hdr">${brandBar()}</header>
      <div class="main">
        ${homeButton('history-nav-home')}
        <span class="nav-title history-title"><img class="nav-ico ico" src="${asset('icon-history-small.svg')}" alt="">History</span>
        <section class="panel history-panel">
          <div class="surface"></div>
          ${columnHeads()}
          <div class="rows">
            ${items.length ? items.map(historyRow).join('') : '<p class="empty">Your prevueR searches will show up here.</p>'}
          </div>
          <button class="btn-dark full-btn" data-go="fullHistory">Full History</button>
        </section>
      </div>
      ${supportFooter()}
    </main>`);
  $$(node, '[data-view]').forEach((b) =>
    b.addEventListener('click', () => go('past', { id: items[Number(b.dataset.view)].id, from: 'history' })),
  );
  return node;
};

// ---------- Full History ----------
screens.fullHistory = async () => {
  const items = await getHistory();
  const node = el(`
    <main class="screen">
      <header class="hdr hdr-list">
        ${brandBar()}
        <div class="list-nav">
          <button class="nav-back-btn" data-go="history" aria-label="Back"><img class="ico" src="${asset('icon-back-small.svg')}" alt=""></button>
          <img class="list-ico-history ico" src="${asset('icon-history-nav.svg')}" alt="">
          <span class="list-title">History</span>
        </div>
        ${columnHeads()}
      </header>
      <div class="main scroll list-main">
        <div class="list-inner">
          <div class="surface"></div>
          <div class="rows">
            ${items.length ? items.map(historyRow).join('') : '<p class="empty">No searches yet. Search a title from Home to start your history.</p>'}
          </div>
        </div>
      </div>
    </main>`);
  $$(node, '[data-view]').forEach((b) =>
    b.addEventListener('click', () => go('past', { id: items[Number(b.dataset.view)].id, from: 'fullHistory' })),
  );
  return node;
};

// ---------- Watched (Trakt) ----------
screens.watched = async (_params, token) => {
  settings = await getSettings();
  const node = el(`
    <main class="screen">
      <header class="hdr hdr-list">
        ${brandBar()}
        <div class="list-nav">
          <button class="nav-back-btn" data-go="home" aria-label="Back"><img class="ico" src="${asset('icon-back-small.svg')}" alt=""></button>
          <span class="list-title">
            <span class="eye"><img class="eye-outer ico" src="${asset('icon-eye-outer.svg')}" alt=""><img class="eye-pupil ico" src="${asset('icon-eye-pupil.svg')}" alt=""></span>
            Watched
          </span>
        </div>
        ${columnHeads()}
      </header>
      <div class="main scroll list-main">
        <div class="list-inner">
          <div class="surface"></div>
          <div class="rows"></div>
          <p class="list-more" hidden></p>
        </div>
      </div>
    </main>`);

  const rows = $(node, '.rows');
  const more = $(node, '.list-more');
  const scroller = $(node, '.list-main');
  const items = [];
  let page = 0;
  let hasMore = true;
  let loading = false;

  const load = async () => {
    if (loading || !hasMore) return;
    loading = true;
    more.hidden = false;
    more.textContent = 'Loading from Trakt…';
    try {
      const res = await getWatchedPage(settings, page + 1);
      if (token !== renderToken) return;
      page += 1;
      hasMore = res.hasMore;
      const start = items.length;
      items.push(...res.items);
      rows.insertAdjacentHTML('beforeend', res.items.map((it, i) => historyRow(it, start + i)).join(''));
      if (!items.length) rows.innerHTML = '<p class="empty">Nothing in your Trakt watch history yet.</p>';
      more.hidden = !hasMore;
      more.textContent = hasMore ? 'Scroll for more' : '';
      // keep filling until the list can scroll
      if (hasMore && scroller.scrollHeight <= scroller.clientHeight) setTimeout(load, 0);
    } catch (err) {
      if (token !== renderToken) return;
      hasMore = false;
      more.hidden = true;
      if (err.kind === 'missing-key' && !items.length) {
        rows.innerHTML = '<p class="empty">Connect Trakt to see what you’ve watched: add your Trakt Client ID and username in <button data-go="settingsApi">Settings › API’s</button>.</p>';
      } else {
        if (!items.length) rows.innerHTML = '<p class="empty">Your Trakt history couldn’t be loaded.</p>';
        showError(err);
      }
    } finally {
      loading = false;
    }
  };

  rows.addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (!b) return;
    const it = items[Number(b.dataset.view)];
    runSearch({ title: it.title, season: it.season, episode: it.episode, type: it.type });
  });
  scroller.addEventListener('scroll', () => {
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 40) load();
  });
  setTimeout(load, 0);
  return node;
};

// ---------- Settings ----------
function settingsFrame({ back = 'subpage', panel, tall = false }) {
  const backNav =
    back === 'overview'
      ? `<div class="settings-back-home">
           <img class="ico" src="${asset('nav-back-home.svg')}" alt="">
           <button class="sbh-back" data-go="home" aria-label="Back"></button>
           <button class="sbh-home" data-go="home" aria-label="Home"></button>
         </div>`
      : `<button class="settings-back" data-go="settings"><img class="ico" src="${asset('icon-back.svg')}" alt=""><span>Back</span></button>`;
  return el(`
    <main class="screen">
      <header class="hdr">
        ${logo('logo-center')}
        ${backNav}
      </header>
      <div class="main ${tall ? 'scroll settings-main' : ''}">
        <div class="settings-heading"><img class="ico" src="${asset('icon-settings-heading.svg')}" alt=""><span>Settings</span></div>
        ${panel}
      </div>
      ${supportFooter()}
    </main>`);
}

screens.settings = async () => {
  const items = [
    ['settingsApi', 'API’s', 10],
    ['settingsAppearance', 'Appearance', 28],
    ['settingsPrivacy', 'Privacy', 50],
    ['settingsShortcut', 'Shortcut', 72],
    ['settingsSupport', 'Support &amp; FAQ', 94],
  ];
  return settingsFrame({
    back: 'overview',
    panel: `
      <nav class="panel settings-panel" style="height:114px" aria-label="Settings">
        ${items.map(([to, label, top]) => `<button class="menu-item" data-go="${to}" style="top:${top}px"><span>${label}</span><img src="${asset('icon-chevron-right.svg')}" alt=""></button>`).join('')}
      </nav>`,
  });
};

// Shared by Settings › API's and the first-launch Welcome screen. `help` adds "get a key" links.
function apiFormHtml({ cls = '', title = 'API', submit = 'Save', help = false, skip = false } = {}) {
  const opts = Object.entries(PROVIDERS)
    .map(([k, p]) => `<option value="${k}" ${settings.aiProvider === k ? 'selected' : ''}>${esc(p.label)}</option>`)
    .join('');
  const link = (key, label) => (help ? `<button type="button" class="key-link" data-key-link="${key}">${label} ↗</button>` : '');
  return `
    <form class="panel settings-panel is-tall ${cls}" autocomplete="off">
      <span class="panel-title">${title}</span>
      <div class="settings-stack">
        <label class="pill-label" for="f-provider">AI provider</label>
        <select class="pill-field" id="f-provider" name="aiProvider">${opts}</select>
        <label class="pill-label" for="f-aikey">AI key</label>
        <input class="pill-field" id="f-aikey" name="aiKey" type="password" placeholder="Chatbot/AI API Key" value="${esc(settings.aiKey)}">
        ${link('ai', 'Get an AI key')}
        <label class="pill-label" for="f-base" data-show="base">Server URL</label>
        <input class="pill-field" id="f-base" name="aiBaseUrl" data-show="base" placeholder="localhost:8080/v1" value="${esc(settings.aiBaseUrl)}">
        <label class="pill-label" for="f-model">Model</label>
        <input class="pill-field" id="f-model" name="aiModel" placeholder="Model (auto)" value="${esc(settings.aiModel)}">
        <label class="pill-label" for="f-yt">YouTube</label>
        <input class="pill-field" id="f-yt" name="youtubeKey" type="password" placeholder="Youtube API Key" value="${esc(settings.youtubeKey)}">
        ${link('youtube', 'Get a YouTube key')}
        <label class="pill-label" for="f-tid">Trakt${help ? ' (optional)' : ''}</label>
        <input class="pill-field" id="f-tid" name="traktClientId" type="password" placeholder="Trakt Client ID" value="${esc(settings.traktClientId)}">
        <input class="pill-field" id="f-tuser" name="traktUsername" placeholder="Trakt Username" aria-label="Trakt username" value="${esc(settings.traktUsername)}">
        ${link('trakt', 'Create a Trakt app')}
        <button type="submit" class="btn-dark">${submit}</button>
        ${skip ? '<button type="button" class="skip-btn" data-action="skip">Skip for now</button>' : ''}
        <p class="save-status" role="status"></p>
      </div>
    </form>`;
}

function wireApiForm(node, onSaved) {
  const form = $(node, 'form');
  const sync = () => {
    const p = PROVIDERS[form.aiProvider.value];
    form.aiKey.disabled = !p.needsKey;
    form.aiKey.placeholder = p.needsKey ? 'Chatbot/AI API Key' : 'No key needed';
    const showBase = form.aiProvider.value === 'localai' || form.aiProvider.value === 'llama';
    $$(form, '[data-show="base"]').forEach((x) => (x.hidden = !showBase));
    form.aiBaseUrl.placeholder = p.base.replace(/^https?:\/\//, '');
    const aiLink = $(form, '[data-key-link="ai"]');
    if (aiLink) aiLink.textContent = p.needsKey ? 'Get an AI key ↗' : 'Set up LocalAI ↗';
  };
  form.aiProvider.addEventListener('change', sync);
  sync();

  $$(form, '[data-key-link]').forEach((b) =>
    b.addEventListener('click', () => {
      const k = b.dataset.keyLink;
      openTab(k === 'ai' ? PROVIDERS[form.aiProvider.value].keyUrl : KEY_LINKS[k]);
    }),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $(form, '.save-status');
    let base = form.aiBaseUrl.value.trim();
    if (base && !/^https?:\/\//.test(base)) base = `http://${base}`;
    if (base) {
      // Match patterns can't carry a port, so ask for the host; it covers every port.
      let pattern;
      try {
        const u = new URL(base);
        pattern = `${u.protocol}//${u.hostname}/*`;
      } catch {
        status.textContent = 'That server URL isn’t valid';
        return;
      }
      const granted = await chrome.permissions.request({ origins: [pattern] }).catch(() => false);
      if (!granted) {
        status.textContent = 'Permission for that server URL was declined';
        return;
      }
    }
    settings = await saveSettings({
      aiProvider: form.aiProvider.value,
      aiKey: form.aiKey.value.trim(),
      aiBaseUrl: base,
      aiModel: form.aiModel.value.trim(),
      youtubeKey: form.youtubeKey.value.trim(),
      traktClientId: form.traktClientId.value.trim(),
      traktUsername: form.traktUsername.value.trim(),
      onboarded: true,
    });
    form.aiBaseUrl.value = base;
    status.textContent = 'Saved';
    setTimeout(() => (status.textContent = ''), 2000);
    onSaved?.();
  });
  return form;
}

screens.settingsApi = async () => {
  settings = await getSettings();
  const node = settingsFrame({ tall: true, panel: apiFormHtml() });
  wireApiForm(node);
  return node;
};

// ---------- Welcome (first launch) ----------
const hasAnyKey = (s) => !!(s.aiKey || s.youtubeKey || s.traktClientId);

screens.welcome = async () => {
  settings = await getSettings();
  const node = el(`
    <main class="screen">
      <header class="hdr">${logo('logo-center')}</header>
      <div class="main scroll welcome-main">
        <h1 class="welcome-title">Welcome to prevueR</h1>
        <p class="welcome-text">Add your API keys to get AI summaries and trailers. Keys are stored only on this device, and you can change them any time in Settings › API’s.</p>
        ${apiFormHtml({ cls: 'welcome-panel', title: 'Set up your API keys', submit: 'Save &amp; Continue', help: true, skip: true })}
      </div>
      ${supportFooter()}
    </main>`);
  wireApiForm(node, () => go('home'));
  $(node, '[data-action="skip"]').addEventListener('click', async () => {
    settings = await saveSettings({ onboarded: true });
    go('home');
  });
  return node;
};

screens.settingsAppearance = async () => {
  settings = await getSettings();
  const node = settingsFrame({
    panel: `
      <section class="panel settings-panel">
        <span class="panel-title">Appearance</span>
        <div class="settings-stack appearance-stack" role="group" aria-label="Theme">
          <button class="theme-btn" data-theme-set="dark" aria-pressed="${settings.theme === 'dark'}">Dark</button>
          <button class="theme-btn" data-theme-set="light" aria-pressed="${settings.theme !== 'dark'}">Light</button>
        </div>
        <span class="panel-title panel-subtitle">Window Size</span>
        <div class="settings-stack appearance-stack size-stack" role="group" aria-label="Window size">
          ${SIZE_PRESETS.map(([k, label]) => `<button class="theme-btn" data-size="${k}" aria-pressed="false">${label}</button>`).join('')}
          <p class="shortcut-hint">or drag the bottom-left corner</p>
        </div>
      </section>`,
  });
  $$(node, '[data-size]').forEach((b) =>
    b.addEventListener('click', () => {
      const [, , w, h] = SIZE_PRESETS.find((p) => p[0] === b.dataset.size);
      saveSize(w, h);
    }),
  );
  setTimeout(syncSizeButtons, 0);
  $$(node, '[data-theme-set]').forEach((b) =>
    b.addEventListener('click', async () => {
      settings = await saveSettings({ theme: b.dataset.themeSet });
      applyTheme();
      $$(node, '[data-theme-set]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    }),
  );
  return node;
};

screens.settingsPrivacy = async () => {
  const node = settingsFrame({
    panel: `
      <section class="panel settings-panel privacy-panel">
        <span class="panel-title">Privacy</span>
        <div class="settings-stack"><button class="btn-dark" data-link="privacy">Read Privacy Policy</button></div>
      </section>`,
  });
  $(node, '[data-link]').addEventListener('click', () => openTab(LINKS.privacy));
  return node;
};

function formatShortcut(s) {
  if (!s) return 'Not set';
  const map = { '⇧': 'shift', '⌘': 'cmd', '⌥': 'option', '⌃': 'ctrl' };
  const parts = /[⇧⌘⌥⌃]/.test(s) ? [...s].map((c) => map[c] || c) : s.split('+');
  return parts.map((p) => p.trim().toLowerCase()).join(' + ');
}

screens.settingsShortcut = async () => {
  let shortcut = '';
  try {
    const cmds = await chrome.commands.getAll();
    shortcut = cmds.find((c) => c.name === '_execute_action')?.shortcut || '';
  } catch { /* commands API unavailable */ }
  const node = settingsFrame({
    panel: `
      <section class="panel settings-panel shortcut-panel">
        <span class="panel-title">Shortcut</span>
        <div class="settings-stack">
          <button class="shortcut-pill" title="Change in Chrome’s keyboard shortcuts">${esc(formatShortcut(shortcut))}</button>
          <p class="shortcut-hint">Tap to change it</p>
        </div>
      </section>`,
  });
  $(node, '.shortcut-pill').addEventListener('click', () => openTab(LINKS.shortcuts));
  return node;
};

screens.settingsSupport = async () => {
  const node = settingsFrame({
    panel: `
      <section class="panel settings-panel support-panel">
        <span class="panel-title">Support &amp; FAQ</span>
        <div class="settings-stack">
          <button class="btn-dark" data-link="support">Support</button>
          <button class="btn-dark" data-link="faq">FAQ</button>
        </div>
      </section>`,
  });
  $(node, '[data-link="support"]').addEventListener('click', () => openTab(`mailto:${LINKS.supportEmail}`));
  $(node, '[data-link="faq"]').addEventListener('click', () => openTab(LINKS.faq));
  return node;
};

// ---------- boot ----------
try {
  const cached = JSON.parse(localStorage.getItem(SIZE_CACHE) || 'null');
  if (Array.isArray(cached)) applySize(...cached);
} catch { /* storage blocked or bad cache */ }
mountResizeGrip();
window.addEventListener('resize', () => syncMoreButtons());

(async () => {
  settings = await getSettings();
  applyTheme();
  applySize(settings.windowW, settings.windowH);
  const start = new URLSearchParams(location.search).get('screen');
  if (start && screens[start]) await go(start);
  else if (!settings.onboarded && !hasAnyKey(settings)) await go('welcome');
  else await go('home');
})();
