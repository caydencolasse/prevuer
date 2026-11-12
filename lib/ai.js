// AI summary generation. LocalAI (https://github.com/mudler/LocalAI) is the default;
// OpenAI, Anthropic (Claude), Google Gemini and Meta Llama work with the user's own key.

import { PrevueRError, fetchJson } from './errors.js';
import { episodeCode } from './media.js';

export const PROVIDERS = {
  localai: { label: 'LocalAI (default)', base: 'http://localhost:8080/v1', needsKey: false, style: 'openai', keyUrl: 'https://localai.io/basics/getting_started/' },
  openai: { label: 'OpenAI ChatGPT', base: 'https://api.openai.com/v1', needsKey: true, style: 'openai', keyUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic Claude', base: 'https://api.anthropic.com/v1', needsKey: true, style: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys' },
  gemini: { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, style: 'gemini', keyUrl: 'https://aistudio.google.com/apikey' },
  llama: { label: 'Meta Llama', base: 'https://api.llama.com/compat/v1', needsKey: true, style: 'openai', keyUrl: 'https://llama.developer.meta.com/' },
};

export function providerNeedsKey(settings) {
  return (PROVIDERS[settings.aiProvider] || PROVIDERS.localai).needsKey;
}

const SYSTEM_PROMPT =
  'You are prevueR, a spoiler-conscious preview assistant for movies, TV episodes, live events and sports games. ' +
  'Write a short preview that helps someone decide whether to watch. Cover the premise or matchup, tone, ' +
  'who is involved (cast, creators, teams or performers), and why people watch it. Do not reveal twists or endings. ' +
  'For a sports game or event, preview the matchup, stakes and storylines rather than a final score unless it is clearly over. ' +
  'If you are not sure what the title refers to, say what you think it most likely is. ' +
  'Plain prose only: no headings, lists or markdown. 120 to 180 words.';

function userPrompt(media) {
  const kind = { movie: 'Movie', tv: 'TV show / series', sport: 'Sports game or live event' }[media.type] || 'Movie, show or event (work out which)';
  const code = episodeCode(media);
  return [
    `Title: ${media.title}`,
    `Type: ${kind}`,
    media.season != null ? `Season: ${media.season}` : '',
    media.episode != null ? `Episode: ${media.episode}` : '',
    code !== 'N/A' ? `Preview this specific episode (${code}), not the whole series.` : '',
  ].filter(Boolean).join('\n');
}

function baseUrl(settings) {
  const p = PROVIDERS[settings.aiProvider] || PROVIDERS.localai;
  return (settings.aiBaseUrl || p.base).replace(/\/+$/, '');
}

function serviceName(settings) {
  return (PROVIDERS[settings.aiProvider] || PROVIDERS.localai).label.replace(' (default)', '');
}

// When the user hasn't named a model, ask the provider which ones it has.
async function resolveModel(settings) {
  if (settings.aiModel) return settings.aiModel;
  const p = PROVIDERS[settings.aiProvider] || PROVIDERS.localai;
  const base = baseUrl(settings);
  const service = serviceName(settings);

  if (p.style === 'anthropic') {
    const { body } = await fetchJson(`${base}/models?limit=20`, { headers: anthropicHeaders(settings) }, service);
    const m = body?.data?.find((x) => /sonnet|haiku/i.test(x.id)) || body?.data?.[0];
    if (m) return m.id;
  } else if (p.style === 'gemini') {
    const { body } = await fetchJson(`${base}/models?key=${encodeURIComponent(settings.aiKey)}&pageSize=100`, {}, service);
    const usable = (body?.models || []).filter((x) => x.supportedGenerationMethods?.includes('generateContent') && /gemini/.test(x.name));
    const m = usable.find((x) => /flash/.test(x.name) && !/lite|image|tts|live|exp|preview/.test(x.name)) || usable[0];
    if (m) return m.name.replace(/^models\//, '');
  } else {
    const headers = settings.aiKey ? { Authorization: `Bearer ${settings.aiKey}` } : {};
    const { body } = await fetchJson(`${base}/models`, { headers }, service);
    let list = body?.data || [];
    if (settings.aiProvider === 'openai') {
      list = list
        .filter((x) => /^gpt-/.test(x.id) && !/audio|realtime|image|transcribe|tts|search|instruct/.test(x.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0));
      const m = list.find((x) => /mini/.test(x.id)) || list[0];
      if (m) return m.id;
    } else if (list[0]) {
      return list[0].id;
    }
  }
  throw new PrevueRError(`${service}: no model available. Set one in Settings > API's.`, { service });
}

function anthropicHeaders(settings) {
  return {
    'x-api-key': settings.aiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
}

export async function generateSummary(media, settings) {
  const p = PROVIDERS[settings.aiProvider] || PROVIDERS.localai;
  const service = serviceName(settings);
  if (p.needsKey && !settings.aiKey) {
    throw new PrevueRError('Your API Keys have not been set', { kind: 'missing-key', service });
  }
  const model = await resolveModel(settings);
  const base = baseUrl(settings);
  const prompt = userPrompt(media);
  let text = '';

  if (p.style === 'anthropic') {
    const { body } = await fetchJson(`${base}/messages`, {
      method: 'POST',
      headers: anthropicHeaders(settings),
      body: JSON.stringify({ model, max_tokens: 700, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: prompt }] }),
    }, service);
    text = (body?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  } else if (p.style === 'gemini') {
    const { body } = await fetchJson(
      `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.aiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
      },
      service,
    );
    text = (body?.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('\n');
  } else {
    const headers = { 'content-type': 'application/json' };
    if (settings.aiKey) headers.Authorization = `Bearer ${settings.aiKey}`;
    const { body } = await fetchJson(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
      }),
    }, service);
    text = body?.choices?.[0]?.message?.content || '';
  }

  text = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw new PrevueRError(`${service} returned an empty summary`, { service });
  return text;
}
