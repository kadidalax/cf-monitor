import { describe, expect, it } from 'vitest';
import { defaultDisplayTheme, getNextDisplayTheme, normalizeDisplayTheme } from './displayTheme';

describe('display theme', () => {
  it('keeps the ring monitor theme as the default and toggles to next', () => {
    expect(defaultDisplayTheme).toBe('monitor');
    expect(normalizeDisplayTheme('unknown')).toBe('monitor');
    expect(normalizeDisplayTheme('monitor')).toBe('monitor');
    expect(normalizeDisplayTheme('next')).toBe('next');
    expect(getNextDisplayTheme('monitor')).toBe('next');
    expect(getNextDisplayTheme('next')).toBe('monitor');
  });

  it('migrates previous display theme names to the new public names', () => {
    expect(normalizeDisplayTheme('komari-next')).toBe('monitor');
    expect(normalizeDisplayTheme('cf-monitor')).toBe('next');
  });
});
