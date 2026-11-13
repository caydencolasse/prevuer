// Autofill Search: reads the active tab (streaming sites, IMDb, Wikipedia, Google
// results, YouTube, sports sites...) and works out title / season / episode / type.

import { parseQuery } from './media.js';
import { getLastDetected, setLastDetected } from './storage.js';

// Injected into the page with chrome.scripting, so it must be fully self-contained.
function scrapePage() {
  const out = { title: '', season: null, episode: null, type: null, source: location.hostname, hints: [] };
  const host = location.hostname.replace(/^www\./, '');
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content')?.trim() || '';
  const txt = (sel) => document.querySelector(sel)?.textContent?.trim() || '';

  // 1. schema.org JSON-LD (IMDb, Rotten Tomatoes, TMDB, many news/sports sites)
  const flat = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const stack = [data];
      while (stack.length) {
        const n = stack.pop();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n)) { stack.push(...n); continue; }
        if (n['@graph']) stack.push(n['@graph']);
        flat.push(n);
      }
    } catch { /* ignore malformed JSON-LD */ }
  }
  const typeOf = (n) => [].concat(n['@type'] || []).join(' ');
  const ep = flat.find((n) => /TVEpisode|Episode/.test(typeOf(n)));
  const series = flat.find((n) => /TVSeries|TVSeason|CreativeWorkSeries/.test(typeOf(n)));
  const movie = flat.find((n) => /\bMovie\b/.test(typeOf(n)));
  const sport = flat.find((n) => /SportsEvent|BroadcastEvent|Event/.test(typeOf(n)) && !/Episode/.test(typeOf(n)));
  if (ep) {
    out.type = 'tv';
    out.title = ep.partOfSeries?.name || series?.name || '';
    out.episode = Number(ep.episodeNumber) || null;
    out.season = Number(ep.partOfSeason?.seasonNumber) || null;
    if (!out.title) out.hints.push(ep.name || '');
  } else if (series) {
    out.type = 'tv';
    out.title = series.name || '';
  } else if (movie) {
    out.type = 'movie';
    out.title = movie.name || '';
  } else if (sport && /Sports/.test(typeOf(sport))) {
    out.type = 'sport';
    out.title = sport.name || '';
  }

  // 2. Site-specific readers
  if (/google\./.test(host) && location.pathname.startsWith('/search')) {
    const q = new URLSearchParams(location.search).get('q') || '';
    const panelTitle = txt('[data-attrid="title"]');
    const subtitle = txt('[data-attrid="subtitle"]').toLowerCase();
    out.hints.push(q);
    if (!out.title) out.title = panelTitle || q;
    if (!out.type) {
      if (/tv series|tv program|tv show|series|sitcom|drama series/.test(subtitle)) out.type = 'tv';
      else if (/film|movie/.test(subtitle)) out.type = 'movie';
      else if (/\bvs\.?\b|\bv\.\b|game|match|highlights|score/i.test(q)) out.type = 'sport';
    }
  } else if (/youtube\.com$/.test(host)) {
    const t = txt('h1.ytd-watch-metadata') || document.title.replace(/ - YouTube$/, '');
    out.hints.push(t);
    if (!out.title) out.title = t.replace(/\b(official|final)?\s*(trailer|teaser|clip|promo|highlights?)\b.*$/i, '').replace(/[|(\[].*$/, '').trim();
    if (!out.type && /highlights?/i.test(t)) out.type = 'sport';
  } else if (/imdb\.com$/.test(host)) {
    const h1 = txt('h1');
    if (!out.title) out.title = h1;
    const crumbs = document.body.innerText.slice(0, 4000);
    if (!out.type) out.type = /TV Series|TV Mini Series|Episode aired/i.test(crumbs) ? 'tv' : 'movie';
  } else if (/wikipedia\.org$/.test(host)) {
    const h1 = txt('#firstHeading') || txt('h1');
    if (!out.type) {
      if (/\((?:\d{4} )?(?:american |british )?(?:tv series|television series|miniseries)\)/i.test(h1)) out.type = 'tv';
      else if (/\((?:\d{4} )?(?:\w+ )?film\)/i.test(h1)) out.type = 'movie';
    }
    if (!out.title) out.title = h1.replace(/\s*\([^)]*\)\s*$/, '');
  } else if (/espn\.|nba\.com|nfl\.com|mlb\.com|nhl\.com|fifa\.com|premierleague\.com|ufc\.com|cbssports\.com|bleacherreport\.com|theathletic\.com|foxsports\.com/.test(host)) {
    out.type = out.type || 'sport';
    out.hints.push(txt('h1'));
  } else if (/netflix\.com|hulu\.com|disneyplus\.com|max\.com|primevideo\.com|amazon\.|tv\.apple\.com|peacocktv\.com|paramountplus\.com|crunchyroll\.com/.test(host)) {
    // Players show "Show  S2:E5 Episode name" in the title / overlay
    out.hints.push(txt('[data-uia="video-title"]'), txt('.atvwebplayersdk-title-text'), txt('.atvwebplayersdk-subtitle-text'), txt('h1'));
  }

  // 3. Open Graph + document title as the generic fallback
  const ogTitle = meta('meta[property="og:title"]');
  const ogType = meta('meta[property="og:type"]');
  if (!out.type) {
    if (/video\.movie/.test(ogType)) out.type = 'movie';
    else if (/video\.(episode|tv_show)/.test(ogType)) out.type = 'tv';
  }
  out.hints.push(ogTitle, document.title, decodeURIComponent(location.pathname.replace(/[-_/]+/g, ' ')));
  if (!out.title) {
    const raw = ogTitle || document.title || '';
    out.title = raw.split(/\s+[|•·–—-]\s+/)[0].trim();
  }
  out.hints = out.hints.filter(Boolean).map((h) => h.slice(0, 300));
  return out;
}

const NOISE = /^(new tab|google|youtube|netflix|home|watch|search|untitled)$/i;

// Returns { title, season, episode, type, source } or null when nothing usable was found.
export async function detectFromActiveTab() {
  let scraped = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null && /^https?:/.test(tab.url || 'https:')) {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapePage });
      scraped = res?.result || null;
    }
  } catch {
    scraped = null; // chrome:// pages, the Web Store and PDFs can't be scripted
  }

  if (scraped) {
    const fromTitle = parseQuery(scraped.title);
    let season = scraped.season ?? fromTitle.season;
    let episode = scraped.episode ?? fromTitle.episode;
    if (season == null || episode == null) {
      for (const h of scraped.hints) {
        const p = parseQuery(h);
        if (season == null && p.season != null) season = p.season;
        if (episode == null && p.episode != null) episode = p.episode;
      }
    }
    const title = fromTitle.title || scraped.title;
    if (title && !NOISE.test(title)) {
      const type = scraped.type || (season != null || episode != null ? 'tv' : null);
      const media = { title, season: season ?? null, episode: episode ?? null, type, source: scraped.source };
      await setLastDetected(media);
      return media;
    }
  }
  const cached = await getLastDetected();
  return cached ? { ...cached, source: 'cache' } : null;
}
