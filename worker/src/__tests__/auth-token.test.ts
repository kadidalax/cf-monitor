import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPasswordResetToken,
  generateResetToken,
} from '../auth/password-reset';
import { generateTokenPair } from '../auth/refresh-token';

describe('auth token generation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generates password reset tokens with Web Crypto entropy', () => {
    const mathRandom = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used for reset tokens');
    });

    const token = generateResetToken();

    expect(token).toMatch(/^rst_[a-f0-9]{64}$/);
    expect(mathRandom).not.toHaveBeenCalled();
  });

  it('stores only a password reset token hash in D1', async () => {
    const boundParams: unknown[][] = [];
    const statement = {
      bind: vi.fn((...args: unknown[]) => {
        boundParams.push(args);
        return statement;
      }),
      run: vi.fn(async () => ({ meta: { changes: 1 } })),
    };
    const database = {
      prepare: vi.fn(() => statement),
    } as unknown as D1Database;

    const token = await createPasswordResetToken(database, 'user-1', 'admin@example.com');

    expect(token).toMatch(/^rst_[a-f0-9]{64}$/);
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining('token_hash'));
    expect(boundParams[0][0]).toMatch(/^[a-f0-9]{64}$/);
    expect(boundParams[0][0]).not.toBe(token);
    expect(boundParams[0][1]).toBe('user-1');
  });

  it('generates refresh token JTI values without Math.random', async () => {
    const mathRandom = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used for refresh token JTI values');
    });

    const pair = await generateTokenPair('user-1', 'admin', 'x'.repeat(32));

    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();
    expect(mathRandom).not.toHaveBeenCalled();
  });
});
