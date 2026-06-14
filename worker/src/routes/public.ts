/**
 * 公开 API 路由 - 无需认证
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { AdminBootstrapError, ensureInitialAdmin } from '../auth/admin-bootstrap';
import { AuthConfigurationError, generateToken, verifyAdminToken } from '../auth/jwt';
import { hashPassword, needsPasswordRehash, verifyPassword } from '../auth/password';
import { clearAdminSessionCookie, ensureAdminCsrfCookie, getAdminSessionToken, setAdminSessionCookie, verifyAdminCsrfToken } from '../auth/session';
import { PUBLIC_SETTING_KEYS, buildPublicSettings } from '../settings/schema';

const publicRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const LOGIN_RATE_LIMIT_BASE_LOCK_MS = 30 * 1000;
const LOGIN_RATE_LIMIT_MAX_LOCK_MS = 15 * 60 * 1000;
const LOGIN_RATE_LIMIT_CLEANUP_AGE_MS = 24 * 60 * 60 * 1000;
const LOGIN_RATE_LIMIT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const LOGIN_FAILURE_AUDIT_THROTTLE_MS = 60 * 1000;
const LOGIN_FAILURE_AUDIT_THROTTLE_MAX_ENTRIES = 512;
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
const PUBLIC_METADATA_CACHE_MS = PUBLIC_METADATA_CACHE_SECONDS * 1000;
const PUBLIC_HISTORY_CACHE_MS = PUBLIC_HISTORY_CACHE_SECONDS * 1000;
const PUBLIC_HISTORY_CACHE_MAX_ENTRIES = 256;

type PublicRateLimitBucket = {
  count: number;
  resetAt: number;
  lastSeenAt: number;
};

const publicRateLimitBuckets = new Map<string, PublicRateLimitBucket>();
let publicRateLimitSweepCounter = 0;

type PublicClientsSnapshot = {
  clients: any[];
  nodes: any[];
  publicClientIds: Set<string>;
  privacyMode: boolean;
  expiresAt: number;
};

let publicSettingsCache: { value: Record<string, any>; expiresAt: number } | null = null;
let publicClientsSnapshotCache: PublicClientsSnapshot | null = null;
let publicPingTasksCache: { value: db.PingTask[]; expiresAt: number } | null = null;
const publicHistoryCache = new Map<string, { value: unknown; expiresAt: number }>();
const publicClientVisibilityCache = new Map<string, { value: boolean; expiresAt: number }>();
let lastLoginRateLimitCleanupAt = 0;
const loginFailureAuditThrottle = new Map<string, { expiresAt: number }>();

function cacheIsFresh(entry: { expiresAt: number } | null | undefined, now = Date.now()): boolean {
  return Boolean(entry && entry.expiresAt > now);
}

export function invalidatePublicMetadataCache(): void {
  publicSettingsCache = null;
  publicClientsSnapshotCache = null;
  publicPingTasksCache = null;
  publicHistoryCache.clear();
  publicClientVisibilityCache.clear();
}

function publicHistoryCacheKey(c: any, bucket: string): string {
  const url = new URL(c.req.url);
  url.searchParams.sort();
  return `${bucket}:${url.pathname}?${url.searchParams.toString()}`;
}

function getPublicHistoryCache(c: any, key: string): Response | null {
  const entry = publicHistoryCache.get(key);
  if (!cacheIsFresh(entry)) {
    if (entry) publicHistoryCache.delete(key);
    return null;
  }
  setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
  c.header('X-CF-Monitor-History-Cache', 'hit');
  return c.json(entry!.value);
}

function setPublicHistoryCache(c: any, key: string, value: unknown): Response {
  if (publicHistoryCache.size >= PUBLIC_HISTORY_CACHE_MAX_ENTRIES) {
    const oldestKey = publicHistoryCache.keys().next().value;
    if (oldestKey) publicHistoryCache.delete(oldestKey);
  }
  publicHistoryCache.set(key, {
    value,
    expiresAt: Date.now() + PUBLIC_HISTORY_CACHE_MS,
  });
  setPublicCache(c, PUBLIC_HISTORY_CACHE_SECONDS);
  c.header('X-CF-Monitor-History-Cache', 'miss');
  return c.json(value);
}

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

function readIntListParam(value: string | undefined, maxItems: number): number[] {
  if (!value) return [];
  return [...new Set(
    value
      .split(',')
      .map((item) => Number.parseInt(item.trim(), 10))
      .filter((item) => Number.isInteger(item) && item > 0),
  )].slice(0, maxItems);
}

function readPingTaskHistorySpecs(value: string | undefined, maxItems: number): db.PingTaskHistoryRequest[] {
  if (!value) return [];
  const specs: db.PingTaskHistoryRequest[] = [];
  const seen = new Set<number>();
  for (const rawSpec of value.split(',')) {
    const [rawTaskId, rawLimit, rawInterval] = rawSpec.split(':');
    const taskId = Number.parseInt(rawTaskId || '', 10);
    if (!Number.isInteger(taskId) || taskId <= 0 || seen.has(taskId)) continue;
    seen.add(taskId);
    specs.push({
      taskId,
      limit: readIntParam(rawLimit, 120, 360),
      intervalSec: readIntParam(rawInterval, 60, 86_400),
    });
    if (specs.length >= maxItems) break;
  }
  return specs;
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

async function getPublicSettings(database: D1Database): Promise<Record<string, any>> {
  const now = Date.now();
  if (cacheIsFresh(publicSettingsCache, now)) return publicSettingsCache!.value;

  const settings = buildPublicSettings(await db.getSettingsByKeys(database, PUBLIC_SETTING_KEYS));
  publicSettingsCache = { value: settings, expiresAt: now + PUBLIC_METADATA_CACHE_MS };
  return settings;
}

function isPublicPrivacyModeEnabled(settings: Record<string, any>): boolean {
  return settings.public_privacy_mode === true || settings.public_privacy_mode === 'true';
}

async function getPublicClientsSnapshot(database: D1Database, privacyMode = false): Promise<PublicClientsSnapshot> {
  const now = Date.now();
  if (
    cacheIsFresh(publicClientsSnapshotCache, now) &&
    publicClientsSnapshotCache!.privacyMode === privacyMode
  ) {
    return publicClientsSnapshotCache!;
  }

  const clients = await db.listPublicClientRows(database);
  const publicClients = clients
    .filter(client => !client.hidden)
    .map(client => toPublicClient(client, privacyMode));
  const publicClientIds = new Set(clients.filter(client => !client.hidden).map(client => client.uuid));
  const nodes = publicClients.map((client) => ({
    ...client,
    tags: client.tags ? client.tags.split(';').filter(Boolean) : [],
  }));
  const expiresAt = now + PUBLIC_METADATA_CACHE_MS;
  for (const client of clients) {
    publicClientVisibilityCache.set(client.uuid, { value: !client.hidden, expiresAt });
  }
  publicClientsSnapshotCache = {
    clients: publicClients,
    nodes,
    publicClientIds,
    privacyMode,
    expiresAt,
  };
  return publicClientsSnapshotCache;
}

function boundedPublicPingIntervalSec(settings: Record<string, any>): number {
  const intervalSec = Number(settings.ping_record_persist_interval_sec);
  return Number.isFinite(intervalSec)
    ? Math.min(Math.max(Math.floor(intervalSec), 60), 3600)
    : 300;
}

async function getPublicPingTasks(
  database: D1Database,
  publicClientIds: Set<string>,
  pingIntervalSec: number,
): Promise<db.PingTask[]> {
  const now = Date.now();
  if (!cacheIsFresh(publicPingTasksCache, now)) {
    publicPingTasksCache = {
      value: await db.listPingTasks(database),
      expiresAt: now + PUBLIC_METADATA_CACHE_MS,
    };
  }
  const tasks = publicPingTasksCache?.value || [];
  return tasks
    .map(task => toPublicPingTask(task, publicClientIds))
    .map(task => task ? { ...task, interval_sec: pingIntervalSec } : task)
    .filter((task): task is db.PingTask => Boolean(task));
}

async function isPublicClient(database: D1Database, uuid: string): Promise<boolean> {
  const cached = publicClientVisibilityCache.get(uuid);
  if (cacheIsFresh(cached)) return cached!.value;

  const client = await db.getClientVisibility(database, uuid);
  const value = Boolean(client && !client.hidden);
  publicClientVisibilityCache.set(uuid, { value, expiresAt: Date.now() + PUBLIC_METADATA_CACHE_MS });
  return value;
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

const PUBLIC_PRIVACY_MODE_FIELDS = [
  'region',
  'public_remark',
  'kernel_version',
  'version',
  'price',
  'billing_cycle',
  'auto_renewal',
  'currency',
  'expired_at',
  'traffic_limit',
  'traffic_limit_type',
];

function applyPublicPrivacyMode(publicClient: any): any {
  for (const key of PUBLIC_PRIVACY_MODE_FIELDS) {
    delete publicClient[key];
  }
  return publicClient;
}

function toPublicClient(client: any, privacyMode = false): any {
  const {
    token,
    ipv4,
    ipv6,
    remark,
    ...publicClient
  } = client;
  const result = {
    ...publicClient,
    has_ipv4: Boolean(typeof ipv4 === 'string' ? ipv4.trim() : ipv4),
    has_ipv6: Boolean(typeof ipv6 === 'string' ? ipv6.trim() : ipv6),
    tags: sanitizePublicTags(publicClient.tags),
  };
  return privacyMode ? applyPublicPrivacyMode(result) : result;
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

type LoginRateLimitStateByBucket = Map<string, db.LoginRateLimit | null>;

async function loadLoginRateLimitStates(
  database: D1Database,
  buckets: string[],
): Promise<LoginRateLimitStateByBucket> {
  const states: LoginRateLimitStateByBucket = new Map();
  for (const bucket of buckets) {
    states.set(bucket, await db.getLoginRateLimit(database, bucket));
  }
  return states;
}

function getLoginRetryAfterSeconds(
  states: LoginRateLimitStateByBucket,
  nowMs: number,
): number {
  let lockedUntilMs = 0;
  for (const state of states.values()) {
    lockedUntilMs = Math.max(lockedUntilMs, parseTimeMs(state?.locked_until));
  }
  if (lockedUntilMs <= nowMs) return 0;
  return Math.ceil((lockedUntilMs - nowMs) / 1000);
}

async function recordLoginFailure(
  database: D1Database,
  buckets: string[],
  nowMs: number,
  states?: LoginRateLimitStateByBucket,
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  const rateLimitStates = states || await loadLoginRateLimitStates(database, buckets);
  for (const bucket of buckets) {
    const state = rateLimitStates.has(bucket) ? rateLimitStates.get(bucket) : await db.getLoginRateLimit(database, bucket);
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

    const nextState = {
      bucket,
      failures,
      first_failed_at: firstFailedAt,
      last_failed_at: nowIso,
      locked_until: shouldLock ? new Date(nowMs + lockMs).toISOString() : null,
    };
    await db.setLoginRateLimit(database, nextState);
    rateLimitStates.set(bucket, nextState);
  }
}

async function clearLoginFailures(database: D1Database, buckets: string[]): Promise<void> {
  for (const bucket of buckets) {
    await db.clearLoginRateLimit(database, bucket);
  }
}

async function cleanupExpiredLoginRateLimits(database: D1Database, nowMs: number): Promise<boolean> {
  if (
    lastLoginRateLimitCleanupAt > 0 &&
    nowMs - lastLoginRateLimitCleanupAt < LOGIN_RATE_LIMIT_CLEANUP_INTERVAL_MS
  ) {
    return false;
  }
  await db.deleteLoginRateLimitsBefore(
    database,
    new Date(nowMs - LOGIN_RATE_LIMIT_CLEANUP_AGE_MS).toISOString(),
  );
  lastLoginRateLimitCleanupAt = nowMs;
  return true;
}

function loginFailureAuditThrottleKey(username: string, ip: string, reason: string): string {
  return `${reason}:${ip}:${normalizeLoginUsername(username)}`;
}

async function auditLoginFailure(
  database: D1Database,
  username: string,
  ip: string,
  reason: string,
  nowMs = Date.now(),
): Promise<void> {
  const key = loginFailureAuditThrottleKey(username, ip, reason);
  const existing = loginFailureAuditThrottle.get(key);
  if (existing && existing.expiresAt > nowMs) return;

  if (loginFailureAuditThrottle.size >= LOGIN_FAILURE_AUDIT_THROTTLE_MAX_ENTRIES) {
    for (const [entryKey, entry] of loginFailureAuditThrottle) {
      if (entry.expiresAt <= nowMs || loginFailureAuditThrottle.size >= LOGIN_FAILURE_AUDIT_THROTTLE_MAX_ENTRIES) {
        loginFailureAuditThrottle.delete(entryKey);
      }
      if (loginFailureAuditThrottle.size < LOGIN_FAILURE_AUDIT_THROTTLE_MAX_ENTRIES) break;
    }
  }

  loginFailureAuditThrottle.set(key, {
    expiresAt: nowMs + LOGIN_FAILURE_AUDIT_THROTTLE_MS,
  });
  await db.insertAuditLog(
    database,
    username.slice(0, MAX_LOGIN_USERNAME_LENGTH) || 'anonymous',
    'login_failed',
    JSON.stringify({
      username: username.slice(0, MAX_LOGIN_USERNAME_LENGTH),
      ip,
      reason,
    }),
    'warning',
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
  await cleanupExpiredLoginRateLimits(c.env.DB, nowMs);

  const rateLimitStates = await loadLoginRateLimitStates(c.env.DB, rateLimitBuckets);
  const retryAfter = getLoginRetryAfterSeconds(rateLimitStates, nowMs);
  if (retryAfter > 0) {
    c.header('Retry-After', String(retryAfter));
    await auditLoginFailure(c.env.DB, username, clientIp, 'rate_limited', nowMs);
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
    const failedAt = Date.now();
    await recordLoginFailure(c.env.DB, rateLimitBuckets, failedAt, rateLimitStates);
    await auditLoginFailure(c.env.DB, username, clientIp, 'unknown_user', failedAt);
    return c.json({ error: '用户名或密码错误' }, 401);
  }

  const valid = await verifyPassword(password, user.passwd);
  if (!valid) {
    const failedAt = Date.now();
    await recordLoginFailure(c.env.DB, rateLimitBuckets, failedAt, rateLimitStates);
    await auditLoginFailure(c.env.DB, username, clientIp, 'invalid_password', failedAt);
    return c.json({ error: '用户名或密码错误' }, 401);
  }

  let token: string;
  try {
    token = await generateToken(user.uuid, user.username, c.env, Number(user.session_version || 0));
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
  if (getAdminSessionToken(c) && !verifyAdminCsrfToken(c)) {
    return c.json({ error: 'CSRF token 无效，请刷新页面后重试' }, 403);
  }
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
    const user = await db.getUserByUuid(c.env.DB, payload.userId);
    if (!user || Number(user.session_version || 0) !== Number(payload.sessionVersion || 0)) {
      return c.json({ error: 'Token 无效' }, 401);
    }
    const csrfToken = ensureAdminCsrfCookie(c);
    return c.json({
      uuid: user.uuid,
      username: user.username,
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

  const settings = await getPublicSettings(c.env.DB);
  const snapshot = await getPublicClientsSnapshot(c.env.DB, isPublicPrivacyModeEnabled(settings));
  setPublicCache(c, PUBLIC_METADATA_CACHE_SECONDS);
  return c.json(snapshot.clients);
});

// 获取公开设置
publicRoutes.get('/public', async (c) => {
  const limited = await guardPublicMetadata(c, 'settings');
  if (limited) return limited;

  setPublicCache(c, PUBLIC_METADATA_CACHE_SECONDS);
  return c.json(await getPublicSettings(c.env.DB));
});

// 获取客户端最近的监控记录
publicRoutes.get('/recent/:uuid', async (c) => {
  const limited = await guardPublicHistory(c, 'recent');
  if (limited) return limited;

  const uuid = c.req.param('uuid');
  const limit = readIntParam(c.req.query('limit'), 30, 150);
  if (!(await isPublicClient(c.env.DB, uuid))) {
    return setPublicHistoryCache(c, publicHistoryCacheKey(c, 'recent'), []);
  }
  const cacheKey = publicHistoryCacheKey(c, 'recent');
  const cached = getPublicHistoryCache(c, cacheKey);
  if (cached) return cached;
  const records = await db.getRecentRecords(c.env.DB, uuid, limit);
  return setPublicHistoryCache(c, cacheKey, records);
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
    const cacheKey = publicHistoryCacheKey(c, 'records-load');
    if (wantsPagedResponse(c)) {
      const page = readIntParam(c.req.query('page'), 1, 100000);
      const limit = readIntParam(c.req.query('limit'), 100, 500);
      return setPublicHistoryCache(c, cacheKey, emptyPagedResult(page, limit));
    }
    return setPublicHistoryCache(c, cacheKey, []);
  }
  const cacheKey = publicHistoryCacheKey(c, 'records-load');
  const cached = getPublicHistoryCache(c, cacheKey);
  if (cached) return cached;

  if (start && end) {
    const rangeError = validatePublicTimeRange(start, end);
    if (rangeError) return c.json({ error: rangeError }, 400);

    const limitQuery = c.req.query('limit');
    if (wantsPagedResponse(c)) {
      const page = readIntParam(c.req.query('page'), 1, 100000);
      const limit = readIntParam(limitQuery, 100, 500);
      return setPublicHistoryCache(c, cacheKey, await db.getRecordsByTimeRangePaged(c.env.DB, uuid, start, end, page, limit));
    }

    const limit = readIntParam(limitQuery, 500, 1000);
    return setPublicHistoryCache(c, cacheKey, await db.getRecordsByTimeRangeLimited(c.env.DB, uuid, start, end, limit));
  }

  const records = await db.getRecentRecords(c.env.DB, uuid, readIntParam(c.req.query('limit'), 150, 500));
  if (wantsPagedResponse(c)) {
    return setPublicHistoryCache(c, cacheKey, {
      data: records,
      total: records.length,
      page: 1,
      limit: records.length,
      has_more: false,
    });
  }
  return setPublicHistoryCache(c, cacheKey, records);
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
    const cacheKey = publicHistoryCacheKey(c, 'records-gpu');
    if (wantsPagedResponse(c)) {
      const page = readIntParam(c.req.query('page'), 1, 100000);
      return setPublicHistoryCache(c, cacheKey, emptyPagedResult(page, limit));
    }
    return setPublicHistoryCache(c, cacheKey, []);
  }
  const cacheKey = publicHistoryCacheKey(c, 'records-gpu');
  const cached = getPublicHistoryCache(c, cacheKey);
  if (cached) return cached;

  if (wantsPagedResponse(c)) {
    if (start && end) {
      const rangeError = validatePublicTimeRange(start, end);
      if (rangeError) return c.json({ error: rangeError }, 400);
    }
    const page = readIntParam(c.req.query('page'), 1, 100000);
    return setPublicHistoryCache(c, cacheKey, await db.getGPURecordsPaged(c.env.DB, uuid, start, end, page, limit));
  }

  if (start && end) {
    const rangeError = validatePublicTimeRange(start, end);
    if (rangeError) return c.json({ error: rangeError }, 400);
  }

  const records = await db.getGPURecords(c.env.DB, uuid, start, end, limit);
  return setPublicHistoryCache(c, cacheKey, records);
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
    const cacheKey = publicHistoryCacheKey(c, 'records-ping');
    if (wantsPagedResponse(c)) {
      const page = readIntParam(c.req.query('page'), 1, 100000);
      return setPublicHistoryCache(c, cacheKey, emptyPagedResult(page, limit));
    }
    return setPublicHistoryCache(c, cacheKey, []);
  }
  const cacheKey = publicHistoryCacheKey(c, 'records-ping');
  const cached = getPublicHistoryCache(c, cacheKey);
  if (cached) return cached;

  if (wantsPagedResponse(c)) {
    const page = readIntParam(c.req.query('page'), 1, 100000);
    return setPublicHistoryCache(c, cacheKey, await db.getPingRecordsPaged(c.env.DB, uuid, taskId, page, limit));
  }

  const records = await db.getPingRecords(c.env.DB, uuid, taskId, limit);
  return setPublicHistoryCache(c, cacheKey, records);
});

// 批量获取 Ping 记录。详情页用它一次读取多个任务，避免同一批 ping_snapshots 被重复扫描。
publicRoutes.get('/records/ping/batch', async (c) => {
  const limited = await guardPublicHistory(c, 'records-ping-batch');
  if (limited) return limited;

  const uuid = c.req.query('uuid');
  const taskSpecs = readPingTaskHistorySpecs(c.req.query('task_specs'), 16);
  const taskIds = taskSpecs.length > 0
    ? taskSpecs.map(task => task.taskId)
    : readIntListParam(c.req.query('task_ids'), 16);
  const limit = readIntParam(c.req.query('limit'), 120, 360);
  const baseIntervalSec = readIntParam(c.req.query('base_interval'), 60, 86_400);

  if (!uuid || taskIds.length === 0) {
    return c.json({ error: '缺少参数' }, 400);
  }

  if (!(await isPublicClient(c.env.DB, uuid))) {
    return setPublicHistoryCache(c, publicHistoryCacheKey(c, 'records-ping-batch'), {});
  }
  const cacheKey = publicHistoryCacheKey(c, 'records-ping-batch');
  const cached = getPublicHistoryCache(c, cacheKey);
  if (cached) return cached;

  const records = await db.getPingRecordsForTasks(
    c.env.DB,
    uuid,
    taskSpecs.length > 0 ? taskSpecs : taskIds,
    limit,
    baseIntervalSec,
  );
  return setPublicHistoryCache(c, cacheKey, records);
});

// 获取 Ping 任务列表（公开）
publicRoutes.get('/task/ping', async (c) => {
  const limited = await guardPublicMetadata(c, 'ping-tasks');
  if (limited) return limited;

  const settings = await getPublicSettings(c.env.DB);
  const snapshot = await getPublicClientsSnapshot(c.env.DB, isPublicPrivacyModeEnabled(settings));
  setPublicCache(c, PUBLIC_METADATA_CACHE_SECONDS);
  return c.json(await getPublicPingTasks(c.env.DB, snapshot.publicClientIds, boundedPublicPingIntervalSec(settings)));
});

// 节点信息（兼容旧版格式）
publicRoutes.get('/nodes', async (c) => {
  const limited = await guardPublicMetadata(c, 'nodes');
  if (limited) return limited;

  const settings = await getPublicSettings(c.env.DB);
  const snapshot = await getPublicClientsSnapshot(c.env.DB, isPublicPrivacyModeEnabled(settings));
  setPublicCache(c, PUBLIC_METADATA_CACHE_SECONDS);
  return c.json(snapshot.nodes);
});

// 实时数据 - 代理到 Durable Object
publicRoutes.get('/live', async (c) => {
  const limited = await guardPublicLive(c);
  if (limited) return limited;

  const doId = c.env.LIVE_DATA.idFromName('global');
  const stub = c.env.LIVE_DATA.get(doId);
  return withPublicCache(await stub.fetch(c.req.raw), PUBLIC_LIVE_CACHE_SECONDS);
});

export { publicRoutes };
