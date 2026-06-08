import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(frontendRoot, '..');
const screenshotsDir = path.join(repoRoot, 'design-previews', 'visual-smoke');
const previewPort = 4173;
const previewUrl = `http://127.0.0.1:${previewPort}`;

async function waitForHttp(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function startPreview() {
  return spawn(
    process.execPath,
    [
      path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(previewPort),
    ],
    {
      cwd: frontendRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

const preview = startPreview();
let stderr = '';
preview.stderr.on('data', chunk => { stderr += chunk; });

const publicSettings = {
  site_title: 'CF Monitor',
  site_description: 'Server monitor probe',
  live_poll_active_interval_sec: '3',
  live_poll_idle_interval_sec: '600',
  live_poll_active_max_duration_sec: '600',
};

const clients = [
  {
    uuid: 'demo-linux-gpu',
    token: 'demo-token',
    name: 'Tokyo GPU Node With A Rather Long Name',
    type: 'linux',
    os: 'Ubuntu',
    arch: 'amd64',
    group: 'edge',
    remark: 'Primary display node',
    public_remark: 'Tokyo',
    version: '1.1.0',
    virtualization: 'kvm',
    kernel_version: '6.8.0',
    cpu_name: 'AMD EPYC',
    gpu_name: 'NVIDIA RTX',
    mem_total: 64 * 1024 * 1024 * 1024,
    disk_total: 1024 * 1024 * 1024 * 1024,
    swap_total: 8 * 1024 * 1024 * 1024,
    cpu_cores: 16,
    region: 'JP',
    ipv4: '203.0.113.10',
    ipv6: '2001:db8::10',
    hidden: false,
    price: 10,
    billing_cycle: 30,
    currency: '$',
    auto_renewal: false,
    traffic_limit_type: 'sum',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    location: 'JP',
    tags: ['gpu', 'edge'],
    traffic_limit: 1099511627776,
  },
  {
    uuid: 'demo-offline',
    token: 'demo-offline-token',
    name: 'Offline Backup Node',
    type: 'linux',
    os: 'Debian',
    arch: 'amd64',
    group: 'backup',
    remark: '',
    public_remark: '',
    version: '1.1.0',
    virtualization: 'kvm',
    kernel_version: '6.6.0',
    cpu_name: 'Intel Xeon',
    gpu_name: '',
    mem_total: 8 * 1024 * 1024 * 1024,
    disk_total: 128 * 1024 * 1024 * 1024,
    swap_total: 0,
    cpu_cores: 4,
    region: 'US',
    hidden: false,
    price: 0,
    billing_cycle: 30,
    currency: '$',
    auto_renewal: false,
    traffic_limit_type: 'sum',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    location: 'US',
    tags: ['backup'],
  },
];

const liveSnapshot = {
  type: 'snapshot',
  online: ['demo-linux-gpu'],
  count: 1,
  timestamp: Date.now(),
  clients: [
    {
      uuid: 'demo-linux-gpu',
      name: clients[0].name,
      lastReportTime: Date.now(),
      cpu: 42.4,
      gpu: 61,
      ram: 18 * 1024 * 1024 * 1024,
      ram_total: 64 * 1024 * 1024 * 1024,
      swap: 1 * 1024 * 1024 * 1024,
      swap_total: 8 * 1024 * 1024 * 1024,
      disk: 360 * 1024 * 1024 * 1024,
      disk_total: 1024 * 1024 * 1024 * 1024,
      net_in: 8 * 1024 * 1024,
      net_out: 3 * 1024 * 1024,
      net_total_up: 720 * 1024 * 1024 * 1024,
      net_total_down: 980 * 1024 * 1024 * 1024,
      load: 1.8,
      temp: 56,
      uptime: 345600,
      process_count: 226,
      connections: 1024,
      connections_udp: 188,
    },
  ],
  data: {
    'demo-linux-gpu': {
      cpu: 42.4,
      gpu: 61,
      ram: 18 * 1024 * 1024 * 1024,
      ram_total: 64 * 1024 * 1024 * 1024,
      swap: 1 * 1024 * 1024 * 1024,
      swap_total: 8 * 1024 * 1024 * 1024,
      disk: 360 * 1024 * 1024 * 1024,
      disk_total: 1024 * 1024 * 1024 * 1024,
      net_in: 8 * 1024 * 1024,
      net_out: 3 * 1024 * 1024,
      net_total_up: 720 * 1024 * 1024 * 1024,
      net_total_down: 980 * 1024 * 1024 * 1024,
      load: 1.8,
      temp: 56,
      uptime: 345600,
      process_count: 226,
      connections: 1024,
      connections_udp: 188,
    },
  },
};

const adminSettings = {
  record_enabled: 'true',
  record_preserve_time: '72',
  ping_record_preserve_time: '72',
  live_poll_active_interval_sec: '3',
  live_poll_idle_interval_sec: '600',
  live_poll_active_max_duration_sec: '600',
  record_persist_interval_sec: '60',
  record_high_watermark_rows: '450000',
  capacity_daily_view_minutes: '60',
};

const capacityEstimate = {
  clients: 2,
  record_high_watermark_rows: 450000,
  ping_records_per_day: 2880,
  estimated_storage_bytes: 2530000,
  expired_row_counts: {
    records: 0,
    gpu_records: 0,
    ping_records: 12,
    audit_logs: 0,
  },
  quota_reference: {
    d1: {
      rows_written_per_day: {
        free: 100000,
        paid_estimate: Math.floor(50000000 / 30),
        paid_monthly_included: 50000000,
      },
      storage_bytes: {
        free_database: 500 * 1024 * 1024,
        paid_database: 10 * 1024 * 1024 * 1024,
        free_account: 5 * 1024 * 1024 * 1024,
      },
      estimated_row_bytes: {
        monitor_record: 420,
        ping_record: 160,
      },
      retained_rows_reference: {
        free: 500000,
        paid: 10000000,
      },
    },
    workers: {
      requests_per_day: {
        free: 100000,
        paid_included: 10000000,
      },
    },
  },
  d1_reference_rows: {
    free_reference_rows: 500000,
    paid_reference_rows: 10000000,
  },
};

const unhandledApiPaths = new Set();

function jsonPayload(body, status = 200) {
  return {
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function installApiMocks(page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === '/api/public') return route.fulfill(jsonPayload(publicSettings));
    if (pathname === '/api/clients') return route.fulfill(jsonPayload(clients));
    if (pathname === '/api/live/clients') return route.fulfill(jsonPayload(liveSnapshot));
    if (pathname === '/api/ws/live-token') return route.fulfill(jsonPayload({ token: '', expires_at: Date.now() + 600000 }));
    if (pathname === '/api/me') return route.fulfill(jsonPayload({ uuid: 'admin', username: 'admin' }));
    if (pathname === '/api/version') return route.fulfill(jsonPayload({ version: '1.0.0' }));
    if (pathname === '/api/admin/clients') return route.fulfill(jsonPayload(clients));
    if (pathname === '/api/admin/settings') return route.fulfill(jsonPayload(adminSettings));
    if (pathname === '/api/admin/capacity') return route.fulfill(jsonPayload(capacityEstimate));
    if (pathname === '/api/admin/maintenance/cleanup') return route.fulfill(jsonPayload({
      success: true,
      deleted: { records: 0, gpu_records: 0, ping_records: 12, audit_logs: 0 },
      expired_backlog_before: capacityEstimate.expired_row_counts,
      expired_backlog_after: { records: 0, gpu_records: 0, ping_records: 0, audit_logs: 0 },
      orphan_cleanup: {},
    }));
    if (pathname === '/api/task/ping') return route.fulfill(jsonPayload([]));
    if (pathname === '/api/records/ping') return route.fulfill(jsonPayload([]));
    unhandledApiPaths.add(pathname);
    return route.fulfill(jsonPayload({ error: `Unhandled visual smoke API route: ${pathname}` }, 404));
  });
}

async function assertPageHealthy(page, label) {
  const metrics = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyText: document.body.innerText,
  }));
  if (metrics.scrollWidth > metrics.width + 1) {
    throw new Error(`${label} has horizontal overflow: ${metrics.scrollWidth} > ${metrics.width}`);
  }
  if (!metrics.bodyText.trim()) {
    throw new Error(`${label} rendered no visible text`);
  }
}

