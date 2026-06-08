/**
 * WebSocket routes for agent reports and live viewer snapshots.
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { buildPublicSettings } from '../settings/schema';
import { createViewerToken, verifyViewerToken } from '../auth/viewer-token';

const wsRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS = 60_000;
const VIEWER_TOKEN_RATE_LIMIT_MAX = 20;
const LIVE_CLIENTS_RATE_LIMIT_WINDOW_MS = 60_000;
const LIVE_CLIENTS_RATE_LIMIT_MAX = 180;
const LIVE_CLIENTS_CACHE_SECONDS = 2;

function bearerToken(c: any): string {
  const authHeader = c.req.header('Authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

function requestHasValidOrigin(c: any): boolean {
  const origin = c.req.header('Origin');
  if (!origin) return true;

  try {
    const requestUrl = new URL(c.req.url);
    const originUrl = new URL(origin);
    return originUrl.protocol === requestUrl.protocol && originUrl.host === requestUrl.host;
  } catch {
    return false;
  }
}

function isWebSocketUpgrade(c: any): boolean {
  return (c.req.header('Upgrade') || '').toLowerCase() === 'websocket';
}

function requestIp(c: any): string {
  const forwardedFor = c.req.header('X-Forwarded-For') || '';
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Real-IP') ||
    forwardedFor.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function viewerTtlMs(c: any): Promise<number> {
  const settings = buildPublicSettings(await db.getAllSettings(c.env.DB));
  const seconds = Number(settings.live_poll_active_max_duration_sec || 600);
  const boundedSeconds = Number.isFinite(seconds)
    ? Math.min(Math.max(seconds, 60), 3600)
    : 600;
  return Math.floor(boundedSeconds) * 1000;
}

async function enforceViewerTokenRateLimit(c: any, ip: string): Promise<Response | null> {
  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);
  const response = await stub.fetch(new Request('https://do/rate-limit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bucket: 'viewer-token',
      ip,
      max: VIEWER_TOKEN_RATE_LIMIT_MAX,
      windowMs: VIEWER_TOKEN_RATE_LIMIT_WINDOW_MS,
    }),
  }));
  const result = await response.json().catch(() => null) as any;
  if (result?.allowed !== false) return null;
  return new Response(JSON.stringify({ error: 'Too many live viewer token requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(result?.retry_after || 60),
      'X-RateLimit-Limit': String(result?.limit || VIEWER_TOKEN_RATE_LIMIT_MAX),
      'X-RateLimit-Remaining': String(result?.remaining || 0),
    },
  });
}

async function enforceLiveClientsRateLimit(c: any, ip: string): Promise<Response | null> {
  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);
  const response = await stub.fetch(new Request('https://do/rate-limit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bucket: 'live-clients',
      ip,
      max: LIVE_CLIENTS_RATE_LIMIT_MAX,
      windowMs: LIVE_CLIENTS_RATE_LIMIT_WINDOW_MS,
    }),
  }));
  const result = await response.json().catch(() => null) as any;
  if (result?.allowed !== false) {
    c.header('X-RateLimit-Limit', String(result?.limit || LIVE_CLIENTS_RATE_LIMIT_MAX));
    c.header('X-RateLimit-Remaining', String(result?.remaining ?? LIVE_CLIENTS_RATE_LIMIT_MAX));
    return null;
  }
  return new Response(JSON.stringify({ error: 'Too many live clients requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(result?.retry_after || 60),
      'X-RateLimit-Limit': String(result?.limit || LIVE_CLIENTS_RATE_LIMIT_MAX),
      'X-RateLimit-Remaining': String(result?.remaining || 0),
    },
  });
}

function jwtSecret(c: any): string {
  return String(c.env.JWT_SECRET || '').trim();
}

wsRoutes.get('/clients/report', async (c) => {
  const token = bearerToken(c);

  if (!token) {
    return c.json({ error: 'Missing token' }, 401);
  }

  const client = await db.getClientByToken(c.env.DB, token);
  if (!client) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  if (!isWebSocketUpgrade(c)) {
    return c.json({ error: 'WebSocket upgrade required' }, 400);
  }
  if (!requestHasValidOrigin(c)) {
    return c.json({ error: 'Invalid WebSocket Origin' }, 403);
  }

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);

  const url = new URL(c.req.url);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('id', client.uuid);
  url.searchParams.set('name', client.name);
  url.searchParams.set('hidden', client.hidden ? '1' : '0');
  url.searchParams.set('role', 'agent');

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

wsRoutes.get('/ws/live-token', async (c) => {
  const secret = jwtSecret(c);
  if (new TextEncoder().encode(secret).byteLength < 32) {
    return c.json({ error: 'Server authentication is not configured' }, 500);
  }

  const ip = requestIp(c);
  const limited = await enforceViewerTokenRateLimit(c, ip);
  if (limited) return limited;

  return c.json(await createViewerToken({
    ip,
    secret,
  }));
});

wsRoutes.get('/ws/live', async (c) => {
  if (!isWebSocketUpgrade(c)) {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    return stub.fetch(new Request(c.req.url, { method: 'GET' }));
  }
  if (!requestHasValidOrigin(c)) {
    return c.json({ error: 'Invalid WebSocket Origin' }, 403);
  }

  const viewerIp = requestIp(c);
  const viewerToken = c.req.query('viewer_token') || '';
  const secret = jwtSecret(c);
  if (!viewerToken) {
    return c.json({ error: 'Missing viewer token' }, 401);
  }
  if (new TextEncoder().encode(secret).byteLength < 32) {
    return c.json({ error: 'Server authentication is not configured' }, 500);
  }
  if (!await verifyViewerToken({ token: viewerToken, ip: viewerIp, secret })) {
    return c.json({ error: 'Invalid viewer token' }, 403);
  }

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);

  const url = new URL(c.req.url);
  url.pathname = '/';
  url.search = '';
  url.searchParams.set('id', 'frontend-' + crypto.randomUUID());
  url.searchParams.set('role', 'viewer');
  url.searchParams.set('viewer_ttl_ms', String(await viewerTtlMs(c)));
  url.searchParams.set('viewer_ip', viewerIp);

  return stub.fetch(new Request(url.toString(), c.req.raw));
});

wsRoutes.get('/live/clients', async (c) => {
  const limited = await enforceLiveClientsRateLimit(c, requestIp(c));
  if (limited) return limited;

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);

  const response = await stub.fetch(new Request('https://do/live', { method: 'GET' }));
  c.header('Cache-Control', `public, max-age=${LIVE_CLIENTS_CACHE_SECONDS}, s-maxage=${LIVE_CLIENTS_CACHE_SECONDS}, stale-while-revalidate=${LIVE_CLIENTS_CACHE_SECONDS * 2}`);
  return c.json(await response.json());
});

export { wsRoutes };
