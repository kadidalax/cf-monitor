/**
 * Agent 客户端 API 路由
 * 用于 Agent 上报数据、获取 Ping 任务等
 */

import { Hono } from 'hono';
import type { Bindings, Variables } from '../index';
import * as db from '../db/queries';
import { buildAdminSettings } from '../settings/schema';
import { normalizeMonitorReport } from '../utils/monitor-report';
import { validatePingResults } from '../utils/ping-result';
import { escapeTelegramHtml } from '../utils/telegram';
import { bestEffortRecordHealthEvent, errorDetail } from '../utils/observability';

const clientRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const HTTP_LIVE_TTL_FALLBACK_MS = 180_000;
const HTTP_LIVE_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const AGENT_AUTH_CACHE_MS = 15_000;
const AGENT_AUTH_NEGATIVE_CACHE_MS = 5_000;
const AGENT_AUTH_CACHE_MAX_ENTRIES = 512;
const AGENT_PING_TASK_CACHE_MS = 30_000;
const AGENT_PING_TASK_EMPTY_POLL_SEC = 600;
const AGENT_PING_TASK_MAX_POLL_SEC = 3600;
const AGENT_PING_TASK_MIN_POLL_SEC = 60;
const AGENT_PING_TASK_DEFAULT_INTERVAL_SEC = 300;
const AGENT_PING_INTERVAL_SETTING_CACHE_MS = 5_000;
const IP_CHANGE_NOTIFICATION_SETTING_KEYS = [
  'enable_ip_change_notification',
  'telegram_bot_token',
  'telegram_chat_id',
];
const AGENT_POLICY_SETTING_KEYS = [
  'live_poll_active_interval_sec',
  'live_poll_idle_interval_sec',
  'live_poll_active_max_duration_sec',
];
const AGENT_PING_INTERVAL_SETTING_KEYS = ['ping_record_persist_interval_sec'];

type AgentAuthCacheEntry<T> = { value: T | null; expiresAt: number };

let agentAuthCache = new Map<string, AgentAuthCacheEntry<db.Client>>();
let agentIdentityAuthCache = new Map<string, AgentAuthCacheEntry<db.ClientIdentity>>();
let agentPingTasksCache: { value: db.PingTask[]; expiresAt: number } | null = null;
let agentPingIntervalCache: { value: number; expiresAt: number } | null = null;

export function invalidateAgentClientAuthCache(client?: { uuid?: string; token?: string }): void {
  if (!client) {
    agentAuthCache.clear();
    agentIdentityAuthCache.clear();
    return;
  }
  for (const [token, entry] of agentAuthCache) {
    if (token === client.token || entry.value?.uuid === client.uuid) {
      agentAuthCache.delete(token);
    }
  }
  for (const [token, entry] of agentIdentityAuthCache) {
    if (token === client.token || entry.value?.uuid === client.uuid) {
      agentIdentityAuthCache.delete(token);
    }
  }
}

export function invalidateAgentPingTaskCache(): void {
  agentPingTasksCache = null;
  agentPingIntervalCache = null;
}

function setAgentAuthCache<T>(
  cache: Map<string, AgentAuthCacheEntry<T>>,
  token: string,
  value: T | null,
  ttlMs: number,
  now: number,
): void {
  if (cache.size >= AGENT_AUTH_CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (typeof firstKey === 'string') cache.delete(firstKey);
  }
  cache.set(token, {
    value,
    expiresAt: now + ttlMs,
  });
}

export async function getAgentClientByToken(database: D1Database, token: string): Promise<db.Client | null> {
  const now = Date.now();
  const cached = agentAuthCache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const client = await db.getClientByToken(database, token);
  if (client) {
    setAgentAuthCache(agentAuthCache, token, client, AGENT_AUTH_CACHE_MS, now);
  } else {
    setAgentAuthCache(agentAuthCache, token, null, AGENT_AUTH_NEGATIVE_CACHE_MS, now);
  }
  return client;
}

export async function getAgentClientIdentityByToken(database: D1Database, token: string): Promise<db.ClientIdentity | null> {
  const now = Date.now();
  const cached = agentIdentityAuthCache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const client = await db.getClientIdentityByToken(database, token);
  if (client) {
    setAgentAuthCache(agentIdentityAuthCache, token, client, AGENT_AUTH_CACHE_MS, now);
  } else {
    setAgentAuthCache(agentIdentityAuthCache, token, null, AGENT_AUTH_NEGATIVE_CACHE_MS, now);
  }
  return client;
}

