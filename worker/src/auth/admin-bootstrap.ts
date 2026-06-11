import * as db from '../db/queries';
import { hashPassword, passwordHashExceedsCurrentCost } from './password';

const MIN_INITIAL_ADMIN_PASSWORD_BYTES = 12;
const LEGACY_DEFAULT_ADMIN = {
  uuid: 'admin-uuid-001',
  username: 'admin',
  hashedPassword: '98072d1ac6b14e04d93c1da0588d04d474eaf29ef88e06e7b6ccc40b0d0a349a',
};

type AdminBootstrapEnv = {
  DB: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
};

export type AdminBootstrapErrorCode = 'missing_credentials' | 'weak_password';

export class AdminBootstrapError extends Error {
  constructor(readonly code: AdminBootstrapErrorCode) {
    super(code);
    this.name = 'AdminBootstrapError';
  }
}

function readInitialAdminEnv(env: AdminBootstrapEnv): { username: string; password: string } {
  const username = env.ADMIN_USERNAME?.trim() ?? '';
  const password = env.ADMIN_PASSWORD ?? '';

  if (!username || password.length === 0) {
    throw new AdminBootstrapError('missing_credentials');
  }

  if (new TextEncoder().encode(password).byteLength < MIN_INITIAL_ADMIN_PASSWORD_BYTES) {
    throw new AdminBootstrapError('weak_password');
  }

  return { username, password };
}

function readOptionalInitialAdminEnv(env: AdminBootstrapEnv): { username: string; password: string } | null {
  const username = env.ADMIN_USERNAME?.trim() ?? '';
  const password = env.ADMIN_PASSWORD ?? '';

  if (!username || password.length === 0) return null;
  if (new TextEncoder().encode(password).byteLength < MIN_INITIAL_ADMIN_PASSWORD_BYTES) return null;

  return { username, password };
}

function isUnchangedLegacyDefaultAdmin(user: db.User | null): boolean {
  return Boolean(
    user &&
    user.uuid === LEGACY_DEFAULT_ADMIN.uuid &&
    user.username === LEGACY_DEFAULT_ADMIN.username &&
    user.passwd.toLowerCase() === LEGACY_DEFAULT_ADMIN.hashedPassword,
  );
}

async function bestEffortAuditLog(
  env: AdminBootstrapEnv,
  user: string,
  action: string,
  detail: string,
): Promise<void> {
  try {
    await db.insertAuditLog(env.DB, user, action, detail);
  } catch (error) {
    console.error('[auth] admin bootstrap audit failed:', error);
  }
}

async function createInitialAdmin(env: AdminBootstrapEnv, username: string, password: string): Promise<boolean> {
  const created = await db.createUser(env.DB, {
    uuid: crypto.randomUUID(),
    username,
    hashedPassword: await hashPassword(password),
  });

  if (created) {
    await bestEffortAuditLog(env, username, 'admin_bootstrap', 'Initialized first admin from environment variables');
  }

  return created;
}

async function refreshConfiguredAdminHashIfNeeded(env: AdminBootstrapEnv): Promise<void> {
  const configuredAdmin = readOptionalInitialAdminEnv(env);
  if (!configuredAdmin) return;

  const user = await db.getUserByUsername(env.DB, configuredAdmin.username);
  if (!user || !passwordHashExceedsCurrentCost(user.passwd)) return;

  await db.updateUserPassword(env.DB, user.uuid, await hashPassword(configuredAdmin.password));
  await bestEffortAuditLog(
    env,
    configuredAdmin.username,
    'admin_bootstrap',
    'Refreshed initial admin password hash for Workers CPU limits',
  );
}

export async function ensureInitialAdmin(env: AdminBootstrapEnv): Promise<void> {
  const userCount = await db.countUsers(env.DB);
  const legacyDefaultAdmin = await db.getUserByUsername(env.DB, LEGACY_DEFAULT_ADMIN.username);
  const hasUnchangedLegacyDefaultAdmin = isUnchangedLegacyDefaultAdmin(legacyDefaultAdmin);

  if (userCount === 0) {
    const { username, password } = readInitialAdminEnv(env);
    await createInitialAdmin(env, username, password);
    return;
  }

  if (!hasUnchangedLegacyDefaultAdmin) {
    await refreshConfiguredAdminHashIfNeeded(env);
    return;
  }

  if (userCount > 1) {
    const removed = await db.deleteUserIfMatches(env.DB, LEGACY_DEFAULT_ADMIN);
    if (removed) {
      await bestEffortAuditLog(env, 'system', 'admin_bootstrap', 'Removed unchanged legacy default admin');
    }
    return;
  }

  const { username, password } = readInitialAdminEnv(env);

  if (username === LEGACY_DEFAULT_ADMIN.username) {
    await db.updateUserPassword(env.DB, LEGACY_DEFAULT_ADMIN.uuid, await hashPassword(password));
    await bestEffortAuditLog(env, username, 'admin_bootstrap', 'Replaced legacy default admin password from environment variable');
    return;
  }

  await createInitialAdmin(env, username, password);
  const removed = await db.deleteUserIfMatches(env.DB, LEGACY_DEFAULT_ADMIN);
  if (removed) {
    await bestEffortAuditLog(env, username, 'admin_bootstrap', 'Replaced legacy default admin with environment admin');
  }
}
