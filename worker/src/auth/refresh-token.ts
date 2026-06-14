/**
 * JWT Refresh Token 机制
 *
 * 实现方案：
 * - Access Token: 1小时有效期，用于API请求
 * - Refresh Token: 30天有效期，用于刷新Access Token
 * - Token黑名单: 使用D1存储已撤销的token
 */

import { sign, verify } from 'hono/jwt';

const MIN_JWT_SECRET_BYTES = 32;
export const ACCESS_TOKEN_EXPIRY_SEC = 60 * 60; // 1小时
export const REFRESH_TOKEN_EXPIRY_SEC = 30 * 24 * 60 * 60; // 30天

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigurationError';
  }
}

type JwtEnv = {
  JWT_SECRET?: string;
};

export function requireJwtSecret(env: JwtEnv): string {
  const secret = env.JWT_SECRET?.trim() ?? '';
  const secretBytes = new TextEncoder().encode(secret).byteLength;

  if (secretBytes < MIN_JWT_SECRET_BYTES) {
    throw new AuthConfigurationError('JWT_SECRET must be at least 32 bytes');
  }

  return secret;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
}

export interface AccessTokenPayload {
  [key: string]: unknown;
  userId: string;
  username: string;
  sessionVersion: number;
  type: 'access';
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  [key: string]: unknown;
  userId: string;
  username: string;
  sessionVersion: number;
  type: 'refresh';
  jti: string; // JWT ID for blacklist
  iat?: number;
  exp?: number;
}

/**
 * 生成Access Token和Refresh Token对
 */
export async function generateTokenPair(
  userId: string,
  username: string,
  secret: string,
  sessionVersion = 0,
): Promise<TokenPair> {
  const now = Math.floor(Date.now() / 1000);
  const jti = generateJti();

  const accessPayload: AccessTokenPayload = {
    userId,
    username,
    sessionVersion,
    type: 'access',
    iat: now,
    exp: now + ACCESS_TOKEN_EXPIRY_SEC,
  };

  const refreshPayload: RefreshTokenPayload = {
    userId,
    username,
    sessionVersion,
    type: 'refresh',
    jti,
    iat: now,
    exp: now + REFRESH_TOKEN_EXPIRY_SEC,
  };

  const accessToken = await sign(accessPayload, secret, 'HS256');
  const refreshToken = await sign(refreshPayload, secret, 'HS256');

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: now + ACCESS_TOKEN_EXPIRY_SEC,
    refreshTokenExpiresAt: now + REFRESH_TOKEN_EXPIRY_SEC,
  };
}

/**
 * 验证Access Token
 */
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload | null> {
  try {
    const payload = await verify(token, secret, 'HS256');

    if (
      !payload ||
      payload.type !== 'access' ||
      typeof payload.userId !== 'string' ||
      typeof payload.username !== 'string'
    ) {
      return null;
    }

    return {
      userId: payload.userId,
      username: payload.username,
      sessionVersion: typeof payload.sessionVersion === 'number' ? payload.sessionVersion : 0,
      type: 'access',
    };
  } catch {
    return null;
  }
}

/**
 * 验证Refresh Token
 */
export async function verifyRefreshToken(
  token: string,
  secret: string,
): Promise<RefreshTokenPayload | null> {
  try {
    const payload = await verify(token, secret, 'HS256');

    if (
      !payload ||
      payload.type !== 'refresh' ||
      typeof payload.userId !== 'string' ||
      typeof payload.username !== 'string' ||
      typeof payload.jti !== 'string'
    ) {
      return null;
    }

    return {
      userId: payload.userId,
      username: payload.username,
      sessionVersion: typeof payload.sessionVersion === 'number' ? payload.sessionVersion : 0,
      type: 'refresh',
      jti: payload.jti,
    };
  } catch {
    return null;
  }
}

/**
 * 生成唯一JWT ID
 */
function generateJti(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 15);
  return `${timestamp}-${random}`;
}

/**
 * Token黑名单管理（使用D1数据库）
 */

export interface TokenBlacklist {
  jti: string;
  userId: string;
  revokedAt: string;
  expiresAt: string;
  reason: string;
}

/**
 * 将Token加入黑名单
 */
export async function blacklistToken(
  db: D1Database,
  jti: string,
  userId: string,
  expiresAt: number,
  reason: string,
): Promise<void> {
  const now = new Date().toISOString();
  const expiry = new Date(expiresAt * 1000).toISOString();

  await db.prepare(`
    INSERT INTO token_blacklist (jti, user_id, revoked_at, expires_at, reason)
    VALUES (?, ?, ?, ?, ?)
  `).bind(jti, userId, now, expiry, reason).run();
}

/**
 * 检查Token是否在黑名单中
 */
export async function isTokenBlacklisted(
  db: D1Database,
  jti: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await db.prepare(`
    SELECT 1 FROM token_blacklist
    WHERE jti = ? AND expires_at > ?
  `).bind(jti, now).first();

  return !!result;
}

/**
 * 清理过期的黑名单记录
 */
export async function cleanupExpiredBlacklist(
  db: D1Database,
): Promise<number> {
  const now = new Date().toISOString();
  const result = await db.prepare(`
    DELETE FROM token_blacklist
    WHERE expires_at <= ?
  `).bind(now).run();

  return result.meta.changes || 0;
}

/**
 * 撤销用户的所有Refresh Token
 */
export async function revokeAllUserTokens(
  db: D1Database,
  userId: string,
): Promise<void> {
  const now = new Date().toISOString();

  // 通过增加sessionVersion来使所有现有token失效
  await db.prepare(`
    UPDATE users
    SET session_version = session_version + 1,
        updated_at = ?
    WHERE uuid = ?
  `).bind(now, userId).run();
}

/**
 * 滑动过期时间策略（可选）
 * 如果access token还有超过一半的有效期，则不刷新
 */
export function shouldRefreshAccessToken(expiresAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  const remaining = expiresAt - now;
  const halfLife = ACCESS_TOKEN_EXPIRY_SEC / 2;

  return remaining < halfLife;
}
