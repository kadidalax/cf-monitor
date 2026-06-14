/**
 * 负载通知优化
 *
 * 功能：
 * 1. 连续超标N次才告警（防止抖动）
 * 2. 多级阈值（警告、严重）
 * 3. 样本不足检测
 */

export interface LoadThreshold {
  level: 'warning' | 'critical';
  percentage: number;
  consecutiveCount: number; // 连续超标次数
}

export interface LoadCheckState {
  clientId: string;
  metric: 'cpu' | 'memory' | 'disk';
  consecutiveBreaches: number;
  lastCheckAt: string;
  lastBreachValue?: number;
}

/**
 * 默认阈值配置
 */
export const DEFAULT_LOAD_THRESHOLDS: Record<string, LoadThreshold[]> = {
  cpu: [
    { level: 'warning', percentage: 70, consecutiveCount: 3 },
    { level: 'critical', percentage: 90, consecutiveCount: 2 },
  ],
  memory: [
    { level: 'warning', percentage: 75, consecutiveCount: 3 },
    { level: 'critical', percentage: 90, consecutiveCount: 2 },
  ],
  disk: [
    { level: 'warning', percentage: 80, consecutiveCount: 3 },
    { level: 'critical', percentage: 95, consecutiveCount: 2 },
  ],
};

/**
 * 检查是否应该发送负载告警
 */
export async function shouldSendLoadAlert(
  db: D1Database,
  clientId: string,
  metric: 'cpu' | 'memory' | 'disk',
  currentValue: number,
  thresholds: LoadThreshold[] = DEFAULT_LOAD_THRESHOLDS[metric],
): Promise<{
  shouldAlert: boolean;
  level?: 'warning' | 'critical';
  consecutiveBreaches?: number;
  threshold?: number;
}> {
  // 检查当前值是否超过任何阈值
  const breachedThreshold = thresholds
    .sort((a, b) => b.percentage - a.percentage) // 从高到低排序
    .find(t => currentValue >= t.percentage);

  if (!breachedThreshold) {
    // 未超标，重置计数器
    await resetLoadCheckState(db, clientId, metric);
    return { shouldAlert: false };
  }

  // 获取当前状态
  const state = await getLoadCheckState(db, clientId, metric);

  const newConsecutiveBreaches = (state?.consecutiveBreaches || 0) + 1;

  // 更新状态
  await updateLoadCheckState(db, {
    clientId,
    metric,
    consecutiveBreaches: newConsecutiveBreaches,
    lastCheckAt: new Date().toISOString(),
    lastBreachValue: currentValue,
  });

  // 判断是否达到告警条件
  if (newConsecutiveBreaches >= breachedThreshold.consecutiveCount) {
    return {
      shouldAlert: true,
      level: breachedThreshold.level,
      consecutiveBreaches: newConsecutiveBreaches,
      threshold: breachedThreshold.percentage,
    };
  }

  return {
    shouldAlert: false,
    consecutiveBreaches: newConsecutiveBreaches,
  };
}

/**
 * 获取负载检查状态
 */
async function getLoadCheckState(
  db: D1Database,
  clientId: string,
  metric: string,
): Promise<LoadCheckState | null> {
  const result = await db.prepare(`
    SELECT client_id, metric, consecutive_breaches, last_check_at, last_breach_value
    FROM load_check_states
    WHERE client_id = ? AND metric = ?
  `).bind(clientId, metric).first<{
    client_id: string;
    metric: string;
    consecutive_breaches: number;
    last_check_at: string;
    last_breach_value: number;
  }>();

  if (!result) return null;

  return {
    clientId: result.client_id,
    metric: result.metric as 'cpu' | 'memory' | 'disk',
    consecutiveBreaches: result.consecutive_breaches,
    lastCheckAt: result.last_check_at,
    lastBreachValue: result.last_breach_value,
  };
}

/**
 * 更新负载检查状态
 */
async function updateLoadCheckState(
  db: D1Database,
  state: LoadCheckState,
): Promise<void> {
  await db.prepare(`
    INSERT INTO load_check_states (
      client_id, metric, consecutive_breaches, last_check_at, last_breach_value, updated_at
    ) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(client_id, metric) DO UPDATE SET
      consecutive_breaches = excluded.consecutive_breaches,
      last_check_at = excluded.last_check_at,
      last_breach_value = excluded.last_breach_value,
      updated_at = datetime('now')
  `).bind(
    state.clientId,
    state.metric,
    state.consecutiveBreaches,
    state.lastCheckAt,
    state.lastBreachValue || null,
  ).run();
}

/**
 * 重置负载检查状态
 */
async function resetLoadCheckState(
  db: D1Database,
  clientId: string,
  metric: string,
): Promise<void> {
  await db.prepare(`
    DELETE FROM load_check_states
    WHERE client_id = ? AND metric = ?
  `).bind(clientId, metric).run();
}

/**
 * 检查样本数是否充足
 */
export function isSampleSufficient(
  sampleCount: number,
  minRequired = 2,
): { sufficient: boolean; message?: string } {
  if (sampleCount < minRequired) {
    return {
      sufficient: false,
      message: `样本数不足(${sampleCount}/${minRequired})，跳过检测`,
    };
  }

  return { sufficient: true };
}

/**
 * 清理过期的负载检查状态
 */
export async function cleanupLoadCheckStates(
  db: D1Database,
  retentionDays = 7,
): Promise<number> {
  const result = await db.prepare(`
    DELETE FROM load_check_states
    WHERE last_check_at < datetime('now', '-' || ? || ' days')
  `).bind(retentionDays).run();

  return result.meta.changes || 0;
}
