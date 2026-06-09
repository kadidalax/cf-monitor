import { readFile } from 'node:fs/promises';
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
];

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

for (const fileName of migrations) {
  if (fileName === '006_ping_task_sort_order.sql' || fileName === '007_client_sort_order.sql') {
    await executeIdempotentColumnMigration(fileName);
  } else {
    await executeFile(fileName);
  }
}

console.log(`[migrate] ${mode}: complete`);
