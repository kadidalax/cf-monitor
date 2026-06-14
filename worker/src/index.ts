/**
 * CF Monitor - Cloudflare Worker 监控系统
 * 基于 Komari 重构，使用 Hono 框架 + D1 数据库 + Durable Objects
 */

import { Hono } from 'hono';

// 路由模块
import { publicRoutes } from './routes/public';
import { adminRoutes } from './routes/admin';
import { clientRoutes } from './routes/client';
import { wsRoutes } from './routes/websocket';
import * as db from './db/queries';
import { ensureSchema } from './db/schema-bootstrap';
import { AuthConfigurationError, verifyAdminToken } from './auth/jwt';
import { getAdminSessionToken, verifyAdminCsrfToken } from './auth/session';
import { buildAdminSettings } from './settings/schema';
import { escapeTelegramHtml } from './utils/telegram';
import { bestEffortRecordHealthEvent, errorDetail } from './utils/observability';
import type { Client as MonitorClient, ScheduledClientRow } from './db/queries';

// 类型定义
export type Bindings = {
  DB: D1Database;
  LIVE_DATA: DurableObjectNamespace;
  RATE_LIMIT: DurableObjectNamespace;
  JWT_SECRET?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  SITE_TITLE: string;
  SITE_DESCRIPTION: string;
};

export type Variables = {
  userId: string;
  username: string;
  clientUuid?: string;
  clientName?: string;
  clientHidden?: boolean;
  clientRecord?: MonitorClient;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const SOURCE_REVISION = '2026-06-07-p2-audit-fixes';
const CSRF_REJECTION_AUDIT_THROTTLE_MS = 60_000;
const CSRF_REJECTION_AUDIT_THROTTLE_MAX_ENTRIES = 512;
const csrfRejectionAuditThrottle = new Map<string, { expiresAt: number }>();

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:",
};

function requestIp(c: any): string {
  const forwardedFor = c.req.header('X-Forwarded-For') || '';
  return (
    c.req.header('CF-Connecting-IP') ||
    c.req.header('X-Real-IP') ||
    forwardedFor.split(',')[0]?.trim() ||
    'unknown'
  );
}

function csrfRejectionAuditKey(username: string, ip: string, path: string): string {
  return `${username}:${ip}:${path}`;
}

export function resetCsrfRejectionAuditThrottleForTests(): void {
  csrfRejectionAuditThrottle.clear();
}

export async function auditCsrfRejection(
  database: D1Database,
  username: string,
  ip: string,
  path: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const key = csrfRejectionAuditKey(username, ip, path);
  const existing = csrfRejectionAuditThrottle.get(key);
  if (existing && existing.expiresAt > nowMs) return false;

  if (csrfRejectionAuditThrottle.size >= CSRF_REJECTION_AUDIT_THROTTLE_MAX_ENTRIES) {
    for (const [entryKey, entry] of csrfRejectionAuditThrottle) {
      if (entry.expiresAt <= nowMs || csrfRejectionAuditThrottle.size >= CSRF_REJECTION_AUDIT_THROTTLE_MAX_ENTRIES) {
        csrfRejectionAuditThrottle.delete(entryKey);
      }
      if (csrfRejectionAuditThrottle.size < CSRF_REJECTION_AUDIT_THROTTLE_MAX_ENTRIES) break;
    }
  }

  csrfRejectionAuditThrottle.set(key, {
    expiresAt: nowMs + CSRF_REJECTION_AUDIT_THROTTLE_MS,
  });
  await db.insertAuditLog(
    database,
    username,
    'csrf_rejected',
    `拒绝缺少或无效 CSRF token 的管理写请求: ${path}; ip=${ip}`,
    'warning',
  );
  return true;
}

app.use('*', async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    c.header(name, value);
  }
});

// API 路由 - 无缓存
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

// 公开 API，无认证
app.route('/api', publicRoutes);

