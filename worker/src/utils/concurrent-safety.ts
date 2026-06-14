/**
 * D1数据库并发安全工具
 *
 * 功能：
 * 1. 乐观锁检查（基于updated_at）
 * 2. 原子操作封装
 * 3. 并发更新检测
 */

const D1_BATCH_SAFE_STATEMENT_LIMIT = 900;

export class OptimisticLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptimisticLockError';
  }
}

/**
 * 使用乐观锁更新记录
 *
 * @param db D1数据库实例
 * @param table 表名
 * @param id 记录ID
 * @param updates 要更新的字段
 * @param expectedVersion 期望的updated_at版本
 * @returns 是否更新成功
 */
export async function updateWithOptimisticLock(
  db: D1Database,
  table: string,
  id: string,
  updates: Record<string, any>,
  expectedVersion: string | null,
): Promise<{ success: boolean; newVersion: string }> {
  const now = new Date().toISOString();

  // 构建SET子句
  const setClause = Object.keys(updates)
    .map(key => `${key} = ?`)
    .join(', ');

  const values = [...Object.values(updates), now];

  // 如果提供了expectedVersion，使用乐观锁
  let query: string;
  let params: any[];

  if (expectedVersion !== null) {
    query = `
      UPDATE ${table}
      SET ${setClause}, updated_at = ?
      WHERE uuid = ? AND updated_at = ?
    `;
    params = [...values, id, expectedVersion];
  } else {
    query = `
      UPDATE ${table}
      SET ${setClause}, updated_at = ?
      WHERE uuid = ?
    `;
    params = [...values, id];
  }

  const result = await db.prepare(query).bind(...params).run();

  if (result.meta.changes === 0) {
    if (expectedVersion !== null) {
      throw new OptimisticLockError(
        `Record was modified by another process. Expected version: ${expectedVersion}`
      );
    }
    return { success: false, newVersion: '' };
  }

  return { success: true, newVersion: now };
}

/**
 * 原子递增计数器
 */
export async function atomicIncrement(
  db: D1Database,
  table: string,
  id: string,
  field: string,
  amount = 1,
): Promise<number> {
  const result = await db.prepare(`
    UPDATE ${table}
    SET ${field} = ${field} + ?,
        updated_at = datetime('now')
    WHERE uuid = ?
    RETURNING ${field}
  `).bind(amount, id).first<{ [key: string]: number }>();

  return result?.[field] ?? 0;
}

/**
 * 带重试的乐观锁更新
 */
export async function updateWithRetry<T>(
  db: D1Database,
  operation: () => Promise<T>,
  maxRetries = 3,
  retryDelay = 100,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof OptimisticLockError) {
        lastError = error;

        // 等待一段时间后重试
        await new Promise(resolve =>
          setTimeout(resolve, retryDelay * (attempt + 1))
        );
        continue;
      }

      // 非乐观锁错误，直接抛出
      throw error;
    }
  }

  throw lastError || new Error('Update failed after retries');
}

/**
 * 检查记录是否被修改
 */
export async function isRecordModified(
  db: D1Database,
  table: string,
  id: string,
  expectedVersion: string,
): Promise<boolean> {
  const result = await db.prepare(`
    SELECT updated_at
    FROM ${table}
    WHERE uuid = ?
  `).bind(id).first<{ updated_at: string }>();

  if (!result) {
    return true; // 记录不存在
  }

  return result.updated_at !== expectedVersion;
}

/**
 * 幂等性检查：使用唯一索引防止重复插入
 */
export async function insertIdempotent(
  db: D1Database,
  table: string,
  data: Record<string, any>,
  uniqueKey: string,
): Promise<{ success: boolean; isDuplicate: boolean; id?: string }> {
  try {
    const columns = Object.keys(data).join(', ');
    const placeholders = Object.keys(data).map(() => '?').join(', ');
    const values = Object.values(data);

    const result = await db.prepare(`
      INSERT INTO ${table} (${columns})
      VALUES (${placeholders})
      ON CONFLICT(${uniqueKey}) DO NOTHING
      RETURNING uuid
    `).bind(...values).first<{ uuid: string }>();

    if (result) {
      return { success: true, isDuplicate: false, id: result.uuid };
    } else {
      // 冲突，获取现有记录
      const existing = await db.prepare(`
        SELECT uuid FROM ${table}
        WHERE ${uniqueKey} = ?
      `).bind(data[uniqueKey]).first<{ uuid: string }>();

      return {
        success: true,
        isDuplicate: true,
        id: existing?.uuid
      };
    }
  } catch (error) {
    return { success: false, isDuplicate: false };
  }
}

/**
 * 事务辅助函数（D1不支持真正的事务，但可以批量操作）
 */
export async function batchOperations(
  db: D1Database,
  operations: Array<{ sql: string; params: any[] }>,
): Promise<boolean> {
  try {
    if (operations.length > D1_BATCH_SAFE_STATEMENT_LIMIT) {
      throw new Error(`batchOperations would execute ${operations.length} D1 statements in one batch`);
    }

    const statements = operations.map(op =>
      db.prepare(op.sql).bind(...op.params)
    );

    await db.batch(statements);
    return true;
  } catch (error) {
    console.error('[batch-operations] Failed:', error);
    return false;
  }
}

/**
 * 读取-修改-写入模式（带版本检查）
 */
export async function readModifyWrite<T>(
  db: D1Database,
  table: string,
  id: string,
  modifier: (current: T) => Partial<T>,
): Promise<T> {
  // 读取当前值和版本
  const current = await db.prepare(`
    SELECT * FROM ${table} WHERE uuid = ?
  `).bind(id).first<T & { updated_at: string }>();

  if (!current) {
    throw new Error(`Record not found: ${id}`);
  }

  const currentVersion = current.updated_at;

  // 修改数据
  const updates = modifier(current);

  // 使用乐观锁写入
  const result = await updateWithOptimisticLock(
    db,
    table,
    id,
    updates,
    currentVersion,
  );

  if (!result.success) {
    throw new OptimisticLockError('Record was modified during read-modify-write');
  }

  return { ...current, ...updates };
}
