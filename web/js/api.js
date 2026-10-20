// Thin client for the KARAMAY API. The session lives in an HttpOnly cookie that
// JavaScript cannot read; only the per-session CSRF token is held in memory.

export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let csrfToken = null;
let currentSession = null;

export function session() {
  return currentSession;
}

export async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'offline', 'Mukhang offline ka. · You seem to be offline.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error ?? {};
    if (res.status === 401) {
      currentSession = null;
      csrfToken = null;
    }
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'May nangyaring mali. · Something went wrong.', e);
  }
  if (data?.session) {
    currentSession = { ...(currentSession ?? {}), ...data.session };
    if (data.session.csrfToken) csrfToken = data.session.csrfToken;
  }
  return data;
}

/** Loads the current session if one exists, without creating one. */
export async function loadSession() {
  const data = await api('GET', '/api/session');
  if (!data.session) clearSession();
  return currentSession;
}

/** Ensures a session exists, creating an anonymous guest session only when a server feature is used. */
export async function ensureSession() {
  if (currentSession) return currentSession;
  await loadSession();
  if (currentSession) return currentSession;
  await api('POST', '/api/session/guest', { client: 'web' });
  await api('GET', '/api/session');
  return currentSession;
}

export function clearSession() {
  currentSession = null;
  csrfToken = null;
}

let configCache = null;
export async function getConfig() {
  if (configCache) return configCache;
  try {
    configCache = await api('GET', '/api/config');
  } catch {
    configCache = { aiAvailable: false, accountsEnabled: false, paymentsAvailable: false, limits: { maxMessageChars: 2000, maxJournalChars: 20000 } };
  }
  return configCache;
}
