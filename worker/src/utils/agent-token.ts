const CLIENT_TOKEN_HASH_PREFIX = 'sha256:';
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const STORED_HASH_RE = /^sha256:([a-f0-9]{64})$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}

export function isTokenHash(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

export function storedTokenHash(hash: string): string {
  return `${CLIENT_TOKEN_HASH_PREFIX}${hash}`;
}

export function readStoredTokenHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(STORED_HASH_RE);
  return match ? match[1] : null;
}

export function isStoredTokenHash(value: unknown): boolean {
  return readStoredTokenHash(value) !== null;
}

export async function hashAgentToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToHex(new Uint8Array(digest));
}

export async function prepareAgentTokenForStorage(token: string): Promise<{
  tokenHash: string;
  tokenPrefix: string;
  storedToken: string;
}> {
  const tokenHash = await hashAgentToken(token);
  return {
    tokenHash,
    tokenPrefix: tokenPrefix(token),
    storedToken: storedTokenHash(tokenHash),
  };
}
