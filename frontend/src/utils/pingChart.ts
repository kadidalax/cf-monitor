export interface PingTask {
  id: number | string;
  name?: string;
  type?: string;
  target?: string;
  clients?: string[] | string;
  all_clients?: boolean | number | string;
  interval?: number;
  interval_sec?: number;
}

export interface PingRecord {
  time: string;
  value: number;
  task_id?: number | string;
}

export interface NormalizedPingTask {
  id: number;
  key: string;
  label: string;
  target: string;
  type: string;
  intervalSec: number;
  color: string;
}

export interface PingTaskSeries {
  task: NormalizedPingTask;
  records: PingRecord[];
}

export type PingChartRow = {
  time: number;
  [key: string]: number | null;
};

export interface PingSeriesStats {
  latest: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p99: number;
}

const pingSeriesColors = [
  '#D84F57',
  '#347433',
  '#6F72C5',
  '#008F8A',
  '#0E93B5',
  '#8257D8',
  '#D9643A',
  '#B89600',
];

const demoTaskColorOrder = [
  'Demo - Cloudflare ICMP',
  'Demo - IPv6 DNS',
  'Demo - HTTPS 443',
];

function getTaskColor(task: PingTask, index: number) {
  const demoIndex = demoTaskColorOrder.findIndex((name) => name === task.name);
  const colorIndex = demoIndex >= 0 ? demoIndex : index + demoTaskColorOrder.length;
  return pingSeriesColors[colorIndex % pingSeriesColors.length];
}

function toClients(value: PingTask['clients']): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function isAllClients(value: PingTask['all_clients']) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

export function pingTaskAppliesToClient(task: PingTask, uuid: string) {
  const clients = toClients(task.clients);
  return isAllClients(task.all_clients) || clients.length === 0 || clients.includes(uuid);
}

export function normalizePingTask(task: PingTask, index: number): NormalizedPingTask | null {
  const id = Number(task.id);
  if (!Number.isFinite(id) || id <= 0) return null;

  const target = (task.target || task.name || `Task ${id}`).trim();
  const type = (task.type || 'ping').toUpperCase();
  const intervalSec = Number(task.interval_sec || task.interval || 60);

  return {
    id,
    key: `task_${id}`,
    label: (task.name || target).trim(),
    target,
    type,
    intervalSec: Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 60,
    color: getTaskColor(task, index),
  };
}

function findAnchor(anchors: number[], timestamp: number, toleranceMs: number) {
  for (const anchor of anchors) {
    if (Math.abs(anchor - timestamp) <= toleranceMs) return anchor;
  }
  return null;
}

export function buildPingChartRows(series: PingTaskSeries[]) {
  const validIntervals = series
    .map((item) => item.task.intervalSec)
    .filter((value) => Number.isFinite(value) && value > 0);
  const minInterval = validIntervals.length ? Math.min(...validIntervals) : 60;
  const toleranceMs = Math.min(1500, Math.max(800, Math.floor(minInterval * 1000 * 0.4)));
  const anchors: number[] = [];
  const grouped: Record<number, PingChartRow> = {};

  for (const item of series) {
    for (const record of item.records) {
      const timestamp = new Date(record.time).getTime();
      if (!Number.isFinite(timestamp)) continue;

      const anchor = findAnchor(anchors, timestamp, toleranceMs);
      const useTimestamp = anchor ?? timestamp;
      if (!grouped[useTimestamp]) {
        grouped[useTimestamp] = { time: useTimestamp };
        if (anchor === null) anchors.push(useTimestamp);
      }
      grouped[useTimestamp][item.task.key] = record.value < 0 ? null : Number(record.value);
    }
  }

  return Object.values(grouped).sort((a, b) => Number(a.time) - Number(b.time));
}

