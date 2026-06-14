import { describe, it, expect } from 'vitest';
import { buildPublicSettings, normalizeSettingValue } from '../settings/schema';
import {
  evaluateLoadNotificationBreach,
  evaluateOfflineState,
  shouldSendOfflineNotification,
  shouldRunScheduledInterval,
} from '../index';
import { normalizeAuditLogLevel } from '../db/queries';

describe('settings schema', () => {
  it('exposes public privacy mode with a safe default', () => {
    const settings = buildPublicSettings({});

    expect(settings.public_privacy_mode).toBe('false');
  });

  it('normalizes public privacy mode as a boolean setting', () => {
    expect(normalizeSettingValue('public_privacy_mode', true)).toEqual({ ok: true, value: 'true' });
    expect(normalizeSettingValue('public_privacy_mode', '0')).toEqual({ ok: true, value: 'false' });
    expect(normalizeSettingValue('public_privacy_mode', 'maybe').ok).toBe(false);
  });
});

describe('scheduled notification helpers', () => {
  const now = new Date('2026-06-13T01:00:00.000Z');

  it('waits for the expected idle report interval plus the grace period', () => {
    expect(evaluateOfflineState({
      now: new Date('2026-06-13T10:12:59.000Z'),
      clientCreatedAt: '2026-06-13T09:00:00.000Z',
      lastTime: '2026-06-13T10:00:00.000Z',
      gracePeriodSec: 180,
      expectedReportIntervalSec: 600,
      notifyNeverReported: true,
    })).toBeNull();

    const state = evaluateOfflineState({
      now: new Date('2026-06-13T10:13:00.000Z'),
      clientCreatedAt: '2026-06-13T09:00:00.000Z',
      lastTime: '2026-06-13T10:00:00.000Z',
      gracePeriodSec: 180,
      expectedReportIntervalSec: 600,
      notifyNeverReported: true,
    });

    expect(state?.offlineMs).toBe(13 * 60 * 1000);
    expect(state?.expectedReportIntervalSec).toBe(600);
  });

  it('uses the active report interval when a viewer recently kept the agent hot', () => {
    expect(evaluateOfflineState({
      now: new Date('2026-06-13T10:02:59.000Z'),
      clientCreatedAt: '2026-06-13T09:00:00.000Z',
      lastTime: '2026-06-13T10:00:00.000Z',
      gracePeriodSec: 180,
      expectedReportIntervalSec: 3,
      notifyNeverReported: true,
    })).toBeNull();

    const state = evaluateOfflineState({
      now: new Date('2026-06-13T10:03:03.000Z'),
      clientCreatedAt: '2026-06-13T09:00:00.000Z',
      lastTime: '2026-06-13T10:00:00.000Z',
      gracePeriodSec: 180,
      expectedReportIntervalSec: 3,
      notifyNeverReported: true,
    });

    expect(state?.offlineMs).toBe(183 * 1000);
    expect(state?.expectedReportIntervalSec).toBe(3);
  });

  it('does not repeat an open offline incident after an attempt or successful send', () => {
    expect(shouldSendOfflineNotification({
      now,
    })).toBe(true);
    expect(shouldSendOfflineNotification({
      now,
      incidentLastAttempt: '2026-06-13T00:58:00.000Z',
    })).toBe(false);
    expect(shouldSendOfflineNotification({
      now,
      incidentLastSent: '2026-06-13T00:58:00.000Z',
    })).toBe(false);
  });

  it('keeps heavy scheduled tasks on the ten minute cadence', () => {
    expect(shouldRunScheduledInterval(new Date('2026-06-13T10:10:00.000Z'), 10)).toBe(true);
    expect(shouldRunScheduledInterval(new Date('2026-06-13T10:11:00.000Z'), 10)).toBe(false);
  });

  it('requires enough load samples and the configured exceed ratio', () => {
    expect(evaluateLoadNotificationBreach({ samples: 1, exceeded: 1, avg_value: 99 }, 0.8)).toBeNull();
    expect(evaluateLoadNotificationBreach({ samples: 5, exceeded: 3, avg_value: 82 }, 0.8)).toBeNull();
    expect(evaluateLoadNotificationBreach({ samples: 5, exceeded: 4, avg_value: 91 }, 0.8)).toMatchObject({
      samples: 5,
      exceeded: 4,
      avg_value: 91,
      exceedRatio: 0.8,
    });
  });
});

describe('audit log helpers', () => {
  it('normalizes audit levels to the supported enum', () => {
    expect(normalizeAuditLogLevel('info')).toBe('info');
    expect(normalizeAuditLogLevel('warning')).toBe('warning');
    expect(normalizeAuditLogLevel('warn')).toBe('warning');
    expect(normalizeAuditLogLevel('error')).toBe('error');
    expect(normalizeAuditLogLevel('debug')).toBe('info');
  });
});