// Agent 上报 API，Token 认证
app.route('/api/clients', clientRoutes);

// WebSocket 路由
app.route('/api', wsRoutes);

// 管理员 API，JWT 认证
app.use('/api/admin/*', async (c, next) => {
  const token = getAdminSessionToken(c);
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await verifyAdminToken(token, c.env);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      console.error('[auth] JWT_SECRET is missing or shorter than 32 bytes');
      return c.json({ error: 'Server authentication is not configured' }, 500);
    }
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('userId', payload.userId);
  c.set('username', payload.username);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !verifyAdminCsrfToken(c)) {
    try {
      const path = new URL(c.req.url).pathname;
      await auditCsrfRejection(c.env.DB, payload.username, requestIp(c), path);
    } catch {
      // Keep CSRF rejection independent from audit logging availability.
    }
    return c.json({ error: 'CSRF token 无效，请刷新页面后重试' }, 403);
  }
  await next();
});

app.route('/api/admin', adminRoutes);

// 管理员手动触发维护任务，用于本地开发和部署后自检。
app.post('/api/admin/cron/run', async (c) => {
  await runScheduled(c.env);
  return c.json({ success: true });
});

// 健康检查
app.get('/ping', (c) => c.text('pong'));

// 版本信息
app.get('/api/version', (c) => c.json({
  version: '2.0.0',
  name: 'CF Monitor',
  hash: 'cf-worker',
  source_revision: SOURCE_REVISION,
}));

// 404 处理
// 前端静态资源由 wrangler.toml 的 [assets] 托管；
// 非 API 路由的 SPA fallback 也由 Workers Static Assets 接管。
app.notFound((c) => {
  const url = new URL(c.req.url);
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/ping') {
    return c.text('CF Monitor frontend asset not found. Run `npm run build` in ../frontend and check [assets] in worker/wrangler.toml.', 404);
  }
  return c.json({ error: 'Not Found' }, 404);
});

type ScheduledSettings = Record<string, string>;
type ScheduledAdminSettings = ReturnType<typeof buildAdminSettings>;
type ScheduledMonitorClient = ScheduledClientRow;
const SCHEDULED_SETTING_KEYS = [
  'notification_method',
  'telegram_bot_token',
  'telegram_chat_id',
  'record_preserve_time',
  'ping_record_preserve_time',
  'audit_log_preserve_time',
  'offline_notify_never_reported',
];

interface ScheduledRunContext {
  getSettings(): Promise<ScheduledSettings>;
  getAdminSettings(): Promise<ScheduledAdminSettings>;
  getClients(clientIds?: string[]): Promise<ScheduledMonitorClient[]>;
}

function normalizeScheduledClientIds(clientIds: string[] | undefined): string[] | null {
  if (clientIds === undefined) return null;
  return [...new Set(
    clientIds
      .filter((clientId): clientId is string => typeof clientId === 'string')
      .map(clientId => clientId.trim())
      .filter(Boolean),
  )].sort();
}

export function createScheduledRunContext(env: Bindings): ScheduledRunContext {
  let settingsPromise: Promise<ScheduledSettings> | null = null;
  let adminSettingsPromise: Promise<ScheduledAdminSettings> | null = null;
  let clientsPromise: Promise<ScheduledMonitorClient[]> | null = null;
  const clientsByIdsPromises = new Map<string, Promise<ScheduledMonitorClient[]>>();

  return {
    getSettings() {
      settingsPromise ||= db.getSettingsByKeys(env.DB, SCHEDULED_SETTING_KEYS);
      return settingsPromise;
    },
    getAdminSettings() {
      adminSettingsPromise ||= this.getSettings().then(settings => buildAdminSettings(settings));
      return adminSettingsPromise;
    },
    getClients(clientIds) {
      const normalizedIds = normalizeScheduledClientIds(clientIds);
      if (normalizedIds === null) {
        clientsPromise ||= db.listScheduledClientRows(env.DB);
        return clientsPromise;
      }
      if (normalizedIds.length === 0) {
        return Promise.resolve([]);
      }
      if (clientsPromise) {
        const idSet = new Set(normalizedIds);
        return clientsPromise.then(clients => clients.filter(client => idSet.has(client.uuid)));
      }
      const cacheKey = normalizedIds.join('\0');
      let promise = clientsByIdsPromises.get(cacheKey);
      if (!promise) {
        promise = db.getScheduledClientRowsByIds(env.DB, normalizedIds);
        clientsByIdsPromises.set(cacheKey, promise);
      }
      return promise;
    },
  };
}

