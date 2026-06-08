import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const files = [
  'src/pages/admin/Notifications.tsx',
  'src/pages/admin/PingTasks.tsx',
];

const mojibakeFragments = [
  '鈹',
  '绂',
  '鎴',
  '閫',
  '璇',
  '鐩',
  '鍚',
  '澶',
  '宸',
  '娣',
  '鍒',
  '纭',
  '鏆',
  '棰',
  '瑙',
];

const frontendRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('admin page copy integrity', () => {
  it('does not contain common mojibake fragments in key admin pages', () => {
    const offenders = files.flatMap((file) => {
      const text = readFileSync(resolve(frontendRoot, file), 'utf8');
      return mojibakeFragments
        .filter((fragment) => text.includes(fragment))
        .map((fragment) => `${file}: ${fragment}`);
    });

    expect(offenders).toEqual([]);
  });
});
