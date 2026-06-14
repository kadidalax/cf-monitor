type SettingType = 'string' | 'boolean' | 'integer' | 'enum';

interface SettingDefinition {
  type: SettingType;
  defaultValue: string;
  public: boolean;
  sensitive?: boolean;
  safeImageUrl?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  values?: readonly string[];
  minLengthWhenSet?: number;
}

const REMOVED_SETTING_KEYS = new Set([
  'allow_cors',
  'private_site',
  'private_site_password',
  'tempory_share_token',
  'tempory_share_token_expire_at',
  'temporary_share_token',
  'temporary_share_token_expire_at',
  'custom_head',
  'custom_body',
  'custom_footer_html',
  'agent_auto_discovery_key',
]);

export const SETTING_SCHEMA = {
  site_title: {
    type: 'string',
    defaultValue: 'CF Monitor',
    public: true,
    maxLength: 128,
  },
  site_subtitle: {
    type: 'string',
    defaultValue: '',
    public: true,
    maxLength: 128,
  },
  site_description: {
    type: 'string',
    defaultValue: '服务器监控探针',
    public: true,
    maxLength: 512,
  },
  language: {
    type: 'string',
    defaultValue: 'zh-CN',
    public: true,
    maxLength: 32,
  },
  script_domain: {
    type: 'string',
    defaultValue: '',
    public: true,
    maxLength: 256,
  },
  public_privacy_mode: {
    type: 'boolean',
    defaultValue: 'false',
    public: true,
  },
  record_enabled: {
    type: 'boolean',
    defaultValue: 'true',
    public: false,
  },
  record_preserve_time: {
    type: 'integer',
    defaultValue: '72',
    public: false,
    min: 1,
    max: 72,
  },
  ping_record_preserve_time: {
    type: 'integer',
    defaultValue: '72',
    public: false,
    min: 1,
    max: 72,
  },
  record_persist_interval_sec: {
    type: 'integer',
    defaultValue: '60',
    public: false,
    min: 3,
    max: 3600,
  },
  ping_record_persist_interval_sec: {
    type: 'integer',
    defaultValue: '300',
    public: true,
    min: 60,
    max: 3600,
  },
  record_high_watermark_rows: {
    type: 'integer',
    defaultValue: '450000',
    public: false,
    min: 1000,
    max: 10000000,
  },
  capacity_daily_view_minutes: {
    type: 'integer',
    defaultValue: '60',
    public: false,
    min: 0,
    max: 1440,
  },
  audit_log_preserve_time: {
    type: 'integer',
    defaultValue: '2160',
    public: false,
    min: 24,
    max: 87600,
  },
  live_poll_active_interval_sec: {
    type: 'integer',
    defaultValue: '3',
    public: true,
    min: 3,
    max: 300,
  },
  live_poll_idle_interval_sec: {
    type: 'integer',
    defaultValue: '600',
    public: true,
    min: 60,
    max: 3600,
  },
  live_poll_active_max_duration_sec: {
    type: 'integer',
    defaultValue: '600',
    public: true,
    min: 60,
    max: 3600,
  },
  notification_method: {
    type: 'enum',
    defaultValue: 'telegram',
    public: false,
    values: ['telegram', 'none'],
  },
  telegram_bot_token: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 256,
  },
  telegram_chat_id: {
    type: 'string',
    defaultValue: '',
    public: false,
    sensitive: true,
    maxLength: 128,
  },
  enable_ip_change_notification: {
    type: 'boolean',
    defaultValue: 'false',
    public: false,
  },
  offline_notify_never_reported: {
    type: 'boolean',
    defaultValue: 'true',
    public: false,
  },
  theme_bg_desktop: {
    type: 'string',
    defaultValue: '',
    public: true,
    safeImageUrl: true,
    maxLength: 1024,
  },
  theme_bg_mobile: {
    type: 'string',
    defaultValue: '',
    public: true,
    safeImageUrl: true,
    maxLength: 1024,
  },
  theme_content_width: {
    type: 'integer',
    defaultValue: '100',
    public: true,
    min: 60,
    max: 100,
  },
} as const satisfies Record<string, SettingDefinition>;

type SettingKey = keyof typeof SETTING_SCHEMA;

const SETTING_KEYS = Object.keys(SETTING_SCHEMA) as SettingKey[];
export const PUBLIC_SETTING_KEYS = SETTING_KEYS.filter(key => SETTING_SCHEMA[key].public);
const SETTING_KEY_SET = new Set<string>(SETTING_KEYS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function settingToString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

function normalizeBoolean(value: unknown): string | null {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return 'true';
  if (normalized === 'false' || normalized === '0') return 'false';
  return null;
}

function normalizeInteger(value: unknown, definition: SettingDefinition): string | null {
  if (value === '' || value === null || value === undefined) {
    return definition.defaultValue;
  }
  const numberValue = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(numberValue) || !Number.isInteger(numberValue)) return null;
  if (definition.min !== undefined && numberValue < definition.min) return null;
  if (definition.max !== undefined && numberValue > definition.max) return null;
  return String(numberValue);
}

