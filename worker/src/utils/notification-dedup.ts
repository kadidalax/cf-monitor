/**
 * 通知去重和Incident聚合
 *
 * 功能：
 * 1. 通知静默期：同一事件在静默期内不重复发送
 * 2. 每日通知频率限制：防止通知轰炸
 * 3. Incident聚合：合并同一节点的同类事件
 */

/**
 * 通知频率限制检查
 */
export interface NotificationRateLimit {
  clientId: string;
  notificationType: string;
  count: number;
  windowStart: string;
}

/**
 * 检查是否在静默期内
 */
export function isInSilencePeriod(
  lastNotifiedAt: string | null | undefined,
  silencePeriodSec: number,
  now: Date,
): boolean {
  if (!lastNotifiedAt) return false;

  const lastNotifiedMs = new Date(lastNotifiedAt).getTime();
  if (Number.isNaN(lastNotifiedMs)) return false;

  const nowMs = now.getTime();
  const silencePeriodMs = silencePeriodSec * 1000;

  return nowMs - lastNotifiedMs < silencePeriodMs;
}

/**
 * 检查是否超过每日通知限制
 */
export async function checkDailyNotificationLimit(
  db: D1Database,
  clientId: string,
  notificationType: string,
  maxPerDay: number,
  now: Date,
): Promise<{ allowed: boolean; count: number }> {
  const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const windowStart = `${today}T00:00:00.000Z`;

  const result = await db.prepare(`
    SELECT COUNT(*) as count
    FROM notification_deliveries
    WHERE client = ?
      AND notification_type = ?
      AND status = 'sent'
      AND attempted_at >= ?
  `).bind(clientId, notificationType, windowStart).first<{ count: number }>();

  const count = result?.count || 0;

  return {
    allowed: count < maxPerDay,
    count,
  };
}

/**
 * 合并Incident（检查是否有未解决的同类事件）
 */
export async function shouldAggregateIncident(
  db: D1Database,
  notificationType: string,
  target: string,
  clientId: string | null,
): Promise<{ shouldAggregate: boolean; existingIncidentKey?: string }> {
  // 查找未解决的同类incident
  const result = await db.prepare(`
    SELECT incident_key
    FROM notification_incidents
    WHERE notification_type = ?
      AND target = ?
      AND client = ?
      AND status = 'open'
    ORDER BY first_detected_at DESC
    LIMIT 1
  `).bind(notificationType, target, clientId || null).first<{ incident_key: string }>();

  if (result) {
    return {
      shouldAggregate: true,
      existingIncidentKey: result.incident_key,
    };
  }

  return { shouldAggregate: false };
}

/**
 * 更新Incident的最后检测时间
 */
export async function updateIncidentLastDetected(
  db: D1Database,
  incidentKey: string,
  detectedAt: string,
): Promise<void> {
  await db.prepare(`
    UPDATE notification_incidents
    SET last_detected_at = ?,
        updated_at = datetime('now')
    WHERE incident_key = ?
  `).bind(detectedAt, incidentKey).run();
}

/**
 * 获取Incident的发送历史
 */
export async function getIncidentNotificationHistory(
  db: D1Database,
  incidentKey: string,
): Promise<{
  totalAttempts: number;
  lastSentAt: string | null;
  lastAttemptAt: string | null;
}> {
  const incident = await db.prepare(`
    SELECT last_sent_at, last_attempt_at
    FROM notification_incidents
    WHERE incident_key = ?
  `).bind(incidentKey).first<{
    last_sent_at: string | null;
    last_attempt_at: string | null;
  }>();

  if (!incident) {
    return {
      totalAttempts: 0,
      lastSentAt: null,
      lastAttemptAt: null,
    };
  }

  const deliveries = await db.prepare(`
    SELECT COUNT(*) as count
    FROM notification_deliveries
    WHERE target = (
      SELECT target FROM notification_incidents WHERE incident_key = ?
    )
    AND notification_type = (
      SELECT notification_type FROM notification_incidents WHERE incident_key = ?
    )
  `).bind(incidentKey, incidentKey).first<{ count: number }>();

  return {
    totalAttempts: deliveries?.count || 0,
    lastSentAt: incident.last_sent_at,
    lastAttemptAt: incident.last_attempt_at,
  };
}

/**
 * 综合检查是否应该发送通知
 */
export async function shouldSendNotification(
  db: D1Database,
  params: {
    clientId: string;
    notificationType: string;
    target: string;
    lastNotifiedAt: string | null | undefined;
    silencePeriodSec: number;
    maxPerDay: number;
    now: Date;
  },
): Promise<{
  allowed: boolean;
  reason?: string;
  aggregatedIncidentKey?: string;
}> {
  const { clientId, notificationType, target, lastNotifiedAt, silencePeriodSec, maxPerDay, now } = params;

  // 检查静默期
  if (isInSilencePeriod(lastNotifiedAt, silencePeriodSec, now)) {
    return {
      allowed: false,
      reason: `在静默期内（${silencePeriodSec}秒）`,
    };
  }

  // 检查每日限制
  const limitCheck = await checkDailyNotificationLimit(db, clientId, notificationType, maxPerDay, now);
  if (!limitCheck.allowed) {
    return {
      allowed: false,
      reason: `已达到每日通知限制（${limitCheck.count}/${maxPerDay}）`,
    };
  }

  // 检查是否应该聚合到现有incident
  const aggregation = await shouldAggregateIncident(db, notificationType, target, clientId);
  if (aggregation.shouldAggregate && aggregation.existingIncidentKey) {
    // 更新现有incident的最后检测时间
    await updateIncidentLastDetected(db, aggregation.existingIncidentKey, now.toISOString());

    // 检查该incident是否最近发送过通知
    const history = await getIncidentNotificationHistory(db, aggregation.existingIncidentKey);
    if (history.lastSentAt) {
      const lastSentMs = new Date(history.lastSentAt).getTime();
      const nowMs = now.getTime();
      const timeSinceLastSent = nowMs - lastSentMs;

      // 如果在静默期内，不再发送
      if (timeSinceLastSent < silencePeriodSec * 1000) {
        return {
          allowed: false,
          reason: 'Incident已聚合且在静默期内',
          aggregatedIncidentKey: aggregation.existingIncidentKey,
        };
      }
    }
  }

  return {
    allowed: true,
    aggregatedIncidentKey: aggregation.existingIncidentKey,
  };
}

/**
 * 记录通知发送尝试（用于审计和统计）
 */
export async function recordNotificationAttempt(
  db: D1Database,
  params: {
    clientId: string;
    notificationType: string;
    target: string;
    success: boolean;
    error?: string;
    attemptedAt: string;
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO notification_deliveries (
      notification_type, channel, status, target, client, attempted_at, sent_at, error
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    params.notificationType,
    'telegram',
    params.success ? 'sent' : 'failed',
    params.target,
    params.clientId,
    params.attemptedAt,
    params.success ? params.attemptedAt : null,
    params.error || null,
  ).run();
}
