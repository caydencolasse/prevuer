// Shared helpers for describing a piece of media (movie, show episode, sport/event).

export const TYPES = ['movie', 'tv', 'sport'];

// Pulls "S3E21", "S03 E21", "3x21" or "season 3 episode 21" out of free text.
export function parseQuery(raw) {
  let text = String(raw || '').trim();
  let season = null;
  let episode = null;
  const patterns = [
    /\b(?:season\s*|s)(\d{1,2})\s*[,:.\-]?\s*(?:episode\s*|ep\.?\s*|e)(\d{1,3})\b/i,
    /\bseason\s*(\d{1,2})\D{1,20}?episode\s*(\d{1,3})\b/i,
    /\b(\d{1,2})x(\d{1,3})\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      season = Number(m[1]);
      episode = Number(m[2]);
      text = text.replace(m[0], ' ');
      break;
    }
  }
  if (season == null) {
    const s = text.match(/\b(?:season\s*|s)(\d{1,2})\b/i);
    if (s) {
      season = Number(s[1]);
      text = text.replace(s[0], ' ');
    }
  }
  if (episode == null) {
    const e = text.match(/\b(?:episode\s*|ep\.?\s*|e)(\d{1,3})\b/i);
    if (e) {
      episode = Number(e[1]);
      text = text.replace(e[0], ' ');
    }
  }
  const title = text.replace(/[\s\-–—:|,]+$/g, '').replace(/^[\s\-–—:|,]+/g, '').replace(/\s{2,}/g, ' ').trim();
  return { title, season, episode, type: season != null || episode != null ? 'tv' : null };
}

export function episodeCode(m) {
  if (m.season == null && m.episode == null) return 'N/A';
  const s = m.season != null ? `S${m.season}` : '';
  const e = m.episode != null ? `E${m.episode}` : '';
  return `${s}${e}` || 'N/A';
}

export function describe(m) {
  const code = episodeCode(m);
  return code === 'N/A' ? m.title : `${m.title} ${code}`;
}

export function formatDate(ts) {
  if (!ts) return 'N/A';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'N/A';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}
