import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPingTaskSeries, formatPingMs, getPingSeriesStats } from './pingChart';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ping chart formatting', () => {
  it('formats ping latency as whole milliseconds without decimals', () => {
    expect(formatPingMs(29.4)).toBe('29 ms');
    expect(formatPingMs(29.5)).toBe('30 ms');
    expect(formatPingMs(0)).toBe('0 ms');
  });

  it('keeps missing ping values compact', () => {
    expect(formatPingMs(null)).toBe('-');
    expect(formatPingMs(undefined)).toBe('-');
    expect(formatPingMs(-1)).toBe('-');
  });

  it('excludes ping loss markers from latency stats', () => {
    const stats = getPingSeriesStats([
      { time: '2026-01-01T00:00:00.000Z', value: 20 },
      { time: '2026-01-01T00:01:00.000Z', value: -1 },
      { time: '2026-01-01T00:02:00.000Z', value: 40 },
    ]);

    expect(stats?.latest).toBe(40);
    expect(stats?.avg).toBe(30);
    expect(stats?.min).toBe(20);
    expect(stats?.max).toBe(40);
  });

  it('requests batch ping history with per-task limits and intervals', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 1, name: 'Fast', target: '1.1.1.1', interval_sec: 60, all_clients: true },
        { id: 2, name: 'Slow', target: '8.8.8.8', interval_sec: 600, all_clients: true },
      ])))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        1: [{ time: '2026-01-01T00:00:00.000Z', value: 20 }],
        2: [{ time: '2026-01-01T00:00:00.000Z', value: 40 }],
      })));

    vi.stubGlobal('fetch', fetchMock);

    const series = await fetchPingTaskSeries('node-a', {
      limit: 5,
      maxTasks: 2,
      rangeHours: 1,
    });

    expect(series).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const batchUrl = new URL(String(fetchMock.mock.calls[1][0]), 'http://example.test');
    expect(batchUrl.pathname).toBe('/api/records/ping/batch');
    expect(batchUrl.searchParams.get('uuid')).toBe('node-a');
    expect(batchUrl.searchParams.get('base_interval')).toBe('60');
    expect(batchUrl.searchParams.get('limit')).toBe('64');
    expect(batchUrl.searchParams.get('task_specs')).toBe('1:64:60,2:10:600');
  });
});
