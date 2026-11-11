// Trailers & Clips via the YouTube Data API v3 (search.list).

import { PrevueRError, fetchJson } from './errors.js';
import { episodeCode } from './media.js';

export const MAX_VIDEOS = 9;

function buildQuery(media) {
  const code = episodeCode(media);
  if (media.type === 'sport') return `${media.title} highlights`;
  if (media.type === 'tv') {
    return code !== 'N/A' ? `${media.title} ${code} promo clip` : `${media.title} official trailer`;
  }
  return `${media.title} official trailer`;
}

export async function searchVideos(media, settings) {
  if (!settings.youtubeKey) {
    throw new PrevueRError('Your YouTube API Key has not been set', { kind: 'missing-key', service: 'YouTube' });
  }
  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    maxResults: String(MAX_VIDEOS),
    q: buildQuery(media),
    safeSearch: 'moderate',
    videoEmbeddable: 'true',
    key: settings.youtubeKey,
  });
  const { body } = await fetchJson(`https://www.googleapis.com/youtube/v3/search?${params}`, {}, 'YouTube');
  return (body?.items || [])
    .filter((it) => it?.id?.videoId)
    .map((it) => ({
      id: it.id.videoId,
      title: decodeEntities(it.snippet?.title || ''),
      channel: it.snippet?.channelTitle || '',
      thumb:
        it.snippet?.thumbnails?.medium?.url ||
        it.snippet?.thumbnails?.high?.url ||
        it.snippet?.thumbnails?.default?.url ||
        `https://i.ytimg.com/vi/${it.id.videoId}/mqdefault.jpg`,
    }));
}

function decodeEntities(s) {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}
