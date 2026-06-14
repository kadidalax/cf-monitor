/**
 * 工具函数测试
 */

import { describe, it, expect, vi } from 'vitest';
import { handleApiError, ApiError } from '../errorHandler';
import { toast } from 'sonner';

// Mock sonner
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

describe('errorHandler', () => {
  describe('ApiError', () => {
    it('should create ApiError with status and message', () => {
      const error = new ApiError(404, 'Not found');
      expect(error.status).toBe(404);
      expect(error.message).toBe('Not found');
      expect(error.name).toBe('ApiError');
    });

    it('should accept optional data', () => {
      const data = { details: 'Resource not found' };
      const error = new ApiError(404, 'Not found', data);
      expect(error.data).toEqual(data);
    });
  });

  describe('handleApiError', () => {
    it('should handle ApiError', () => {
      const error = new ApiError(404, 'Resource not found');
      handleApiError(error);
      expect(toast.error).toHaveBeenCalledWith('Resource not found');
    });

    it('should handle generic Error', () => {
      const error = new Error('Something went wrong');
      handleApiError(error);
      expect(toast.error).toHaveBeenCalledWith('Something went wrong');
    });

    it('should use custom message if provided', () => {
      const error = new ApiError(500, 'Server error');
      handleApiError(error, 'Custom error message');
      expect(toast.error).toHaveBeenCalledWith('Custom error message');
    });

    it('should handle network errors', () => {
      const error = new Error('Failed to fetch');
      handleApiError(error);
      expect(toast.error).toHaveBeenCalledWith('网络连接失败，请检查网络设置');
    });

    it('should handle timeout errors', () => {
      const error = new Error('Request timeout');
      handleApiError(error);
      expect(toast.error).toHaveBeenCalledWith('请求超时，请重试');
    });

    it('should handle unknown errors', () => {
      handleApiError('some string error');
      expect(toast.error).toHaveBeenCalledWith('未知错误');
    });
  });
});
