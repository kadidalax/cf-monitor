import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

interface User {
  uuid: string;
  username: string;
}

interface AuthContextType {
  user: User | null;
  login: (username: string, password: string) => Promise<string | null>;
  logout: () => void;
  updateUser: (nextUser: Partial<User>) => void;
  isAuthenticated: boolean;
  authLoading: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => null,
  logout: () => {},
  updateUser: () => {},
  isAuthenticated: false,
  authLoading: true,
});

const API_BASE = '/api';
const CSRF_COOKIE_NAME = 'cf_monitor_csrf';

async function readJson(res: Response) {
  return res.json().catch(() => ({}));
}

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const prefix = `${name}=`;
  return document.cookie
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(prefix))
    ?.slice(prefix.length) || '';
}

function isUnsafeMethod(method: string | undefined): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes((method || 'GET').toUpperCase());
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const clearAuth = useCallback(() => {
    setUser(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAuthLoading(true);

    fetch(`${API_BASE}/me`, {
      credentials: 'same-origin',
    })
      .then(async (res) => {
        const data = await readJson(res);
        if (!res.ok || !data.uuid) {
          throw new Error(data.error || 'Invalid session');
        }
        return data;
      })
      .then((data) => {
        if (!cancelled) {
          setUser({ uuid: data.uuid, username: data.username });
        }
      })
      .catch(() => {
        if (!cancelled) clearAuth();
      })
      .finally(() => {
        if (!cancelled) setAuthLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [clearAuth]);

  const login = useCallback(async (username: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      const data = await readJson(res);

      if (res.ok && data.user) {
        setUser(data.user);
        return null;
      }
      return data.error || 'Login failed';
    } catch {
      return 'Network error';
    }
  }, []);

  const logout = useCallback(() => {
    clearAuth();
    fetch(`${API_BASE}/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => {});
  }, [clearAuth]);

  const updateUser = useCallback((nextUser: Partial<User>) => {
    setUser((current) => current ? { ...current, ...nextUser } : current);
  }, []);

  return (
    <AuthContext.Provider value={{ user, login, logout, updateUser, isAuthenticated: !!user, authLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

export function useApi() {
  const { logout } = useAuth();

  const apiFetch = useCallback(async (path: string, options: RequestInit = {}) => {
    const normalizedPath = path.startsWith('/') ? path : '/' + path;
    const url = `${API_BASE}${normalizedPath}`;

    const headers = new Headers(options.headers);
    const isFormData = options.body instanceof FormData;
    if (!headers.has('Content-Type') && !isFormData) {
      headers.set('Content-Type', 'application/json');
    }
    if (normalizedPath.startsWith('/admin/') && isUnsafeMethod(options.method)) {
      const csrfToken = readCookie(CSRF_COOKIE_NAME);
      if (csrfToken && !headers.has('X-CSRF-Token')) {
        headers.set('X-CSRF-Token', csrfToken);
      }
    }

    const res = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    const data = await readJson(res);

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        logout();
      }
      const details = Array.isArray(data.details) ? `: ${data.details.join('；')}` : '';
      throw new Error(data.error ? `${data.error}${details}` : `HTTP ${res.status}`);
    }

    return data;
  }, [logout]);

  return apiFetch;
}