async function sendTelegram(env: Bindings, context: ScheduledRunContext, text: string): Promise<boolean> {
  const settings = await context.getAdminSettings();
  if (settings['notification_method'] !== 'telegram') {
    await bestEffortRecordHealthEvent(env.DB, 'telegram', 'disabled', 'notification_method is not telegram');
    return false;
  }

  const botToken = settings['telegram_bot_token'];
  const chatId = settings['telegram_chat_id'];
  if (!botToken || !chatId) {
    await bestEffortRecordHealthEvent(env.DB, 'telegram', 'disabled', 'telegram credentials are not configured');
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: escapeTelegramHtml(text),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });

    if (!response.ok) {
      await bestEffortRecordHealthEvent(
        env.DB,
        'telegram',
        'error',
        `Telegram HTTP ${response.status}`,
        { auditAction: 'telegram_error' },
      );
      return false;
    }

    await bestEffortRecordHealthEvent(env.DB, 'telegram', 'ok', 'Telegram message sent', {
      successThrottleMs: 60 * 60 * 1000,
    });
    return true;
  } catch (error) {
    await bestEffortRecordHealthEvent(
      env.DB,
      'telegram',
      'error',
      `Telegram send failed: ${errorDetail(error)}`,
      { auditAction: 'telegram_error' },
    );
    return false;
  }
}

async function runRecordCleanup(env: Bindings, context: ScheduledRunContext, now: Date): Promise<void> {
  const settings = await context.getSettings();
  const recordHours = Math.min(72, Math.max(1, Number(settings['record_preserve_time'] || 72)));
  const pingHours = Math.min(72, Math.max(1, Number(settings['ping_record_preserve_time'] || recordHours)));
  const auditHours = Math.max(24, Number(settings['audit_log_preserve_time'] || 2160));

  const recordBefore = new Date(now.getTime() - recordHours * 60 * 60 * 1000).toISOString();
  const pingBefore = new Date(now.getTime() - pingHours * 60 * 60 * 1000).toISOString();
  const auditBefore = new Date(now.getTime() - auditHours * 60 * 60 * 1000).toISOString();

  const recordDeleted = await db.deleteOldRecords(env.DB, recordBefore);
  const pingDeleted = await db.deleteOldPingRecords(env.DB, pingBefore);
  const auditDeleted = await db.deleteOldAuditLogs(env.DB, auditBefore);
  const deleted = {
    ...recordDeleted,
    ...pingDeleted,
    ...auditDeleted,
  };
  const deletedRows = Object.values(deleted).reduce((sum, value) => sum + Number(value || 0), 0);
  if (deletedRows === 0) {
    return;
  }
  await db.insertAuditLog(env.DB, 'system', 'cron_cleanup', `分批清理完成: ${JSON.stringify({
    before: {
      records: recordBefore,
      ping_records: pingBefore,
      audit_logs: auditBefore,
    },
    deleted,
    expired_backlog_after: 'skipped_for_quota',
  })}`);
}

type OfflineNotificationCandidate = {
  offlineMs: number;
  lastSeenLabel: string;
  neverReported: boolean;
  createdAt?: string;
};

