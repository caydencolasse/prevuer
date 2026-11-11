// kind: 'missing-key' -> user must add a key in Settings > API's
//       'api'         -> the provider answered with an error or was unreachable
export class PrevueRError extends Error {
  constructor(message, { kind = 'api', service = '' } = {}) {
    super(message);
    this.kind = kind;
    this.service = service;
  }
}

export async function fetchJson(url, init, service) {
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new PrevueRError(`Couldn't reach ${service}`, { service });
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const detail =
      body?.error?.message || body?.error_description || body?.message ||
      (typeof body?.error === 'string' ? body.error : '') || res.statusText;
    const kind = res.status === 401 || res.status === 403 ? 'missing-key' : 'api';
    throw new PrevueRError(`${service}: ${detail || `HTTP ${res.status}`}`, { kind, service });
  }
  return { body, res };
}
