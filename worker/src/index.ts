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
import * as notificationQueue from './db/notification-queue';
import * as cronHealth from './db/cron-health';
import * as refreshToken from './auth/refresh-token';
import * as passwordReset from './auth/password-reset';

// 类型定义
export type Bindings = {
  DB: D1Database;
  LIVE_DATA: DurableObjectNamespace;
  RATE_LIMIT: DurableObjectNamespace;
  JWT_SECRET?: string;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  RESET_ADMIN_PASSWORD?: string;
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
const SOURCE_REVISION = '2026-06-13-notification-incidents';
const CSRF_REJECTION_AUDIT_THROTTLE_MS = 60_000;
const CSRF_REJECTION_AUDIT_THROTTLE_MAX_ENTRIES = 512;
const csrfRejectionAuditThrottle = new Map<string, { expiresAt: number }>();

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'",
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
  if (new URL(c.req.url).protocol === 'https:') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
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

  const user = await db.getUserByUuid(c.env.DB, payload.userId);
  if (!user || Number(user.session_version || 0) !== Number(payload.sessionVersion || 0)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  c.set('userId', payload.userId);
  c.set('username', user.username || payload.username);
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
  await runScheduled(c.env, { forceFull: true });
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
  'live_poll_active_interval_sec',
  'live_poll_idle_interval_sec',
];

interface ScheduledRunContext {
  getSettings(): Promise<ScheduledSettings>;
  getAdminSettings(): Promise<ScheduledAdminSettings>;
  getClients(clientIds?: string[]): Promise<ScheduledMonitorClient[]>;
}

type TelegramSendResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
};

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

async function sendTelegram(env: Bindings, context: ScheduledRunContext, text: string): Promise<TelegramSendResult> {
  const settings = await context.getAdminSettings();
  if (settings['notification_method'] !== 'telegram') {
    await bestEffortRecordHealthEvent(env.DB, 'telegram', 'disabled', 'notification_method is not telegram');
    return { ok: false, skipped: true, error: 'notification_method is not telegram' };
  }

  const botToken = settings['telegram_bot_token'];
  const chatId = settings['telegram_chat_id'];
  if (!botToken || !chatId) {
    await bestEffortRecordHealthEvent(env.DB, 'telegram', 'disabled', 'telegram credentials are not configured');
    return { ok: false, skipped: true, error: 'telegram credentials are not configured' };
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
      const detail = await response.text().catch(() => '');
      const error = `Telegram HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`;
      await bestEffortRecordHealthEvent(
        env.DB,
        'telegram',
        'error',
        error,
        { auditAction: 'telegram_error' },
      );
      return { ok: false, error };
    }

    await bestEffortRecordHealthEvent(env.DB, 'telegram', 'ok', 'Telegram message sent', {
      successThrottleMs: 60 * 60 * 1000,
    });
    return { ok: true };
  } catch (error) {
    const detail = `Telegram send failed: ${errorDetail(error)}`;
    await bestEffortRecordHealthEvent(
      env.DB,
      'telegram',
      'error',
      detail,
      { auditAction: 'telegram_error' },
    );
    return { ok: false, error: detail };
  }
}

/**
 * 发送通知（带队列和重试支持）
 */
async function sendNotificationWithRetry(
  env: Bindings,
  context: ScheduledRunContext,
  notification: {
    type: string;
    target: string;
    message: string;
    client?: string | null;
    ruleId?: number | null;
  },
): Promise<TelegramSendResult> {
  const delivery = await sendTelegram(env, context, notification.message);

  // 如果发送失败（非跳过），加入队列重试
  if (!delivery.ok && !delivery.skipped) {
    try {
      await notificationQueue.enqueueNotification(env.DB, {
        notification_type: notification.type,
        target: notification.target,
        message: notification.message,
        client: notification.client,
        rule_id: notification.ruleId,
        next_retry_at: notificationQueue.calculateNextRetryTime(0),
        max_attempts: 5,
      });
    } catch (error) {
      console.error('[notification-queue] Failed to enqueue notification:', errorDetail(error));
    }
  }

  return delivery;
}

function telegramDeliveryStatus(delivery: TelegramSendResult): db.NotificationDeliveryStatus {
  if (delivery.ok) return 'sent';
  return delivery.skipped ? 'skipped' : 'failed';
}

