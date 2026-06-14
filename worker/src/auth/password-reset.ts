/**
 * 密码重置功能
 *
 * 支持两种重置方式：
 * 1. 环境变量紧急重置（适用于管理员忘记密码）
 * 2. 管理员自助修改密码（已登录状态）
 */

import { hashPassword } from './password';

const RESET_TOKEN_BYTES = 32;

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function hashResetToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 检查并执行环境变量密码重置
 *
 * 使用方法：
 * 1. 设置环境变量 RESET_ADMIN_PASSWORD=new_password
 * 2. 重新部署Worker
 * 3. 首次请求会自动重置密码并清除环境变量标记
 */
export async function checkEmergencyPasswordReset(
  db: D1Database,
  env: {
    RESET_ADMIN_PASSWORD?: string;
    ADMIN_USERNAME?: string;
  },
): Promise<boolean> {
  const resetPassword = env.RESET_ADMIN_PASSWORD?.trim();

  if (!resetPassword) {
    return false;
  }

  try {
    const username = env.ADMIN_USERNAME?.trim() || 'admin';

    // 验证新密码强度
    const passwordError = validatePasswordStrength(resetPassword);
    if (passwordError) {
      console.error('[password-reset] Invalid password:', passwordError);
      return false;
    }

    // 获取管理员账户
    const user = await db.prepare('SELECT uuid, username FROM users WHERE username = ? LIMIT 1')
      .bind(username)
      .first<{ uuid: string; username: string }>();

    if (!user) {
      console.error('[password-reset] Admin user not found:', username);
      return false;
    }

    // 重置密码
    const hashedPassword = await hashPassword(resetPassword);
    const now = new Date().toISOString();

    await db.prepare(`
      UPDATE users
      SET passwd = ?,
          session_version = session_version + 1,
          updated_at = ?
      WHERE uuid = ?
    `).bind(hashedPassword, now, user.uuid).run();

    // 记录审计日志
    await db.prepare(`
      INSERT INTO audit_logs (time, user, action, detail, level)
      VALUES (?, ?, ?, ?, ?)
    `).bind(now, user.username, 'emergency_password_reset', '通过环境变量紧急重置密码', 'warning').run();

    console.log(`[password-reset] Password reset successfully for user: ${user.username}`);
    console.log('[password-reset] IMPORTANT: Remove RESET_ADMIN_PASSWORD environment variable!');

    return true;
  } catch (error) {
    console.error('[password-reset] Emergency password reset failed:', error);
    return false;
  }
}

/**
 * 验证密码强度
 */
export function validatePasswordStrength(password: string): string | null {
  if (!password || password.length < 8) {
    return '密码至少需要8个字符';
  }

  if (password.length > 128) {
    return '密码不能超过128个字符';
  }

  // 检查是否包含至少3种类型的字符
  let types = 0;
  if (/[a-z]/.test(password)) types++;
  if (/[A-Z]/.test(password)) types++;
  if (/[0-9]/.test(password)) types++;
  if (/[^a-zA-Z0-9]/.test(password)) types++;

  if (types < 3) {
    return '密码必须包含至少3种类型的字符（小写字母、大写字母、数字、特殊符号）';
  }

  // 检查常见弱密码
  const weakPasswords = [
    'password', '12345678', 'admin123', 'qwerty123',
    'password123', 'admin@123', '123456789'
  ];

  if (weakPasswords.includes(password.toLowerCase())) {
    return '密码过于简单，请使用更强的密码';
  }

  return null;
}

/**
 * 生成密码重置令牌（用于未来的邮箱重置功能）
 */
export function generateResetToken(): string {
  return `rst_${randomHex(RESET_TOKEN_BYTES)}`;
}

/**
 * 密码重置令牌管理（预留接口）
 */
export interface PasswordResetToken {
  tokenHash: string;
  userId: string;
  email: string;
  expiresAt: string;
  used: boolean;
}

/**
 * 创建密码重置令牌（预留）
 */
export async function createPasswordResetToken(
  db: D1Database,
  userId: string,
  email: string,
  validityMinutes = 30,
): Promise<string> {
  const token = generateResetToken();
  const tokenHash = await hashResetToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + validityMinutes * 60 * 1000).toISOString();

  await db.prepare(`
    INSERT INTO password_reset_tokens (token_hash, user_id, email, expires_at, used, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).bind(tokenHash, userId, email, expiresAt, now.toISOString(), now.toISOString()).run();

  return token;
}

/**
 * 验证密码重置令牌（预留）
 */
export async function verifyPasswordResetToken(
  db: D1Database,
  token: string,
): Promise<{ valid: boolean; userId?: string; error?: string }> {
  const tokenHash = await hashResetToken(token);
  const result = await db.prepare(`
    SELECT user_id, expires_at, used
    FROM password_reset_tokens
    WHERE token_hash = ?
  `).bind(tokenHash).first<{ user_id: string; expires_at: string; used: number }>();

  if (!result) {
    return { valid: false, error: '无效的重置令牌' };
  }

  if (result.used) {
    return { valid: false, error: '重置令牌已使用' };
  }

  const expiresAt = new Date(result.expires_at).getTime();
  const now = Date.now();

  if (now > expiresAt) {
    return { valid: false, error: '重置令牌已过期' };
  }

  return { valid: true, userId: result.user_id };
}

/**
 * 标记令牌为已使用（预留）
 */
export async function markTokenAsUsed(
  db: D1Database,
  token: string,
): Promise<void> {
  const tokenHash = await hashResetToken(token);
  await db.prepare(`
    UPDATE password_reset_tokens
    SET used = 1, updated_at = datetime('now')
    WHERE token_hash = ?
  `).bind(tokenHash).run();
}

/**
 * 清理过期的重置令牌（预留）
 */
export async function cleanupExpiredResetTokens(
  db: D1Database,
): Promise<number> {
  const result = await db.prepare(`
    DELETE FROM password_reset_tokens
    WHERE expires_at < datetime('now')
       OR (used = 1 AND updated_at < datetime('now', '-7 days'))
  `).run();

  return result.meta.changes || 0;
}
