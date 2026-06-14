/**
 * IP变更通知去重
 *
 * 功能：
 * 1. IP变更最小通知间隔
 * 2. IP变更历史记录
 * 3. IP白名单支持
 */

export interface IpChangeRecord {
  clientId: string;
  oldIpv4?: string;
  newIpv4?: string;
  oldIpv6?: string;
  newIpv6?: string;
  changedAt: string;
  notified: boolean;
}

/**
 * 检查是否应该发送IP变更通知
 */
export async function shouldNotifyIpChange(
  db: D1Database,
  clientId: string,
  minIntervalSec = 600, // 默认10分钟
): Promise<{ allowed: boolean; reason?: string; lastNotifiedAt?: string }> {
  // 查询最近一次IP变更通知时间
  const lastNotification = await db.prepare(`
    SELECT attempted_at
    FROM notification_deliveries
    WHERE client = ?
      AND notification_type = 'ip_change'
      AND status = 'sent'
    ORDER BY attempted_at DESC
    LIMIT 1
  `).bind(clientId).first<{ attempted_at: string }>();

  if (!lastNotification) {
    return { allowed: true };
  }

  const lastNotifiedMs = new Date(lastNotification.attempted_at).getTime();
  const nowMs = Date.now();
  const elapsedSec = (nowMs - lastNotifiedMs) / 1000;

  if (elapsedSec < minIntervalSec) {
    return {
      allowed: false,
      reason: `距离上次通知仅${Math.floor(elapsedSec)}秒，最小间隔${minIntervalSec}秒`,
      lastNotifiedAt: lastNotification.attempted_at,
    };
  }

  return {
    allowed: true,
    lastNotifiedAt: lastNotification.attempted_at,
  };
}

/**
 * 记录IP变更历史
 */
export async function recordIpChange(
  db: D1Database,
  record: IpChangeRecord,
): Promise<void> {
  await db.prepare(`
    INSERT INTO ip_change_history (
      client_id, old_ipv4, new_ipv4, old_ipv6, new_ipv6,
      changed_at, notified, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(
    record.clientId,
    record.oldIpv4 || null,
    record.newIpv4 || null,
    record.oldIpv6 || null,
    record.newIpv6 || null,
    record.changedAt,
    record.notified ? 1 : 0,
  ).run();
}

/**
 * 获取IP变更历史
 */
export async function getIpChangeHistory(
  db: D1Database,
  clientId: string,
  limit = 10,
): Promise<IpChangeRecord[]> {
  const results = await db.prepare(`
    SELECT
      client_id,
      old_ipv4,
      new_ipv4,
      old_ipv6,
      new_ipv6,
      changed_at,
      notified
    FROM ip_change_history
    WHERE client_id = ?
    ORDER BY changed_at DESC
    LIMIT ?
  `).bind(clientId, limit).all();

  return results.results?.map((row: any) => ({
    clientId: row.client_id,
    oldIpv4: row.old_ipv4,
    newIpv4: row.new_ipv4,
    oldIpv6: row.old_ipv6,
    newIpv6: row.new_ipv6,
    changedAt: row.changed_at,
    notified: row.notified === 1,
  })) || [];
}

/**
 * 检查IP是否在白名单中
 */
export function isIpInWhitelist(
  ip: string,
  whitelist: string[],
): boolean {
  if (!ip || !whitelist || whitelist.length === 0) {
    return false;
  }

  for (const whitelistedIp of whitelist) {
    // 支持CIDR格式
    if (whitelistedIp.includes('/')) {
      if (isIpInCidr(ip, whitelistedIp)) {
        return true;
      }
    } else {
      // 精确匹配
      if (ip === whitelistedIp) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 检查IP是否在CIDR范围内（简化版）
 */
function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    const [network, prefixLength] = cidr.split('/');
    const prefix = parseInt(prefixLength, 10);

    // 只支持IPv4的简单检查
    if (ip.includes(':') || network.includes(':')) {
      // IPv6暂不支持
      return false;
    }

    const ipParts = ip.split('.').map(Number);
    const networkParts = network.split('.').map(Number);

    // 计算需要匹配的字节数
    const bytesToMatch = Math.floor(prefix / 8);
    const bitsInLastByte = prefix % 8;

    // 检查完整字节
    for (let i = 0; i < bytesToMatch; i++) {
      if (ipParts[i] !== networkParts[i]) {
        return false;
      }
    }

    // 检查最后一个字节的部分位
    if (bitsInLastByte > 0) {
      const mask = (0xFF << (8 - bitsInLastByte)) & 0xFF;
      if ((ipParts[bytesToMatch] & mask) !== (networkParts[bytesToMatch] & mask)) {
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error('[ip-whitelist] CIDR check error:', error);
    return false;
  }
}

/**
 * 清理旧的IP变更历史
 */
export async function cleanupIpChangeHistory(
  db: D1Database,
  retentionDays = 30,
): Promise<number> {
  const result = await db.prepare(`
    DELETE FROM ip_change_history
    WHERE changed_at < datetime('now', '-' || ? || ' days')
  `).bind(retentionDays).run();

  return result.meta.changes || 0;
}
