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
