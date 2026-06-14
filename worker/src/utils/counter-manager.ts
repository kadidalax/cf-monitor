/**
 * 历史表计数器管理工具
 *
 * 用于验证和修复 history_row_counters 表的计数准确性
 */

import type { D1Database } from '@cloudflare/workers-types';
import { getHistoryStorageRowCounts, getHistoryStorageRowCountsFast } from '../db/queries';

export interface CounterVerificationResult {
  table: string;
  counter_value: number;
  actual_value: number;
  diff: number;
  accurate: boolean;
}

/**
 * 验证计数器准确性
 */
export async function verifyCounters(db: D1Database): Promise<{
  accurate: boolean;
  results: CounterVerificationResult[];
  total_diff: number;
}> {
  const [counterCounts, actualCounts] = await Promise.all([
    getHistoryStorageRowCountsFast(db),
    getHistoryStorageRowCounts(db),
  ]);

  const tables = ['records', 'gpu_records', 'gpu_snapshots', 'ping_records', 'ping_snapshots'] as const;
  const results: CounterVerificationResult[] = [];
  let totalDiff = 0;

  for (const table of tables) {
    const counterValue = counterCounts[table];
    const actualValue = actualCounts[table];
    const diff = Math.abs(counterValue - actualValue);
    totalDiff += diff;

    results.push({
      table,
      counter_value: counterValue,
      actual_value: actualValue,
      diff,
      accurate: diff === 0,
    });
  }

  return {
    accurate: totalDiff === 0,
    results,
    total_diff: totalDiff,
  };
}

/**
 * 修复计数器（使用实际 COUNT(*) 值）
 */
export async function repairCounters(db: D1Database): Promise<{
  success: boolean;
  updated: number;
  results: CounterVerificationResult[];
}> {
  const verification = await verifyCounters(db);

  if (verification.accurate) {
    return {
      success: true,
      updated: 0,
      results: verification.results,
    };
  }

  // 更新所有不准确的计数
  let updated = 0;
  for (const result of verification.results) {
    if (!result.accurate) {
      await db.prepare(
        'UPDATE history_row_counters SET row_count = ?, updated_at = datetime(\'now\') WHERE table_name = ?'
      )
        .bind(result.actual_value, result.table)
        .run();
      updated++;
    }
  }

  // 重新验证
  const afterRepair = await verifyCounters(db);

  return {
    success: afterRepair.accurate,
    updated,
    results: afterRepair.results,
  };
}

/**
 * 获取计数器状态
 */
export async function getCounterStatus(db: D1Database): Promise<{
  counters: Array<{
    table_name: string;
    row_count: number;
    updated_at: string;
  }>;
  last_update: string | null;
}> {
  const rows = await db.prepare(
    'SELECT table_name, row_count, updated_at FROM history_row_counters ORDER BY table_name'
  ).all<{ table_name: string; row_count: number; updated_at: string }>();

  const lastUpdate = rows.results.length > 0
    ? rows.results.reduce((latest, row) => {
        return row.updated_at > latest ? row.updated_at : latest;
      }, rows.results[0].updated_at)
    : null;

  return {
    counters: rows.results,
    last_update: lastUpdate,
  };
}
