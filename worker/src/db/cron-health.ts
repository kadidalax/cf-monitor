/**
 * Cron 健康监控系统
 */

export interface CronHealth {
  component: string;
  last_run_at: string;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  total_runs: number;
  total_failures: number;
  updated_at: string;
}

export async function recordCronRun(
  db: D1Database,
  component: string,
  success: boolean,
  error: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();

  if (success) {
    await db.prepare(`
      INSERT INTO cron_health (component, last_run_at, last_success_at, consecutive_failures, total_runs, total_failures, updated_at)
      VALUES (?, ?, ?, 0, 1, 0, ?)
      ON CONFLICT(component) DO UPDATE SET
        last_run_at = excluded.last_run_at,
        last_success_at = excluded.last_success_at,
        consecutive_failures = 0,
        total_runs = total_runs + 1,
        updated_at = excluded.updated_at
    `).bind(component, now, now, now).run();
  } else {
    await db.prepare(`
      INSERT INTO cron_health (component, last_run_at, last_error, consecutive_failures, total_runs, total_failures, updated_at)
      VALUES (?, ?, ?, 1, 1, 1, ?)
      ON CONFLICT(component) DO UPDATE SET
        last_run_at = excluded.last_run_at,
        last_error = excluded.last_error,
        consecutive_failures = consecutive_failures + 1,
        total_runs = total_runs + 1,
        total_failures = total_failures + 1,
        updated_at = excluded.updated_at
    `).bind(component, now, error || 'unknown error', now).run();
  }
}

export async function getCronHealth(db: D1Database): Promise<CronHealth[]> {
  const result = await db.prepare('SELECT * FROM cron_health ORDER BY component').all<CronHealth>();
  return result.results || [];
}

export async function getCronHealthByComponent(db: D1Database, component: string): Promise<CronHealth | null> {
  return db.prepare('SELECT * FROM cron_health WHERE component = ?').bind(component).first<CronHealth>();
}

/**
 * 检查Cron健康状态是否需要告警
 */
export function shouldAlertCronHealth(health: CronHealth, maxConsecutiveFailures = 3): boolean {
  return health.consecutive_failures >= maxConsecutiveFailures;
}

/**
 * 检查Cron是否长时间未运行
 */
export function isCronStale(health: CronHealth, maxStaleMinutes = 15): boolean {
  const lastRunMs = new Date(health.last_run_at).getTime();
  const nowMs = Date.now();
  const staleMs = maxStaleMinutes * 60 * 1000;
  return nowMs - lastRunMs > staleMs;
}
