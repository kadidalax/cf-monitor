/**
 * 统一错误处理工具
 * 用于显示用户友好的错误提示
 */

import { toast } from 'sonner';

/**
 * API 错误类
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 错误消息映射
 */
const ERROR_MESSAGES: Record<number, string> = {
  400: '请求参数错误',
  401: '未授权，请重新登录',
  403: '权限不足',
  404: '资源不存在',
  409: '操作冲突',
  429: '请求过于频繁，请稍后重试',
  500: '服务器错误，请稍后重试',
  502: '网关错误',
  503: '服务暂时不可用',
};

/**
 * 获取友好的错误消息
 */
function getFriendlyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message || ERROR_MESSAGES[error.status] || '操作失败';
  }

  if (error instanceof Error) {
    // 处理网络错误
    if (error.message.includes('Failed to fetch')) {
      return '网络连接失败，请检查网络设置';
    }
    if (error.message.includes('timeout')) {
      return '请求超时，请重试';
    }
    return error.message;
  }

  return '未知错误';
}

/**
 * 处理 API 错误并显示 toast
 */
export function handleApiError(error: unknown, customMessage?: string): void {
  const message = customMessage || getFriendlyErrorMessage(error);
  toast.error(message);

  // 开发环境打印详细错误
  if (import.meta.env.DEV) {
    console.error('[API Error]', error);
  }
}
