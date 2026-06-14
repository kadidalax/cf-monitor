/**
 * LiveDataDO - Durable Object 用于 WebSocket 实时数据推送
 * 
 * 功能:
 * 1. 维护所有在线客户端的 WebSocket 连接
 * 2. 缓存最新的监控数据（内存缓存，避免频繁查询 D1）
 * 3. 广播数据更新给所有连接的前端客户端
 * 4. 使用 Alarm 定时清理过期连接
 */

import type { DurableObjectState } from '@cloudflare/workers-types';
import { normalizeMonitorReport, toMonitorRecord } from '../utils/monitor-report';
import * as db from '../db/queries';
import { MAX_PING_RESULTS_PER_REPORT, MAX_PING_VALUE_MS, PING_LOSS_VALUE, validatePingResults } from '../utils/ping-result';
import {
  buildAdminSettings,
  isRecordPersistenceEnabled as normalizeRecordPersistenceEnabled,
} from '../settings/schema';
import { bestEffortRecordHealthEvent, errorDetail } from '../utils/observability';

// 客户端状态
interface ClientState {
  uuid: string;
  name: string;
  hidden: boolean;
  lastReportTime: number;
  lastReport: any; // 最后一次上报的数据
  expiresAt?: number;
}

const RECORD_PERSIST_INTERVAL_MS = 60_000;
const PING_RECORD_PERSIST_INTERVAL_MS = 300_000;
const MIN_RECORD_PERSIST_INTERVAL_MS = 3_000;
const MAX_RECORD_PERSIST_INTERVAL_MS = 3_600_000;
const MIN_PING_RECORD_PERSIST_INTERVAL_MS = 60_000;
const MAX_PING_RECORD_PERSIST_INTERVAL_MS = 3_600_000;
const RECORD_SETTING_CACHE_MS = 5_000;
const RECORD_HIGH_WATERMARK_DEFAULT_ROWS = 450_000;
const RECORD_HIGH_WATERMARK_MIN_ROWS = 1_000;
const RECORD_HIGH_WATERMARK_MAX_ROWS = 10_000_000;
const RECORD_CAPACITY_CACHE_FAR_MS = 60 * 60_000;
const RECORD_CAPACITY_CACHE_NEAR_MS = 10 * 60_000;
const RECORD_CAPACITY_CACHE_CRITICAL_MS = 60_000;
const RECORD_CAPACITY_AUDIT_THROTTLE_MS = 10 * 60 * 1000;
const HOT_PATH_HEALTH_OK_THROTTLE_MS = 10 * 60 * 1000;
const LAST_SEEN_UPDATE_INTERVAL_MS = 30_000;
const POLICY_SETTING_CACHE_MS = 5_000;
const PING_TASK_CACHE_MS = 30_000;
const AGENT_POLICY_SETTING_KEYS = [
  'live_poll_active_interval_sec',
  'live_poll_idle_interval_sec',
  'live_poll_active_max_duration_sec',
];
const RECORD_PERSISTENCE_SETTING_KEYS = [
  'record_enabled',
  'record_persist_interval_sec',
  'ping_record_persist_interval_sec',
  'record_high_watermark_rows',
];
const HTTP_CLIENT_MIN_TTL_MS = 30_000;
const HTTP_CLIENT_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const VIEWER_MIN_TTL_MS = 60_000;
const VIEWER_MAX_TTL_MS = 60 * 60 * 1000;
const VIEWER_DEFAULT_TTL_MS = 10 * 60 * 1000;
const VIEWER_MAX_TOTAL_SESSIONS = 128;
const VIEWER_MAX_SESSIONS_PER_IP = 8;
const RATE_LIMIT_STORAGE_PREFIX = 'rate-limit:';
const RATE_LIMIT_MAX_BUCKETS = 5000;
const PING_RESULT_STORAGE_PREFIX = 'ping-result:';
type SessionRole = 'agent' | 'viewer';
type AgentPolicyMode = 'active' | 'idle';

interface AgentPolicySettings {
  activeIntervalSec: number;
  idleIntervalSec: number;
  viewerTtlSec: number;
}

interface AgentPolicyMessage {
  type: 'policy';
  mode: AgentPolicyMode;
  sample_interval_sec: number;
  report_interval_sec: number;
  report_now: boolean;
  viewer_count: number;
  viewer_ttl_sec: number;
  timestamp: number;
}

interface PingPersistenceResult {
  taskId: number;
  value: number;
  intervalSec?: number;
}

interface SessionAttachment {
  role: SessionRole;
  clientId: string;
  clientName: string;
  hidden: boolean;
  viewerIp?: string;
  viewerExpiresAt?: number;
}

export function normalizeViewerTtlMs(value: unknown): number {
  const ttlMs = Number(value);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return VIEWER_DEFAULT_TTL_MS;
  return Math.min(Math.max(ttlMs, VIEWER_MIN_TTL_MS), VIEWER_MAX_TTL_MS);
}

