import { describe, expect, it } from 'vitest';
import {
  applyThemeClass,
  defaultThemeMode,
  getExplicitThemeAppearance,
  normalizeThemeMode,
} from './themeAppearance';

describe('theme appearance bootstrap', () => {
  it('uses the same explicit dark default before and after React mounts', () => {
    expect(defaultThemeMode).toBe('dark');
    expect(normalizeThemeMode(null)).toBe('dark');
    expect(normalizeThemeMode('unexpected')).toBe('dark');
    expect(getExplicitThemeAppearance(normalizeThemeMode(null))).toBe('dark');
  });

  it('only lets system mode defer the explicit Radix appearance', () => {
    expect(getExplicitThemeAppearance('light')).toBe('light');
    expect(getExplicitThemeAppearance('dark')).toBe('dark');
    expect(getExplicitThemeAppearance('system')).toBeUndefined();
  });

  it('keeps the html theme class in sync with explicit and system modes', () => {
    const classes = new Set<string>();
    const element = {
      classList: {
        add: (value: string) => classes.add(value),
        remove: (...values: string[]) => values.forEach((value) => classes.delete(value)),
      },
    };

    applyThemeClass(element, 'dark', false);
    expect(Array.from(classes)).toEqual(['dark']);

    applyThemeClass(element, 'system', false);
    expect(Array.from(classes)).toEqual(['light']);

    applyThemeClass(element, 'system', true);
    expect(Array.from(classes)).toEqual(['dark']);
  });
});