export function evaluateOfflineNotificationCandidate(args: {
  now: Date;
  clientCreatedAt: string | null | undefined;
  lastTime: string | null | undefined;
  lastNotified: string | null | undefined;
  gracePeriodSec: number;
  notifyNeverReported: boolean;
}): OfflineNotificationCandidate | null {
  const graceMs = Math.max(30, Number(args.gracePeriodSec || 180)) * 1000;
  const nowMs = args.now.getTime();

  let referenceTime: string;
  let neverReported = false;

  if (args.lastTime) {
    referenceTime = args.lastTime;
  } else {
    if (!args.notifyNeverReported || !args.clientCreatedAt) return null;
    referenceTime = args.clientCreatedAt;
    neverReported = true;
  }

  const referenceMs = new Date(referenceTime).getTime();
  if (Number.isNaN(referenceMs)) return null;

  const offlineMs = nowMs - referenceMs;
  if (offlineMs < graceMs) return null;

  const lastNotifiedMs = args.lastNotified ? new Date(args.lastNotified).getTime() : 0;
  if (!Number.isNaN(lastNotifiedMs) && lastNotifiedMs && nowMs - lastNotifiedMs < graceMs) return null;

  return {
    offlineMs,
    lastSeenLabel: neverReported ? '从未上报' : referenceTime,
    neverReported,
    createdAt: neverReported ? referenceTime : undefined,
  };
}

async function runOfflineCheck(env: Bindings, context: ScheduledRunContext, now: Date): Promise<void> {
  const notifications = await db.listOfflineNotifications(env.DB);
  const enabled = notifications.filter((item: any) => item.enable);
  if (enabled.length === 0) return;

  const settings = await context.getAdminSettings();
  const notifyNeverReported = settings.offline_notify_never_reported !== 'false';

  const clients = await context.getClients(enabled.map((item: any) => item.client));
  const clientMap = new Map(clients.map(client => [client.uuid, client]));
  const latestTimes = await db.getLatestRecordTimesForClients(
    env.DB,
    enabled.map((item: any) => item.client),
  );
  const latestMap = new Map(latestTimes.map(row => [row.client, row.last_time]));

  for (const item of enabled) {
    const client = clientMap.get(item.client);
    if (!client) continue;

    const gracePeriod = Math.max(30, Number(item.grace_period || 180));
    const candidate = evaluateOfflineNotificationCandidate({
      now,
      clientCreatedAt: client.created_at,
      lastTime: latestMap.get(item.client),
      lastNotified: item.last_notified,
      gracePeriodSec: gracePeriod,
      notifyNeverReported,
    });
    if (!candidate) continue;

    const minutes = Math.floor(candidate.offlineMs / 60000);
    const message = candidate.neverReported
      ? `CF Monitor 离线告警\n节点: ${client.name || client.uuid}\n离线时间: ${minutes} 分钟\n最后上报: ${candidate.lastSeenLabel}\n创建时间: ${candidate.createdAt}`
      : `CF Monitor 离线告警\n节点: ${client.name || client.uuid}\n离线时间: ${minutes} 分钟\n最后上报: ${candidate.lastSeenLabel}`;
    const sent = await sendTelegram(env, context, message);
    await db.markOfflineNotificationSent(env.DB, item.client, now.toISOString());
    await db.insertAuditLog(env.DB, 'system', 'offline_notify', `${sent ? '已发送' : '已记录'}离线告警: ${client.name || client.uuid}${candidate.neverReported ? ' (从未上报)' : ''}`);
  }
}