export class LiveDataDO {
  private state: DurableObjectState;
  private env: any;
  private sessions: Map<string, WebSocket>; // WebSocket 连接
  private sessionRoles: Map<string, SessionRole>;
  private viewerExpiresAt: Map<string, number>;
  private clients: Map<string, ClientState>; // 在线客户端状态
  private recordPersistenceEnabled: boolean = true;
  private recordPersistIntervalMs: number = RECORD_PERSIST_INTERVAL_MS;
  private pingRecordPersistIntervalMs: number = PING_RECORD_PERSIST_INTERVAL_MS;
  private recordPersistenceCheckedAt: number = 0;
  private recordHighWatermarkRows: number = RECORD_HIGH_WATERMARK_DEFAULT_ROWS;
  private recordCapacityNextCheckAt: number = 0;
  private recordCapacityRows: number = 0;
  private recordCapacityBlocked: boolean = false;
  private recordCapacityLastAuditAt: number = 0;
  private healthOkLastWriteAt: Map<string, number> = new Map();
  private recordLastPersistAt: Map<string, number> = new Map();
  private lastSeenLastWriteAt: Map<string, number> = new Map();
  private policySettings: AgentPolicySettings = {
    activeIntervalSec: 3,
    idleIntervalSec: 600,
    viewerTtlSec: 600,
  };
  private policySettingsCheckedAt: number = 0;
  private lastBroadcastPolicyKey: string = '';
  private rateLimitSweepCounter: number = 0;
  private pingTasksCache: { value: db.PingTask[]; expiresAt: number } | null = null;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.sessionRoles = new Map();
    this.viewerExpiresAt = new Map();
    this.clients = new Map();
    this.hydrateSessionsFromAcceptedWebSockets();
  }

  private getSessionAttachment(ws: WebSocket): SessionAttachment | null {
    const attachment = ws.deserializeAttachment();
    if (!attachment || typeof attachment !== 'object') return null;
    const value = attachment as Partial<SessionAttachment>;
    if (value.role !== 'agent' && value.role !== 'viewer') return null;
    if (typeof value.clientId !== 'string' || value.clientId.trim() === '') return null;
    return {
      role: value.role,
      clientId: value.clientId,
      clientName: typeof value.clientName === 'string' && value.clientName.trim() !== ''
        ? value.clientName
        : value.clientId,
      hidden: Boolean(value.hidden),
      viewerIp: typeof value.viewerIp === 'string' && value.viewerIp.trim() !== ''
        ? value.viewerIp
        : undefined,
      viewerExpiresAt: typeof value.viewerExpiresAt === 'number' && Number.isFinite(value.viewerExpiresAt)
        ? value.viewerExpiresAt
        : undefined,
    };
  }

  private runBackground(task: Promise<unknown>): void {
    const guarded = task.catch((error) => {
      console.error('[live-data-do] background task failed:', errorDetail(error));
    });
    const state = this.state as DurableObjectState & { waitUntil?: (promise: Promise<unknown>) => void };
    if (typeof state.waitUntil === 'function') {
      state.waitUntil(guarded);
      return;
    }
    void guarded;
  }

  private registerSession(ws: WebSocket, attachment: SessionAttachment): void {
    ws.serializeAttachment(attachment);
    this.sessions.set(attachment.clientId, ws);
    this.sessionRoles.set(attachment.clientId, attachment.role);
    if (attachment.role === 'viewer' && typeof attachment.viewerExpiresAt === 'number') {
      this.viewerExpiresAt.set(attachment.clientId, attachment.viewerExpiresAt);
    } else {
      this.viewerExpiresAt.delete(attachment.clientId);
    }
  }

  private hydrateSessionsFromAcceptedWebSockets(): void {
    for (const ws of this.state.getWebSockets()) {
      const attachment = this.getSessionAttachment(ws);
      if (!attachment) continue;
      this.sessions.set(attachment.clientId, ws);
      this.sessionRoles.set(attachment.clientId, attachment.role);
      if (attachment.role === 'viewer' && typeof attachment.viewerExpiresAt === 'number') {
        this.viewerExpiresAt.set(attachment.clientId, attachment.viewerExpiresAt);
      }
    }
  }

  private sanitizeReport(report: any): any {
    if (!report || typeof report !== 'object') return {};
    const {
      token,
      authorization,
      password,
      ...safeReport
    } = report;
    return safeReport;
  }

  private buildSnapshot() {
    const now = Date.now();
    const onlineClients = Array.from(this.clients.values())
      .filter(c => !c.hidden && (!c.expiresAt || c.expiresAt > now))
      .map(c => ({
        uuid: c.uuid,
        name: c.name,
        lastReportTime: c.lastReportTime,
        ...(c.lastReport || {}),
      }));
    const liveData = onlineClients.reduce((acc: Record<string, any>, client: any) => {
      acc[client.uuid] = client;
      return acc;
    }, {});

    return {
      online: onlineClients.map(c => c.uuid),
      clients: onlineClients,
      data: liveData,
      count: onlineClients.length,
      timestamp: Date.now(),
    };
  }

  private sendSnapshot(ws: WebSocket) {
    if (ws.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      ws.send(JSON.stringify({
        type: 'snapshot',
        ...this.buildSnapshot(),
      }));
    } catch (error) {
      // Viewer snapshots are best effort; HTTP fallback will retry.
    }
  }

  private isVisibleClient(client: ClientState | undefined, now: number): boolean {
    return Boolean(client && !client.hidden && (!client.expiresAt || client.expiresAt > now));
  }

  private updateClientReport(
    clientId: string,
    clientName: string,
    hidden: boolean,
    data: any,
    now: number,
    expiresAt?: number,
  ) {
    const report = this.sanitizeReport(normalizeMonitorReport(data));
    const previous = this.clients.get(clientId);
    const wasVisible = this.isVisibleClient(previous, now);
    const next: ClientState = {
      uuid: clientId,
      name: clientName,
      hidden,
      lastReportTime: now,
      lastReport: report,
      expiresAt,
    };

    this.clients.set(clientId, next);

    if (this.isVisibleClient(next, now)) {
      this.broadcastToViewers({
        type: 'update',
        client: clientId,
        name: clientName,
        data: report,
        timestamp: now,
      });
    } else if (wasVisible) {
      this.broadcastToViewers({
        type: 'remove',
        client: clientId,
        timestamp: now,
      });
    }

    return report;
  }

  private boundedHttpTtlMs(value: unknown): number {
    const ttlMs = Number(value);
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return 180_000;
    return Math.min(Math.max(ttlMs, HTTP_CLIENT_MIN_TTL_MS), HTTP_CLIENT_MAX_TTL_MS);
  }

  private boundedViewerTtlMs(value: unknown): number {
    return normalizeViewerTtlMs(value);
  }

  private boundIntegerSetting(value: string | undefined, fallback: number, min: number, max: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  }

  private async getAgentPolicySettings(now: number, forceRefresh = false): Promise<AgentPolicySettings> {
    if (!this.env?.DB) return this.policySettings;
    if (!forceRefresh && now - this.policySettingsCheckedAt < POLICY_SETTING_CACHE_MS) {
      return this.policySettings;
    }

    try {
      const settings = buildAdminSettings(await db.getSettingsByKeys(this.env.DB, AGENT_POLICY_SETTING_KEYS));
      this.policySettings = {
        activeIntervalSec: this.boundIntegerSetting(settings.live_poll_active_interval_sec, 3, 3, 300),
        idleIntervalSec: this.boundIntegerSetting(settings.live_poll_idle_interval_sec, 600, 60, 3600),
        viewerTtlSec: this.boundIntegerSetting(settings.live_poll_active_max_duration_sec, 600, 60, 3600),
      };
    } catch (error) {
      await bestEffortRecordHealthEvent(
        this.env?.DB,
        'agent_policy',
        'error',
        `policy settings lookup failed: ${errorDetail(error)}`,
        { auditAction: 'agent_policy_error' },
      );
    }
    this.policySettingsCheckedAt = now;
    return this.policySettings;
  }

  private async getPingTasks(now: number, forceRefresh = false): Promise<db.PingTask[]> {
    if (!this.env?.DB) return [];
    if (!forceRefresh && this.pingTasksCache && this.pingTasksCache.expiresAt > now) {
      return this.pingTasksCache.value;
    }

    const tasks = await db.listPingTasks(this.env.DB);
    this.pingTasksCache = {
      value: tasks,
      expiresAt: now + PING_TASK_CACHE_MS,
    };
    return tasks;
  }

  private invalidatePingTasksCache(): void {
    this.pingTasksCache = null;
  }

  private activeViewerCount(now: number): number {
    let count = 0;
    for (const [id, role] of this.sessionRoles) {
      if (role !== 'viewer') continue;
      const expiresAt = this.viewerExpiresAt.get(id);
      if (typeof expiresAt === 'number' && expiresAt > now) {
        count += 1;
      }
    }
    return count;
  }

  private async buildAgentPolicy(
    now: number,
    reportNow: boolean,
    forceRefreshSettings = false,
  ): Promise<AgentPolicyMessage> {
    const settings = await this.getAgentPolicySettings(now, forceRefreshSettings);
    const viewerCount = this.activeViewerCount(now);
    const mode: AgentPolicyMode = viewerCount > 0 ? 'active' : 'idle';
    return {
      type: 'policy',
      mode,
      sample_interval_sec: settings.activeIntervalSec,
      report_interval_sec: mode === 'active' ? settings.activeIntervalSec : settings.idleIntervalSec,
      report_now: mode === 'active' && reportNow,
      viewer_count: viewerCount,
      viewer_ttl_sec: settings.viewerTtlSec,
      timestamp: now,
    };
  }

  private sendAgentPolicy(session: WebSocket, policy: AgentPolicyMessage): void {
    if (session.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      session.send(JSON.stringify(policy));
    } catch {
      // Broken agent sockets are cleaned up by close/error handlers.
    }
  }

  private async sendCurrentPolicyToAgent(
    session: WebSocket,
    now: number,
    reportNow = false,
    forceRefreshSettings = false,
  ): Promise<void> {
    const policy = await this.buildAgentPolicy(now, reportNow, forceRefreshSettings);
    this.sendAgentPolicy(session, policy);
  }

  private async broadcastAgentPolicy(
    now: number,
    reportNow = false,
    forceRefreshSettings = false,
  ): Promise<void> {
    const policy = await this.buildAgentPolicy(now, reportNow, forceRefreshSettings);
    const policyKey = `${policy.mode}:${policy.sample_interval_sec}:${policy.report_interval_sec}:${policy.viewer_ttl_sec}`;
    if (!reportNow && !forceRefreshSettings && policyKey === this.lastBroadcastPolicyKey) {
      return;
    }
    this.lastBroadcastPolicyKey = policyKey;
    for (const [id, session] of this.sessions) {
      if (this.sessionRoles.get(id) !== 'agent') continue;
      this.sendAgentPolicy(session, policy);
    }
  }

  private removeExpiredClients(now: number) {
    for (const [uuid, client] of this.clients) {
      if (!client.expiresAt || client.expiresAt > now) continue;

      const wasVisible = !client.hidden;
      this.clients.delete(uuid);
      if (wasVisible) {
        this.broadcastToViewers({
          type: 'remove',
          client: uuid,
          timestamp: now,
        });
      }
    }
  }

  private async scheduleExpiryAlarm(now: number) {
    try {
      const expiries: number[] = [];
      for (const client of this.clients.values()) {
        const expiresAt = client.expiresAt;
        if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > now) {
          expiries.push(expiresAt);
        }
      }
      for (const expiresAt of this.viewerExpiresAt.values()) {
        if (Number.isFinite(expiresAt) && expiresAt > now) {
          expiries.push(expiresAt);
        }
      }
      const nextExpiry = expiries.sort((a, b) => a - b)[0];

      if (nextExpiry === undefined) {
        await this.state.storage.deleteAlarm();
        return;
      }

      await this.state.storage.setAlarm(Math.max(nextExpiry, now + 1000));
    } catch {
      // Alarm scheduling is best effort; snapshots still filter expired HTTP clients.
    }
  }

  private broadcastToViewers(message: Record<string, any>) {
    const payload = JSON.stringify(message);
    for (const [id, session] of this.sessions) {
      if (this.sessionRoles.get(id) !== 'viewer' || session.readyState !== WebSocket.READY_STATE_OPEN) {
        continue;
      }
      try {
        session.send(payload);
      } catch {
        // Close/error handlers clean up broken viewer sockets.
      }
    }
  }

  private countViewers(viewerIp?: string): { total: number; sameIp: number } {
    const now = Date.now();
    let total = 0;
    let sameIp = 0;
    for (const ws of this.sessions.values()) {
      const attachment = this.getSessionAttachment(ws);
      if (!attachment || attachment.role !== 'viewer') continue;
      if (typeof attachment.viewerExpiresAt !== 'number' || attachment.viewerExpiresAt <= now) continue;
      total += 1;
      if (viewerIp && attachment.viewerIp === viewerIp) {
        sameIp += 1;
      }
    }
    return { total, sameIp };
  }

  private enforceViewerConnectionLimit(viewerIp?: string): Response | null {
    const counts = this.countViewers(viewerIp);
    if (counts.total >= VIEWER_MAX_TOTAL_SESSIONS) {
      return new Response(JSON.stringify({ error: 'Too many live viewers' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      });
    }
    if (viewerIp && counts.sameIp >= VIEWER_MAX_SESSIONS_PER_IP) {
      return new Response(JSON.stringify({ error: 'Too many live viewers from this IP' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
        },
      });
    }
    return null;
  }

  private async checkRateLimit(request: Request): Promise<Response> {
    let body: { bucket?: unknown; ip?: unknown; max?: unknown; windowMs?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid rate limit payload' }, { status: 400 });
    }

    const bucket = typeof body.bucket === 'string' ? body.bucket.slice(0, 96) : '';
    const ip = typeof body.ip === 'string' ? body.ip.slice(0, 128) : '';
    const max = Number(body.max);
    const windowMs = Number(body.windowMs);
    if (!bucket || !ip || !Number.isInteger(max) || max <= 0 || !Number.isInteger(windowMs) || windowMs < 1000) {
      return Response.json({ error: 'Invalid rate limit payload' }, { status: 400 });
    }

    const now = Date.now();
    this.rateLimitSweepCounter += 1;
    if (this.rateLimitSweepCounter % 256 === 0) {
      await this.cleanupRateLimitBuckets(now);
    }
    const key = `${RATE_LIMIT_STORAGE_PREFIX}${bucket}:${ip}`;
    const current = await this.state.storage.get<{ count: number; resetAt: number }>(key);
    const state = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + windowMs }
      : current;
    state.count += 1;
    await this.state.storage.put(key, state);
    if (this.rateLimitSweepCounter % 1024 === 0) {
      await this.enforceRateLimitBucketLimit(now);
    }

    const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
    const remaining = Math.max(0, max - state.count);
    return Response.json({
      allowed: state.count <= max,
      retry_after: retryAfter,
      limit: max,
      remaining,
      reset: Math.ceil(state.resetAt / 1000),
    });
  }

  private async cleanupRateLimitBuckets(now: number): Promise<void> {
    try {
      const entries = await this.state.storage.list<{ count: number; resetAt: number }>({
        prefix: RATE_LIMIT_STORAGE_PREFIX,
      });
      const expired: string[] = [];
      for (const [key, value] of entries) {
        if (!value || value.resetAt <= now) expired.push(key);
      }
      await Promise.all(expired.map(key => this.state.storage.delete(key)));
    } catch {
      // Rate-limit cleanup is best effort; active buckets overwrite themselves.
    }
  }

  private async enforceRateLimitBucketLimit(now: number): Promise<void> {
    try {
      const entries = await this.state.storage.list<{ count: number; resetAt: number }>({
        prefix: RATE_LIMIT_STORAGE_PREFIX,
      });
      if (entries.size <= RATE_LIMIT_MAX_BUCKETS) return;

      const expired: string[] = [];
      const active: Array<{ key: string; resetAt: number }> = [];
      for (const [key, value] of entries) {
        if (!value || value.resetAt <= now) {
          expired.push(key);
        } else {
          active.push({ key, resetAt: value.resetAt });
        }
      }

      const overflow = Math.max(0, active.length - RATE_LIMIT_MAX_BUCKETS);
      const oldest = overflow > 0
        ? active.sort((a, b) => a.resetAt - b.resetAt).slice(0, overflow).map(item => item.key)
        : [];
      await Promise.all([...expired, ...oldest].map(key => this.state.storage.delete(key)));
    } catch {
      // Best effort; live snapshots and agent policy should continue even if compaction fails.
    }
  }

  private async cleanupClientStorage(clientId: string): Promise<number> {
    const keys = [`record:persist:${clientId}`];
    this.recordLastPersistAt.delete(clientId);
    this.lastSeenLastWriteAt.delete(clientId);

    try {
      const pingEntries = await this.state.storage.list<number>({
        prefix: `${PING_RESULT_STORAGE_PREFIX}${clientId}:`,
      });
      keys.push(...pingEntries.keys());
      await Promise.all(keys.map(key => this.state.storage.delete(key)));
      return keys.length;
    } catch {
      return 0;
    }
  }

  private async cleanupPingTaskStorage(taskIds: number[]): Promise<number> {
    const taskIdSet = new Set(taskIds.filter(id => Number.isInteger(id) && id > 0).map(String));
    if (taskIdSet.size === 0) return 0;

    try {
      const entries = await this.state.storage.list<number>({ prefix: PING_RESULT_STORAGE_PREFIX });
      const keys: string[] = [];
      for (const key of entries.keys()) {
        const taskId = key.slice(key.lastIndexOf(':') + 1);
        if (taskIdSet.has(taskId)) keys.push(key);
      }
      await Promise.all(keys.map(key => this.state.storage.delete(key)));
      return keys.length;
    } catch {
      return 0;
    }
  }

  private expireViewer(id: string, session: WebSocket, now: number): void {
    this.viewerExpiresAt.delete(id);
    if (this.sessions.get(id) === session) {
      this.sessions.delete(id);
      this.sessionRoles.delete(id);
    }

    if (session.readyState !== WebSocket.READY_STATE_OPEN) return;
    try {
      session.send(JSON.stringify({
        type: 'viewer_expired',
        timestamp: now,
      }));
    } catch {
      // Best effort only; closing below is the enforcement.
    }
    try {
      session.close(1000, 'Viewer live window expired');
    } catch {
      // Best effort only.
    }
  }

  private removeExpiredViewers(now: number): void {
    for (const [id, expiresAt] of this.viewerExpiresAt) {
      if (expiresAt > now) continue;
      const session = this.sessions.get(id);
      if (!session) {
        this.viewerExpiresAt.delete(id);
        this.sessionRoles.delete(id);
        continue;
      }
      this.expireViewer(id, session, now);
    }
  }

  private cleanupSession(ws: WebSocket, attachment: SessionAttachment): void {
    if (this.sessions.get(attachment.clientId) !== ws) return;

    const existing = this.clients.get(attachment.clientId);
    const wasVisible = existing ? !existing.hidden : false;
    this.sessions.delete(attachment.clientId);
    this.sessionRoles.delete(attachment.clientId);
    this.viewerExpiresAt.delete(attachment.clientId);

    if (attachment.role !== 'agent') return;

    this.clients.delete(attachment.clientId);
    if (wasVisible) {
      this.broadcastToViewers({
        type: 'remove',
        client: attachment.clientId,
        timestamp: Date.now(),
      });
    }
  }

  private async updateClientMeta(request: Request): Promise<Response> {
    const meta = await request.json().catch(() => null) as any;
    if (!meta || typeof meta.uuid !== 'string' || meta.uuid.trim() === '') {
      return new Response(JSON.stringify({ error: 'Invalid client metadata' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const uuid = meta.uuid;
    const current = this.clients.get(uuid);
    if (current) {
      const wasVisible = !current.hidden;
      current.name = typeof meta.name === 'string' ? meta.name : current.name;
      current.hidden = Boolean(meta.hidden);
      this.clients.set(uuid, current);

      if (wasVisible && current.hidden) {
        this.broadcastToViewers({
          type: 'remove',
          client: uuid,
          timestamp: Date.now(),
        });
      } else if (!current.hidden && current.lastReport) {
        this.broadcastToViewers({
          type: 'update',
          client: uuid,
          name: current.name,
          data: current.lastReport,
          timestamp: current.lastReportTime,
        });
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async removeClient(request: Request): Promise<Response> {
    const meta = await request.json().catch(() => null) as any;
    if (!meta || typeof meta.uuid !== 'string' || meta.uuid.trim() === '') {
      return new Response(JSON.stringify({ error: 'Invalid client metadata' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const existing = this.clients.get(meta.uuid);
    const wasVisible = existing ? !existing.hidden : false;
    const session = this.sessions.get(meta.uuid);
    if (session && session.readyState === WebSocket.READY_STATE_OPEN) {
      try {
        session.close(1008, 'Client removed');
      } catch {
        // Best effort only.
      }
    }
    this.sessions.delete(meta.uuid);
    this.sessionRoles.delete(meta.uuid);
    this.clients.delete(meta.uuid);
    const cleanedStorageKeys = await this.cleanupClientStorage(meta.uuid);
    if (wasVisible) {
      this.broadcastToViewers({
        type: 'remove',
        client: meta.uuid,
        timestamp: Date.now(),
      });
    }

    return new Response(JSON.stringify({ success: true, cleaned_storage_keys: cleanedStorageKeys }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async updateHttpClientReport(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => null) as any;
    const reports = Array.isArray(payload?.reports)
      ? payload.reports.slice(0, 1200)
      : payload?.report
        ? [payload.report]
        : [];
    if (!payload || typeof payload.uuid !== 'string' || payload.uuid.trim() === '' || reports.length === 0) {
      return new Response(JSON.stringify({ error: 'Invalid client report' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const now = Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now();
    const ttlMs = this.boundedHttpTtlMs(payload.ttl_ms);
    let persisted = false;
    for (let index = 0; index < reports.length; index += 1) {
      const rawReport = reports[index];
      const reportTime = this.reportTimestamp(rawReport, now);
      const isLast = index === reports.length - 1;
      if (isLast) {
        const report = this.updateClientReport(
          payload.uuid,
          typeof payload.name === 'string' && payload.name.trim() !== '' ? payload.name.trim() : payload.uuid,
          Boolean(payload.hidden),
          rawReport,
          reportTime,
          now + ttlMs,
        );
        persisted = (await this.persistReport(payload.uuid, report, reportTime)) || persisted;
      } else {
        persisted = (await this.persistReport(payload.uuid, rawReport, reportTime)) || persisted;
      }
    }

    await this.scheduleExpiryAlarm(now);

    return new Response(JSON.stringify({ success: true, persisted }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private reportTimestamp(report: any, fallback: number): number {
    const parsed = Number(report?.timestamp);
    const now = Date.now();
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed < 0 || parsed > now + 60_000) return fallback;
    return parsed;
  }

  // HTTP 请求处理（用于 Agent 上报数据）
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/client-meta') {
      return this.updateClientMeta(request);
    }

    if (request.method === 'POST' && url.pathname === '/client-remove') {
      return this.removeClient(request);
    }

    if (request.method === 'POST' && url.pathname === '/client-report') {
      return this.updateHttpClientReport(request);
    }

    if (request.method === 'POST' && url.pathname === '/ping-result') {
      return this.updateHttpPingResult(request);
    }

    if (request.method === 'POST' && url.pathname === '/rate-limit') {
      return this.checkRateLimit(request);
    }

    if (request.method === 'POST' && url.pathname === '/policy-refresh') {
      await this.broadcastAgentPolicy(Date.now(), false, true);
      return Response.json({ success: true });
    }

    if (request.method === 'POST' && url.pathname === '/record-settings-refresh') {
      await this.isRecordPersistenceEnabled(Date.now(), true);
      this.recordCapacityNextCheckAt = 0;
      return Response.json({ success: true });
    }

    if (request.method === 'POST' && url.pathname === '/ping-tasks-refresh') {
      const payload = await request.json().catch(() => null) as any;
      const removedTaskIds = Array.isArray(payload?.removed_task_ids)
        ? payload.removed_task_ids.map(Number).filter((id: number) => Number.isInteger(id) && id > 0)
        : [];
      const cleanedStorageKeys = await this.cleanupPingTaskStorage(removedTaskIds);
      this.invalidatePingTasksCache();
      return Response.json({ success: true, cleaned_storage_keys: cleanedStorageKeys });
    }

    if (request.method === 'GET' && url.pathname === '/policy') {
      return Response.json(await this.buildAgentPolicy(Date.now(), false));
    }

    // WebSocket 升级
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const clientId = url.searchParams.get('id') || crypto.randomUUID();
      const clientName = url.searchParams.get('name') || clientId;
      const hidden = url.searchParams.get('hidden') === '1' || url.searchParams.get('hidden') === 'true';
      const role = url.searchParams.get('role') === 'agent' ? 'agent' : 'viewer';
      const viewerIp = url.searchParams.get('viewer_ip') || undefined;
      const now = Date.now();
      const activeViewersBefore = this.activeViewerCount(now);

      if (role === 'viewer') {
        const limitResponse = this.enforceViewerConnectionLimit(viewerIp);
        if (limitResponse) return limitResponse;
      }

      const oldSession = role === 'agent' ? this.sessions.get(clientId) : undefined;
      if (oldSession && oldSession.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          oldSession.close(1000, 'Replaced by a new connection');
        } catch {
          // Best effort only.
        }
      }

      const attachment: SessionAttachment = {
        role,
        clientId,
        clientName,
        hidden,
        ...(role === 'viewer' && viewerIp ? { viewerIp } : {}),
      };
      if (role === 'viewer') {
        const viewerTtlMs = this.boundedViewerTtlMs(url.searchParams.get('viewer_ttl_ms'));
        attachment.viewerExpiresAt = now + viewerTtlMs;
      }

      this.registerSession(server, attachment);
      this.state.acceptWebSocket(server);

      if (role === 'viewer') {
        void this.scheduleExpiryAlarm(now);
      }

      if (role === 'viewer') {
        this.sendSnapshot(server);
        if (activeViewersBefore === 0) {
          void this.broadcastAgentPolicy(now, true);
        }
      } else {
        void this.sendCurrentPolicyToAgent(server, now, false);
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP GET - 获取缓存的实时数据
    if (request.method === 'GET') {
      return new Response(JSON.stringify(this.buildSnapshot()), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  private async handleMessage(clientId: string, clientName: string, hidden: boolean, data: any, ws: WebSocket) {
    const now = Date.now();
    if (data?.type === 'ping_result') {
      this.runBackground(this.markClientSeen(clientId, now, 'ws-ping'));
      this.runBackground(this.persistPingResult(clientId, data, now));
      return;
    }

    if (data?.type === 'reports' && Array.isArray(data.reports)) {
      const reports = data.reports.slice(0, 1200);
      const reportsToPersist: Array<{ report: any; reportTime: number }> = [];
      let lastReportIntervalSec: number | null = null;
      for (let index = 0; index < reports.length; index += 1) {
        const rawReport = reports[index];
        const reportTime = this.reportTimestamp(rawReport, now);
        const isLast = index === reports.length - 1;
        if (isLast) {
          const report = this.updateClientReport(clientId, clientName, hidden, rawReport, reportTime);
          lastReportIntervalSec = Number(report.report_interval || 0) || null;
          reportsToPersist.push({ report, reportTime });
        } else {
          reportsToPersist.push({ report: rawReport, reportTime });
        }
      }
      this.runBackground(this.markClientSeen(clientId, now, 'ws', false, false, lastReportIntervalSec));

      if (ws.readyState === WebSocket.READY_STATE_OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ack', timestamp: now }));
        } catch {
          // 忽略 ack 发送错误
        }
      }
      this.runBackground(this.persistReportsSequential(clientId, reportsToPersist));
      return;
    }

    const report = this.updateClientReport(clientId, clientName, hidden, data, now);
    this.runBackground(this.markClientSeen(clientId, now, 'ws', false, false, report.report_interval));

    if (ws.readyState === WebSocket.READY_STATE_OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'ack', timestamp: now }));
      } catch {
        // 忽略 ack 发送错误
      }
    }

    // 持久化放在实时响应之后，避免 D1 写入延迟阻塞 Agent WebSocket ack。
    this.runBackground(this.persistReport(clientId, report, now));
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const attachment = this.getSessionAttachment(ws);
    if (!attachment || attachment.role !== 'agent') return;
    try {
      const data = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
      await this.handleMessage(attachment.clientId, attachment.clientName, attachment.hidden, data, ws);
    } catch {
      // Ignore malformed agent messages.
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = this.getSessionAttachment(ws);
    if (attachment) {
      const wasViewer = attachment.role === 'viewer';
      const activeViewersBefore = this.activeViewerCount(Date.now());
      this.cleanupSession(ws, attachment);
      if (wasViewer && activeViewersBefore > 0) {
        await this.broadcastAgentPolicy(Date.now(), false);
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const attachment = this.getSessionAttachment(ws);
    if (attachment) {
      const wasViewer = attachment.role === 'viewer';
      const activeViewersBefore = this.activeViewerCount(Date.now());
      this.cleanupSession(ws, attachment);
      if (wasViewer && activeViewersBefore > 0) {
        await this.broadcastAgentPolicy(Date.now(), false);
      }
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.removeExpiredClients(now);
    this.removeExpiredViewers(now);
    await this.cleanupRateLimitBuckets(now);
    await this.enforceRateLimitBucketLimit(now);
    await this.broadcastAgentPolicy(now, false);
    await this.scheduleExpiryAlarm(now);
  }

  private async reservePersistSlot(clientId: string, now: number): Promise<boolean> {
    const storageKey = `record:persist:${clientId}`;
    let lastPersist = this.recordLastPersistAt.get(clientId);
    if (lastPersist === undefined) {
      const storedLastPersist = Number(await this.state.storage.get<number>(storageKey) || 0);
      lastPersist = this.recordLastPersistAt.get(clientId) ?? storedLastPersist;
      this.recordLastPersistAt.set(clientId, lastPersist);
    }
    if (now - lastPersist < this.recordPersistIntervalMs) {
      return false;
    }
    this.recordLastPersistAt.set(clientId, now);
    try {
      await this.state.storage.put(storageKey, now);
    } catch (error) {
      this.recordLastPersistAt.set(clientId, lastPersist);
      throw error;
    }
    return true;
  }

  private async persistReportsSequential(
    clientId: string,
    reports: Array<{ report: any; reportTime: number }>,
  ): Promise<void> {
    for (const item of reports) {
      await this.persistReport(clientId, item.report, item.reportTime);
    }
  }

  private async isRecordPersistenceEnabled(now: number, forceRefresh = false): Promise<boolean> {
    if (!this.env?.DB) return false;
    if (!forceRefresh && now - this.recordPersistenceCheckedAt < RECORD_SETTING_CACHE_MS) {
      return this.recordPersistenceEnabled;
    }

    try {
      const settings = buildAdminSettings(await db.getSettingsByKeys(this.env.DB, RECORD_PERSISTENCE_SETTING_KEYS));
      this.recordPersistenceEnabled = normalizeRecordPersistenceEnabled(settings);
      const intervalSec = Number(settings.record_persist_interval_sec);
      const boundedIntervalSec = Number.isFinite(intervalSec)
        ? Math.min(Math.max(Math.floor(intervalSec), 3), 3600)
        : RECORD_PERSIST_INTERVAL_MS / 1000;
      this.recordPersistIntervalMs = Math.min(
        Math.max(boundedIntervalSec * 1000, MIN_RECORD_PERSIST_INTERVAL_MS),
        MAX_RECORD_PERSIST_INTERVAL_MS,
      );
      const pingIntervalSec = Number(settings.ping_record_persist_interval_sec);
      const boundedPingIntervalSec = Number.isFinite(pingIntervalSec)
        ? Math.min(Math.max(Math.floor(pingIntervalSec), 60), 3600)
        : PING_RECORD_PERSIST_INTERVAL_MS / 1000;
      this.pingRecordPersistIntervalMs = Math.min(
        Math.max(boundedPingIntervalSec * 1000, MIN_PING_RECORD_PERSIST_INTERVAL_MS),
        MAX_PING_RECORD_PERSIST_INTERVAL_MS,
      );
      const highWatermarkRows = Number(settings.record_high_watermark_rows);
      this.recordHighWatermarkRows = Number.isFinite(highWatermarkRows)
        ? Math.min(
          Math.max(Math.floor(highWatermarkRows), RECORD_HIGH_WATERMARK_MIN_ROWS),
          RECORD_HIGH_WATERMARK_MAX_ROWS,
        )
        : RECORD_HIGH_WATERMARK_DEFAULT_ROWS;
      this.recordPersistenceCheckedAt = now;
    } catch (error) {
      await bestEffortRecordHealthEvent(
        this.env?.DB,
        'do_record_persistence',
        'error',
        `record persistence settings lookup failed: ${errorDetail(error)}`,
        { auditAction: 'do_record_persistence_error' },
      );
      this.recordPersistenceCheckedAt = now;
    }

    return this.recordPersistenceEnabled;
  }

  private capacityCheckDelayMs(): number {
    if (this.recordCapacityBlocked) return RECORD_CAPACITY_CACHE_CRITICAL_MS;
    if (this.recordHighWatermarkRows <= 0) return RECORD_CAPACITY_CACHE_NEAR_MS;
    const ratio = this.recordCapacityRows / this.recordHighWatermarkRows;
    if (ratio >= 0.95) return RECORD_CAPACITY_CACHE_CRITICAL_MS;
    if (ratio >= 0.8) return RECORD_CAPACITY_CACHE_NEAR_MS;
    return RECORD_CAPACITY_CACHE_FAR_MS;
  }

  private async canPersistWithinCapacity(now: number): Promise<boolean> {
    if (!this.env?.DB) return false;
    if (now < this.recordCapacityNextCheckAt) {
      return !this.recordCapacityBlocked;
    }

    try {
      // 使用快速计数（增量计数表），避免全表扫描
      const counts = await db.getHistoryStorageRowCountsFast(this.env.DB);
      this.recordCapacityRows = counts.records + counts.gpu_records + counts.gpu_snapshots + counts.ping_records + counts.ping_snapshots;
      this.recordCapacityBlocked = this.recordCapacityRows >= this.recordHighWatermarkRows;
      this.recordCapacityNextCheckAt = now + this.capacityCheckDelayMs();
      if (this.recordCapacityBlocked && now - this.recordCapacityLastAuditAt >= RECORD_CAPACITY_AUDIT_THROTTLE_MS) {
        this.recordCapacityLastAuditAt = now;
        await bestEffortRecordHealthEvent(
          this.env.DB,
          'do_record_persistence',
          'error',
          `record persistence paused at ${this.recordCapacityRows}/${this.recordHighWatermarkRows} rows; live data continues without D1 history writes`,
          { auditAction: 'do_record_capacity_high_watermark' },
        );
      }
    } catch (error) {
      this.recordCapacityNextCheckAt = now + RECORD_CAPACITY_CACHE_NEAR_MS;
      await bestEffortRecordHealthEvent(
        this.env.DB,
        'do_record_persistence',
        'error',
        `record capacity check failed: ${errorDetail(error)}`,
        { auditAction: 'do_record_capacity_error' },
      );
      return true;
    }

    return !this.recordCapacityBlocked;
  }

  private async recordHotPathHealthOk(component: string, detail: string, now: number): Promise<void> {
    const previous = this.healthOkLastWriteAt.get(component) || 0;
    if (now - previous < HOT_PATH_HEALTH_OK_THROTTLE_MS) return;
    this.healthOkLastWriteAt.set(component, now);
    await bestEffortRecordHealthEvent(this.env.DB, component, 'ok', detail, {
      successThrottleMs: HOT_PATH_HEALTH_OK_THROTTLE_MS,
    });
  }

  private async markClientSeen(
    clientId: string,
    nowMs: number,
    source: string,
    persisted = false,
    force = false,
    reportIntervalSec?: number | null,
  ): Promise<void> {
    if (!this.env?.DB) return;
    const previous = this.lastSeenLastWriteAt.get(clientId) || 0;
    if (!force && !persisted && nowMs - previous < LAST_SEEN_UPDATE_INTERVAL_MS) return;
    this.lastSeenLastWriteAt.set(clientId, nowMs);
    const seenAt = new Date(nowMs).toISOString();
    try {
      await db.markClientSeen(this.env.DB, clientId, seenAt, source, persisted ? seenAt : null, reportIntervalSec);
    } catch {
      // Last-seen updates must never block realtime delivery.
    }
  }

  private async persistReport(clientId: string, report: any, nowMs: number, force = false): Promise<boolean> {
    if (!this.env?.DB || !report || report.type === 'ping' || report.type === 'pong' || report.type === 'ping_result') {
      return false;
    }

    try {
      if (!(await this.isRecordPersistenceEnabled(nowMs))) {
        return false;
      }

      if (!force && !(await this.reservePersistSlot(clientId, nowMs))) {
        return false;
      }

      if (!(await this.canPersistWithinCapacity(nowMs))) {
        return false;
      }

      const time = new Date(nowMs).toISOString();
      const record = toMonitorRecord(clientId, time, report);
      await this.env.DB.prepare(
        'INSERT INTO records (client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp, disk, disk_total, net_in, net_out, net_total_up, net_total_down, process_count, connections, connections_udp, uptime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(
        record.client,
        record.time,
        record.cpu,
        record.gpu,
        record.ram,
        record.ram_total,
        record.swap,
        record.swap_total,
        record.load,
        record.temp,
        record.disk,
        record.disk_total,
        record.net_in,
        record.net_out,
        record.net_total_up,
        record.net_total_down,
        record.process_count,
        record.connections,
        record.connections_udp,
        record.uptime,
      ).run();

      if (Array.isArray(report.gpus) && report.gpus.length > 0) {
        await db.insertGPURecords(this.env.DB, clientId, time, report.gpus);
      }
      await this.recordHotPathHealthOk(
        'do_record_persistence',
        `record persisted for ${clientId}`,
        nowMs,
      );
      await this.markClientSeen(clientId, nowMs, 'history', true, true, report.report_interval);
      return true;
    } catch (error) {
      await bestEffortRecordHealthEvent(
        this.env.DB,
        'do_record_persistence',
        'error',
        `record persist failed for ${clientId}: ${errorDetail(error)}`,
        { auditAction: 'do_record_persistence_error' },
      );
      // DO 内部写库失败不应中断实时广播
      return false;
    }
  }

  private async persistPingResult(clientId: string, result: any, nowMs: number) {
    if (!this.env?.DB) return;

    try {
      if (!(await this.isRecordPersistenceEnabled(nowMs))) return;
      if (!(await this.canPersistWithinCapacity(nowMs))) return;

      const tasks = await this.getPingTasks(nowMs);
      const validated = validatePingResults(result, tasks, clientId);
      if (!validated.ok) return;

      const accepted = await this.filterPingResultsByInterval(clientId, validated.results, tasks, nowMs);
      if (accepted.length === 0) return;

      const time = new Date(nowMs).toISOString();
      await db.insertPingSnapshot(this.env.DB, clientId, time, accepted);
      await this.markClientSeen(clientId, nowMs, 'ping', true, true);
      await this.recordHotPathHealthOk(
        'ping_persistence',
        `ping result persisted for ${clientId}`,
        nowMs,
      );
    } catch (error) {
      await bestEffortRecordHealthEvent(
        this.env.DB,
        'ping_persistence',
        'error',
        `ping persist failed for ${clientId}: ${errorDetail(error)}`,
        { auditAction: 'ping_persistence_error' },
      );
    }
  }

  private async updateHttpPingResult(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => null) as any;
    if (!payload || typeof payload.client_id !== 'string' || !Array.isArray(payload.results)) {
      return Response.json({ error: 'Invalid ping result payload' }, { status: 400 });
    }
    if (!this.env?.DB) {
      return Response.json({ error: 'D1 is unavailable' }, { status: 500 });
    }

    try {
      const nowMs = Number.isFinite(Number(payload.timestamp)) ? Number(payload.timestamp) : Date.now();
      if (!(await this.isRecordPersistenceEnabled(nowMs))) {
        return Response.json({ success: true, accepted: 0, disabled: true });
      }
      if (!(await this.canPersistWithinCapacity(nowMs))) {
        return Response.json({ success: true, accepted: 0, capacity_limited: true });
      }

      let accepted: PingPersistenceResult[] = [];
      const trustedResults = this.trustedPingResults(payload.results);
      if (trustedResults) {
        accepted = await this.filterTrustedPingResultsByInterval(payload.client_id, trustedResults, nowMs);
      } else {
        const tasks = await this.getPingTasks(nowMs);
        const validated = validatePingResults(payload.results, tasks, payload.client_id);
        if (!validated.ok) {
          return Response.json({ error: validated.error }, { status: validated.status });
        }
        accepted = await this.filterPingResultsByInterval(payload.client_id, validated.results, tasks, nowMs);
      }
      if (accepted.length === 0) {
        return Response.json({ success: true, accepted: 0, rate_limited: true });
      }

      const time = new Date(nowMs).toISOString();
      await db.insertPingSnapshot(this.env.DB, payload.client_id, time, accepted);
      await this.markClientSeen(payload.client_id, nowMs, 'ping', true, true);
      await this.recordHotPathHealthOk(
        'ping_persistence',
        `ping result persisted for ${payload.client_id}`,
        nowMs,
      );
      return Response.json({ success: true, accepted: accepted.length });
    } catch (error) {
      await bestEffortRecordHealthEvent(
        this.env.DB,
        'ping_persistence',
        'error',
        `ping persist failed: ${errorDetail(error)}`,
        { auditAction: 'ping_persistence_error' },
      );
      return Response.json({ error: 'Ping persist failed' }, { status: 500 });
    }
  }

  private pingResultIntervalMs(result: PingPersistenceResult): number {
    const intervalSec = Number(result.intervalSec);
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) return this.pingRecordPersistIntervalMs;
    return Math.min(
      Math.max(intervalSec * 1000, MIN_PING_RECORD_PERSIST_INTERVAL_MS),
      MAX_PING_RECORD_PERSIST_INTERVAL_MS,
    );
  }

  private trustedPingResults(input: unknown): PingPersistenceResult[] | null {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_PING_RESULTS_PER_REPORT) return null;
    const results: PingPersistenceResult[] = [];
    for (const raw of input) {
      if (!raw || typeof raw !== 'object') return null;
      const item = raw as Record<string, unknown>;
      const taskId = Number(item.task_id);
      const value = Number(item.value);
      const intervalSec = Number(item.interval_sec);
      if (
        !Number.isInteger(taskId) ||
        taskId <= 0 ||
        !Number.isFinite(value) ||
        (value !== PING_LOSS_VALUE && (value < 0 || value > MAX_PING_VALUE_MS)) ||
        !Number.isFinite(intervalSec)
      ) {
        return null;
      }
      results.push({
        taskId,
        value,
        intervalSec,
      });
    }
    return results;
  }

  private async filterPingResultsByInterval(
    clientId: string,
    results: PingPersistenceResult[],
    tasks: db.PingTask[],
    nowMs: number,
  ): Promise<PingPersistenceResult[]> {
    const taskMap = new Map<number, db.PingTask>();
    for (const task of tasks) {
      if (typeof task.id === 'number') taskMap.set(task.id, task);
    }

    return this.filterTrustedPingResultsByInterval(clientId, results.map(result => ({
      ...result,
      intervalSec: result.intervalSec ?? taskMap.get(result.taskId)?.interval_sec,
    })), nowMs);
  }

  private async filterTrustedPingResultsByInterval(
    clientId: string,
    results: PingPersistenceResult[],
    nowMs: number,
  ): Promise<PingPersistenceResult[]> {
    const accepted: PingPersistenceResult[] = [];
    for (const result of results) {
      const minIntervalMs = this.pingResultIntervalMs(result);
      const key = `${PING_RESULT_STORAGE_PREFIX}${clientId}:${result.taskId}`;
      const lastAcceptedMs = Number(await this.state.storage.get<number>(key) || 0);
      if (lastAcceptedMs && nowMs - lastAcceptedMs < minIntervalMs) {
        continue;
      }
      await this.state.storage.put(key, nowMs);
      accepted.push(result);
    }
    return accepted;
  }
}
