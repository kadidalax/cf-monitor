import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as db from '../db/queries';
import {
  getAgentClientByToken,
  getAgentClientIdentityByToken,
  invalidateAgentClientAuthCache,
} from '../routes/client';

describe('agent auth cache', () => {
  const database = {} as D1Database;

  beforeEach(() => {
    invalidateAgentClientAuthCache();
    vi.restoreAllMocks();
  });

  it('keeps an invalid full client token invalid when the negative cache hits', async () => {
    const lookup = vi.spyOn(db, 'getClientByToken').mockResolvedValue(null);

    await expect(getAgentClientByToken(database, 'bad-token')).resolves.toBeNull();
    await expect(getAgentClientByToken(database, 'bad-token')).resolves.toBeNull();

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('keeps an invalid identity token invalid when the negative cache hits', async () => {
    const lookup = vi.spyOn(db, 'getClientIdentityByToken').mockResolvedValue(null);

    await expect(getAgentClientIdentityByToken(database, 'bad-token')).resolves.toBeNull();
    await expect(getAgentClientIdentityByToken(database, 'bad-token')).resolves.toBeNull();

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed cached rows without a non-empty uuid', async () => {
    vi.spyOn(db, 'getClientByToken').mockResolvedValue({
      uuid: '',
      name: 'invalid',
      hidden: false,
    } as db.Client);
    vi.spyOn(db, 'getClientIdentityByToken').mockResolvedValue({
      uuid: '',
      name: 'invalid',
      hidden: false,
    } as db.ClientIdentity);

    await expect(getAgentClientByToken(database, 'malformed-full')).resolves.toBeNull();
    await expect(getAgentClientIdentityByToken(database, 'malformed-identity')).resolves.toBeNull();
  });
});