export function shouldSendExpiryNotification(args: {
  now: Date;
  expiredAt: string | null | undefined;
  advanceDays: number;
  lastNotified: string | null | undefined;
}): { daysLeft: number; expiredAt: string } | null {
  if (!args.expiredAt) return null;
  const expiryMs = new Date(args.expiredAt).getTime();
  const nowMs = args.now.getTime();
  if (Number.isNaN(expiryMs) || expiryMs < nowMs) return null;

  const advanceMs = Math.max(1, Number(args.advanceDays || 7)) * 24 * 60 * 60 * 1000;
  const windowStartMs = expiryMs - advanceMs;
  if (nowMs < windowStartMs) return null;

  const lastNotifiedMs = args.lastNotified ? new Date(args.lastNotified).getTime() : 0;
  if (!Number.isNaN(lastNotifiedMs) && lastNotifiedMs >= windowStartMs) return null;

  return {
    daysLeft: Math.max(0, Math.ceil((expiryMs - nowMs) / (24 * 60 * 60 * 1000))),
    expiredAt: new Date(expiryMs).toISOString(),
  };
}

async function runExpiryCheck(env: Bindings, context: ScheduledRunContext, now: Date): Promise<void> {
  const notifications = await db.listExpiryNotifications(env.DB);
  const enabled = notifications.filter((item: any) => item.enable);
  if (enabled.length === 0) return;

  const clients = await context.getClients(enabled.map((item: any) => item.client));
  const clientMap = new Map(clients.map(client => [client.uuid, client]));

  for (const item of enabled) {
    const client = clientMap.get(item.client);
    if (!client) continue;

    const candidate = shouldSendExpiryNotification({
      now,
      expiredAt: client.expired_at,
      advanceDays: Number(item.advance_days || 7),
      lastNotified: item.last_notified,
    });
    if (!candidate) continue;

    const message = `CF Monitor 到期提醒\n节点: ${client.name || client.uuid}\n到期时间: ${candidate.expiredAt}\n剩余天数: ${candidate.daysLeft} 天`;
    const sent = await sendTelegram(env, context, message);
    await db.markExpiryNotificationSent(env.DB, item.client, now.toISOString());
    await db.insertAuditLog(env.DB, 'system', 'expiry_notify', `${sent ? '已发送' : '已记录'}到期提醒: ${client.name || client.uuid} - ${candidate.daysLeft} 天`);
  }
}

type LoadNotificationPlan = {
  rule: any;
  ratio: number;
  label: string;
  targetClients: string[];
};

type LoadNotificationGroup = {
  metric: db.LoadNotificationMetric;
  threshold: number;
  startTime: string;
  endTime: string;
  clientIds: Set<string>;
  plans: LoadNotificationPlan[];
};

