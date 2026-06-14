const D1_FREE_DAILY_ROWS_WRITTEN = 100_000;
const D1_PAID_MONTHLY_ROWS_WRITTEN_INCLUDED = 50_000_000;
const D1_PAID_DAILY_ROWS_WRITTEN_ESTIMATE = Math.floor(D1_PAID_MONTHLY_ROWS_WRITTEN_INCLUDED / 30);
const D1_FREE_DAILY_ROWS_READ = 5_000_000;
const D1_PAID_MONTHLY_ROWS_READ_INCLUDED = 25_000_000_000;
const D1_PAID_DAILY_ROWS_READ_ESTIMATE = Math.floor(D1_PAID_MONTHLY_ROWS_READ_INCLUDED / 30);
const WORKERS_FREE_DAILY_REQUESTS = 100_000;
const WORKERS_PAID_DAILY_REQUESTS_INCLUDED = 10_000_000;
const D1_FREE_DATABASE_STORAGE_BYTES = 500 * 1024 * 1024;
const D1_PAID_DATABASE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;
const D1_ACCOUNT_FREE_STORAGE_BYTES = 5 * 1024 * 1024 * 1024;
export const ESTIMATED_MONITOR_RECORD_BYTES = 420;
const ESTIMATED_PING_RECORD_BYTES = 160;
export const ESTIMATED_PING_SNAPSHOT_BYTES = 220;
export const ESTIMATED_GPU_SNAPSHOT_BYTES = 420;
export const D1_FREE_RETAINED_ROWS_REFERENCE = 500_000;
export const D1_PAID_RETAINED_ROWS_REFERENCE = 10_000_000;
export const D1_ROWS_READ_PER_WRITE_ESTIMATE = 30;

export function buildQuotaReference() {
  return {
    d1: {
      rows_written_per_day: {
        free: D1_FREE_DAILY_ROWS_WRITTEN,
        paid_estimate: D1_PAID_DAILY_ROWS_WRITTEN_ESTIMATE,
        paid_monthly_included: D1_PAID_MONTHLY_ROWS_WRITTEN_INCLUDED,
        paid_estimate_note: 'Paid rows written are included monthly; daily value is a 30-day planning estimate.',
      },
      rows_read_per_day: {
        free: D1_FREE_DAILY_ROWS_READ,
        paid_estimate: D1_PAID_DAILY_ROWS_READ_ESTIMATE,
        paid_monthly_included: D1_PAID_MONTHLY_ROWS_READ_INCLUDED,
        paid_estimate_note: 'Paid rows read are included monthly; daily value is a 30-day planning estimate.',
      },
      storage_bytes: {
        free_database: D1_FREE_DATABASE_STORAGE_BYTES,
        paid_database: D1_PAID_DATABASE_STORAGE_BYTES,
        free_account: D1_ACCOUNT_FREE_STORAGE_BYTES,
      },
      estimated_row_bytes: {
        monitor_record: ESTIMATED_MONITOR_RECORD_BYTES,
        gpu_snapshot: ESTIMATED_GPU_SNAPSHOT_BYTES,
        ping_record: ESTIMATED_PING_RECORD_BYTES,
        ping_snapshot: ESTIMATED_PING_SNAPSHOT_BYTES,
      },
      retained_rows_reference: {
        free: D1_FREE_RETAINED_ROWS_REFERENCE,
        paid: D1_PAID_RETAINED_ROWS_REFERENCE,
        note: 'Rows retained are only a planning reference; D1 limits are based on storage, rows read, rows written, and query cost.',
      },
    },
    workers: {
      requests_per_day: {
        free: WORKERS_FREE_DAILY_REQUESTS,
        paid_included: WORKERS_PAID_DAILY_REQUESTS_INCLUDED,
      },
    },
    sources: {
      d1_limits: 'https://developers.cloudflare.com/d1/platform/limits/',
      d1_pricing: 'https://developers.cloudflare.com/d1/platform/pricing/',
      workers_limits: 'https://developers.cloudflare.com/workers/platform/limits/',
    },
  };
}
