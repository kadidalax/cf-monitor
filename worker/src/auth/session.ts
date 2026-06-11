import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

const ADMIN_SESSION_COOKIE = 'cf_monitor_session';
const ADMIN_CSRF_COOKIE = 'cf_monitor_csrf';
const ADMIN_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const ADMIN_CSRF_MAX_AGE_SECONDS = ADMIN_SESSION_MAX_AGE_SECONDS;

function isHttpsRequest(c: any): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

export function getAdminSessionToken(c: any): string | null {
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return getCookie(c, ADMIN_SESSION_COOKIE) ?? null;
}

export function setAdminSessionCookie(c: any, token: string): void {
  setCookie(c, ADMIN_SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: isHttpsRequest(c),
    sameSite: 'Lax',
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
}

function generateCsrfToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function isValidCsrfToken(token: string | undefined): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token);
}

export function getAdminCsrfToken(c: any): string | null {
  const token = getCookie(c, ADMIN_CSRF_COOKIE);
  return isValidCsrfToken(token) ? token : null;
}

export function ensureAdminCsrfCookie(c: any): string {
  const existing = getAdminCsrfToken(c);
  const token = existing || generateCsrfToken();
  setCookie(c, ADMIN_CSRF_COOKIE, token, {
    path: '/',
    httpOnly: false,
    secure: isHttpsRequest(c),
    sameSite: 'Lax',
    maxAge: ADMIN_CSRF_MAX_AGE_SECONDS,
  });
  return token;
}

export function verifyAdminCsrfToken(c: any): boolean {
  const cookieToken = getAdminCsrfToken(c);
  const headerToken = c.req.header('X-CSRF-Token');
  return Boolean(cookieToken && isValidCsrfToken(headerToken) && cookieToken === headerToken);
}

export function clearAdminSessionCookie(c: any): void {
  deleteCookie(c, ADMIN_SESSION_COOKIE, {
    path: '/',
  });
  deleteCookie(c, ADMIN_CSRF_COOKIE, {
    path: '/',
  });
}