async function listAgentPingTasks(database: D1Database): Promise<db.PingTask[]> {
  const now = Date.now();
  if (agentPingTasksCache && agentPingTasksCache.expiresAt > now) {
    return agentPingTasksCache.value;
  }

  const tasks = await db.listPingTasks(database);
  agentPingTasksCache = {
    value: tasks,
    expiresAt: now + AGENT_PING_TASK_CACHE_MS,
  };
  return tasks;
}

async function getUnifiedPingIntervalSec(database: D1Database): Promise<number> {
  const now = Date.now();
  if (agentPingIntervalCache && agentPingIntervalCache.expiresAt > now) {
    return agentPingIntervalCache.value;
  }

  const settings = buildAdminSettings(await db.getSettingsByKeys(database, AGENT_PING_INTERVAL_SETTING_KEYS));
  const intervalSec = Number(settings.ping_record_persist_interval_sec);
  const bounded = Number.isFinite(intervalSec)
    ? Math.min(Math.max(Math.floor(intervalSec), AGENT_PING_TASK_MIN_POLL_SEC), AGENT_PING_TASK_MAX_POLL_SEC)
    : AGENT_PING_TASK_DEFAULT_INTERVAL_SEC;
  agentPingIntervalCache = {
    value: bounded,
    expiresAt: now + AGENT_PING_INTERVAL_SETTING_CACHE_MS,
  };
  return bounded;
}

function withUnifiedPingInterval(tasks: db.PingTask[], intervalSec: number): db.PingTask[] {
  return tasks.map(task => ({ ...task, interval_sec: intervalSec }));
}

function estimateNextPingTaskPollSec(tasks: db.PingTask[], unifiedIntervalSec: number): number {
  if (tasks.length === 0) return AGENT_PING_TASK_EMPTY_POLL_SEC;
  return Math.min(
    Math.max(unifiedIntervalSec, AGENT_PING_TASK_MIN_POLL_SEC),
    AGENT_PING_TASK_MAX_POLL_SEC,
  );
}

function nonEmptyString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function positiveNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clientFieldChanged(current: unknown, next: unknown): boolean {
  if (typeof next === 'number') return Number(current || 0) !== next;
  return String(current ?? '') !== String(next ?? '');
}

function buildChangedClientPatch(client: db.Client | null | undefined, nextValues: Partial<db.Client>): Partial<db.Client> {
  const patch: Partial<db.Client> = {};
  for (const [key, value] of Object.entries(nextValues)) {
    const typedKey = key as keyof db.Client;
    if (clientFieldChanged(client?.[typedKey], value)) {
      (patch as Record<string, unknown>)[key] = value;
    }
  }
  return patch;
}

function requestClientIp(c: any): string {
  const forwardedFor = c.req.header('X-Forwarded-For') || '';
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Real-IP') ||
    forwardedFor.split(',')[0] ||
    ''
  ).trim();
}

function isIPv6(ip: string): boolean {
  return ip.includes(':');
}

function requestRegion(c: any): string {
  const cf = (c.req.raw as any)?.cf || {};
  const parts = [
    cf.city,
    cf.region,
    cf.country || c.req.header('CF-IPCountry'),
  ].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  return parts.join(', ');
}

function liveReportTtlMs(report: Record<string, any>): number {
  const intervalSec = Number(report.report_interval ?? report.interval_sec ?? report.interval);
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return HTTP_LIVE_TTL_FALLBACK_MS;
  return Math.min(Math.max(intervalSec * 3 * 1000, 30_000), HTTP_LIVE_TTL_MAX_MS);
}

function ipChangeParts(oldIpv4: string, oldIpv6: string, newIpv4: string, newIpv6: string): string[] {
  const parts: string[] = [];
  if (oldIpv4 && newIpv4 && oldIpv4 !== newIpv4) {
    parts.push(`IPv4: ${oldIpv4} → ${newIpv4}`);
  }
  if (oldIpv6 && newIpv6 && oldIpv6 !== newIpv6) {
    parts.push(`IPv6: ${oldIpv6.slice(0, 10)}… → ${newIpv6.slice(0, 10)}…`);
  }
  return parts;
}

