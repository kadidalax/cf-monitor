import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { Badge, Box, Button, Flex, Grid, Text } from '@radix-ui/themes';
import { Database, Eye, Gauge, HardDrive, Save, Server } from 'lucide-react';
import { toast } from 'sonner';
import Loading from '../../components/Loading';
import { useApi } from '../../contexts/AuthContext';
import { LIVE_POLL_SETTINGS_UPDATED_EVENT } from '../../contexts/livePolling';
import { SettingCard, SettingInput, SettingToggle } from '../../components/admin/SettingCard';
import type { SettingsLayoutOutletContext } from './SettingsLayout';

type SettingsMap = Record<string, string>;

interface CapacityEstimate {
  clients: number;
  gpu_clients?: number;
  capacity_daily_view_minutes?: number;
  record_persist_interval_sec?: number;
  ping_record_persist_interval_sec?: number;
  record_high_watermark_rows?: number;
  active_monitor_records_per_day?: number;
  idle_monitor_records_per_day?: number;
  monitor_records_per_day?: number;
  active_gpu_snapshots_per_day?: number;
  idle_gpu_snapshots_per_day?: number;
  gpu_snapshots_per_day?: number;
  estimated_rows_retained?: number;
  estimated_storage_bytes?: number;
  estimated_gpu_snapshots_retained?: number;
  ping_records_per_day: number;
  monitor_d1_rows_written_per_day?: number;
  gpu_d1_rows_written_per_day?: number;
  ping_d1_rows_written_per_day?: number;
  total_estimated_business_rows_per_day?: number;
  total_estimated_writes_per_day?: number;
  total_estimated_reads_per_day?: number;
  write_amplified_d1_rows_read_per_day?: number;
  public_metadata_d1_rows_read_per_day?: number;
  agent_auth_d1_rows_read_per_day?: number;
  agent_ping_d1_rows_read_per_day?: number;
  ping_result_reports_per_day?: number;
  agent_ping_task_pulls_per_day?: number;
  agent_basic_info_reports_per_day?: number;
  agent_websocket_connects_per_day?: number;
  estimated_worker_requests_per_day?: number;
  legacy_ping_records_per_day?: number;
  ping_records_saved_per_day?: number;
  ping_storage_mode?: string;
  ping_tasks?: Array<{
    id: number;
    name?: string;
    target_client_count?: number;
  }>;
  d1_reference_rows?: {
    free_warning_rows?: number;
    paid_warning_rows?: number;
    free_reference_rows?: number;
    paid_reference_rows?: number;
  };
  expired_row_counts?: {
    records?: number;
    gpu_records?: number;
    gpu_snapshots?: number;
    ping_records?: number;
    ping_snapshots?: number;
    audit_logs?: number;
  } | null;
  row_counts_checked_at?: string;
  row_counts_cache_seconds?: number;
  quota_reference?: {
    d1?: {
      rows_written_per_day?: {
        free?: number;
        paid_estimate?: number;
        paid_monthly_included?: number;
        paid_estimate_note?: string;
      };
      rows_read_per_day?: {
        free?: number;
        paid_estimate?: number;
        paid_monthly_included?: number;
        paid_estimate_note?: string;
      };
      storage_bytes?: {
        free_database?: number;
        paid_database?: number;
        free_account?: number;
      };
      estimated_row_bytes?: {
        monitor_record?: number;
        gpu_snapshot?: number;
        ping_record?: number;
        ping_snapshot?: number;
      };
      retained_rows_reference?: {
        free?: number;
        paid?: number;
        note?: string;
      };
      retained_rows_warning?: {
        free?: number;
        paid?: number;
      };
    };
    workers?: {
      requests_per_day?: {
        free?: number;
        paid_included?: number;
      };
    };
  };
}

