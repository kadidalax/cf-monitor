import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  defaultDisplayTheme,
  DisplayTheme,
  getNextDisplayTheme,
  normalizeDisplayTheme,
} from '../utils/displayTheme';

interface DisplayThemeContextType {
  displayTheme: DisplayTheme;
  setDisplayTheme: (theme: DisplayTheme) => void;
  toggleDisplayTheme: () => void;
}

const STORAGE_KEY = 'cf-monitor-display-theme';

const DisplayThemeContext = createContext<DisplayThemeContextType>({
  displayTheme: defaultDisplayTheme,
  setDisplayTheme: () => {},
  toggleDisplayTheme: () => {},
});

export function useDisplayTheme() {
  return useContext(DisplayThemeContext);
}

function applyDisplayTheme(theme: DisplayTheme) {
  document.documentElement.setAttribute('data-monitor-theme', theme);
  const setter = (window as any).__setRadixAccentColor;
  if (setter) setter(theme);
}

export function DisplayThemeProvider({ children }: { children: React.ReactNode }) {
  const [displayTheme, setDisplayThemeState] = useState<DisplayTheme>(() => {
    const normalized = normalizeDisplayTheme(localStorage.getItem(STORAGE_KEY));
    localStorage.setItem(STORAGE_KEY, normalized);
    return normalized;
  });

  useEffect(() => {
    applyDisplayTheme(displayTheme);
  }, [displayTheme]);

  const setDisplayTheme = useCallback((theme: DisplayTheme) => {
    setDisplayThemeState(theme);
    localStorage.setItem(STORAGE_KEY, theme);
    applyDisplayTheme(theme);
  }, []);

  const toggleDisplayTheme = useCallback(() => {
    setDisplayThemeState((current) => {
      const next = getNextDisplayTheme(current);
      localStorage.setItem(STORAGE_KEY, next);
      applyDisplayTheme(next);
      return next;
    });
  }, []);

  return (
    <DisplayThemeContext.Provider value={{ displayTheme, setDisplayTheme, toggleDisplayTheme }}>
      {children}
    </DisplayThemeContext.Provider>
  );
}
