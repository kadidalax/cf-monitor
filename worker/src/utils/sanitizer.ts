/**
 * 日志和审计记录脱敏工具
 * 自动清除敏感信息，防止泄露
 */

// 敏感字段列表
const SENSITIVE_FIELD_NAMES = [
  'password',
  'passwd',
  'token',
  'secret',
  'key',
  'telegram_bot_token',
  'telegram_chat_id',
  'api_key',
  'auth_token',
  'bearer',
  'authorization',
] as const;

// 敏感字段值的正则匹配
const SENSITIVE_PATTERNS = [
  // JWT Token
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // UUID
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  // Telegram Bot Token
  /\d{8,10}:[A-Za-z0-9_-]{35}/g,
  // Base64 strings (>= 20 chars)
  /(?:[A-Za-z0-9+/]{4}){5,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?/g,
] as const;

/**
 * 脱敏字符串中的敏感信息
 */
export function sanitizeString(input: string): string {
  if (!input || typeof input !== 'string') return input;

  let sanitized = input;

  // 替换已知的敏感模式
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // 保留前4个字符，其余用*代替
      if (match.length <= 8) return '[REDACTED]';
      const prefix = match.slice(0, 4);
      const suffix = match.slice(-4);
      const middle = '*'.repeat(Math.min(match.length - 8, 16));
      return `${prefix}${middle}${suffix}`;
    });
  }

  return sanitized;
}

/**
 * 脱敏对象中的敏感字段
 */
export function sanitizeObject<T extends Record<string, any>>(obj: T): T {
  if (!obj || typeof obj !== 'object') return obj;

  const sanitized: Record<string, any> = { ...obj };

  for (const [key, value] of Object.entries(sanitized)) {
    const keyLower = key.toLowerCase();

    // 检查字段名是否敏感
    const isSensitiveField = SENSITIVE_FIELD_NAMES.some(sensitive =>
      keyLower.includes(sensitive)
    );

    if (isSensitiveField) {
      // 完全隐藏敏感字段值
      if (typeof value === 'string' && value) {
        sanitized[key] = '[REDACTED]' as any;
      } else if (value) {
        sanitized[key] = '[REDACTED]' as any;
      }
    } else if (typeof value === 'string') {
      // 脱敏字符串值中可能包含的敏感信息
      sanitized[key] = sanitizeString(value) as any;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // 递归处理嵌套对象
      sanitized[key] = sanitizeObject(value);
    } else if (Array.isArray(value)) {
      // 处理数组
      sanitized[key] = value.map(item =>
        typeof item === 'object' && item ? sanitizeObject(item) : item
      ) as any;
    }
  }

  return sanitized as T;
}

/**
 * 脱敏日志消息
 */
export function sanitizeLogMessage(message: string): string {
  return sanitizeString(message);
}

/**
 * 脱敏错误堆栈
 */
export function sanitizeError(error: Error | unknown): string {
  if (!error) return 'Unknown error';

  if (error instanceof Error) {
    let message = error.message || 'Unknown error';
    message = sanitizeString(message);

    // 不包含完整堆栈，避免泄露敏感信息
    return message;
  }

  const stringified = String(error);
  return sanitizeString(stringified);
}

/**
 * 安全地序列化对象为JSON（自动脱敏）
 */
export function safeStringify(obj: any): string {
  try {
    const sanitized = sanitizeObject(obj);
    return JSON.stringify(sanitized);
  } catch (error) {
    return '[Serialization Error]';
  }
}

/**
 * 检查字符串是否可能包含敏感信息
 */
export function containsSensitiveData(input: string): boolean {
  if (!input || typeof input !== 'string') return false;

  return SENSITIVE_PATTERNS.some(pattern => {
    pattern.lastIndex = 0; // 重置正则状态
    return pattern.test(input);
  });
}

/**
 * 为审计日志脱敏详情字段
 */
export function sanitizeAuditDetail(detail: string): string {
  try {
    // 尝试解析为JSON
    const parsed = JSON.parse(detail);
    if (typeof parsed === 'object' && parsed !== null) {
      return safeStringify(parsed);
    }
  } catch {
    // 不是JSON，直接脱敏字符串
  }

  return sanitizeLogMessage(detail);
}