const DEFAULT_RETENTION_HOURS = 72;
const MAX_RETENTION_HOURS = 72;
const DEFAULT_ACTIVE_SAMPLE_SEC = 3;
const DEFAULT_IDLE_UPLOAD_SEC = 600;
const MIN_IDLE_UPLOAD_SEC = 60;
const DEFAULT_VIEWER_TTL_SEC = 600;
const DEFAULT_RECORD_PERSIST_SEC = 60;
const DEFAULT_PING_RECORD_PERSIST_SEC = 300;
const DEFAULT_RECORD_HIGH_WATERMARK_ROWS = 450_000;
const DEFAULT_DAILY_VIEW_MINUTES = 60;
const D1_FREE_DAILY_WRITES_FALLBACK = 100_000;
const D1_PAID_MONTHLY_WRITES_FALLBACK = 50_000_000;
const D1_PAID_DAILY_WRITES_FALLBACK = Math.floor(50_000_000 / 30);
const D1_FREE_DAILY_READS_FALLBACK = 5_000_000;
const D1_PAID_MONTHLY_READS_FALLBACK = 25_000_000_000;
const D1_PAID_DAILY_READS_FALLBACK = Math.floor(D1_PAID_MONTHLY_READS_FALLBACK / 30);
const D1_FREE_DATABASE_STORAGE_BYTES = 500 * 1024 * 1024;
const D1_PAID_DATABASE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
const ESTIMATED_MONITOR_RECORD_BYTES = 420;
const ESTIMATED_GPU_SNAPSHOT_BYTES = 420;
const ESTIMATED_PING_RECORD_BYTES = 160;
const ESTIMATED_PING_SNAPSHOT_BYTES = 220;
const WORKER_FREE_DAILY_REQUESTS = 100_000;
const WORKER_PAID_DAILY_REQUESTS = 10_000_000;
const MONITOR_RECORD_D1_ROWS_WRITTEN = 3;
const GPU_SNAPSHOT_D1_ROWS_WRITTEN = 3;
const PING_SNAPSHOT_D1_ROWS_WRITTEN = 3;
const D1_ROWS_READ_PER_WRITE_ESTIMATE = 30;
const AGENT_AUTH_CACHE_SEC = 15;
const PUBLIC_CLIENT_REFRESH_INTERVAL_SEC = 60;

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function formatInteger(value: number | undefined): string {
  return Math.ceil(Number(value || 0)).toLocaleString();
}

