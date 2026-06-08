import { describe, expect, it } from 'vitest';
import {
  monitorYAxisProps,
  monitorYAxisWidth,
  pingYAxisProps,
  pingYAxisWidth,
  wideYAxisProps,
  wideYAxisWidth,
} from './monitorChartAxis';

describe('monitor chart axis', () => {
  it('keeps compact percentage axes narrow and gives unit labels enough room', () => {
    expect(monitorYAxisWidth).toBe(32);
    expect(monitorYAxisProps.width).toBe(monitorYAxisWidth);
    expect(wideYAxisWidth).toBe(48);
    expect(wideYAxisProps.width).toBe(wideYAxisWidth);
    expect(pingYAxisWidth).toBe(56);
    expect(pingYAxisProps.width).toBe(pingYAxisWidth);
    expect(pingYAxisProps.tickMargin).toBe(monitorYAxisProps.tickMargin);
  });
});