const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i;
const SAFE_RELATIVE_URL_ORIGIN = 'https://cf-monitor.local';

function normalizeSafeImageUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/[\x00-\x1F\x7F]/.test(trimmed)) return null;

  if (SAFE_DATA_IMAGE_PATTERN.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('/')) {
    if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return null;
    try {
      const parsed = new URL(trimmed, SAFE_RELATIVE_URL_ORIGIN);
      if (parsed.origin !== SAFE_RELATIVE_URL_ORIGIN) return null;
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isKnownSettingKey(key: string): key is SettingKey {
  return SETTING_KEY_SET.has(key);
}

export function normalizeSettingValue(
  key: string,
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (!isKnownSettingKey(key)) {
    return { ok: false, error: `未知设置: ${key}` };
  }

  const definition: SettingDefinition = SETTING_SCHEMA[key];
  let normalized: string | null = null;

  switch (definition.type) {
    case 'boolean':
      normalized = normalizeBoolean(value);
      break;
    case 'integer':
      normalized = normalizeInteger(value, definition);
      break;
    case 'enum': {
      const text = settingToString(value);
      normalized = text && definition.values?.includes(text) ? text : null;
      break;
    }
    case 'string':
      normalized = settingToString(value);
      break;
  }

  if (normalized === null) {
    return { ok: false, error: `${key} 类型或取值无效` };
  }

  if (definition.safeImageUrl) {
    normalized = normalizeSafeImageUrl(normalized);
    if (normalized === null) {
      return { ok: false, error: `${key} 只允许 https://、同源路径或安全 data:image 背景` };
    }
  }

  if (definition.maxLength !== undefined && normalized.length > definition.maxLength) {
    return { ok: false, error: `${key} 超过最大长度 ${definition.maxLength}` };
  }

  if (
    definition.minLengthWhenSet !== undefined &&
    normalized.length > 0 &&
    normalized.length < definition.minLengthWhenSet
  ) {
    return { ok: false, error: `${key} 至少需要 ${definition.minLengthWhenSet} 个字符` };
  }

  return { ok: true, value: normalized };
}

export function sanitizeSettingsForStorage(
  input: unknown,
  options: { ignoreRemoved?: boolean } = {},
): { ok: boolean; settings: Record<string, string>; errors: string[]; ignoredKeys: string[] } {
  const ignoreRemoved = options.ignoreRemoved ?? true;
  if (!isPlainObject(input)) {
    return { ok: false, settings: {}, errors: ['设置必须是对象'], ignoredKeys: [] };
  }

  const settings: Record<string, string> = {};
  const errors: string[] = [];
  const ignoredKeys: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (REMOVED_SETTING_KEYS.has(key) && ignoreRemoved) {
      ignoredKeys.push(key);
      continue;
    }
    const normalized = normalizeSettingValue(key, value);
    if (!normalized.ok) {
      errors.push(normalized.error);
      continue;
    }
    settings[key] = normalized.value;
  }

  return { ok: errors.length === 0, settings, errors, ignoredKeys };
}

export function buildAdminSettings(stored: Record<string, string>): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const normalized = normalizeSettingValue(key, stored[key] ?? SETTING_SCHEMA[key].defaultValue);
    settings[key] = normalized.ok ? normalized.value : SETTING_SCHEMA[key].defaultValue;
  }
  return settings;
}

export function buildPublicSettings(stored: Record<string, string>): Record<string, any> {
  const adminSettings = buildAdminSettings(stored);
  const publicSettings: Record<string, any> = {};

  for (const key of SETTING_KEYS) {
    if (!SETTING_SCHEMA[key].public || key.startsWith('theme_')) continue;
    publicSettings[key] = adminSettings[key];
  }

  publicSettings.theme_settings = {
    backgroundImageUrlDesktop: adminSettings.theme_bg_desktop,
    backgroundImageUrlMobile: adminSettings.theme_bg_mobile,
    mainContentWidth: Number(adminSettings.theme_content_width),
  };

  return publicSettings;
}

export function isRecordPersistenceEnabled(settings: Record<string, string> | string | null | undefined): boolean {
  const value = typeof settings === 'string'
    ? settings
    : settings?.record_enabled;
  const normalized = normalizeSettingValue('record_enabled', value ?? SETTING_SCHEMA.record_enabled.defaultValue);
  return normalized.ok ? normalized.value === 'true' : true;
}
