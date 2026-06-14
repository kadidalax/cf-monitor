import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const workerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] === 'remote' ? 'remote' : 'local';
const d1Name = process.argv[3] || (mode === 'remote' ? 'DB' : 'cf-monitor-db');
const configRoot = process.argv[4] ? path.resolve(process.cwd(), process.argv[4]) : workerRoot;
const migrationsDir = path.join(workerRoot, 'migrations');
const wranglerBin = path.join(workerRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const configPath = path.join(configRoot, 'wrangler.toml');

const migrations = [
  '001_init.sql',
  '003_query_indexes.sql',
  '004_remove_removed_settings.sql',
  '005_login_rate_limits.sql',
  '006_ping_task_sort_order.sql',
  '007_client_sort_order.sql',
  '008_record_high_watermark.sql',
  '009_expiry_notifications.sql',
  '010_optimize_ping_indexes.sql',
  '011_align_runtime_interval_settings.sql',
  '012_ping_snapshots.sql',
  '013_gpu_snapshots.sql',
  '014_drop_redundant_client_indexes.sql',
  '015_ping_persist_interval.sql',
  '016_history_row_counters.sql',
  '017_last_seen_sessions_notifications.sql',
  '018_client_token_hash.sql',
  '019_notification_deliveries.sql',
  '020_public_privacy_mode.sql',
  '021_notification_incidents.sql',
  '022_token_hash_index.sql',
  '023_client_report_interval.sql',
];
const intentionallyManualMigrations = new Set([
  '000_reset_local.sql',
  '002_seed_demo.sql',
]);

async function fileExists(filePath) {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function tomlLineValue(content, key) {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function tomlD1Value(content, key) {
  const d1Match = content.match(/\[\[d1_databases\]\]([\s\S]*?)(?:\n\[\[|\n\[|$)/);
  if (!d1Match) return null;
  return tomlLineValue(d1Match[1], key);
}

async function validateMigrationList() {
  const files = (await readdir(migrationsDir))
    .filter(file => /^\d+_.*\.sql$/.test(file))
    .sort();
  const listed = new Set(migrations);
  const missing = files.filter(file => !listed.has(file) && !intentionallyManualMigrations.has(file));
  const stale = migrations.filter(file => !files.includes(file));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(`Migration list drift detected. Missing from script: ${missing.join(', ') || 'none'}; listed but absent: ${stale.join(', ') || 'none'}`);
  }
}

async function validateWranglerConfigSync() {
  const rootConfigPath = path.resolve(workerRoot, '..', 'wrangler.toml');
  const workerConfigPath = path.join(workerRoot, 'wrangler.toml');
  if (!await fileExists(rootConfigPath) || !await fileExists(workerConfigPath)) return;

  const [rootConfig, workerConfig] = await Promise.all([
    readFile(rootConfigPath, 'utf8'),
    readFile(workerConfigPath, 'utf8'),
  ]);
  const checks = [
    ['triggers.crons', tomlLineValue(rootConfig, 'crons'), tomlLineValue(workerConfig, 'crons')],
    ['d1.database_name', tomlD1Value(rootConfig, 'database_name'), tomlD1Value(workerConfig, 'database_name')],
    ['d1.database_id', tomlD1Value(rootConfig, 'database_id'), tomlD1Value(workerConfig, 'database_id')],
  ];
  const drift = checks
    .filter(([, rootValue, workerValue]) => rootValue !== workerValue)
    .map(([name, rootValue, workerValue]) => `${name}: root=${rootValue || 'missing'} worker=${workerValue || 'missing'}`);
  if (drift.length > 0) {
    throw new Error(`wrangler.toml drift detected; keep root and worker configs in sync for shared deployment fields. ${drift.join('; ')}`);
  }
}

function wranglerArgs(extraArgs) {
  return [wranglerBin, 'd1', 'execute', d1Name, mode === 'remote' ? '--remote' : '--local', `--config=${configPath}`, ...extraArgs];
}

function runWrangler(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: configRoot,
      shell: false,
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    if (options.capture) {
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
    }
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`wrangler ${args.slice(1).join(' ')} exited with ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function executeFile(fileName) {
  const filePath = path.join(migrationsDir, fileName);
  console.log(`[migrate] ${mode}: ${fileName}`);
  await runWrangler(wranglerArgs([`--file=${filePath}`]));
}

async function executeSql(label, sql) {
  console.log(`[migrate] ${mode}: ${label}`);
  await runWrangler(wranglerArgs([`--command=${sql}`]), { capture: true });
}

function splitStatements(sql) {
  return sql
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.trim())
    .filter(Boolean);
}

function isDuplicateColumnError(error) {
  const text = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`.toLowerCase();
  return text.includes('duplicate column name') || text.includes('already exists');
}

async function executeIdempotentColumnMigration(fileName) {
  const sql = await readFile(path.join(migrationsDir, fileName), 'utf8');
  const statements = splitStatements(sql);
  for (const [index, statement] of statements.entries()) {
    try {
      await executeSql(`${fileName} #${index + 1}`, statement);
    } catch (error) {
      if (/^\s*ALTER\s+TABLE/i.test(statement) && isDuplicateColumnError(error)) {
        console.log(`[migrate] ${fileName} #${index + 1}: column already exists, continuing`);
        continue;
      }
      throw error;
    }
  }
}

const idempotentColumnMigrations = new Set([
  '006_ping_task_sort_order.sql',
  '007_client_sort_order.sql',
  '017_last_seen_sessions_notifications.sql',
  '018_client_token_hash.sql',
  '023_client_report_interval.sql',
]);

await validateMigrationList();
await validateWranglerConfigSync();

for (const fileName of migrations) {
  if (idempotentColumnMigrations.has(fileName)) {
    await executeIdempotentColumnMigration(fileName);
  } else {
    await executeFile(fileName);
  }
}

console.log(`[migrate] ${mode}: complete`);
