import { describe, expect, it } from 'vitest';
import {
  applyLiveRemove,
  applyLiveUpdate,
  buildLiveWebSocketUrl,
  type LiveDataResponse,
} from './LiveDataContext';
import {
  getFallbackViewerExpiry,
  getLivePollDelay,
  isViewerWindowExpired,
  normalizeLivePollConfig,
  shouldReconnectLiveWebSocket,
} from './livePolling';

describe('getLivePollDelay', () => {
  it('uses the fast interval while the page is visible', () => {
    expect(getLivePollDelay({ hidden: false })).toBe(3000);
  });

  it('uses the idle interval while the page is hidden', () => {
    expect(getLivePollDelay({ hidden: true })).toBe(600000);
  });

  it('falls back to the idle interval after the active refresh window expires', () => {
    expect(getLivePollDelay({ hidden: false, activeSince: 0, now: 600000 })).toBe(600000);
  });

  it('normalizes public settings from seconds to milliseconds with sane bounds', () => {
    expect(normalizeLivePollConfig({
      live_poll_active_interval_sec: '5',
      live_poll_idle_interval_sec: '900',
      live_poll_active_max_duration_sec: '1200',
    })).toEqual({
      activeIntervalMs: 5000,
      idleIntervalMs: 900000,
      activeMaxDurationMs: 1200000,
    });

    expect(normalizeLivePollConfig({
      live_poll_active_interval_sec: '1',
      live_poll_idle_interval_sec: '10',
      live_poll_active_max_duration_sec: '20',
    })).toEqual({
      activeIntervalMs: 3000,
      idleIntervalMs: 60000,
      activeMaxDurationMs: 60000,
    });
  });
});

describe('live WebSocket helpers', () => {
  it('reconnects only while the viewer window is active and visible', () => {
    expect(shouldReconnectLiveWebSocket({ expired: false, hidden: false })).toBe(true);
    expect(shouldReconnectLiveWebSocket({ expired: true, hidden: false })).toBe(false);
    expect(shouldReconnectLiveWebSocket({ expired: false, hidden: true })).toBe(false);
  });

  it('builds a WebSocket URL from the current origin', () => {
    expect(buildLiveWebSocketUrl('http://localhost:8787')).toBe('ws://localhost:8787/api/ws/live');
    expect(buildLiveWebSocketUrl('https://monitor.example.com')).toBe('wss://monitor.example.com/api/ws/live');
    expect(buildLiveWebSocketUrl('https://monitor.example.com', '/api/ws/live', 'viewer.token')).toBe(
      'wss://monitor.example.com/api/ws/live?viewer_token=viewer.token',
    );
  });

  it('keeps HTTP fallback on the same viewer window until it expires', () => {
    const config = normalizeLivePollConfig({
      live_poll_active_max_duration_sec: '120',
    });

    const expiresAt = getFallbackViewerExpiry({ currentExpiresAt: null, now: 1000, config });
    expect(expiresAt).toBe(121000);
    expect(getFallbackViewerExpiry({ currentExpiresAt: expiresAt, now: 5000, config })).toBe(expiresAt);
    expect(isViewerWindowExpired({ expiresAt, now: 120999 })).toBe(false);
    expect(isViewerWindowExpired({ expiresAt, now: 121000 })).toBe(true);
  });

  it('merges live updates without leaking previous nodes', () => {
    const updated = applyLiveUpdate(null, {
      type: 'update',
      client: 'client-1',
      name: 'Visible node',
      timestamp: 123,
      data: {
        cpu: 10,
        ram: 20,
        ram_total: 100,
        swap: 0,
        swap_total: 0,
        disk: 30,
        disk_total: 100,
        net_in: 1,
        net_out: 2,
        net_total_up: 3,
        net_total_down: 4,
        load: 0.5,
        temp: 40,
        uptime: 99,
        process_count: 10,
        connections: 5,
        connections_udp: 1,
      },
    });

    expect(updated.online).toEqual(['client-1']);
    expect(updated.count).toBe(1);
    expect(updated.clients[0]).toMatchObject({
      uuid: 'client-1',
      name: 'Visible node',
      lastReportTime: 123,
      cpu: 10,
    });
    expect(updated.data['client-1']).toMatchObject({ cpu: 10, ram: 20 });
  });

  it('removes nodes from live state', () => {
    const current: LiveDataResponse = {
      online: ['client-1', 'client-2'],
      clients: [
        { uuid: 'client-1', name: 'one', lastReportTime: 1 },
        { uuid: 'client-2', name: 'two', lastReportTime: 1 },
      ],
      data: {
        'client-1': {} as any,
        'client-2': {} as any,
      },
      count: 2,
      timestamp: 1,
    };

    expect(applyLiveRemove(current, {
      type: 'remove',
      client: 'client-1',
      timestamp: 2,
    })).toMatchObject({
      online: ['client-2'],
      clients: [{ uuid: 'client-2' }],
      count: 1,
      timestamp: 2,
    });
  });
});