async function recordIpChangeIfEnabled(c: any, clientName: string, parts: string[]): Promise<void> {
  if (parts.length === 0) return;

  const settings = await db.getSettingsByKeys(c.env.DB, IP_CHANGE_NOTIFICATION_SETTING_KEYS);
  if (settings['enable_ip_change_notification'] !== 'true') return;

  const message = `CF Monitor IP 变更通知\n节点: ${clientName}\n${parts.join('\n')}`;
  const botToken = settings['telegram_bot_token'];
  const chatId = settings['telegram_chat_id'];
  if (botToken && chatId) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: escapeTelegramHtml(message), parse_mode: 'HTML' }),
      });
    } catch { /* best effort */ }
  }

  await db.insertAuditLog(c.env.DB, 'system', 'ip_change',
    `IP 变更: ${clientName} ${parts.join(', ')}`);
}

async function syncClientIpsFromReport(
  c: any,
  uuid: string,
  clientName: string,
  report: Record<string, any>,
  oldClient: db.Client | null,
): Promise<void> {
  if (!oldClient) return;

  const fallbackIp = requestClientIp(c);
  const reportedIpv4 = nonEmptyString(report.ipv4, '');
  const reportedIpv6 = nonEmptyString(report.ipv6, '');
  const nextIpv4 = reportedIpv4 || (!reportedIpv6 && fallbackIp && !isIPv6(fallbackIp) ? fallbackIp : '');
  const nextIpv6 = reportedIpv6 || (fallbackIp && isIPv6(fallbackIp) ? fallbackIp : '');

  const updates: Record<string, string> = {};
  if (nextIpv4 && oldClient.ipv4 !== nextIpv4) updates.ipv4 = nextIpv4;
  if (nextIpv6 && oldClient.ipv6 !== nextIpv6) updates.ipv6 = nextIpv6;
  if (Object.keys(updates).length === 0) return;

  await db.updateClient(c.env.DB, uuid, updates as any);
  invalidateAgentClientAuthCache({ uuid, token: oldClient.token });
  const parts = ipChangeParts(oldClient.ipv4 || '', oldClient.ipv6 || '', nextIpv4 || oldClient.ipv4 || '', nextIpv6 || oldClient.ipv6 || '');
  await recordIpChangeIfEnabled(c, clientName, parts);
}

async function updateLiveReport(
  c: any,
  uuid: string,
  name: string,
  hidden: boolean,
  reportOrReports: Record<string, any> | Record<string, any>[],
  nowMs: number,
): Promise<boolean> {
  const reports = Array.isArray(reportOrReports) ? reportOrReports : undefined;
  const report = reports ? reports[reports.length - 1] : reportOrReports;
  try {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    const response = await stub.fetch(new Request('https://do/client-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uuid,
        name,
        hidden,
        ...(reports ? { reports } : { report }),
        timestamp: nowMs,
        ttl_ms: liveReportTtlMs(report),
      }),
    }));
    const result = await response.json().catch(() => null) as { persisted?: unknown } | null;
    return Boolean(response.ok && result?.persisted);
  } catch {
    // HTTP reports remain accepted even if the realtime fanout path is unavailable.
    return false;
  }
}

async function fallbackAgentPolicy(database: D1Database) {
  const settings = buildAdminSettings(await db.getSettingsByKeys(database, AGENT_POLICY_SETTING_KEYS));
  const sampleIntervalSec = Math.min(Math.max(Number(settings.live_poll_active_interval_sec || 3), 3), 300);
  const reportIntervalSec = Math.min(Math.max(Number(settings.live_poll_idle_interval_sec || 600), 60), 3600);
  const viewerTtlSec = Math.min(Math.max(Number(settings.live_poll_active_max_duration_sec || 600), 60), 3600);
  return {
    type: 'policy',
    mode: 'idle',
    sample_interval_sec: Math.floor(sampleIntervalSec),
    report_interval_sec: Math.floor(reportIntervalSec),
    report_now: false,
    viewer_count: 0,
    viewer_ttl_sec: Math.floor(viewerTtlSec),
    timestamp: Date.now(),
  };
}

