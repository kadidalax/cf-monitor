import { copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = path.join(os.tmpdir(), `cf-monitor-cloudflare-smoke-${Date.now()}`);

const REQUIRED_LINUX_OPTIONALS = [
  'node_modules/@rolldown/binding-linux-x64-gnu',
  'node_modules/lightningcss-linux-x64-gnu',
];
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      shell: process.platform === 'win32',
      stdio: 'inherit',
      env: {
        ...process.env,
        npm_config_progress: 'false',
        ...options.env,
      },
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function copyRepoSnapshot() {
  await mkdir(tmpRoot, { recursive: true });
  const entries = [
    '.gitignore',
    'README.md',
    'package-lock.json',
    'package.json',
    'wrangler.toml',
    'agent',
    'frontend',
    'worker',
  ];
  for (const entry of entries) {
    await cp(path.join(root, entry), path.join(tmpRoot, entry), {
      recursive: true,
      force: true,
      filter: (source) => {
        const normalized = source.replaceAll('\\', '/');
        return ![
          '/node_modules',
          '/dist',
          '/.wrangler',
          '/.tmp',
          '/tsconfig.tsbuildinfo',
        ].some((part) => normalized.includes(part));
      },
    });
  }
  await mkdir(path.join(tmpRoot, 'scripts'), { recursive: true });
  await copyFile(
    path.join(root, 'scripts', 'cloudflare-deploy-smoke.mjs'),
    path.join(tmpRoot, 'scripts', 'cloudflare-deploy-smoke.mjs'),
  );
}

async function assertCloudflareConfig() {
  const wranglerToml = await readFile(path.join(root, 'wrangler.toml'), 'utf8');
  if (/new_classes\s*=/.test(wranglerToml)) {
    throw new Error('Root wrangler.toml uses new_classes; free-plan Durable Objects require new_sqlite_classes.');
  }
  if (!/new_sqlite_classes\s*=\s*\["LiveDataDO"\]/.test(wranglerToml)) {
    throw new Error('Root wrangler.toml is missing new_sqlite_classes for LiveDataDO.');
  }
  if (!/new_sqlite_classes\s*=\s*\["RateLimitDO"\]/.test(wranglerToml)) {
    throw new Error('Root wrangler.toml is missing new_sqlite_classes for RateLimitDO.');
  }
  if (/database_id\s*=\s*"REPLACE_WITH_YOUR_D1_DATABASE_ID"/.test(wranglerToml)) {
    throw new Error('Root wrangler.toml must not contain a placeholder D1 database_id for deploy-button provisioning.');
  }

  const packageLock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  for (const packageName of REQUIRED_LINUX_OPTIONALS) {
    if (!packageLock.packages?.[packageName]) {
      throw new Error(`Root package-lock.json is missing Linux optional package ${packageName}.`);
    }
  }
}

try {
  await assertCloudflareConfig();
  await copyRepoSnapshot();
  await run(npmBin, ['clean-install', '--progress=false'], { cwd: tmpRoot });
  await run(npmBin, ['run', 'build'], { cwd: tmpRoot });
  await run('node', [
    './worker/node_modules/wrangler/bin/wrangler.js',
    'deploy',
    '--dry-run',
    '--config',
    'wrangler.toml',
  ], { cwd: tmpRoot });
  console.log('Cloudflare deploy smoke passed');
} finally {
  await rm(tmpRoot, { recursive: true, force: true });
}
