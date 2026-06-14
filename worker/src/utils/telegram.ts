/**
 * Telegram HTML模式转义
 *
 * 支持的HTML标签: <b>, <i>, <u>, <s>, <code>, <pre>, <a>
 * 需要转义的字符: &, <, >
 */
export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Telegram MarkdownV2模式转义
 *
 * 需要转义的特殊字符: _*[]()~`>#+-=|{}.!
 */
export function escapeTelegramMarkdown(value: unknown): string {
  return String(value ?? '')
    .replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
}

/**
 * 安全构建Telegram消息
 *
 * 自动转义所有动态内容，防止注入攻击
 */
export function buildTelegramMessage(
  template: string,
  variables: Record<string, any>,
  mode: 'HTML' | 'MarkdownV2' = 'HTML',
): string {
  const escape = mode === 'HTML' ? escapeTelegramHtml : escapeTelegramMarkdown;

  let message = template;
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{${key}}`;
    const escapedValue = escape(value);
    message = message.replace(new RegExp(placeholder, 'g'), escapedValue);
  }

  return message;
}

/**
 * 验证Telegram消息长度
 *
 * Telegram消息最大长度: 4096字符
 */
export function validateTelegramMessageLength(message: string): {
  valid: boolean;
  length: number;
  maxLength: number;
  error?: string;
} {
  const MAX_LENGTH = 4096;
  const length = message.length;

  if (length > MAX_LENGTH) {
    return {
      valid: false,
      length,
      maxLength: MAX_LENGTH,
      error: `消息长度${length}超过Telegram限制${MAX_LENGTH}`,
    };
  }

  return {
    valid: true,
    length,
    maxLength: MAX_LENGTH,
  };
}

/**
 * 截断过长的Telegram消息
 */
export function truncateTelegramMessage(
  message: string,
  maxLength = 4096,
  suffix = '...',
): string {
  if (message.length <= maxLength) {
    return message;
  }

  const truncateAt = maxLength - suffix.length;
  return message.substring(0, truncateAt) + suffix;
}
