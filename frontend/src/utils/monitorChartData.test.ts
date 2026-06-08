import { describe, expect, it } from 'vitest';
import { buildMonitorChartData, getMonitorChartRenderData } from './monitorChartData';

describe('monitor chart data', () => {
  it('keeps history-derived chart values normalized for monitor metrics', () => {
    const [point] = buildMonitorChartData([
      {
        time: '2026-06-06T08:00:00.000Z',
        cpu: 12.345,
        ram: 3,
        ram_total: 12,
        disk: 20,
        disk_total: 80,
        net_in: 1024,
        net_out: 2048,
        temp: 48.6,
        connections: 120,
        connections_udp: 30,
        process_count: 88,
      },
    ]);

    expect(point).toEqual({
      time: Date.parse('2026-06-06T08:00:00.000Z'),
      cpu: 12.35,
      ram: 25,
      disk: 25,
      net_in: 1024,
      net_out: 2048,
      temp: 48.6,
      connections: 120,
      connections_udp: 30,
      process_count: 88,
    });
  });

  it('provides zero-value axis points when history is empty so chart scales still render', () => {
    const now = Date.parse('2026-06-06T09:00:00.000Z');
    const renderData = getMonitorChartRenderData([], 3_600_000, now);

    expect(renderData).toHaveLength(2);
    expect(renderData.map((point) => point.time)).toEqual([
      Date.parse('2026-06-06T08:00:00.000Z'),
      now,
    ]);
    expect(renderData).toEqual([
      expect.objectContaining({ cpu: 0, net_in: 0, connections: 0, process_count: 0, temp: 0 }),
      expect.objectContaining({ cpu: 0, net_in: 0, connections: 0, process_count: 0, temp: 0 }),
    ]);
  });

  it('does not replace real history with axis placeholder points', () => {
    const chartData = buildMonitorChartData([{ time: '2026-06-06T08:00:00.000Z', cpu: 7 }]);

    expect(getMonitorChartRenderData(chartData, 3_600_000, Date.now())).toBe(chartData);
  });
});