try {
  await waitForHttp(previewUrl);
  await mkdir(screenshotsDir, { recursive: true });

  const browser = await chromium.launch();
  const pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    const text = message.text();
    if (message.type() === 'error' && !text.includes('Failed to load resource')) pageErrors.push(text);
  });
  await installApiMocks(page);
  await page.goto(`${previewUrl}/login`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(screenshotsDir, 'login-desktop.png'), fullPage: true });

  const bodyText = await page.locator('body').innerText();
  if (!bodyText.includes('CF Monitor')) {
    throw new Error('Login page did not render CF Monitor text');
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${previewUrl}/login`, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(screenshotsDir, 'login-mobile.png'), fullPage: true });
  await assertPageHealthy(page, 'login mobile');

  await page.close();

  const dashboardPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  dashboardPage.on('pageerror', error => pageErrors.push(error.message));
  dashboardPage.on('console', message => {
    const text = message.text();
    if (message.type() === 'error' && !text.includes('Failed to load resource')) pageErrors.push(text);
  });
  await installApiMocks(dashboardPage);
  await dashboardPage.addInitScript(() => {
    Object.defineProperty(window, 'WebSocket', { value: undefined, configurable: true });
  });
  await dashboardPage.goto(previewUrl, { waitUntil: 'networkidle' });
  await assertPageHealthy(dashboardPage, 'dashboard desktop');
  if (!(await dashboardPage.locator('text=Tokyo GPU Node').count())) {
    throw new Error('Dashboard page did not render mocked node data');
  }
  await dashboardPage.screenshot({ path: path.join(screenshotsDir, 'dashboard-desktop.png'), fullPage: true });

  await dashboardPage.setViewportSize({ width: 390, height: 844 });
  await dashboardPage.goto(previewUrl, { waitUntil: 'networkidle' });
  await assertPageHealthy(dashboardPage, 'dashboard mobile');
  await dashboardPage.screenshot({ path: path.join(screenshotsDir, 'dashboard-mobile.png'), fullPage: true });
  await dashboardPage.close();

  const adminPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  adminPage.on('pageerror', error => pageErrors.push(error.message));
  adminPage.on('console', message => {
    const text = message.text();
    if (message.type() === 'error' && !text.includes('Failed to load resource')) pageErrors.push(text);
  });
  await installApiMocks(adminPage);
  await adminPage.addInitScript(() => {
    Object.defineProperty(window, 'WebSocket', { value: undefined, configurable: true });
  });
  await adminPage.goto(`${previewUrl}/admin/settings/general`, { waitUntil: 'networkidle' });
  await assertPageHealthy(adminPage, 'admin settings general');
  if (!(await adminPage.locator('text=D1 预计存储').count())) {
    throw new Error('Settings page did not render the D1 storage quota panel');
  }
  await adminPage.screenshot({ path: path.join(screenshotsDir, 'settings-general-desktop.png'), fullPage: true });
  await adminPage.close();

  const commandPage = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  commandPage.on('pageerror', error => pageErrors.push(error.message));
  commandPage.on('console', message => {
    const text = message.text();
    if (message.type() === 'error' && !text.includes('Failed to load resource')) pageErrors.push(text);
  });
  await installApiMocks(commandPage);
  await commandPage.addInitScript(() => {
    Object.defineProperty(window, 'WebSocket', { value: undefined, configurable: true });
  });
  await commandPage.goto(`${previewUrl}/admin/clients`, { waitUntil: 'networkidle' });
  await assertPageHealthy(commandPage, 'admin clients desktop');
  const installButtons = await commandPage.getByRole('button', { name: '安装命令' }).count();
  if (installButtons !== 2) {
    throw new Error(`Expected two install command buttons, got ${installButtons}`);
  }
  await commandPage.getByRole('button', { name: '安装命令' }).first().click();
  await commandPage.locator('.install-options-grid').waitFor({ state: 'visible', timeout: 5000 });
  if (!(await commandPage.locator('text=网卡排除').count())) {
    throw new Error('Install command dialog did not render network filter options');
  }
  await assertPageHealthy(commandPage, 'admin install command dialog desktop');
  await commandPage.screenshot({ path: path.join(screenshotsDir, 'install-command-desktop.png'), fullPage: true });
  await commandPage.close();

  if (pageErrors.length) {
    throw new Error(`Console/page errors during visual smoke: ${pageErrors.slice(0, 5).join(' | ')}`);
  }
  if (unhandledApiPaths.size) {
    throw new Error(`Unhandled visual smoke API routes: ${[...unhandledApiPaths].join(', ')}`);
  }
  await browser.close();

  const indexHtml = await readFile(path.join(frontendRoot, 'dist', 'index.html'), 'utf8');
  if (!indexHtml.includes('type="module"')) {
    throw new Error('Built index.html no longer contains a module script');
  }

  console.log(`Visual smoke passed: screenshots written to ${path.relative(repoRoot, screenshotsDir)}`);
} catch (error) {
  const message = String(error?.message || error);
  if (message.includes('Executable doesn') || message.includes('browserType.launch')) {
    console.error('Visual smoke needs Playwright browsers. Run: npm --prefix frontend exec playwright install chromium');
  }
  if (stderr.trim()) {
    console.error(stderr.trim().slice(0, 1000));
  }
  throw error;
} finally {
  preview.kill();
}
