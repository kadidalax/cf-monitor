/**
 * HTTP请求增强工具
 *
 * 功能：
 * - 请求超时控制
 * - 自动重试
 * - 请求取消
 * - 错误处理
 */

export interface RequestOptions extends RequestInit {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

export class RequestTimeoutError extends Error {
  constructor(timeout: number) {
    super(`Request timeout after ${timeout}ms`);
    this.name = 'RequestTimeoutError';
  }
}

export class RequestAbortedError extends Error {
  constructor() {
    super('Request was aborted');
    this.name = 'RequestAbortedError';
  }
}

/**
 * 带超时和重试的fetch包装器
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const {
    timeout = 30000, // 默认30秒超时
    retries = 0,
    retryDelay = 1000,
    onRetry,
    signal,
    ...fetchOptions
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // 创建AbortController处理超时
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      // 如果外部也提供了signal，需要同时监听
      if (signal) {
        signal.addEventListener('abort', () => controller.abort());
      }

      try {
        const response = await fetch(url, {
          ...fetchOptions,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        return response;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error) {
          if (error.name === 'AbortError') {
            if (signal?.aborted) {
              throw new RequestAbortedError();
            }
            throw new RequestTimeoutError(timeout);
          }
          throw error;
        }
        throw error;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // 如果是最后一次尝试或不应该重试的错误，直接抛出
      if (attempt === retries || error instanceof RequestAbortedError) {
        throw lastError;
      }

      // 通知重试
      if (onRetry) {
        onRetry(attempt + 1, lastError);
      }

      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, retryDelay * (attempt + 1)));
    }
  }

  throw lastError || new Error('Request failed');
}

/**
 * JSON API请求包装器
 */
export async function fetchJSON<T = any>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `HTTP ${response.status}: ${response.statusText}${errorText ? ` - ${errorText}` : ''}`
    );
  }

  return response.json();
}

/**
 * POST JSON请求
 */
export async function postJSON<T = any>(
  url: string,
  data: any,
  options: RequestOptions = {},
): Promise<T> {
  return fetchJSON<T>(url, {
    ...options,
    method: 'POST',
    body: JSON.stringify(data),
  });
}

/**
 * 批量请求管理器
 * 用于控制并发请求数量
 */
export class RequestQueue {
  private queue: Array<() => Promise<any>> = [];
  private running = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent = 6) {
    this.maxConcurrent = maxConcurrent;
  }

  async add<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.process();
    });
  }

  private async process() {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const fn = this.queue.shift();
    if (!fn) return;

    this.running++;
    try {
      await fn();
    } finally {
      this.running--;
      this.process();
    }
  }
}

/**
 * React Hook: 带超时和重试的数据获取
 */
export function useFetch<T>(
  url: string | null,
  options: RequestOptions = {},
) {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);

  React.useEffect(() => {
    if (!url) return;

    const controller = new AbortController();
    setLoading(true);
    setError(null);

    fetchJSON<T>(url, {
      ...options,
      signal: controller.signal,
    })
      .then(setData)
      .catch(err => {
        if (err.name !== 'AbortError') {
          setError(err);
        }
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [url]);

  const refetch = React.useCallback(() => {
    if (!url) return;

    setLoading(true);
    setError(null);

    fetchJSON<T>(url, options)
      .then(setData)
      .catch(setError)
      .finally(() => setLoading(false));
  }, [url]);

  return { data, loading, error, refetch };
}

// 导出React用于hook
import * as React from 'react';
