export const LIVE_POLL_INTERVAL_ACTIVE = 3000;
export const LIVE_POLL_INTERVAL_IDLE = 10 * 60 * 1000;
export const LIVE_POLL_ACTIVE_MAX_DURATION = 10 * 60 * 1000;
export const LIVE_POLL_SETTINGS_UPDATED_EVENT = 'cf-monitor:live-poll-settings-updated';

export interface LivePollConfig {
  activeIntervalMs: number;
  idleIntervalMs: number;
  activeMaxDurationMs: number;
}

export const DEFAULT_LIVE_POLL_CONFIG: LivePollConfig = {
  activeIntervalMs: LIVE_POLL_INTERVAL_ACTIVE,
  idleIntervalMs: LIVE_POLL_INTERVAL_IDLE,
  activeMaxDurationMs: LIVE_POLL_ACTIVE_MAX_DURATION,
};

function secondsToMsSetting(
  value: unknown,
  fallbackSeconds: number,
  minSeconds: number,
  maxSeconds: number,
) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  const seconds = Number.isFinite(parsed) ? parsed : fallbackSeconds;
  return Math.min(Math.max(seconds, minSeconds), maxSeconds) * 1000;
}

export function normalizeLivePollConfig(settings: Record<string, unknown> | null | undefined): LivePollConfig {
  return {
    activeIntervalMs: secondsToMsSetting(settings?.live_poll_active_interval_sec, 3, 3, 300),
    idleIntervalMs: secondsToMsSetting(settings?.live_poll_idle_interval_sec, 600, 60, 3600),
    activeMaxDurationMs: secondsToMsSetting(settings?.live_poll_active_max_duration_sec, 600, 60, 3600),
  };
}

export function getLivePollDelay({
  hidden,
  activeSince,
  now = Date.now(),
  config = DEFAULT_LIVE_POLL_CONFIG,
}: {
  hidden: boolean;
  activeSince?: number | null;
  now?: number;
  config?: LivePollConfig;
}) {
  if (hidden) return config.idleIntervalMs;
  if (activeSince !== null && activeSince !== undefined && now - activeSince >= config.activeMaxDurationMs) {
    return config.idleIntervalMs;
  }
  return config.activeIntervalMs;
}

export function shouldReconnectLiveWebSocket({
  expired,
  hidden,
}: {
  expired: boolean;
  hidden: boolean;
}) {
  return !expired && !hidden;
}

export function getFallbackViewerExpiry({
  currentExpiresAt,
  now = Date.now(),
  config = DEFAULT_LIVE_POLL_CONFIG,
}: {
  currentExpiresAt?: number | null;
  now?: number;
  config?: LivePollConfig;
}) {
  return currentExpiresAt ?? now + config.activeMaxDurationMs;
}

export function isViewerWindowExpired({
  expiresAt,
  now = Date.now(),
}: {
  expiresAt?: number | null;
  now?: number;
}) {
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && now >= expiresAt;
}
