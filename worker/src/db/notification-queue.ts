/**
 * 通知队列系统 - 实现失败重试机制
 */

export interface NotificationQueueItem {
  id: number;
  notification_type: string;
  target: string;
  message: string;
  client: string | null;
  rule_id: number | null;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string;
  last_attempt_at: string | null;
  last_error: string | null;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'expired';
  created_at: string;
  updated_at: string;
}

export async function enqueueNotification(
  db: D1Database,
  notification: {
    notification_type: string;
    target: string;
    message: string;
    client?: string | null;
    rule_id?: number | null;
    next_retry_at: string;
    max_attempts?: number;
  },
): Promise<void> {
  await db.prepare(`
    INSERT INTO notification_queue (
      notification_type, target, message, client, rule_id,
      next_retry_at, max_attempts, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).bind(
    notification.notification_type,
    notification.target,
    notification.message,
    notification.client || null,
    notification.rule_id ?? null,
    notification.next_retry_at,
    notification.max_attempts || 5,
  ).run();
}

export async function getPendingNotifications(
  db: D1Database,
  now: string,
  limit = 50,
): Promise<NotificationQueueItem[]> {
  const result = await db.prepare(`
    SELECT * FROM notification_queue
    WHERE status = 'pending' AND next_retry_at <= ?
    ORDER BY next_retry_at ASC
    LIMIT ?
  `).bind(now, limit).all<NotificationQueueItem>();
  return result.results || [];
}

export async function markNotificationProcessing(
  db: D1Database,
  id: number,
): Promise<void> {
  await db.prepare(`
    UPDATE notification_queue
    SET status = 'processing', updated_at = datetime('now')
    WHERE id = ?
  `).bind(id).run();
}

export async function markNotificationSent(
  db: D1Database,
  id: number,
): Promise<void> {
  await db.prepare(`
    UPDATE notification_queue
    SET status = 'sent', updated_at = datetime('now')
    WHERE id = ?
  `).bind(id).run();
}

export async function markNotificationFailed(
  db: D1Database,
  id: number,
  error: string,
  nextRetryAt: string | null,
): Promise<void> {
  if (nextRetryAt) {
    // 还有重试次数，重新排队
    await db.prepare(`
      UPDATE notification_queue
      SET attempt_count = attempt_count + 1,
          last_attempt_at = datetime('now'),
          last_error = ?,
          next_retry_at = ?,
          status = 'pending',
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(error, nextRetryAt, id).run();
  } else {
    // 达到最大重试次数，标记为失败
    await db.prepare(`
      UPDATE notification_queue
      SET attempt_count = attempt_count + 1,
          last_attempt_at = datetime('now'),
          last_error = ?,
          status = 'failed',
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(error, id).run();
  }
}

export async function deleteOldQueueItems(
  db: D1Database,
  before: string,
): Promise<{ deleted: number }> {
  const result = await db.prepare(`
    DELETE FROM notification_queue
    WHERE status IN ('sent', 'failed', 'expired') AND updated_at < ?
  `).bind(before).run();
  return { deleted: result.meta.changes || 0 };
}

/**
 * 计算下次重试时间 - 指数退避策略
 * @param attemptCount 当前尝试次数（0-based）
 * @param baseDelayMs 基础延迟（毫秒），默认60秒
 * @returns ISO时间戳
 */
export function calculateNextRetryTime(attemptCount: number, baseDelayMs = 60000): string {
  // 指数退避：1分钟, 2分钟, 5分钟, 10分钟, 20分钟
  const delays = [baseDelayMs, baseDelayMs * 2, baseDelayMs * 5, baseDelayMs * 10, baseDelayMs * 20];
  const delayMs = delays[Math.min(attemptCount, delays.length - 1)];
  return new Date(Date.now() + delayMs).toISOString();
}

/**
 * 检查是否应该继续重试
 */
export function shouldRetry(attemptCount: number, maxAttempts: number): boolean {
  return attemptCount < maxAttempts;
}