function getLatestPingTimestamp(series: PingTaskSeries[]) {
  const timestamps = series.flatMap((item) =>
    item.records
      .map((record) => new Date(record.time).getTime())
      .filter((timestamp) => Number.isFinite(timestamp)),
  );
  return timestamps.length ? Math.max(...timestamps) : null;
}

export function limitPingSeriesToRecentRange(series: PingTaskSeries[], rangeHours?: number) {
  if (!rangeHours || rangeHours <= 0) return series;

  const latest = getLatestPingTimestamp(series);
  if (!latest) return series;

  const cutoff = latest - rangeHours * 3600000;
  return series.map((item) => ({
    ...item,
    records: item.records.filter((record) => {
      const timestamp = new Date(record.time).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= latest;
    }),
  }));
}

export function getPingTimeDomain(series: PingTaskSeries[], rangeHours?: number): [number | string, number | string] {
  const latest = getLatestPingTimestamp(series);
  if (!latest || !rangeHours || rangeHours <= 0) return ['dataMin', 'dataMax'];
  return [latest - rangeHours * 3600000, latest];
}

export function getPingValues(series: PingTaskSeries[]) {
  return series.flatMap((item) =>
    item.records
      .map((record) => Number(record.value))
      .filter((value) => Number.isFinite(value) && value >= 0),
  );
}

export function getPingYAxisDomain(series: PingTaskSeries[]): [number, number] {
  const values = getPingValues(series);
  if (values.length === 0) return [0, 100];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const padding = range > 0 ? Math.max(5, range * 0.35) : Math.max(8, max * 0.25);
  const lower = Math.max(0, min - padding);
  const upper = max + padding;

  if (upper - lower < 12) {
    const extra = (12 - (upper - lower)) / 2;
    return [Math.max(0, lower - extra), upper + extra];
  }

  return [lower, upper];
}

export function getPingSeriesStats(records: PingRecord[]): PingSeriesStats | null {
  const chronological = records
    .map((record) => Number(record.value))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (chronological.length === 0) return null;

  const sorted = [...chronological].sort((a, b) => a - b);
  const sum = chronological.reduce((total, value) => total + value, 0);
  const pick = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];

  return {
    latest: chronological[chronological.length - 1],
    avg: sum / chronological.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: pick(0.5),
    p99: pick(0.99),
  };
}

export function formatPingMs(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return '-';
  return `${Math.round(numberValue)} ms`;
}

export async function fetchPingTaskSeries(
  uuid: string,
  {
    limit = 180,
    maxTasks = 8,
    rangeHours,
    signal,
  }: {
    limit?: number;
    maxTasks?: number;
    rangeHours?: number;
    signal?: AbortSignal;
  } = {},
): Promise<PingTaskSeries[]> {
  const taskResponse = await fetch('/api/task/ping', { signal });
  if (!taskResponse.ok) throw new Error(`HTTP ${taskResponse.status}`);

  const taskData = await taskResponse.json();
  const tasks = (Array.isArray(taskData) ? taskData : [])
    .filter((task) => pingTaskAppliesToClient(task, uuid))
    .map((task, index) => normalizePingTask(task, index))
    .filter((task): task is NormalizedPingTask => Boolean(task))
    .slice(0, maxTasks);

  const series = await Promise.all(
    tasks.map(async (task) => {
      try {
        const rangeLimit = rangeHours
          ? Math.ceil((rangeHours * 3600) / task.intervalSec) + 4
          : 0;
        const requestLimit = Math.min(360, Math.max(limit, rangeLimit));
        const recordsResponse = await fetch(
          `/api/records/ping?uuid=${encodeURIComponent(uuid)}&task_id=${task.id}&limit=${requestLimit}`,
          { signal },
        );
        if (!recordsResponse.ok) return { task, records: [] };
        const records = await recordsResponse.json();
        return {
          task,
          records: Array.isArray(records) ? records : [],
        };
      } catch {
        return { task, records: [] };
      }
    }),
  );

  return limitPingSeriesToRecentRange(series, rangeHours);
}