async function recordTelegramDelivery(
  env: Bindings,
  delivery: TelegramSendResult,
  input: {
    notificationType: string;
    target: string;
    attemptedAt: string;
    client?: string | null;
    ruleId?: number | null;
  },
): Promise<void> {
  try {
    await db.insertNotificationDelivery(env.DB, {
      notification_type: input.notificationType,
      channel: 'telegram',
      status: telegramDeliveryStatus(delivery),
      target: input.target,
      client: input.client || null,
      rule_id: input.ruleId ?? null,
      attempted_at: input.attemptedAt,
      sent_at: delivery.ok ? input.attemptedAt : null,
      error: delivery.ok ? null : delivery.error,
    });
  } catch (error) {
    await bestEffortRecordHealthEvent(
      env.DB,
      'notification_delivery',
      'error',
      `notification delivery write failed: ${errorDetail(error)}`,
      { auditAction: 'notification_delivery_error' },
    );
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
    ...(await db.deleteOldNotificationDeliveries(env.DB, auditBefore)),
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
  expectedReportIntervalSec: number;
  thresholdMs: number;
  lastSeenLabel: string;
  neverReported: boolean;
  createdAt?: string;
};

const DEFAULT_IDLE_REPORT_INTERVAL_SEC = 600;
const MIN_EXPECTED_REPORT_INTERVAL_SEC = 0;
const MAX_EXPECTED_REPORT_INTERVAL_SEC = 3600;
const HEAVY_SCHEDULED_INTERVAL_MINUTES = 10;

function normalizeExpectedReportIntervalSec(value: unknown, fallbackSec = DEFAULT_IDLE_REPORT_INTERVAL_SEC): number {
  const parsed = Number(value);
  const fallback = Number.isFinite(Number(fallbackSec)) ? Number(fallbackSec) : DEFAULT_IDLE_REPORT_INTERVAL_SEC;
  if (!Number.isFinite(parsed)) {
    return Math.min(MAX_EXPECTED_REPORT_INTERVAL_SEC, Math.max(MIN_EXPECTED_REPORT_INTERVAL_SEC, Math.floor(fallback)));
  }
  return Math.min(MAX_EXPECTED_REPORT_INTERVAL_SEC, Math.max(MIN_EXPECTED_REPORT_INTERVAL_SEC, Math.floor(parsed)));
}

export function shouldRunScheduledInterval(now: Date, intervalMinutes: number): boolean {
  const safeInterval = Math.max(1, Math.floor(Number(intervalMinutes) || 1));
  const minute = Math.floor(now.getTime() / 60000);
  return minute % safeInterval === 0;
}

export function evaluateOfflineState(args: {
  now: Date;
  clientCreatedAt: string | null | undefined;
  lastTime: string | null | undefined;
  gracePeriodSec: number;
  expectedReportIntervalSec?: number | null;
  notifyNeverReported: boolean;
}): OfflineNotificationCandidate | null {
  const graceMs = Math.max(30, Number(args.gracePeriodSec || 180)) * 1000;
  const expectedReportIntervalSec = normalizeExpectedReportIntervalSec(args.expectedReportIntervalSec, DEFAULT_IDLE_REPORT_INTERVAL_SEC);
  const thresholdMs = graceMs + expectedReportIntervalSec * 1000;
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

  // 检查时间解析是否有效
  if (Number.isNaN(referenceMs)) {
    console.error('[offline-detection] Invalid reference time:', referenceTime);
    return null;
  }

  const offlineMs = nowMs - referenceMs;

  // 检查时间异常：时间回拨或未来时间
  if (offlineMs < 0) {
    console.error('[offline-detection] Time anomaly detected:', {
      now: args.now.toISOString(),
      referenceTime,
      offlineMs,
      reason: 'reference time is in the future',
    });
    return null;
  }

  // 检查是否超过合理范围（30天）
  const maxOfflineMs = 30 * 24 * 60 * 60 * 1000;
  if (offlineMs > maxOfflineMs) {
    console.warn('[offline-detection] Unusually long offline time:', {
      referenceTime,
      offlineDays: Math.floor(offlineMs / (24 * 60 * 60 * 1000)),
    });
  }

  // 新节点首次上报宽限期：创建后30分钟内不检测离线
  if (neverReported && args.clientCreatedAt) {
    const createdMs = new Date(args.clientCreatedAt).getTime();
    const firstReportGraceMs = 30 * 60 * 1000; // 30分钟
    if (nowMs - createdMs < firstReportGraceMs) {
      return null;
    }
  }

  if (offlineMs < thresholdMs) return null;

  return {
    offlineMs,
    expectedReportIntervalSec,
    thresholdMs,
    lastSeenLabel: neverReported ? '从未上报' : referenceTime,
    neverReported,
    createdAt: neverReported ? referenceTime : undefined,
  };
}

export function shouldSendOfflineNotification(args: {
  now: Date;
  incidentLastSent?: string | null | undefined;
  incidentLastAttempt?: string | null | undefined;
}): boolean {
  if (args.incidentLastSent) return false;
  if (args.incidentLastAttempt) return false;
  return true;
}

export function evaluateOfflineNotificationCandidate(args: {
  now: Date;
  clientCreatedAt: string | null | undefined;
  lastTime: string | null | undefined;
  lastNotified: string | null | undefined;
  gracePeriodSec: number;
  expectedReportIntervalSec?: number | null;
  notifyNeverReported: boolean;
}): OfflineNotificationCandidate | null {
  const state = evaluateOfflineState(args);
  if (!state || !shouldSendOfflineNotification({ now: args.now, incidentLastSent: args.lastNotified })) return null;
  return state;
}

async function applyIncidentDeliveryResult(
  env: Bindings,
  incidentKey: string,
  delivery: TelegramSendResult,
  attemptedAt: string,
): Promise<void> {
  if (delivery.ok) {
    await db.markNotificationIncidentSent(env.DB, incidentKey, attemptedAt);
  } else {
    await db.markNotificationIncidentAttempt(env.DB, incidentKey, attemptedAt, delivery.error || 'send failed');
  }
}

async function runOfflineCheck(env: Bindings, context: ScheduledRunContext, now: Date): Promise<void> {
  const notifications = await db.listOfflineNotifications(env.DB);
  const enabled = notifications.filter((item: any) => item.enable);
  if (enabled.length === 0) return;

  const settings = await context.getAdminSettings();
  const notifyNeverReported = settings.offline_notify_never_reported !== 'false';
  const defaultReportIntervalSec = normalizeExpectedReportIntervalSec(
    settings.live_poll_idle_interval_sec,
    DEFAULT_IDLE_REPORT_INTERVAL_SEC,
  );

  const clients = await context.getClients(enabled.map((item: any) => item.client));
  const clientMap = new Map(clients.map(client => [client.uuid, client]));
  const openIncidents = await db.listOpenNotificationIncidents(
    env.DB,
    'offline',
    enabled.map((item: any) => item.client),
  );
  const nowIso = now.toISOString();
  for (const item of enabled) {
    const client = clientMap.get(item.client);
    if (!client) continue;

    const gracePeriod = Math.max(30, Number(item.grace_period || 180));
    const expectedReportIntervalSec = normalizeExpectedReportIntervalSec(
      client.last_report_interval_sec,
      defaultReportIntervalSec,
    );
    const candidate = evaluateOfflineState({
      now,
      clientCreatedAt: client.created_at,
      lastTime: client.last_seen_at,
      gracePeriodSec: gracePeriod,
      expectedReportIntervalSec,
      notifyNeverReported,
    });
    if (!candidate) {
      const incident = openIncidents.get(item.client);
      if (!incident) continue;

      await db.resolveNotificationIncident(env.DB, incident.incident_key, nowIso);
      if (!incident.last_sent_at) continue;

      const message = `CF Monitor 恢复通知\n节点: ${client.name || client.uuid}\n状态: 已恢复在线\n最后上报: ${client.last_seen_at || nowIso}`;
      const delivery = await sendTelegram(env, context, message);
      await recordTelegramDelivery(env, delivery, {
        notificationType: 'offline_recovery',
        target: item.client,
        client: item.client,
        attemptedAt: nowIso,
      });
      await applyIncidentDeliveryResult(env, incident.incident_key, delivery, nowIso);
      const status = delivery.ok ? '已发送' : delivery.skipped ? '已跳过' : '发送失败';
      await db.insertAuditLog(env.DB, 'system', 'offline_recovery_notify', `${status}离线恢复通知: ${client.name || client.uuid}`);
      continue;
    }

    const incidentKey = await db.openNotificationIncident(env.DB, {
      notification_type: 'offline',
      target: item.client,
      client: item.client,
      detected_at: nowIso,
    });
    const existingIncident = openIncidents.get(item.client);
    if (!shouldSendOfflineNotification({
      now,
      incidentLastSent: existingIncident?.last_sent_at,
      incidentLastAttempt: existingIncident?.last_attempt_at,
    })) {
      continue;
    }

    const minutes = Math.floor(candidate.offlineMs / 60000);
    const message = candidate.neverReported
      ? `CF Monitor 离线告警\n节点: ${client.name || client.uuid}\n离线时间: ${minutes} 分钟\n最后上报: ${candidate.lastSeenLabel}\n创建时间: ${candidate.createdAt}`
      : `CF Monitor 离线告警\n节点: ${client.name || client.uuid}\n离线时间: ${minutes} 分钟\n最后上报: ${candidate.lastSeenLabel}`;
    const attemptedAt = nowIso;
    const delivery = await sendNotificationWithRetry(env, context, {
      type: 'offline',
      target: item.client,
      message,
      client: item.client,
    });
    await recordTelegramDelivery(env, delivery, {
      notificationType: 'offline',
      target: item.client,
      client: item.client,
      attemptedAt,
    });
    if (delivery.ok) {
      await db.markOfflineNotificationSent(env.DB, item.client, attemptedAt);
    } else {
      await db.markOfflineNotificationAttempt(env.DB, item.client, attemptedAt, delivery.error || 'send failed');
    }
    await applyIncidentDeliveryResult(env, incidentKey, delivery, attemptedAt);
    const status = delivery.ok ? '已发送' : delivery.skipped ? '已跳过' : '发送失败';
    await db.insertAuditLog(env.DB, 'system', 'offline_notify', `${status}离线告警: ${client.name || client.uuid}${candidate.neverReported ? ' (从未上报)' : ''}`);
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

  // 检查时间解析是否有效
  if (Number.isNaN(expiryMs)) {
    console.error('[expiry-detection] Invalid expiry time:', args.expiredAt);
    return null;
  }

  const advanceMs = Math.max(1, Number(args.advanceDays || 7)) * 24 * 60 * 60 * 1000;
  const windowStartMs = expiryMs - advanceMs;
  const lastNotifiedMs = args.lastNotified ? new Date(args.lastNotified).getTime() : 0;

  // 检查lastNotified时间是否有效
  if (args.lastNotified && Number.isNaN(lastNotifiedMs)) {
    console.error('[expiry-detection] Invalid last notified time:', args.lastNotified);
    // 继续处理，视为未通知过
  }

  // 还未到通知窗口
  if (nowMs < windowStartMs) return null;

  // 已经通知过且在窗口期内
  if (!Number.isNaN(lastNotifiedMs) && lastNotifiedMs >= Math.min(windowStartMs, expiryMs)) return null;

  const daysLeft = Math.max(0, Math.ceil((expiryMs - nowMs) / (24 * 60 * 60 * 1000)));

  return {
    daysLeft,
    expiredAt: new Date(expiryMs).toISOString(),
  };
}

type LoadWindowStats = {
  samples: number;
  exceeded: number;
  avg_value: number;
};

type LoadNotificationBreach = LoadWindowStats & {
  exceedRatio: number;
};

export function evaluateLoadNotificationBreach(
  stats: LoadWindowStats,
  requiredRatio: number,
): LoadNotificationBreach | null {
  const samples = Number(stats.samples || 0);
  if (samples < 2) return null;

  const exceeded = Number(stats.exceeded || 0);
  const exceedRatio = exceeded / samples;
  const ratio = Math.max(0, Math.min(1, Number(requiredRatio || 0)));
  if (exceedRatio < ratio) return null;

  return {
    samples,
    exceeded,
    avg_value: Number(stats.avg_value || 0),
    exceedRatio,
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
    const attemptedAt = now.toISOString();
    const delivery = await sendTelegram(env, context, message);
    await recordTelegramDelivery(env, delivery, {
      notificationType: 'expiry',
      target: item.client,
      client: item.client,
      attemptedAt,
    });
    if (delivery.ok) {
      await db.markExpiryNotificationSent(env.DB, item.client, attemptedAt);
    } else if (!delivery.skipped) {
      await db.markExpiryNotificationAttempt(env.DB, item.client, attemptedAt, delivery.error || 'send failed');
    }
    const status = delivery.ok ? '已发送' : delivery.skipped ? '已跳过' : '发送失败';
    await db.insertAuditLog(env.DB, 'system', 'expiry_notify', `${status}到期提醒: ${client.name || client.uuid} - ${candidate.daysLeft} 天`);
  }
}

function loadIncidentTarget(ruleId: number, clientUuid: string): string {
  return `${ruleId}:${clientUuid}`;
}

async function runLoadCheck(env: Bindings, context: ScheduledRunContext, now: Date): Promise<void> {
  const notifications = await db.listLoadNotifications(env.DB);
  if (notifications.length === 0) return;

  const hasAllClientRule = notifications.some(rule => !(rule.clients && Array.isArray(rule.clients) && rule.clients.length > 0));
  const scheduledClientIds = hasAllClientRule
    ? undefined
    : notifications.flatMap(rule => Array.isArray(rule.clients) ? rule.clients : []);
  const clients = await context.getClients(scheduledClientIds);
  const clientMap = new Map(clients.map(c => [c.uuid, c]));
  const nowIso = now.toISOString();

  for (const rule of notifications) {
    const intervalMs = Math.max(1, Number(rule.interval_min || 15)) * 60 * 1000;
    const startTime = new Date(now.getTime() - intervalMs).toISOString();
    const endTime = now.toISOString();
    const threshold = Number(rule.threshold || 80);
    const ratio = Math.max(0, Math.min(1, Number(rule.ratio || 0.8)));
    const metric = ['cpu', 'ram', 'load', 'disk', 'temp'].includes(rule.metric)
      ? rule.metric as db.LoadNotificationMetric
      : 'cpu';
    const metricLabel: Record<string, string> = { cpu: "CPU", ram: "内存", load: "负载", disk: "磁盘", temp: "温度" };
    const label = metricLabel[metric] || metric;

    const targetClients: string[] = (rule.clients && Array.isArray(rule.clients) && rule.clients.length > 0)
      ? rule.clients.filter((uuid: unknown): uuid is string => typeof uuid === 'string' && uuid.trim() !== '')
      : clients.map(c => c.uuid);
    const uniqueTargetClients = [...new Set(targetClients)];
    const ruleId = Number(rule.id);
    if (!Number.isInteger(ruleId) || ruleId <= 0) continue;
    const incidentTargetsByClient = new Map(uniqueTargetClients.map(clientUuid => [
      clientUuid,
      loadIncidentTarget(ruleId, clientUuid),
    ]));
    const openIncidents = await db.listOpenNotificationIncidents(
      env.DB,
      'load',
      [...incidentTargetsByClient.values()],
    );
    const sinceTime = startTime;
    const recentlySentClients = await db.listRecentlySentLoadNotificationClients(
      env.DB,
      ruleId,
      uniqueTargetClients,
      sinceTime,
    );
    const legacyLastNotified = rule.last_notified ? new Date(rule.last_notified).getTime() : 0;
    const legacyRuleCooldownActive = recentlySentClients.size === 0 &&
      !Number.isNaN(legacyLastNotified) &&
      legacyLastNotified > 0 &&
      now.getTime() - legacyLastNotified < intervalMs;

    const statsByClient = await db.getLoadMetricWindowStatsForClients(
      env.DB,
      uniqueTargetClients,
      startTime,
      endTime,
      metric,
      threshold,
    );

    for (const clientUuid of uniqueTargetClients) {
      const client = clientMap.get(clientUuid);
      if (!client) continue;

      const stats = statsByClient.get(clientUuid) || { samples: 0, exceeded: 0, avg_value: 0 };
      const breach = evaluateLoadNotificationBreach(stats, ratio);
      const incidentTarget = incidentTargetsByClient.get(clientUuid) || loadIncidentTarget(ruleId, clientUuid);
      const openIncident = openIncidents.get(incidentTarget);
      if (!breach) {
        if (!openIncident) continue;

        await db.resolveNotificationIncident(env.DB, openIncident.incident_key, nowIso);
        if (!openIncident.last_sent_at) continue;

        const currentLabel = stats.samples > 0
          ? `当前平均 ${Number(stats.avg_value || 0).toFixed(1)}%，超标率 ${((Number(stats.exceeded || 0) / Number(stats.samples || 1)) * 100).toFixed(0)}%`
          : '当前窗口样本不足';
        const recoveryMessage = `CF Monitor 负载恢复\n规则: ${rule.name || label + " 告警"}\n节点: ${client.name || clientUuid}\n指标: ${label} 已恢复\n${currentLabel}`;
        const delivery = await sendTelegram(env, context, recoveryMessage);
        await recordTelegramDelivery(env, delivery, {
          notificationType: 'load_recovery',
          target: String(ruleId),
          client: clientUuid,
          ruleId,
          attemptedAt: nowIso,
        });
        await applyIncidentDeliveryResult(env, openIncident.incident_key, delivery, nowIso);
        const status = delivery.ok ? '已发送' : delivery.skipped ? '已跳过' : '发送失败';
        await db.insertAuditLog(env.DB, 'system', 'load_recovery_notify', `${status}负载恢复通知: ${client.name || clientUuid} - ${label}`);
        continue;
      }

      const incidentKey = await db.openNotificationIncident(env.DB, {
        notification_type: 'load',
        target: incidentTarget,
        client: clientUuid,
        rule_id: ruleId,
        detected_at: nowIso,
      });
      if (legacyRuleCooldownActive || recentlySentClients.has(clientUuid)) continue;

      const message = `CF Monitor 负载告警\n规则: ${rule.name || label + " 告警"}\n节点: ${client.name || clientUuid}\n指标: ${label} 平均 ${breach.avg_value.toFixed(1)}% (阈值 ${threshold}%)\n超标率: ${(breach.exceedRatio * 100).toFixed(0)}% / ${(ratio * 100).toFixed(0)}%`;
      const attemptedAt = nowIso;
      const delivery = await sendTelegram(env, context, message);
      await recordTelegramDelivery(env, delivery, {
        notificationType: 'load',
        target: String(ruleId),
        client: clientUuid,
        ruleId,
        attemptedAt,
      });
      if (delivery.ok) {
        recentlySentClients.add(clientUuid);
        await db.markLoadNotificationSent(env.DB, ruleId, attemptedAt);
      } else if (!delivery.skipped) {
        await db.markLoadNotificationAttempt(env.DB, ruleId, attemptedAt, delivery.error || 'send failed');
      }
      await applyIncidentDeliveryResult(env, incidentKey, delivery, attemptedAt);
      const status = delivery.ok ? '已发送' : delivery.skipped ? '已跳过' : '发送失败';
      await db.insertAuditLog(env.DB, 'system', 'load_notify', `${status}负载告警: ${client.name || clientUuid} - ${label}`);

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
    await cronHealth.recordCronRun(env.DB, component, true);
    await bestEffortRecordHealthEvent(env.DB, component, 'ok', `${label} completed`, {
      successThrottleMs: 60 * 60 * 1000,
    });
  } catch (error) {
    const message = errorDetail(error);
    console.error(`[scheduled] ${label} failed:`, message);
    await cronHealth.recordCronRun(env.DB, component, false, message);
    await bestEffortRecordHealthEvent(
      env.DB,
      component,
      'error',
      `${label} failed: ${message}`,
      { auditAction: action },
    );

    // 检查是否需要告警
    const health = await cronHealth.getCronHealthByComponent(env.DB, component);
    if (health && cronHealth.shouldAlertCronHealth(health, 3)) {
      console.error(`[cron-health] ALERT: ${component} has failed ${health.consecutive_failures} times consecutively`);
      await db.insertAuditLog(
        env.DB,
        'system',
        'cron_health_alert',
        `严重: ${label} 连续失败 ${health.consecutive_failures} 次`,
        'error',
      );
    }
  }
}

async function runScheduled(env: Bindings, options: { forceFull?: boolean } = {}): Promise<void> {
  const now = new Date();
  const context = createScheduledRunContext(env);
  const runHeavyTasks = options.forceFull || shouldRunScheduledInterval(now, HEAVY_SCHEDULED_INTERVAL_MINUTES);
  if (runHeavyTasks) {
    await runScheduledStep(env, 'cron_cleanup', 'cron_cleanup_error', '记录清理', () => runRecordCleanup(env, context, now));
  }
  await runScheduledStep(env, 'cron_notification_queue', 'cron_queue_error', '通知队列处理', () => runNotificationQueueProcessor(env, context, now));
  if (runHeavyTasks) {
    await runScheduledStep(env, 'cron_token_blacklist', 'cron_token_error', 'Token黑名单清理', () => runTokenBlacklistCleanup(env, now));
    await runScheduledStep(env, 'cron_load', 'cron_load_error', '负载告警检查', () => runLoadCheck(env, context, now));
  }
  await runScheduledStep(env, 'cron_offline', 'cron_offline_error', '离线告警检查', () => runOfflineCheck(env, context, now));
  if (runHeavyTasks) {
    await runScheduledStep(env, 'cron_expiry', 'cron_expiry_error', '到期提醒检查', () => runExpiryCheck(env, context, now));
  }
}

/**
 * 清理过期的token黑名单记录
 */
async function runTokenBlacklistCleanup(env: Bindings, now: Date): Promise<void> {
  const deleted = await refreshToken.cleanupExpiredBlacklist(env.DB);
  if (deleted > 0) {
    await db.insertAuditLog(env.DB, 'system', 'token_blacklist_cleanup', `清理过期Token黑名单: ${deleted}条`);
  }
}

/**
 * 处理通知队列中待发送的通知
 */
async function runNotificationQueueProcessor(env: Bindings, context: ScheduledRunContext, now: Date): Promise<void> {
  const nowIso = now.toISOString();
  const pendingNotifications = await notificationQueue.getPendingNotifications(env.DB, nowIso, 50);

  if (pendingNotifications.length === 0) return;

  for (const item of pendingNotifications) {
    try {
      // 标记为处理中
      await notificationQueue.markNotificationProcessing(env.DB, item.id);

      // 尝试发送
      const delivery = await sendTelegram(env, context, item.message);

      if (delivery.ok) {
        // 发送成功
        await notificationQueue.markNotificationSent(env.DB, item.id);
        await recordTelegramDelivery(env, delivery, {
          notificationType: item.notification_type,
          target: item.target,
          client: item.client,
          ruleId: item.rule_id,
          attemptedAt: nowIso,
        });
        await db.insertAuditLog(
          env.DB,
          'system',
          'queue_notification_sent',
          `队列通知发送成功 (重试${item.attempt_count}次): ${item.notification_type} - ${item.target}`,
        );
      } else if (delivery.skipped) {
        // 跳过（如配置未启用）
        await notificationQueue.markNotificationFailed(env.DB, item.id, delivery.error || 'skipped', null);
      } else {
        // 发送失败，判断是否重试
        const shouldRetry = notificationQueue.shouldRetry(item.attempt_count + 1, item.max_attempts);
        const nextRetryAt = shouldRetry ? notificationQueue.calculateNextRetryTime(item.attempt_count + 1) : null;

        await notificationQueue.markNotificationFailed(env.DB, item.id, delivery.error || 'send failed', nextRetryAt);
        await recordTelegramDelivery(env, delivery, {
          notificationType: item.notification_type,
          target: item.target,
          client: item.client,
          ruleId: item.rule_id,
          attemptedAt: nowIso,
        });

        if (!shouldRetry) {
          await db.insertAuditLog(
            env.DB,
            'system',
            'queue_notification_failed',
            `队列通知最终失败 (尝试${item.attempt_count + 1}次): ${item.notification_type} - ${item.target}`,
            'error',
          );
        }
      }
    } catch (error) {
      console.error(`[notification-queue] Failed to process notification ${item.id}:`, errorDetail(error));
      // 处理异常，重新排队
      const nextRetryAt = notificationQueue.calculateNextRetryTime(item.attempt_count + 1);
      await notificationQueue.markNotificationFailed(env.DB, item.id, errorDetail(error), nextRetryAt);
    }
  }

  // 清理旧的已完成/失败的队列项（保留7天）
  const cleanupBefore = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await notificationQueue.deleteOldQueueItems(env.DB, cleanupBefore);
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    await ensureSchema(env.DB);

    // 检查环境变量密码重置
    if (env.RESET_ADMIN_PASSWORD) {
      await passwordReset.checkEmergencyPasswordReset(env.DB, env);
    }

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
