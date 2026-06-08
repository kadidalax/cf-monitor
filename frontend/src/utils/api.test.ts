import { describe, expect, it } from 'vitest';
import { normalizeListResponse } from './api';

describe('api helpers', () => {
  it('normalizes public list responses from array and paged object shapes', () => {
    const arrayPayload = [{ uuid: 'node-a' }];
    const pagedPayload = { data: [{ uuid: 'node-b' }], total: 1 };

    expect(normalizeListResponse(arrayPayload)).toEqual(arrayPayload);
    expect(normalizeListResponse(pagedPayload)).toEqual(pagedPayload.data);
    expect(normalizeListResponse({ error: 'Not Found' })).toEqual([]);
    expect(normalizeListResponse(null)).toEqual([]);
  });
});
