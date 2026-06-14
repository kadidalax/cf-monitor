import { describe, expect, it, vi } from 'vitest';
import {
  replaceAllSettings,
  restoreBackupData,
} from '../db/queries';

describe('D1 safety guards', () => {
  it('rejects oversized replacement batches before sending them to D1', async () => {
    const statement = {
      bind: vi.fn(() => statement),
    } as unknown as D1PreparedStatement;
    const database = {
      prepare: vi.fn(() => statement),
      batch: vi.fn(async () => []),
    } as unknown as D1Database;
    const settings = Object.fromEntries(
      Array.from({ length: 901 }, (_, index) => [`key_${index}`, `value_${index}`]),
    );

    await expect(replaceAllSettings(database, settings)).rejects.toThrow(/would execute .* D1 statements/);
    expect(database.batch).not.toHaveBeenCalled();
  });

  it('rejects backup restores with client references missing from backup.clients', async () => {
    const backup = {
      clients: [{ uuid: 'client-a', name: 'Client A' }],
      offline_notifications: [{ client: 'client-missing', enable: true }],
    };

    await expect(restoreBackupData({} as D1Database, backup as any)).rejects.toThrow(/references clients/);
  });
});