async function runLoadCheck(env: Bindings, context: ScheduledRunContext, now: Date): Promise<void> {
  const notifications = await db.listLoadNotifications(env.DB);
  if (notifications.length === 0) return;

  const hasAllClientRule = notifications.some(rule => !(rule.clients && Array.isArray(rule.clients) && rule.clients.length > 0));
  const scheduledClientIds = hasAllClientRule
    ? undefined
    : notifications.flatMap(rule => Array.isArray(rule.clients) ? rule.clients : []);
  const clients = await context.getClients(scheduledClientIds);
  const clientMap = new Map(clients.map(c => [c.uuid, c]));
  const metricLabel: Record<string, string> = { cpu: "CPU", ram: "内存", load: "负载", disk: "磁盘", temp: "温度" };
  const groups = new Map<string, LoadNotificationGroup>();

  for (const rule of notifications) {
    const intervalMs = Math.max(1, Number(rule.interval_min || 15)) * 60 * 1000;
    const startTime = new Date(now.getTime() - intervalMs).toISOString();
    const endTime = now.toISOString();
    const threshold = Number(rule.threshold || 80);
    const ratio = Math.max(0, Math.min(1, Number(rule.ratio || 0.8)));
    const metric = ['cpu', 'ram', 'load', 'disk', 'temp'].includes(rule.metric)
      ? rule.metric as db.LoadNotificationMetric
      : 'cpu';
    const label = metricLabel[metric] || metric;
    const lastNotified = rule.last_notified ? new Date(rule.last_notified).getTime() : 0;
    if (lastNotified && now.getTime() - lastNotified < intervalMs) continue;

    const targetClients: string[] = (rule.clients && Array.isArray(rule.clients) && rule.clients.length > 0)
      ? rule.clients.filter((uuid: unknown): uuid is string => typeof uuid === 'string' && uuid.trim() !== '')
      : clients.map(c => c.uuid);
    const uniqueTargetClients = [...new Set(targetClients)];
    if (uniqueTargetClients.length === 0) continue;

    const groupKey = `${metric}:${threshold}:${startTime}:${endTime}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        metric,
        threshold,
        startTime,
        endTime,
        clientIds: new Set<string>(),
        plans: [],
      };
      groups.set(groupKey, group);
    }
    for (const clientUuid of uniqueTargetClients) group.clientIds.add(clientUuid);
    group.plans.push({ rule, ratio, label, targetClients: uniqueTargetClients });
  }

  for (const group of groups.values()) {
    const statsByClient = await db.getLoadMetricWindowStatsForClients(
      env.DB,
      [...group.clientIds],
      group.startTime,
      group.endTime,
      group.metric,
      group.threshold,
    );

    for (const plan of group.plans) {
      let notified = false;
      for (const clientUuid of plan.targetClients) {
        const client = clientMap.get(clientUuid);
        if (!client) continue;

        const stats = statsByClient.get(clientUuid) || { samples: 0, exceeded: 0, avg_value: 0 };
        if (stats.samples < 2) continue;

        const exceedRatio = stats.exceeded / stats.samples;
        if (exceedRatio < plan.ratio) continue;

        const message = `CF Monitor 负载告警\n规则: ${plan.rule.name || plan.label + " 告警"}\n节点: ${client.name || clientUuid}\n指标: ${plan.label} 平均 ${stats.avg_value.toFixed(1)}% (阈值 ${group.threshold}%)\n超标率: ${(exceedRatio * 100).toFixed(0)}% / ${(plan.ratio * 100).toFixed(0)}%`;
        const sent = await sendTelegram(env, context, message);
        notified = true;
        await db.insertAuditLog(env.DB, 'system', 'load_notify', `${sent ? '已发送' : '已记录'}负载告警: ${client.name || clientUuid} - ${plan.label}`);
      }
      if (notified) {
        await db.updateLoadNotification(env.DB, plan.rule.id, { last_notified: now.toISOString() } as any);
      }
    }
  }
}

async function runScheduledStep(
  env: Bindings,
  component: string,
  action: string,
  label: string,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
    await bestEffortRecordHealthEvent(env.DB, component, 'ok', `${label} completed`, {
      successThrottleMs: 60 * 60 * 1000,
    });
  } catch (error) {
    const message = errorDetail(error);
    console.error(`[scheduled] ${label} failed:`, message);
    await bestEffortRecordHealthEvent(
      env.DB,
      component,
      'error',
      `${label} failed: ${message}`,
      { auditAction: action },
    );
  }
}

async function runScheduled(env: Bindings): Promise<void> {
  const now = new Date();
  const context = createScheduledRunContext(env);
  await runScheduledStep(env, 'cron_cleanup', 'cron_cleanup_error', '记录清理', () => runRecordCleanup(env, context, now));
  await runScheduledStep(env, 'cron_load', 'cron_load_error', '负载告警检查', () => runLoadCheck(env, context, now));
  await runScheduledStep(env, 'cron_offline', 'cron_offline_error', '离线告警检查', () => runOfflineCheck(env, context, now));
  await runScheduledStep(env, 'cron_expiry', 'cron_expiry_error', '到期提醒检查', () => runExpiryCheck(env, context, now));
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    await ensureSchema(env.DB);
    return app.fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Bindings, _ctx: ExecutionContext) {
    await ensureSchema(env.DB);
    await runScheduled(env);
  },
};

// 导出 Durable Object
export { LiveDataDO, normalizeViewerTtlMs } from './do/live-data';
export { RateLimitDO } from './do/rate-limit';
