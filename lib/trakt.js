// Watch history from Trakt (https://trakt.docs.apiary.io/). Uses the public
// /users/{username}/history endpoint, which only needs the app's Client ID.

import { PrevueRError, fetchJson } from './errors.js';

export const PAGE_SIZE = 30;

export async function getWatchedPage(settings, page = 1) {
  if (!settings.traktClientId || !settings.traktUsername) {
    throw new PrevueRError('Your Trakt details have not been set', { kind: 'missing-key', service: 'Trakt' });
  }
  const user = encodeURIComponent(settings.traktUsername.trim());
  const url = `https://api.trakt.tv/users/${user}/history?page=${page}&limit=${PAGE_SIZE}`;
  const { body, res } = await fetchJson(url, {
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': settings.traktClientId.trim(),
    },
  }, 'Trakt');

  const pageCount = Number(res.headers.get('X-Pagination-Page-Count')) || page;
  const items = (Array.isArray(body) ? body : []).map((h) => {
    if (h.type === 'episode') {
      return {
        type: 'tv',
        title: h.show?.title || 'Unknown show',
        season: h.episode?.season ?? null,
        episode: h.episode?.number ?? null,
        date: h.watched_at,
      };
    }
    return {
      type: 'movie',
      title: h.movie?.title || 'Unknown movie',
      season: null,
      episode: null,
      date: h.watched_at,
    };
  });
  return { items, hasMore: page < pageCount };
}
