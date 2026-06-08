/**
 * 公开 API 路由 - 无需认证
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { AdminBootstrapError, ensureInitialAdmin } from '../auth/admin-bootstrap';
import { AuthConfigurationError, generateToken, verifyAdminToken } from '../auth/jwt';
import { hashPassword, needsPasswordRehash, verifyPassword } from '../auth/password';
import { clearAdminSessionCookie, ensureAdminCsrfCookie, getAdminSessionToken, setAdminSessionCookie } from '../auth/session';
import { buildPublicSettings } from '../settings/schema';

const publicRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const LOGIN_RATE_LIMIT_BASE_LOCK_MS = 30 * 1000;
const LOGIN_RATE_LIMIT_MAX_LOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_LOGIN_USERNAME_LENGTH = 128;
const MAX_LOGIN_PASSWORD_LENGTH = 4096;
const MAX_PUBLIC_RECORD_RANGE_MS = 3 * 24 * 60 * 60 * 1000;
const PUBLIC_RECORD_RANGE_SLOP_MS = 60 * 1000;
const PUBLIC_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PUBLIC_METADATA_RATE_LIMIT_MAX = 120;
const PUBLIC_HISTORY_RATE_LIMIT_MAX = 60;
const PUBLIC_LIVE_RATE_LIMIT_MAX = 180;
const PUBLIC_METADATA_CACHE_SECONDS = 30;
const PUBLIC_HISTORY_CACHE_SECONDS = 10;
const PUBLIC_LIVE_CACHE_SECONDS = 2;

type PublicRateLimitBucket = {
  count: number;
  resetAt: number;
  lastSeenAt: number;
};

const publicRateLimitBuckets = new Map<string, PublicRateLimitBucket>();
let publicRateLimitSweepCounter = 0;

function cleanupPublicRateLimitBuckets(nowMs: number): void {
  for (const [key, bucket] of publicRateLimitBuckets) {
    if (bucket.resetAt <= nowMs || nowMs - bucket.lastSeenAt > PUBLIC_RATE_LIMIT_WINDOW_MS * 5) {
      publicRateLimitBuckets.delete(key);
    }
  }
}

function readIntParam(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function wantsPagedResponse(c: any): boolean {
  return c.req.query('paged') === 'true' || c.req.query('page') !== undefined;
}

function emptyPagedResult<T>(page: number, limit: number) {
  return {
    data: [] as T[],
    total: 0,
    page,
    limit,
    has_more: false,
  };
}

function validatePublicTimeRange(start: string, end: string): string | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return '时间范围格式无效';
  }
  if (endMs < startMs) {
    return '结束时间不能早于开始时间';
  }
  if (endMs - startMs > MAX_PUBLIC_RECORD_RANGE_MS + PUBLIC_RECORD_RANGE_SLOP_MS) {
    return '公开历史查询最多支持 3 天时间范围';
  }
  return null;
}

async function isPublicClient(database: D1Database, uuid: string): Promise<boolean> {
  const client = await db.getClient(database, uuid);
  return Boolean(client && !client.hidden);
}

function toPublicPingTask(task: db.PingTask, publicClientIds: Set<string>): db.PingTask | null {
  if (task.all_clients) {
    return { ...task, clients: [] };
  }

  const clients = task.clients.filter(uuid => publicClientIds.has(uuid));
  if (clients.length === 0) return null;

  return {
    ...task,
    clients,
  };
}

function isPublicTag(tag: string): boolean {
  const text = tag.replace(/<\w+>$/, '').trim().toLowerCase();
  return !['ipv4', 'ipv6', 'ip4', 'ip6', 'v4', 'v6'].includes(text);
}

function sanitizePublicTags(tags: unknown): string {
  if (typeof tags !== 'string') return '';
  return tags
    .split(/[;,]/)
    .map(tag => tag.trim())
    .filter(Boolean)
    .filter(isPublicTag)
    .join(';');
}

function toPublicClient(client: any): any {
  const {
    token,
    ipv4,
    ipv6,
    remark,
    ...publicClient
  } = client;
  return {
    ...publicClient,
    has_ipv4: Boolean(typeof ipv4 === 'string' ? ipv4.trim() : ipv4),
    has_ipv6: Boolean(typeof ipv6 === 'string' ? ipv6.trim() : ipv6),
    tags: sanitizePublicTags(publicClient.tags),
  };
}

function getAdminBootstrapMessage(error: AdminBootstrapError): string {
  if (error.code === 'weak_password') {
    return 'ADMIN_PASSWORD 至少需要 12 字节';
  }
  return '首次登录前请在 Worker 环境变量设置 ADMIN_USERNAME 和 ADMIN_PASSWORD';
}

function getClientIp(c: any): string {
  const forwardedFor = c.req.header('X-Forwarded-For') || '';
  const ip = (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Real-IP') ||
    forwardedFor.split(',')[0] ||
    'unknown'
  ).trim();
  return (ip || 'unknown').slice(0, 128);
}

function setPublicCache(c: any, maxAgeSeconds: number): void {
  c.header(
    'Cache-Control',
    `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`,
  );
}

function withPublicCache(response: Response, maxAgeSeconds: number): Response {
  const headers = new Headers(response.headers);
  headers.set(
    'Cache-Control',
    `public, max-age=${maxAgeSeconds}, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function localPublicApiRateLimit(c: any, bucket: string, maxRequests: number): Response | null {
  const nowMs = Date.now();
  publicRateLimitSweepCounter += 1;
  if (publicRateLimitSweepCounter % 256 === 0) {
    cleanupPublicRateLimitBuckets(nowMs);
  }

  const clientIp = getClientIp(c);
  const key = `public:${bucket}:${clientIp}`;
  let state = publicRateLimitBuckets.get(key);
  if (!state || state.resetAt <= nowMs) {
    state = {
      count: 0,
      resetAt: nowMs + PUBLIC_RATE_LIMIT_WINDOW_MS,
      lastSeenAt: nowMs,
    };
  }

  state.count += 1;
  state.lastSeenAt = nowMs;
  publicRateLimitBuckets.set(key, state);

  const retryAfter = Math.max(1, Math.ceil((state.resetAt - nowMs) / 1000));
  const remaining = Math.max(0, maxRequests - state.count);
  c.header('X-RateLimit-Limit', String(maxRequests));
  c.header('X-RateLimit-Remaining', String(remaining));
  c.header('X-RateLimit-Reset', String(Math.ceil(state.resetAt / 1000)));

  if (state.count <= maxRequests) {
    return null;
  }

  c.header('Retry-After', String(retryAfter));
  c.header('Cache-Control', 'no-store');
  return c.json({ error: `公开 API 请求过于频繁，请 ${retryAfter} 秒后再试` }, 429);
}

async function publicApiRateLimit(c: any, bucket: string, maxRequests: number): Promise<Response | null> {
  const clientIp = getClientIp(c);
  try {
    const namespace = c.env.RATE_LIMIT;
    if (!namespace) {
      return localPublicApiRateLimit(c, bucket, maxRequests);
    }
    const doId = namespace.idFromName('public-api');
    const stub = namespace.get(doId);
    const response = await stub.fetch(new Request('https://do/rate-limit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket,
        ip: clientIp,
        max: maxRequests,
        windowMs: PUBLIC_RATE_LIMIT_WINDOW_MS,
      }),
    }));
    if (!response.ok) throw new Error(`DO rate limit HTTP ${response.status}`);
    const result = await response.json() as any;
    const retryAfter = Math.max(1, Number(result.retry_after || 1));
    const remaining = Math.max(0, Number(result.remaining || 0));
    const reset = Math.ceil(Number(result.reset || Date.now() / 1000));
    c.header('X-RateLimit-Limit', String(maxRequests));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(reset));
    if (result.allowed) return null;

    c.header('Retry-After', String(retryAfter));
    c.header('Cache-Control', 'no-store');
    return c.json({ error: `公开 API 请求过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  } catch {
    return localPublicApiRateLimit(c, bucket, maxRequests);
  }
}

function guardPublicMetadata(c: any, bucket: string): Promise<Response | null> {
  return publicApiRateLimit(c, `metadata:${bucket}`, PUBLIC_METADATA_RATE_LIMIT_MAX);
}

function guardPublicHistory(c: any, bucket: string): Promise<Response | null> {
  return publicApiRateLimit(c, `history:${bucket}`, PUBLIC_HISTORY_RATE_LIMIT_MAX);
}

function guardPublicLive(c: any): Promise<Response | null> {
  return publicApiRateLimit(c, 'live', PUBLIC_LIVE_RATE_LIMIT_MAX);
}

function normalizeLoginUsername(username: string): string {
  return username.trim().toLowerCase().slice(0, MAX_LOGIN_USERNAME_LENGTH);
}

function loginRateLimitBuckets(ip: string, username: string): string[] {
  const normalizedUsername = normalizeLoginUsername(username);
  return [
    `login:ip:${ip}`,
    `login:ip-user:${ip}:${normalizedUsername}`,
  ];
}

function parseTimeMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

async function getLoginRetryAfterSeconds(
  database: D1Database,
  buckets: string[],
  nowMs: number,
): Promise<number> {
  let lockedUntilMs = 0;
  for (const bucket of buckets) {
    const state = await db.getLoginRateLimit(database, bucket);
    lockedUntilMs = Math.max(lockedUntilMs, parseTimeMs(state?.locked_until));
  }
  if (lockedUntilMs <= nowMs) return 0;
  return Math.ceil((lockedUntilMs - nowMs) / 1000);
}

async function recordLoginFailure(database: D1Database, buckets: string[], nowMs: number): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  for (const bucket of buckets) {
    const state = await db.getLoginRateLimit(database, bucket);
    const firstFailedMs = parseTimeMs(state?.first_failed_at);
    const inWindow = Boolean(state) && nowMs - firstFailedMs <= LOGIN_RATE_LIMIT_WINDOW_MS;
    const failures = inWindow ? Number(state?.failures || 0) + 1 : 1;
    const firstFailedAt = inWindow ? state!.first_failed_at : nowIso;
    const shouldLock = failures >= LOGIN_RATE_LIMIT_MAX_FAILURES;
    const lockMs = shouldLock
      ? Math.min(
        LOGIN_RATE_LIMIT_BASE_LOCK_MS * (2 ** (failures - LOGIN_RATE_LIMIT_MAX_FAILURES)),
        LOGIN_RATE_LIMIT_MAX_LOCK_MS,
      )
      : 0;

    await db.setLoginRateLimit(database, {
      bucket,
      failures,
      first_failed_at: firstFailedAt,
      last_failed_at: nowIso,
      locked_until: shouldLock ? new Date(nowMs + lockMs).toISOString() : null,
    });
  }
}

async function clearLoginFailures(database: D1Database, buckets: string[]): Promise<void> {
  for (const bucket of buckets) {
    await db.clearLoginRateLimit(database, bucket);
  }
}

async function auditLoginFailure(
  database: D1Database,
  username: string,
  ip: string,
  reason: string,
): Promise<void> {
  await db.insertAuditLog(
    database,
    username.slice(0, MAX_LOGIN_USERNAME_LENGTH) || 'anonymous',
    'login_failed',
    JSON.stringify({
      username: username.slice(0, MAX_LOGIN_USERNAME_LENGTH),
      ip,
      reason,
    }),
    'warn',
  );
}

// 登录
publicRoutes.post('/login', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const { username, password } = body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return c.json({ error: '用户名和密码不能为空' }, 400);
  }
  if (username.length > MAX_LOGIN_USERNAME_LENGTH || password.length > MAX_LOGIN_PASSWORD_LENGTH) {
    return c.json({ error: '用户名或密码长度超出限制' }, 400);
  }

  const clientIp = getClientIp(c);
  const rateLimitBuckets = loginRateLimitBuckets(clientIp, username);
  const nowMs = Date.now();
  await db.deleteLoginRateLimitsBefore(
    c.env.DB,
    new Date(nowMs - LOGIN_RATE_LIMIT_CLEANUP_AGE_MS).toISOString(),
  );

  const retryAfter = await getLoginRetryAfterSeconds(c.env.DB, rateLimitBuckets, nowMs);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    await auditLoginFailure(c.env.DB, username, clientIp, 'rate_limited');
    return c.json({ error: `登录尝试过于频繁，请 ${retryAfter} 秒后再试` }, 429);
  }

  try {
    await ensureInitialAdmin(c.env);
  } catch (error) {
    if (error instanceof AdminBootstrapError) {
      return c.json({ error: getAdminBootstrapMessage(error) }, 503);
    }
    console.error('[auth] initial admin bootstrap failed:', error);
    return c.json({ error: '初始化管理员失败' }, 500);
  }

  const user = await db.getUserByUsername(c.env.DB, username);
  if (!user) {
    await recordLoginFailure(c.env.DB, rateLimitBuckets, Date.now());
    await auditLoginFailure(c.env.DB, username, clientIp, 'unknown_user');
    return c.json({ error: '用户名或密码错误' }, 401);
  }

  const valid = await verifyPassword(password, user.passwd);
  if (!valid) {
    await recordLoginFailure(c.env.DB, rateLimitBuckets, Date.now());
    await auditLoginFailure(c.env.DB, username, clientIp, 'invalid_password');
    return c.json({ error: '用户名或密码错误' }, 401);
  }

  let token: string;
  try {
    token = await generateToken(user.uuid, user.username, c.env);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
      return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
    }
    throw error;
  }

  if (needsPasswordRehash(user.passwd)) {
    await db.updateUserPassword(c.env.DB, user.uuid, await hashPassword(password));
  }

  setAdminSessionCookie(c, token);
  const csrfToken = ensureAdminCsrfCookie(c);
  await clearLoginFailures(c.env.DB, rateLimitBuckets);

  // 记录日志
  await db.insertAuditLog(c.env.DB, user.username, 'login', '用户登录');

  return c.json({
    csrf_token: csrfToken,
    user: {
      uuid: user.uuid,
      username: user.username,
    },
  });
});

// 退出登录
publicRoutes.post('/logout', async (c) => {
  clearAdminSessionCookie(c);
  return c.json({ success: true });
});

// 获取当前用户信息（需要 token）
publicRoutes.get('/me', async (c) => {
  const token = getAdminSessionToken(c);
  if (!token) {
    return c.json({ error: '未登录' }, 401);
  }

  try {
    const payload = await verifyAdminToken(token, c.env);
    if (!payload) {
      return c.json({ error: 'Token 无效' }, 401);
    }
    const csrfToken = ensureAdminCsrfCookie(c);
    return c.json({
      uuid: payload.userId,
      username: payload.username,
      csrf_token: csrfToken,
    });
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
      return c.json({ error: '服务端 JWT_SECRET 未正确配置' }, 500);
    }
    return c.json({ error: 'Token 无效' }, 401);
  }
});

// 获取所有客户端列表（公开）
publicRoutes.get('/clients', async (c) => {
  const limited = await guardPublicMetadata(c, 'clients');
  if (limited) return limited;

  const clients = await db.listClients(c.env.DB);
  // 过滤隐藏的客户端，移除敏感信息
  const publicClients = clients
    .filter(c => !c.hidden)
    .map(toPublicClient);
  setPublicCache(c, PUBLIC_METADATA_CACHE_SECONDS);
  return c.json(publicClients);
});

// 获取公开设置
publicRoutes.get('/public', async (c) => {
  const limited = await guardPublicMetadata(c, 'settings');
  if (limited) return limited;

  const settings = await db.getAllSettings(c.env.DB);
  setPublicCache(c, PUBLIC_METADATA_CACHE_SECONDS);
  return c.json(buildPublicSettings(settings));
});

// 获取客户端最近的监控记录
publicRoutes.get('/recent/:uuid', async (c) => {
  const limited = await guardPublicHistory(c, 'recent');
  if (limited) return limited;

  const uuid = c.req.param('uuid');
  const limit = readIntParam(c.req.query('limit'), 30, 150);
  if (!(await isPublicClient(c.env.DB, uuid))) {
    setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
    return c.json([]);
  }
  const records = await db.getRecentRecords(c.env.DB, uuid, limit);
  setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
  return c.json(records);
});

// 获取系统负载历史记录
publicRoutes.get('/records/load', async (c) => {
  const limited = await guardPublicHistory(c, 'records-load');
  if (limited) return limited;

  const uuid = c.req.query('uuid');
  const start = c.req.query('start');
  const end = c.req.query('end');

  if (!uuid) {
    return c.json({ error: '缺少 uuid 参数' }, 400);
  }

  if (!(await isPublicClient(c.env.DB, uuid))) {
    if (wantsPagedResponse(c)) {
      const page = readIntParam(c.req.query('page'), 1, 100000);
      const limit = readIntParam(c.req.query('limit'), 100, 500);
      setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
      return c.json(emptyPagedResult(page, limit));
    }
    setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
    return c.json([]);
  }

  if (start && end) {
    const rangeError = validatePublicTimeRange(start, end);
    if (rangeError) return c.json({ error: rangeError }, 400);

    const limitQuery = c.req.query('limit');
    if (wantsPagedResponse(c)) {
      const page = readIntParam(c.req.query('page'), 1, 100000);
      const limit = readIntParam(limitQuery, 100, 500);
      setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
      return c.json(await db.getRecordsByTimeRangePaged(c.env.DB, uuid, start, end, page, limit));
    }

    const limit = readIntParam(limitQuery, 500, 1000);
    setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
    return c.json(await db.getRecordsByTimeRangeLimited(c.env.DB, uuid, start, end, limit));
  }

  const records = await db.getRecentRecords(c.env.DB, uuid, readIntParam(c.req.query('limit'), 150, 500));
  if (wantsPagedResponse(c)) {
    setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
    return c.json({
      data: records,
      total: records.length,
      page: 1,
      limit: records.length,
      has_more: false,
    });
  }
  setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
  return c.json(records);
});

// 获取 GPU 记录
publicRoutes.get('/records/gpu', async (c) => {
  const limited = await guardPublicHistory(c, 'records-gpu');
  if (limited) return limited;

  const uuid = c.req.query('uuid');
  const start = c.req.query('start');
  const end = c.req.query('end');
  const limit = readIntParam(c.req.query('limit'), 100, 500);

  if (!uuid) {
    return c.json({ error: '缺少 uuid 参数' }, 400);
  }

  if (!(await isPublicClient(c.env.DB, uuid))) {
    if (wantsPagedResponse(c)) {
      const page = readIntParam(c.req.query('page'), 1, 100000);
      setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
      return c.json(emptyPagedResult(page, limit));
    }
    setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
    return c.json([]);
  }

  if (wantsPagedResponse(c)) {
    if (start && end) {
      const rangeError = validatePublicTimeRange(start, end);
      if (rangeError) return c.json({ error: rangeError }, 400);
    }
    const page = readIntParam(c.req.query('page'), 1, 100000);
    setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
    return c.json(await db.getGPURecordsPaged(c.env.DB, uuid, start, end, page, limit));
  }

  if (start && end) {
    const rangeError = validatePublicTimeRange(start, end);
    if (rangeError) return c.json({ error: rangeError }, 400);
  }

  const records = await db.getGPURecords(c.env.DB, uuid, start, end, limit);
  setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
  return c.json(records);
});

// 获取 Ping 记录
publicRoutes.get('/records/ping', async (c) => {
  const limited = await guardPublicHistory(c, 'records-ping');
  if (limited) return limited;

  const uuid = c.req.query('uuid');
  const taskId = parseInt(c.req.query('task_id') || '0');
  const limit = readIntParam(c.req.query('limit'), 120, 360);

  if (!uuid || !taskId) {
    return c.json({ error: '缺少参数' }, 400);
  }

  if (!(await isPublicClient(c.env.DB, uuid))) {
    if (wantsPagedResponse(c)) {
      const page = readIntParam(c.req.query('page'), 1, 100000);
      setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
      return c.json(emptyPagedResult(page, limit));
    }
    setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
    return c.json([]);
  }

  if (wantsPagedResponse(c)) {
    const page = readIntParam(c.req.query('page'), 1, 100000);
    setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
    return c.json(await db.getPingRecordsPaged(c.env.DB, uuid, taskId, page, limit));
  }

  const records = await db.getPingRecords(c.env.DB, uuid, taskId, limit);
  setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
  return c.json(records);
});

// 获取 Ping 任务列表（公开）
publicRoutes.get('/task/ping', async (c) => {
  const limited = await guardPublicMetadata(c, 'ping-tasks');
  if (limited) return limited;

  const tasks = await db.listPingTasks(c.env.DB);
  const clients = await db.listClients(c.env.DB);
  const publicClientIds = new Set(clients.filter(client => !client.hidden).map(client => client.uuid));
  setPublicCache(c, PUBLIC_METADATA_CACHE_SECONDS);
  return c.json(tasks
    .map(task => toPublicPingTask(task, publicClientIds))
    .filter((task): task is db.PingTask => Boolean(task)));
});

// 节点信息（兼容旧版格式）
publicRoutes.get('/nodes', async (c) => {
  const limited = await guardPublicMetadata(c, 'nodes');
  if (limited) return limited;

  const clients = await db.listClients(c.env.DB);
  const nodes = clients
    .filter(c => !c.hidden)
    .map((client) => {
      const publicClient = toPublicClient(client);
      return {
        ...publicClient,
        tags: publicClient.tags ? publicClient.tags.split(';').filter(Boolean) : [],
      };
    });
  setPublicCache(c, PUBLIC_METADATA_CACHE_SECONDS);
  return c.json(nodes);
});

// 实时数据 - 代理到 Durable Object
publicRoutes.get('/live', async (c) => {
  const limited = await guardPublicLive(c);
  if (limited) return limited;

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);
  return withPublicCache(await stub.fetch(c.req.raw), PUBLIC_LIVE_CACHE_SECONDS);
});

export { publicRoutes, generateToken, hashPassword, verifyPassword };
