import { describe, expect, it } from 'vitest';
import { buildDashboardStatusCards, defaultStatusCardVisibility } from './dashboardStatus';

describe('dashboard status cards', () => {
  it('keeps public dashboard status labels and values readable', () => {
    const cards = buildDashboardStatusCards({
      currentTime: '15:06:38',
      onlineCount: 47,
      totalCount: 50,
      regionCount: 19,
      totalUp: 1550000000000,
      totalDown: 3030000000000,
      totalSpeedUp: 1020000,
      totalSpeedDown: 1220000,
    });

    expect(cards.map((card) => card.title)).toEqual([
      '当前时间',
      '当前在线',
      '点亮地区',
      '流量概览',
      '网络速率',
    ]);
    expect(cards.map((card) => card.key)).toEqual(Object.keys(defaultStatusCardVisibility));
    expect(cards[1].value).toBe('47 / 50');
    expect(cards[0].oneLine).toBe(true);
    expect(cards[1].oneLine).toBe(true);
    expect(cards[2].oneLine).toBeUndefined();
    expect(cards[3].value).toContain('↑');
    expect(cards[3].value).toContain('↓');
    expect(cards[3].value).not.toContain('\n');
    expect(cards[3].inlineValues).toEqual([
      expect.stringMatching(/^↑ /),
      expect.stringMatching(/^↓ /),
    ]);
    expect(cards[4].inlineValues).toEqual([
      expect.stringMatching(/^↑ /),
      expect.stringMatching(/^↓ /),
    ]);
  });
});
