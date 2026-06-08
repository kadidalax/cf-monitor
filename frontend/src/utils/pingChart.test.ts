import { describe, expect, it } from 'vitest';
import { formatPingMs, getPingSeriesStats } from './pingChart';

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
});
