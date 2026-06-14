/**
 * LiveDataContext - 实时数据上下文
 * 优先通过 WebSocket 接收实时数据，HTTP 轮询作为断线兜底
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import {
  DEFAULT_LIVE_POLL_CONFIG,
  getLivePollDelay,
  getFallbackViewerExpiry,
  isViewerWindowExpired,
  LIVE_POLL_SETTINGS_UPDATED_EVENT,
  normalizeLivePollConfig,
  shouldReconnectLiveWebSocket,
  type LivePollConfig,
} from './livePolling';
import { fetchPublicSettings, setCachedPublicSettings } from '../utils/publicSettings';

export interface LiveRecord {
  cpu: number;
  gpu?: number;
  ram: number;
  ram_total: number;
  swap: number;
  swap_total: number;
  disk: number;
  disk_total: number;
  net_in: number;
  net_out: number;
  net_total_up: number;
  net_total_down: number;
  load: number;
  temp: number;
  uptime: number;
  process_count: number;
  connections: number;
  connections_udp: number;
  message?: string;
}

export interface LiveDataResponse {
  online: string[];
  clients: Array<{ uuid: string; name: string; lastReportTime: number } & Partial<LiveRecord>>;
  data: Record<string, LiveRecord>;
  count: number;
  timestamp: number;
}

type LiveDataSnapshotMessage = LiveDataResponse & { type: 'snapshot' };

interface LiveDataUpdateMessage {
  type: 'update';
  client: string;
  name?: string;
  data?: Partial<LiveRecord>;
  timestamp: number;
}

interface LiveDataRemoveMessage {
  type: 'remove';
  client: string;
  timestamp: number;
}

interface LiveDataViewerExpiredMessage {
  type: 'viewer_expired';
  timestamp: number;
}

export function buildLiveWebSocketUrl(origin: string, pathname = '/api/ws/live', viewerToken?: string): string {
  const url = new URL(pathname, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (viewerToken) {
    url.searchParams.set('viewer_token', viewerToken);
  }
  return url.toString();
}

function isSnapshotMessage(value: any): value is LiveDataSnapshotMessage {
  return value?.type === 'snapshot' && Array.isArray(value.online) && Array.isArray(value.clients);
}

function isUpdateMessage(value: any): value is LiveDataUpdateMessage {
  return value?.type === 'update' && typeof value.client === 'string' && typeof value.timestamp === 'number';
}

function isRemoveMessage(value: any): value is LiveDataRemoveMessage {
  return value?.type === 'remove' && typeof value.client === 'string';
}

function isViewerExpiredMessage(value: any): value is LiveDataViewerExpiredMessage {
  return value?.type === 'viewer_expired' && typeof value.timestamp === 'number';
}

export function applyLiveUpdate(
  current: LiveDataResponse | null,
  message: LiveDataUpdateMessage,
): LiveDataResponse {
  const base: LiveDataResponse = current || {
    online: [],
    clients: [],
    data: {},
    count: 0,
    timestamp: 0,
  };
  const uuid = message.client;
  const previousClient = base.clients.find(client => client.uuid === uuid);
  const nextRecord = {
    ...(base.data[uuid] || {}),
    ...(message.data || {}),
    lastReportTime: message.timestamp,
  } as LiveRecord;
  const nextOnline = base.online.includes(uuid) ? base.online : [...base.online, uuid];
  const nextClient = {
    ...nextRecord,
    uuid,
    name: message.name || previousClient?.name || uuid,
    lastReportTime: message.timestamp,
  };

  return {
    online: nextOnline,
    clients: [
      ...base.clients.filter(client => client.uuid !== uuid),
      nextClient,
    ],
    data: {
      ...base.data,
      [uuid]: nextRecord,
    },
    count: nextOnline.length,
    timestamp: message.timestamp,
  };
}

export function applyLiveRemove(
  current: LiveDataResponse | null,
  message: LiveDataRemoveMessage,
): LiveDataResponse | null {
  if (!current) return current;
  const { [message.client]: _removed, ...data } = current.data;
  const online = current.online.filter(uuid => uuid !== message.client);

  return {
    ...current,
    online,
    clients: current.clients.filter(client => client.uuid !== message.client),
    data,
    count: online.length,
    timestamp: message.timestamp,
  };
}

interface LiveDataContextType {
  liveData: LiveDataResponse | null;
  loading: boolean;
  error: string | null;
  viewerExpired: boolean;
  viewerExpiresAt: number | null;
  refresh: () => void;
}

const LiveDataContext = createContext<LiveDataContextType>({
  liveData: null,
  loading: true,
  error: null,
  viewerExpired: false,
  viewerExpiresAt: null,
  refresh: () => {},
});

export function useLiveData() {
  return useContext(LiveDataContext);
}

interface LiveDataProviderProps {
  children: React.ReactNode;
  viewer?: boolean;
}

export function LiveDataProvider({ children, viewer = true }: LiveDataProviderProps) {
  const [liveData, setLiveData] = useState<LiveDataResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewerExpired, setViewerExpired] = useState(false);
  const [viewerExpiresAt, setViewerExpiresAt] = useState<number | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const wsOpenRef = useRef(false);
  const wsExpiredRef = useRef(false);
  const pollConfigRef = useRef<LivePollConfig>(DEFAULT_LIVE_POLL_CONFIG);
  const fallbackExpiresAtRef = useRef<number | null>(null);
  const activeSinceRef = useRef<number | null>(
    viewer && (typeof document === 'undefined' || !document.hidden) ? Date.now() : null,
  );

  const expireViewerSession = useCallback(() => {
    wsExpiredRef.current = true;
    wsOpenRef.current = false;
    fallbackExpiresAtRef.current = null;
    setViewerExpired(true);
    setViewerExpiresAt(null);
    setError(null);
    setLoading(false);
  }, []);

  const ensureFallbackViewerWindow = useCallback((now = Date.now()) => {
    if (fallbackExpiresAtRef.current === null) {
      fallbackExpiresAtRef.current = getFallbackViewerExpiry({
        currentExpiresAt: fallbackExpiresAtRef.current,
        now,
        config: pollConfigRef.current,
      });
      setViewerExpiresAt(fallbackExpiresAtRef.current);
      setViewerExpired(false);
    }
    return fallbackExpiresAtRef.current;
  }, []);

  const fetchLiveData = useCallback(async () => {
    if (wsExpiredRef.current) {
      setLoading(false);
      return;
    }
    try {
      const res = await fetch('/api/live/clients', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLiveData(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    fetchLiveData();
  }, [fetchLiveData]);

  useEffect(() => {
    if (!viewer) return;

    let cancelled = false;

    const applySettings = (settings: Record<string, unknown> | null | undefined) => {
      if (settings && typeof settings === 'object') {
        setCachedPublicSettings(settings as Record<string, any>);
      }
      pollConfigRef.current = normalizeLivePollConfig(settings);
      fallbackExpiresAtRef.current = null;
    };

    const loadSettings = () => {
      fetchPublicSettings()
        .then((settings) => {
          if (!cancelled) {
            applySettings(settings);
          }
        })
        .catch(() => {
          if (!cancelled) {
            pollConfigRef.current = DEFAULT_LIVE_POLL_CONFIG;
            fallbackExpiresAtRef.current = null;
          }
        });
    };

    const handleSettingsUpdated = (event: Event) => {
      if (cancelled) return;
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail && typeof detail === 'object') {
        applySettings(detail as Record<string, unknown>);
      } else {
        loadSettings();
      }
    };

    loadSettings();
    window.addEventListener(LIVE_POLL_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);

    return () => {
      cancelled = true;
      window.removeEventListener(LIVE_POLL_SETTINGS_UPDATED_EVENT, handleSettingsUpdated);
    };
  }, [viewer]);

  useEffect(() => {
    if (!viewer) return;

    let cancelled = false;

    const clearReconnectTimeout = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const connect = async () => {
      if (cancelled || typeof WebSocket === 'undefined') return;

      let viewerToken = '';
      try {
        const tokenResponse = await fetch('/api/ws/live-token');
        if (!tokenResponse.ok) throw new Error(`HTTP ${tokenResponse.status}`);
        const tokenData = await tokenResponse.json();
        viewerToken = typeof tokenData.token === 'string' ? tokenData.token : '';
        setViewerExpiresAt(typeof tokenData.expires_at === 'number' ? tokenData.expires_at : null);
        setViewerExpired(false);
      } catch {
        ensureFallbackViewerWindow();
        void fetchLiveData();
        return;
      }
      if (cancelled || !viewerToken) return;

      const ws = new WebSocket(buildLiveWebSocketUrl(window.location.origin, '/api/ws/live', viewerToken));
      wsRef.current = ws;

      ws.addEventListener('open', () => {
        if (wsRef.current !== ws) return;
        wsOpenRef.current = true;
        setError(null);
      });

      ws.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data);
          if (isSnapshotMessage(message)) {
            const { type: _type, ...snapshot } = message;
            setLiveData(snapshot);
            setLoading(false);
            setError(null);
            if ((snapshot.count || 0) === 0 && snapshot.online.length === 0) {
              void fetchLiveData();
            }
            return;
          }
          if (isUpdateMessage(message)) {
            setLiveData(current => applyLiveUpdate(current, message));
            setLoading(false);
            setError(null);
            return;
          }
          if (isRemoveMessage(message)) {
            setLiveData(current => applyLiveRemove(current, message));
            setLoading(false);
            return;
          }
          if (isViewerExpiredMessage(message)) {
            expireViewerSession();
          }
        } catch {
          // Ignore malformed live messages and let the HTTP fallback repair state.
        }
      });

      ws.addEventListener('error', () => {
        if (wsRef.current === ws) {
          setError('Live WebSocket unavailable');
        }
      });

      ws.addEventListener('close', () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
          wsOpenRef.current = false;
        }
        if (cancelled) return;
        if (!wsExpiredRef.current) {
          void fetchLiveData();
        }
        clearReconnectTimeout();
        if (shouldReconnectLiveWebSocket({ expired: wsExpiredRef.current, hidden: document.hidden })) {
          reconnectTimeoutRef.current = setTimeout(
            () => { void connect(); },
            Math.min(30_000, pollConfigRef.current.idleIntervalMs),
          );
        }
      });
    };

    void connect();

    return () => {
      cancelled = true;
      clearReconnectTimeout();
      wsOpenRef.current = false;
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [ensureFallbackViewerWindow, expireViewerSession, fetchLiveData, viewer]);

  // 轮询
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    let lastScheduledDelay = 0;
    let lastScheduleWasIdle = false;

    const clearPollTimeout = () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };

    if (!viewer) {
      const scheduleSnapshotPoll = () => {
        clearPollTimeout();
        if (cancelled) return;
        timeoutRef.current = setTimeout(
          pollSnapshot,
          DEFAULT_LIVE_POLL_CONFIG.idleIntervalMs,
        );
      };

      const pollSnapshot = async () => {
        if (polling || cancelled) return;
        polling = true;
        try {
          await fetchLiveData();
        } finally {
          polling = false;
          scheduleSnapshotPoll();
        }
      };

      const handleVisibility = () => {
        if (!document.hidden) {
          clearPollTimeout();
          void pollSnapshot();
        }
      };

      document.addEventListener('visibilitychange', handleVisibility);
      void pollSnapshot();

      return () => {
        cancelled = true;
        clearPollTimeout();
        document.removeEventListener('visibilitychange', handleVisibility);
      };
    }

    const scheduleNextPoll = () => {
      clearPollTimeout();
      if (cancelled) return;
      const now = Date.now();
      if (!document.hidden && activeSinceRef.current === null) {
        activeSinceRef.current = now;
      }
      const config = pollConfigRef.current;
      if (wsExpiredRef.current) {
        lastScheduledDelay = 0;
        lastScheduleWasIdle = true;
        return;
      }
      const fallbackExpiresAt = wsOpenRef.current ? null : ensureFallbackViewerWindow(now);
      if (isViewerWindowExpired({ expiresAt: fallbackExpiresAt, now })) {
        expireViewerSession();
        lastScheduledDelay = 0;
        lastScheduleWasIdle = true;
        return;
      }
      lastScheduledDelay = wsOpenRef.current
        ? config.idleIntervalMs
        : getLivePollDelay({
            hidden: document.hidden,
            activeSince: activeSinceRef.current,
            now,
            config,
          });
      lastScheduleWasIdle = wsExpiredRef.current || wsOpenRef.current || document.hidden ||
        (activeSinceRef.current !== null && now - activeSinceRef.current >= config.activeMaxDurationMs);
      timeoutRef.current = setTimeout(poll, lastScheduledDelay);
    };

    const poll = async () => {
      if (polling || cancelled) return;
      const fallbackExpiresAt = wsOpenRef.current ? null : ensureFallbackViewerWindow();
      if (isViewerWindowExpired({ expiresAt: fallbackExpiresAt })) {
        expireViewerSession();
        return;
      }
      if (wsOpenRef.current) {
        scheduleNextPoll();
        return;
      }
      polling = true;
      try {
        await fetchLiveData();
      } finally {
        polling = false;
        scheduleNextPoll();
      }
    };

    const handleVisibility = () => {
      if (!document.hidden) {
        if (!wsExpiredRef.current) {
          activeSinceRef.current = Date.now();
        }
        clearPollTimeout();
        if (wsExpiredRef.current) {
          scheduleNextPoll();
        } else {
          poll();
        }
      } else {
        activeSinceRef.current = null;
      }
    };

    const handleUserActivity = () => {
      if (document.hidden || cancelled) return;
      if (wsExpiredRef.current) return;
      activeSinceRef.current = Date.now();
      if (lastScheduleWasIdle) {
        clearPollTimeout();
        poll();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleUserActivity);
    window.addEventListener('pointerdown', handleUserActivity);
    window.addEventListener('keydown', handleUserActivity);
    window.addEventListener('scroll', handleUserActivity, { passive: true });
    poll();

    return () => {
      cancelled = true;
      clearPollTimeout();
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleUserActivity);
      window.removeEventListener('pointerdown', handleUserActivity);
      window.removeEventListener('keydown', handleUserActivity);
      window.removeEventListener('scroll', handleUserActivity);
    };
  }, [ensureFallbackViewerWindow, expireViewerSession, fetchLiveData, viewer]);

  return (
    <LiveDataContext.Provider value={{ liveData, loading, error, viewerExpired, viewerExpiresAt, refresh }}>
      {children}
    </LiveDataContext.Provider>
  );
}