function formatBytes(bytes: number | undefined): string {
  const value = Math.max(0, Number(bytes || 0));
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} B`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  if (value < 0.1 && value > 0) return '<0.1%';
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function getSettingValue(settings: SettingsMap, key: string, fallback: string): string {
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallback;
}

function getPercentTone(value: number): 'green' | 'amber' | 'red' {
  if (value >= 70) return 'red';
  if (value >= 45) return 'amber';
  return 'green';
}

function sumRowCounts(counts: CapacityEstimate['expired_row_counts']): number {
  if (!counts) return 0;
  return Number(counts.records || 0)
    + Number(counts.gpu_records || 0)
    + Number(counts.gpu_snapshots || 0)
    + Number(counts.ping_records || 0)
    + Number(counts.ping_snapshots || 0)
    + Number(counts.audit_logs || 0);
}

function dailySamplesPerClient(intervalSec: number): number {
  return intervalSec > 0 ? Math.ceil(86400 / intervalSec) : 0;
}

function inferPingCoveredClients(capacity: CapacityEstimate | null, clients: number, intervalSec: number): number {
  const pingTasks = capacity?.ping_tasks || [];
  if (clients <= 0 || pingTasks.length === 0) return 0;

  const aggregateReportsPerDay = Math.max(
    0,
    Number(capacity?.ping_result_reports_per_day || capacity?.ping_records_per_day || 0),
  );
  const rowsPerClient = dailySamplesPerClient(intervalSec);
  if (aggregateReportsPerDay > 0 && rowsPerClient > 0) {
    return Math.min(clients, Math.max(0, Math.round(aggregateReportsPerDay / rowsPerClient)));
  }

  const summedTaskTargets = pingTasks.reduce(
    (sum, task) => sum + Math.max(0, Number(task.target_client_count || 0)),
    0,
  );
  return Math.min(clients, summedTaskTargets);
}

function EstimateMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'blue' | 'green' | 'amber' | 'orange' | 'red' | 'purple';
}) {
  return (
    <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
      <Text size="1" color="gray">{label}</Text>
      <Badge variant="soft" color={tone || 'gray'} style={{ width: 'fit-content' }}>{value}</Badge>
    </Flex>
  );
}

function QuotaBar({
  label,
  value,
  percent,
  caption,
  icon,
}: {
  label: string;
  value: string;
  percent: number;
  caption: string;
  icon: React.ReactNode;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = getPercentTone(percent);

  return (
    <div className={`quota-estimate-card quota-estimate-card-${tone}`}>
      <Flex align="center" justify="between" gap="3">
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <span className="quota-estimate-icon" aria-hidden="true">{icon}</span>
          <Flex direction="column" style={{ minWidth: 0 }}>
            <Text size="1" color="gray">{label}</Text>
            <Text size="3" weight="bold" style={{ fontFamily: 'var(--font-mono, monospace)' }}>{value}</Text>
          </Flex>
        </Flex>
        <Badge variant="soft" color={tone}>{formatPercent(percent)}</Badge>
      </Flex>
      <div className="quota-estimate-track" aria-hidden="true">
        <div className="quota-estimate-fill" style={{ width: `${clamped}%` }} />
      </div>
      <Text size="1" color="gray">{caption}</Text>
    </div>
  );
}

export default function SettingsGeneral() {
  const apiFetch = useApi();
  const { setAction } = useOutletContext<SettingsLayoutOutletContext>();
  const [settings, setSettings] = useState<SettingsMap>({});
  const [capacity, setCapacity] = useState<CapacityEstimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const refreshCapacity = useCallback(async (forceCounts = false) => {
    const path = forceCounts ? '/admin/capacity?refresh_counts=true' : '/admin/capacity';
    const capacityData = await apiFetch(path).catch(() => null);
    if (capacityData && typeof capacityData === 'object') setCapacity(capacityData as CapacityEstimate);
  }, [apiFetch]);

  useEffect(() => {
    Promise.all([
      apiFetch('/admin/settings'),
      apiFetch('/admin/capacity').catch(() => null),
    ])
      .then(([settingsData, capacityData]) => {
        if (settingsData && typeof settingsData === 'object') setSettings(settingsData as SettingsMap);
        if (capacityData && typeof capacityData === 'object') setCapacity(capacityData as CapacityEstimate);
      })
      .finally(() => setLoading(false));
  }, [apiFetch]);

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateRetentionHours = (value: string) => {
    setSettings((prev) => ({
      ...prev,
      record_preserve_time: value,
      ping_record_preserve_time: value,
    }));
  };

  const derived = useMemo(() => {
    const clients = Math.max(0, Number(capacity?.clients || 0));
    const gpuClients = Math.max(0, Number(capacity?.gpu_clients || 0));
    const expiredBacklogRows = sumRowCounts(capacity?.expired_row_counts);
    const retentionHours = clampInteger(
      settings.record_preserve_time || settings.ping_record_preserve_time,
      DEFAULT_RETENTION_HOURS,
      1,
      MAX_RETENTION_HOURS,
    );
    const recordEnabled = settings.record_enabled !== 'false';
    const sampleIntervalSec = clampInteger(
      settings.live_poll_active_interval_sec,
      DEFAULT_ACTIVE_SAMPLE_SEC,
      3,
      300,
    );
    const idleUploadIntervalSec = clampInteger(
      settings.live_poll_idle_interval_sec,
      DEFAULT_IDLE_UPLOAD_SEC,
      MIN_IDLE_UPLOAD_SEC,
      3600,
    );
    const viewerTtlSec = clampInteger(
      settings.live_poll_active_max_duration_sec,
      DEFAULT_VIEWER_TTL_SEC,
      60,
      3600,
    );
    const recordPersistIntervalSec = clampInteger(
      settings.record_persist_interval_sec,
      Number(capacity?.record_persist_interval_sec || DEFAULT_RECORD_PERSIST_SEC),
      3,
      3600,
    );
    const pingRecordPersistIntervalSec = clampInteger(
      settings.ping_record_persist_interval_sec,
      Number(capacity?.ping_record_persist_interval_sec || DEFAULT_PING_RECORD_PERSIST_SEC),
      60,
      3600,
    );
    const capacityPingRecordPersistIntervalSec = clampInteger(
      capacity?.ping_record_persist_interval_sec,
      DEFAULT_PING_RECORD_PERSIST_SEC,
      60,
      3600,
    );
    const recordHighWatermarkRows = clampInteger(
      settings.record_high_watermark_rows,
      Number(capacity?.record_high_watermark_rows || DEFAULT_RECORD_HIGH_WATERMARK_ROWS),
      1000,
      10_000_000,
    );
    const dailyViewMinutes = clampInteger(
      settings.capacity_daily_view_minutes,
      Number(capacity?.capacity_daily_view_minutes || DEFAULT_DAILY_VIEW_MINUTES),
      0,
      1440,
    );

    const activeSecondsPerDay = dailyViewMinutes * 60;
    const idleSecondsPerDay = Math.max(0, 86400 - activeSecondsPerDay);
    const activePersistIntervalSec = Math.max(sampleIntervalSec, recordPersistIntervalSec);
    const idlePersistIntervalSec = Math.max(idleUploadIntervalSec, recordPersistIntervalSec);
    const activeMonitorWritesPerDay = recordEnabled && activeSecondsPerDay > 0
      ? Math.ceil(clients * activeSecondsPerDay / activePersistIntervalSec)
      : 0;
    const idleMonitorWritesPerDay = recordEnabled && idleSecondsPerDay > 0
      ? Math.ceil(clients * idleSecondsPerDay / idlePersistIntervalSec)
      : 0;
    const monitorWritesPerDay = activeMonitorWritesPerDay + idleMonitorWritesPerDay;
    const activeGpuWritesPerDay = recordEnabled && activeSecondsPerDay > 0
      ? Math.ceil(gpuClients * activeSecondsPerDay / activePersistIntervalSec)
      : 0;
    const idleGpuWritesPerDay = recordEnabled && idleSecondsPerDay > 0
      ? Math.ceil(gpuClients * idleSecondsPerDay / idlePersistIntervalSec)
      : 0;
    const gpuSnapshotsPerDay = activeGpuWritesPerDay + idleGpuWritesPerDay;
    const pingCoveredClients = inferPingCoveredClients(capacity, clients, capacityPingRecordPersistIntervalSec);
    const pingRowsPerClientPerDay = dailySamplesPerClient(pingRecordPersistIntervalSec);
    const pingRowsPerDay = recordEnabled
      ? pingCoveredClients * pingRowsPerClientPerDay
      : 0;
    const pingResultReportsPerDay = pingCoveredClients * pingRowsPerClientPerDay;
    const estimatedMonitorRowsRetained = Math.ceil(monitorWritesPerDay * retentionHours / 24);
    const estimatedGpuRowsRetained = Math.ceil(gpuSnapshotsPerDay * retentionHours / 24);
    const estimatedPingRowsRetained = Math.ceil(pingRowsPerDay * retentionHours / 24);
    const estimatedRowsRetained = estimatedMonitorRowsRetained + estimatedGpuRowsRetained + estimatedPingRowsRetained;
    const freeRowReference = capacity?.quota_reference?.d1?.retained_rows_reference?.free ||
      capacity?.quota_reference?.d1?.retained_rows_warning?.free ||
      capacity?.d1_reference_rows?.free_reference_rows ||
      capacity?.d1_reference_rows?.free_warning_rows ||
      500_000;
    const freeStorageBytes = capacity?.quota_reference?.d1?.storage_bytes?.free_database ||
      D1_FREE_DATABASE_STORAGE_BYTES;
    const monitorRecordBytes = capacity?.quota_reference?.d1?.estimated_row_bytes?.monitor_record ||
      ESTIMATED_MONITOR_RECORD_BYTES;
    const gpuSnapshotBytes = capacity?.quota_reference?.d1?.estimated_row_bytes?.gpu_snapshot ||
      ESTIMATED_GPU_SNAPSHOT_BYTES;
    const pingRecordBytes = capacity?.quota_reference?.d1?.estimated_row_bytes?.ping_snapshot ||
      capacity?.quota_reference?.d1?.estimated_row_bytes?.ping_record ||
      (capacity?.ping_storage_mode === 'snapshots' ? ESTIMATED_PING_SNAPSHOT_BYTES : ESTIMATED_PING_RECORD_BYTES);
    const estimatedStorageBytes = estimatedMonitorRowsRetained * monitorRecordBytes
      + estimatedGpuRowsRetained * gpuSnapshotBytes
      + estimatedPingRowsRetained * pingRecordBytes;
    const d1FreeDailyWrites = capacity?.quota_reference?.d1?.rows_written_per_day?.free ||
      D1_FREE_DAILY_WRITES_FALLBACK;
    const d1PaidDailyWrites = capacity?.quota_reference?.d1?.rows_written_per_day?.paid_estimate ||
      D1_PAID_DAILY_WRITES_FALLBACK;
    const d1PaidMonthlyWrites = capacity?.quota_reference?.d1?.rows_written_per_day?.paid_monthly_included ||
      D1_PAID_MONTHLY_WRITES_FALLBACK;
    const d1FreeDailyReads = capacity?.quota_reference?.d1?.rows_read_per_day?.free ||
      D1_FREE_DAILY_READS_FALLBACK;
    const d1PaidDailyReads = capacity?.quota_reference?.d1?.rows_read_per_day?.paid_estimate ||
      D1_PAID_DAILY_READS_FALLBACK;
    const d1PaidMonthlyReads = capacity?.quota_reference?.d1?.rows_read_per_day?.paid_monthly_included ||
      D1_PAID_MONTHLY_READS_FALLBACK;
    const d1PaidStorageBytes = capacity?.quota_reference?.d1?.storage_bytes?.paid_database ||
      D1_PAID_DATABASE_STORAGE_BYTES;
    const workerFreeDailyRequests = capacity?.quota_reference?.workers?.requests_per_day?.free ||
      WORKER_FREE_DAILY_REQUESTS;
    const workerPaidDailyRequests = capacity?.quota_reference?.workers?.requests_per_day?.paid_included ||
      WORKER_PAID_DAILY_REQUESTS;
    const monitorD1RowsWrittenPerDay = monitorWritesPerDay * MONITOR_RECORD_D1_ROWS_WRITTEN;
    const gpuD1RowsWrittenPerDay = gpuSnapshotsPerDay * GPU_SNAPSHOT_D1_ROWS_WRITTEN;
    const pingD1RowsWrittenPerDay = pingRowsPerDay * PING_SNAPSHOT_D1_ROWS_WRITTEN;
    const mixedDailyWrites = monitorD1RowsWrittenPerDay + gpuD1RowsWrittenPerDay + pingD1RowsWrittenPerDay;
    const writeAmplifiedD1RowsReadPerDay = mixedDailyWrites * D1_ROWS_READ_PER_WRITE_ESTIMATE;
    const publicMetadataD1RowsReadPerDay = dailyViewMinutes > 0
      ? Math.ceil(activeSecondsPerDay / PUBLIC_CLIENT_REFRESH_INTERVAL_SEC) * Math.max(1, clients)
        + Math.ceil(Math.max(1, dailyViewMinutes) / 30) * (Math.max(1, (capacity?.ping_tasks || []).length) + 16)
      : 0;
    const agentMonitorAuthD1RowsReadPerDay = Math.ceil(clients * activeSecondsPerDay / AGENT_AUTH_CACHE_SEC)
      + Math.ceil(clients * idleSecondsPerDay / Math.max(AGENT_AUTH_CACHE_SEC, idlePersistIntervalSec));
    const activeDailyWrites = recordEnabled
      ? Math.ceil(clients * 86400 / activePersistIntervalSec) * MONITOR_RECORD_D1_ROWS_WRITTEN
        + Math.ceil(gpuClients * 86400 / activePersistIntervalSec) * GPU_SNAPSHOT_D1_ROWS_WRITTEN
        + pingD1RowsWrittenPerDay
      : 0;
    const idleDailyWrites = recordEnabled
      ? Math.ceil(clients * 86400 / idlePersistIntervalSec) * MONITOR_RECORD_D1_ROWS_WRITTEN
        + Math.ceil(gpuClients * 86400 / idlePersistIntervalSec) * GPU_SNAPSHOT_D1_ROWS_WRITTEN
        + pingD1RowsWrittenPerDay
      : 0;
    const hasPingTasks = (capacity?.ping_tasks || []).length > 0;
    const agentPingTaskPullsPerDay = Math.ceil(
      clients * 86400 / (hasPingTasks ? pingRecordPersistIntervalSec : 600),
    );
    const agentBasicInfoReportsPerDay = Math.max(
      0,
      Number(capacity?.agent_basic_info_reports_per_day || clients * 48),
    );
    const agentWebsocketConnectsPerDay = Math.max(
      0,
      Number(capacity?.agent_websocket_connects_per_day || clients),
    );
    const mixedWorkerRequestsPerDay = agentPingTaskPullsPerDay
      + pingResultReportsPerDay
      + agentBasicInfoReportsPerDay
      + agentWebsocketConnectsPerDay;
    const agentPingD1RowsReadPerDay = agentPingTaskPullsPerDay + pingResultReportsPerDay;
    const mixedDailyReads = Math.ceil(
      writeAmplifiedD1RowsReadPerDay +
      publicMetadataD1RowsReadPerDay +
      agentMonitorAuthD1RowsReadPerDay +
      agentPingD1RowsReadPerDay,
    );
    const activeWorkerRequestsPerDay = mixedWorkerRequestsPerDay;
    const idleWorkerRequestsPerDay = mixedWorkerRequestsPerDay;

    return {
      clients,
      gpuClients,
      gpuWritesPerDay: gpuSnapshotsPerDay,
      pingWritesPerDay: pingD1RowsWrittenPerDay,
      pingRowsPerDay,
      expiredBacklogRows,
      retentionHours,
      sampleIntervalSec,
      idleUploadIntervalSec,
      viewerTtlSec,
      recordPersistIntervalSec,
      pingRecordPersistIntervalSec,
      recordHighWatermarkRows,
      dailyViewMinutes,
      activeSecondsPerDay,
      idleSecondsPerDay,
      monitorWritesPerDay,
      activeMonitorWritesPerDay,
      idleMonitorWritesPerDay,
      activeGpuWritesPerDay,
      idleGpuWritesPerDay,
      pingCoveredClients,
      mixedDailyWrites,
      mixedDailyReads,
      writeAmplifiedD1RowsReadPerDay,
      publicMetadataD1RowsReadPerDay,
      agentMonitorAuthD1RowsReadPerDay,
      agentPingD1RowsReadPerDay,
      activeDailyWrites,
      idleDailyWrites,
      estimatedRowsRetained,
      estimatedStorageBytes,
      retainedRowsPercent: estimatedRowsRetained / freeRowReference * 100,
      highWatermarkPercent: estimatedRowsRetained / recordHighWatermarkRows * 100,
      storagePercent: estimatedStorageBytes / freeStorageBytes * 100,
      freeStorageBytes,
      d1FreeDailyWrites,
      d1PaidDailyWrites,
      d1PaidMonthlyWrites,
      d1FreeDailyReads,
      d1PaidDailyReads,
      d1PaidMonthlyReads,
      d1PaidStorageBytes,
      workerFreeDailyRequests,
      workerPaidDailyRequests,
      mixedWritePercent: mixedDailyWrites / d1FreeDailyWrites * 100,
      mixedReadPercent: mixedDailyReads / d1FreeDailyReads * 100,
      activeWritePercent: activeDailyWrites / d1FreeDailyWrites * 100,
      idleWritePercent: idleDailyWrites / d1FreeDailyWrites * 100,
      mixedPaidWritePercent: mixedDailyWrites / d1PaidDailyWrites * 100,
      mixedPaidReadPercent: mixedDailyReads / d1PaidDailyReads * 100,
      activePaidWritePercent: activeDailyWrites / d1PaidDailyWrites * 100,
      activeWorkerRequestsPerDay,
      idleWorkerRequestsPerDay,
      mixedWorkerRequestsPerDay,
      mixedWorkerPercent: mixedWorkerRequestsPerDay / workerFreeDailyRequests * 100,
      activeWorkerPercent: activeWorkerRequestsPerDay / workerFreeDailyRequests * 100,
      idleWorkerPercent: idleWorkerRequestsPerDay / workerFreeDailyRequests * 100,
      mixedPaidWorkerPercent: mixedWorkerRequestsPerDay / workerPaidDailyRequests * 100,
      activePaidWorkerPercent: activeWorkerRequestsPerDay / workerPaidDailyRequests * 100,
    };
  }, [capacity, settings]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const payload = {
        ...settings,
        record_preserve_time: String(derived.retentionHours),
        ping_record_preserve_time: String(derived.retentionHours),
        live_poll_active_interval_sec: String(derived.sampleIntervalSec),
        live_poll_idle_interval_sec: String(derived.idleUploadIntervalSec),
        live_poll_active_max_duration_sec: String(derived.viewerTtlSec),
        record_persist_interval_sec: String(derived.recordPersistIntervalSec),
        ping_record_persist_interval_sec: String(derived.pingRecordPersistIntervalSec),
        record_high_watermark_rows: String(derived.recordHighWatermarkRows),
        capacity_daily_view_minutes: String(derived.dailyViewMinutes),
      };
      const result = await apiFetch('/admin/settings', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (result.success) {
        setSettings(payload);
        window.dispatchEvent(new CustomEvent(LIVE_POLL_SETTINGS_UPDATED_EVENT, { detail: payload }));
        toast.success('设置已保存');
      } else {
        toast.error(result.error || '保存失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [apiFetch, derived, settings]);

  const handleMaintenanceCleanup = useCallback(async () => {
    setCleaning(true);
    try {
      const result = await apiFetch('/admin/maintenance/cleanup', { method: 'POST' });
      if (result.success) {
        const deleted = result.deleted || {};
        const totalDeleted = ['records', 'gpu_records', 'gpu_snapshots', 'ping_records', 'ping_snapshots', 'audit_logs']
          .reduce((sum, key) => sum + Number(deleted[key] || 0), 0);
        toast.success(`维护清理完成，删除 ${formatInteger(totalDeleted)} 行历史数据`);
        await refreshCapacity(true);
      } else {
        toast.error(result.error || '维护清理失败');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '维护清理失败');
    } finally {
      setCleaning(false);
    }
  }, [apiFetch, refreshCapacity]);

  const headerAction = useMemo(() => (
    <Button onClick={handleSave} disabled={loading || saving}>
      <Save size={16} /> {saving ? '保存中…' : '保存'}
    </Button>
  ), [handleSave, loading, saving]);

  useEffect(() => {
    setAction(headerAction);
    return () => setAction(null);
  }, [headerAction, setAction]);

  if (loading) return <Loading />;

  return (
    <Flex direction="column" gap="4">
      <SettingCard title="采集与记录策略" description="统一设置 Agent 采集、历史记录、D1 与 Worker 配额估算" defaultOpen>
        <Box className="quota-estimate-panel">
          <Flex align="center" justify="between" gap="3" wrap="wrap" mb="3">
            <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
              <Gauge size={16} />
              <Text size="2" weight="bold">配额实时估算</Text>
              <Text size="1" color="gray" className="quota-reference-line">
                CF Free 总量：D1 写入 {formatInteger(derived.d1FreeDailyWrites)}/天 · D1 读取 {formatInteger(derived.d1FreeDailyReads)}/天 · Worker {formatInteger(derived.workerFreeDailyRequests)}/天 · D1 存储 {formatBytes(derived.freeStorageBytes)}/库；Paid：D1 写入 {formatInteger(derived.d1PaidMonthlyWrites)}/月 · D1 读取 {formatInteger(derived.d1PaidMonthlyReads)}/月 · Worker {formatInteger(derived.workerPaidDailyRequests)}/天 · D1 存储 {formatBytes(derived.d1PaidStorageBytes)}/库
              </Text>
            </Flex>
            <Flex align="center" gap="2" wrap="wrap">
              <Badge variant="soft" color={getPercentTone(Math.max(derived.storagePercent, derived.mixedWritePercent, derived.mixedReadPercent, derived.mixedWorkerPercent))}>
                当前输入即时估算
              </Badge>
              <Button size="1" variant="soft" onClick={handleMaintenanceCleanup} disabled={cleaning}>
                <Database size={13} /> {cleaning ? '清理中…' : '维护清理'}
              </Button>
            </Flex>
          </Flex>
          <Grid columns={{ initial: '1', sm: '2', lg: '4' }} gap="3">
            <QuotaBar
              label="D1 预计存储"
              value={formatBytes(derived.estimatedStorageBytes)}
              percent={derived.storagePercent}
              caption={`Free 单库 ${formatBytes(derived.freeStorageBytes)}；行数仅作经验参考`}
              icon={<Database size={15} />}
            />
            <QuotaBar
              label="D1 写入/天"
              value={formatInteger(derived.mixedDailyWrites)}
              percent={derived.mixedWritePercent}
              caption={`按每日观看 ${derived.dailyViewMinutes} 分钟估算，Free ${formatInteger(derived.d1FreeDailyWrites)}/天；Paid 按月度额度均摊约 ${formatInteger(derived.d1PaidDailyWrites)}/天`}
              icon={<HardDrive size={15} />}
            />
            <QuotaBar
              label="D1 读取/天"
              value={formatInteger(derived.mixedDailyReads)}
              percent={derived.mixedReadPercent}
              caption={`按写入放大、Agent 鉴权和公开元数据刷新估算，Free ${formatInteger(derived.d1FreeDailyReads)}/天；Paid 按月度额度均摊约 ${formatInteger(derived.d1PaidDailyReads)}/天`}
              icon={<Eye size={15} />}
            />
            <QuotaBar
              label="Worker 请求/天"
              value={formatInteger(derived.mixedWorkerRequestsPerDay)}
              percent={derived.mixedWorkerPercent}
              caption={`按每日观看 ${derived.dailyViewMinutes} 分钟估算，Free ${formatPercent(derived.mixedWorkerPercent)} / Paid ${formatPercent(derived.mixedPaidWorkerPercent)}`}
              icon={<Server size={15} />}
            />
          </Grid>
          <Grid columns={{ initial: '2', sm: '4' }} gap="3" mt="3">
            <EstimateMetric label="节点数" value={formatInteger(derived.clients)} />
            <EstimateMetric label="每日观看时间" value={`${derived.dailyViewMinutes} 分钟`} tone="blue" />
            <EstimateMetric label="混合写入/天" value={formatInteger(derived.mixedDailyWrites)} tone="blue" />
            <EstimateMetric label="D1 读取/天" value={formatInteger(derived.mixedDailyReads)} tone="blue" />
            <EstimateMetric label="经验保留行数" value={formatInteger(derived.estimatedRowsRetained)} tone="purple" />
            <EstimateMetric label="历史高水位" value={`${formatInteger(derived.recordHighWatermarkRows)} 行`} tone={getPercentTone(derived.highWatermarkPercent) === 'red' ? 'red' : 'blue'} />
            <EstimateMetric label="过期待清理" value={formatInteger(derived.expiredBacklogRows)} tone={derived.expiredBacklogRows > 0 ? 'amber' : 'green'} />
            <EstimateMetric label="读取写入倍率" value={`${D1_ROWS_READ_PER_WRITE_ESTIMATE}x`} tone="purple" />
            <EstimateMetric label="全天有人写入/天" value={formatInteger(derived.activeDailyWrites)} tone="amber" />
            <EstimateMetric label="全天无人写入/天" value={formatInteger(derived.idleDailyWrites)} tone="green" />
            <EstimateMetric label="无人 Worker 请求/天" value={formatInteger(derived.idleWorkerRequestsPerDay)} tone="purple" />
            <EstimateMetric label="Ping D1 写入/天" value={formatInteger(derived.pingWritesPerDay)} tone="green" />
            <EstimateMetric label="保留时间" value={`${derived.retentionHours} 小时`} />
            <EstimateMetric label="历史写入间隔" value={`${derived.recordPersistIntervalSec} 秒`} />
            <EstimateMetric label="Ping 间隔" value={`${derived.pingRecordPersistIntervalSec} 秒`} />
            <EstimateMetric label="无人打包间隔" value={`${derived.idleUploadIntervalSec} 秒`} />
          </Grid>
          <Text size="1" color="gray" style={{ display: 'block', marginTop: 8 }}>
            保存时会按允许范围校验并归一化；D1 真实风险以存储、rows read、rows written 和查询成本为准，行数只是规划参考。
          </Text>
        </Box>

        <SettingToggle
          label="启用数据记录"
          description="关闭后不再写入历史记录，但不影响实时数据展示"
          checked={settings.record_enabled !== 'false'}
          onCheckedChange={(checked) => updateSetting('record_enabled', checked ? 'true' : 'false')}
        />
        <SettingInput
          label="数据保留时间"
          description="单位为小时，最大 72 小时（3 天）；同时作用于监控历史和 Ping 历史"
          value={getSettingValue(settings, 'record_preserve_time', getSettingValue(settings, 'ping_record_preserve_time', String(DEFAULT_RETENTION_HOURS)))}
          onChange={updateRetentionHours}
          type="number"
          placeholder="72"
        />
        <SettingInput
          label="每日观看时间"
          description="用于配额估算，默认按每天实际打开前台查看 1 小时计算；不影响访客 10 分钟限时规则"
          value={getSettingValue(settings, 'capacity_daily_view_minutes', String(DEFAULT_DAILY_VIEW_MINUTES))}
          onChange={(value) => updateSetting('capacity_daily_view_minutes', value)}
          type="number"
          placeholder="60"
        />

        <SettingInput
          label="采集间隔"
          description="Agent 取样频率，单位为秒；有人看时按此频率实时上传，无人看时本地取样并按打包间隔上传"
          value={getSettingValue(settings, 'live_poll_active_interval_sec', String(DEFAULT_ACTIVE_SAMPLE_SEC))}
          onChange={(value) => updateSetting('live_poll_active_interval_sec', value)}
          type="number"
          placeholder="3"
        />
        <SettingInput
          label="历史写入间隔"
          description="实时数据仍会按采集间隔刷新，但历史记录至少间隔这么久才写入 D1，用于控制配额"
          value={getSettingValue(settings, 'record_persist_interval_sec', String(DEFAULT_RECORD_PERSIST_SEC))}
          onChange={(value) => updateSetting('record_persist_interval_sec', value)}
          type="number"
          placeholder="60"
        />
        <SettingInput
          label="Ping 采集与写入间隔"
          description="统一控制 Ping 任务执行、结果上报和 D1 历史快照写入；最低 60 秒"
          value={getSettingValue(settings, 'ping_record_persist_interval_sec', String(DEFAULT_PING_RECORD_PERSIST_SEC))}
          onChange={(value) => updateSetting('ping_record_persist_interval_sec', value)}
          type="number"
          placeholder="300"
        />
        <SettingInput
          label="历史高水位行数"
          description="records、gpu_records、gpu_snapshots、ping_records、ping_snapshots 接近该行数时暂停历史写入，只保留实时展示，避免 D1 被写爆"
          value={getSettingValue(settings, 'record_high_watermark_rows', String(DEFAULT_RECORD_HIGH_WATERMARK_ROWS))}
          onChange={(value) => updateSetting('record_high_watermark_rows', value)}
          type="number"
          placeholder="450000"
        />
        <SettingInput
          label="无人看时打包上传间隔"
          description="没有有效前台观看者时，按此间隔批量上传已采集的数据，最少 60 秒，单位为秒"
          value={getSettingValue(settings, 'live_poll_idle_interval_sec', String(DEFAULT_IDLE_UPLOAD_SEC))}
          onChange={(value) => updateSetting('live_poll_idle_interval_sec', value)}
          type="number"
          placeholder="600"
        />
        <SettingInput
          label="连接保活时长"
          description="每个观看连接的实时刷新有效期，过期后停止实时更新，刷新页面重新计时，单位为秒"
          value={getSettingValue(settings, 'live_poll_active_max_duration_sec', String(DEFAULT_VIEWER_TTL_SEC))}
          onChange={(value) => updateSetting('live_poll_active_max_duration_sec', value)}
          type="number"
          placeholder="600"
        />
      </SettingCard>
    </Flex>
  );
}
