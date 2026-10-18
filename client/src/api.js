const TOKEN_KEY = 'ops.token';

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};
export const setToken = (t) => {
  try {
    t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: session just won't persist */
  }
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

/** A fresh key per user action. Reuse the same key when retrying that same action. */
export const newKey = () => crypto.randomUUID();

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

export async function api(method, path, body, { key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  // Every write carries an Idempotency-Key so a double click or a retry can never apply twice.
  if (method !== 'GET' && !path.startsWith('/auth/')) headers['Idempotency-Key'] = key || newKey();

  let res;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, { error: { code: 'NETWORK', message: 'Cannot reach the server. Check your connection and try again.' } });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) onUnauthorized();
    throw new ApiError(res.status, data);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b, o) => api('POST', p, b ?? {}, o);
export const patch = (p, b, o) => api('PATCH', p, b, o);
export const del = (p, o) => api('DELETE', p, undefined, o);

export const qs = (params) => {
  const u = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => v !== '' && v != null && u.set(k, v));
  const s = u.toString();
  return s ? `?${s}` : '';
};
