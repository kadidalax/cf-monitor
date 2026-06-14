/**
 * Public API helper layer.
 * Admin requests must use AuthContext.useApi() so unsafe methods receive CSRF headers.
 */

const BASE_URL = '/api';

function withApiBase(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (normalizedPath === BASE_URL || normalizedPath.startsWith(`${BASE_URL}/`)) {
    return normalizedPath;
  }
  return `${BASE_URL}${normalizedPath}`;
}

function assertPublicApiPath(url: string) {
  if (url === `${BASE_URL}/admin` || url.startsWith(`${BASE_URL}/admin/`)) {
    throw new Error('Admin API requests must use useApi()');
  }
}

export function normalizeListResponse<T = unknown>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data as T[];
  }
  return [];
}

export async function apiFetch<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  const url = withApiBase(path);
  assertPublicApiPath(url);

  const res = await fetch(url, {
    ...options,
    headers,
    credentials: 'same-origin',
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export async function publicFetch<T = any>(path: string): Promise<T> {
  const url = withApiBase(path);
  assertPublicApiPath(url);

  const res = await fetch(url);
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
  return res.json();
}
