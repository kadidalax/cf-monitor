/**
 * API 工具函数测试
 */

import { describe, it, expect } from 'vitest';
import { apiFetch, normalizeListResponse, publicFetch } from '../api';

describe('api utils', () => {
  describe('normalizeListResponse', () => {
    it('should return array if payload is array', () => {
      const input = [{ id: 1 }, { id: 2 }];
      const result = normalizeListResponse(input);
      expect(result).toEqual(input);
    });

    it('should extract data array from object', () => {
      const input = { data: [{ id: 1 }, { id: 2 }] };
      const result = normalizeListResponse(input);
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('should return empty array for null', () => {
      const result = normalizeListResponse(null);
      expect(result).toEqual([]);
    });

    it('should return empty array for undefined', () => {
      const result = normalizeListResponse(undefined);
      expect(result).toEqual([]);
    });

    it('should return empty array for non-array object without data', () => {
      const result = normalizeListResponse({ error: 'something' });
      expect(result).toEqual([]);
    });
  });

  describe('public API guard', () => {
    it('rejects admin paths from apiFetch', async () => {
      await expect(apiFetch('/admin/settings')).rejects.toThrow(/Admin API requests must use useApi/);
    });

    it('rejects admin paths from publicFetch', async () => {
      await expect(publicFetch('/api/admin/settings')).rejects.toThrow(/Admin API requests must use useApi/);
    });
  });
});
