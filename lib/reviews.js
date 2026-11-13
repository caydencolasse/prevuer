// Rotten Tomatoes scores + critic reviews via the "RottenTomato" RapidAPI.
//   GET /?name=<movie>        -> tomatometer_score, audience_score, critics_consensus, critic_reviews[]
//   GET /tv-show?name=<show>  -> tomatometer_score, audience_score, seasons_info[] (per-season critics_score)

import { PrevueRError, fetchJson } from './errors.js';
import { RT_RAPIDAPI } from './config.js';

const MAX_QUOTES = 3;

const score = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || Number.isNaN(n) ? null : Math.round(n);
};

// Returns { tomatometer, audience, consensus, quotes: [{ critic, text }], label } or null when
// Rotten Tomatoes has nothing for this title. Sports and live events are skipped.
export async function getReviews(media, settings) {
  if (media.type === 'sport') return null;
  const key = settings.rtKey || RT_RAPIDAPI.key;
  if (!key) throw new PrevueRError('Your Rotten Tomatoes API Key has not been set', { kind: 'missing-key', service: 'Rotten Tomatoes' });

  const isTv = media.type === 'tv';
  const path = isTv ? '/tv-show' : '/';
  const url = `https://${RT_RAPIDAPI.host}${path}?${new URLSearchParams({ name: media.title })}`;
  const { body } = await fetchJson(url, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': RT_RAPIDAPI.host },
  }, 'Rotten Tomatoes');
  if (!body || body.error || body.message) return null;

  let tomatometer = score(body.tomatometer_score);
  let label = isTv ? 'Series' : '';
  // For an episode search, prefer that season's critics score when RT lists one.
  if (isTv && media.season != null && Array.isArray(body.seasons_info)) {
    const season = body.seasons_info.find((s) => new RegExp(`^Season ${media.season}$`, 'i').test(String(s.title || '').trim()));
    if (season && score(season.critics_score) != null) {
      tomatometer = score(season.critics_score);
      label = `Season ${media.season}`;
    }
  }
  const audience = score(body.audience_score);
  if (tomatometer == null && audience == null) return null;

  const consensus = String(body.critics_consensus || '').replace(/^\s*Critics Consensus\s*/i, '').trim();
  const quotes = (Array.isArray(body.critic_reviews) ? body.critic_reviews : [])
    .filter((r) => r?.review_text)
    .slice(0, MAX_QUOTES)
    .map((r) => ({ critic: String(r.critic_name || '').trim(), text: String(r.review_text).trim() }));
  return { tomatometer, audience, consensus, quotes, label, title: body.title || media.title };
}
