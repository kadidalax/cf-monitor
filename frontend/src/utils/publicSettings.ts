const PUBLIC_SETTINGS_CACHE_MS = 30_000;

let cachedPublicSettings: { value: Record<string, any>; expiresAt: number } | null = null;
let inflightPublicSettings: Promise<Record<string, any>> | null = null;

export function setCachedPublicSettings(settings: Record<string, any>): void {
  cachedPublicSettings = {
    value: settings,
    expiresAt: Date.now() + PUBLIC_SETTINGS_CACHE_MS,
  };
}

export function clearCachedPublicSettings(): void {
  cachedPublicSettings = null;
}

export async function fetchPublicSettings(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<Record<string, any>> {
  if (!options.force && cachedPublicSettings && cachedPublicSettings.expiresAt > Date.now()) {
    return cachedPublicSettings.value;
  }
  if (!options.force && inflightPublicSettings) {
    return inflightPublicSettings;
  }

  inflightPublicSettings = fetch('/api/public', { signal: options.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const settings = await res.json();
      if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
        setCachedPublicSettings(settings);
        return settings;
      }
      throw new Error('Invalid public settings response');
    })
    .finally(() => {
      inflightPublicSettings = null;
    });

  return inflightPublicSettings;
}