function bearerToken(c: any): string {
  const authHeader = c.req.header('Authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
}

// Agent Token 认证中间件
async function clientAuth(c: any, next: any) {
  const token = bearerToken(c).trim();

  if (!token) {
    return c.json({ error: '缺少认证 Token' }, 401);
  }

  const client = await getAgentClientByToken(c.env.DB, token);
  if (!client) {
    return c.json({ error: '无效的 Token' }, 401);
  }

  c.set('clientUuid', client.uuid);
  c.set('clientName', client.name);
  c.set('clientHidden', Boolean(client.hidden));
  c.set('clientRecord', client);
  await next();
}

async function clientIdentityAuth(c: any, next: any) {
  const token = bearerToken(c).trim();

  if (!token) {
    return c.json({ error: '缺少认证 Token' }, 401);
  }

  const client = await getAgentClientIdentityByToken(c.env.DB, token);
  if (!client) {
    return c.json({ error: '无效的 Token' }, 401);
  }

  c.set('clientUuid', client.uuid);
  c.set('clientName', client.name);
  c.set('clientHidden', Boolean(client.hidden));
  await next();
}

// 旧自动注册入口：功能已移除，仅返回明确拒绝，避免旧安装脚本静默失败。
clientRoutes.post('/register', async (c) => {
  return c.json({ error: 'Agent 自动注册已移除，请在后台创建节点并使用节点 Token 安装 Agent' }, 410);
});

// 获取 Agent 动态上报策略（HTTP 模式使用）
clientRoutes.get('/policy', clientIdentityAuth, async (c) => {
  try {
    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    const response = await stub.fetch(new Request('https://do/policy', { method: 'GET' }));
    if (!response.ok) {
      return c.json({ error: '获取策略失败' }, 502);
    }
    return c.json(await response.json());
  } catch {
    try {
      return c.json(await fallbackAgentPolicy(c.env.DB));
    } catch {
      return c.json({
        type: 'policy',
        mode: 'idle',
        sample_interval_sec: 3,
        report_interval_sec: 600,
        report_now: false,
        viewer_count: 0,
        viewer_ttl_sec: 600,
        timestamp: Date.now(),
      });
    }
  }
});

// 上传基本信息（受保护）
clientRoutes.post('/uploadBasicInfo', clientAuth, async (c) => {
  try {
    const body = await c.req.json();
    const uuid = c.get('clientUuid')!;
    const authClient = c.get('clientRecord') as db.Client | undefined;

    // Fetch old client info for IP change detection
    const oldClient = authClient || await db.getClient(c.env.DB, uuid);
    const oldIpv4 = oldClient?.ipv4 || '';
    const oldIpv6 = oldClient?.ipv6 || '';
    const fallbackIp = requestClientIp(c);
    const newIpv4 = nonEmptyString(body.ipv4, oldIpv4);
    const newIpv6 = nonEmptyString(body.ipv6, oldIpv6);
    const inferredIpv4 = !newIpv4 && fallbackIp && !isIPv6(fallbackIp) ? fallbackIp : newIpv4;
    const inferredIpv6 = !newIpv6 && fallbackIp && isIPv6(fallbackIp) ? fallbackIp : newIpv6;
    const displayName = oldClient?.name || c.get('clientName') || uuid;

    const patch = buildChangedClientPatch(oldClient, {
      cpu_name: nonEmptyString(body.cpu_name, oldClient?.cpu_name || ''),
      virtualization: nonEmptyString(body.virtualization, oldClient?.virtualization || ''),
      arch: nonEmptyString(body.arch, oldClient?.arch || ''),
      cpu_cores: positiveNumber(body.cpu_cores, oldClient?.cpu_cores || 0),
      os: nonEmptyString(body.os, oldClient?.os || ''),
      kernel_version: nonEmptyString(body.kernel_version, oldClient?.kernel_version || ''),
      gpu_name: nonEmptyString(body.gpu_name, oldClient?.gpu_name || ''),
      ipv4: inferredIpv4,
      ipv6: inferredIpv6,
      region: nonEmptyString(body.region, oldClient?.region || requestRegion(c)),
      mem_total: positiveNumber(body.mem_total, oldClient?.mem_total || 0),
      swap_total: positiveNumber(body.swap_total, oldClient?.swap_total || 0),
      disk_total: positiveNumber(body.disk_total, oldClient?.disk_total || 0),
      version: nonEmptyString(body.version, oldClient?.version || ''),
    });
    if (Object.keys(patch).length > 0) {
      await db.updateClient(c.env.DB, uuid, patch);
      invalidateAgentClientAuthCache({ uuid, token: oldClient?.token });
    }

    await recordIpChangeIfEnabled(
      c,
      displayName,
      ipChangeParts(oldIpv4, oldIpv6, inferredIpv4, inferredIpv6),
    );

    return c.json({ success: true });
  } catch {
    return c.json({ error: '上传失败' }, 500);
  }
});

// 上报监控数据（HTTP 方式，受保护）
clientRoutes.post('/report', clientAuth, async (c) => {
  try {
    const body = await c.req.json();
    const uuid = c.get('clientUuid')!;
    const nowMs = Date.now();
    const rawReports = Array.isArray(body?.reports) ? body.reports.slice(0, 1200) : [body];
    const reports = rawReports.map((item: any) => normalizeMonitorReport(item));
    const report = reports[reports.length - 1];
    const liveName = nonEmptyString(report.name, c.get('clientName') || uuid);
    const hidden = Boolean(c.get('clientHidden'));
    const authClient = c.get('clientRecord') as db.Client | undefined;

    await syncClientIpsFromReport(c, uuid, liveName, report, authClient || null);

    const persisted = await updateLiveReport(c, uuid, liveName, hidden, reports.length > 1 ? reports : report, nowMs);
    if (persisted) {
      // 版本信息不需要每次上报写入 D1，跟随历史采样刷新即可。
      if (report.version && clientFieldChanged(authClient?.version, report.version)) {
        await db.updateClient(c.env.DB, uuid, {
          version: report.version,
        });
        invalidateAgentClientAuthCache({ uuid, token: authClient?.token });
      }
    }

    return c.json({ success: true, persisted });
  } catch (e) {
    return c.json({ error: '上报失败' }, 500);
  }
});

// 获取 Ping 任务列表（受保护）
clientRoutes.get('/ping/tasks', clientIdentityAuth, async (c) => {
  try {
    const uuid = c.get('clientUuid')!;
    const allTasks = await listAgentPingTasks(c.env.DB);

    // 筛选适用于此客户端的任务
    const tasks = allTasks.filter(task => {
      if (task.all_clients) return true;
      return task.clients.includes(uuid);
    });
    const unifiedPingIntervalSec = await getUnifiedPingIntervalSec(c.env.DB);
    const responseTasks = withUnifiedPingInterval(tasks, unifiedPingIntervalSec);

    if (c.req.query('format') === 'v2') {
      return c.json({
        tasks: responseTasks,
        next_poll_sec: estimateNextPingTaskPollSec(responseTasks, unifiedPingIntervalSec),
      });
    }

    return c.json(responseTasks);
  } catch {
    return c.json({ error: '获取失败' }, 500);
  }
});

// 上报 Ping 结果（受保护）
clientRoutes.post('/ping/result', clientIdentityAuth, async (c) => {
  try {
    const body = await c.req.json();
    const uuid = c.get('clientUuid')!;

    // body 应该是 { task_id, value } 或包含多个结果的数组
    const tasks = await listAgentPingTasks(c.env.DB);
    const validated = validatePingResults(body, tasks, uuid);
    if (!validated.ok) {
      return c.json({ error: validated.error }, validated.status as 400 | 403);
    }
    const taskMap = new Map(tasks.map(task => [task.id, task]));

    const doId = c.env.LIVE_DATA.idFromName('global');
    const stub = c.env.LIVE_DATA.get(doId);
    const doResponse = await stub.fetch(new Request('https://do/ping-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: uuid,
        results: validated.results.map(result => ({
          task_id: result.taskId,
          value: result.value,
          interval_sec: taskMap.get(result.taskId)?.interval_sec || 60,
        })),
        timestamp: Date.now(),
      }),
    }));
    if (!doResponse.ok) {
      return c.json({ error: '上报失败' }, 500);
    }
    const doResult = await doResponse.json().catch(() => null) as { accepted?: unknown } | null;
    const accepted = Number(doResult?.accepted || 0);
    return c.json({ success: true, accepted });
  } catch (error) {
    await bestEffortRecordHealthEvent(
      c.env.DB,
      'ping_persistence',
      'error',
      `ping persist failed: ${errorDetail(error)}`,
      { auditAction: 'ping_persistence_error' },
    );
    return c.json({ error: '上报失败' }, 500);
  }
});

export { clientRoutes, clientAuth, clientIdentityAuth };
