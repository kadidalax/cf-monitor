-- Local demo seed data for CF Monitor.
-- Run only in local/dev D1 when you need complete display data:
--   wrangler d1 execute cf-monitor-db --local --file=./migrations/002_seed_demo.sql
--
-- The script is idempotent for the fixed demo-* clients and keeps non-demo data intact.
--
-- Demo source policy:
-- - IPv4/IPv6 values use documentation-only ranges from RFC 5737 and RFC 3849.
-- - Hardware/OS names are public vendor or distribution product names.
-- - Monitoring rows are deterministic scenario samples derived from schema.sql
--   records/gpu_records fields and the agent report payload; they are not
--   random production measurements.

DELETE FROM ping_records
WHERE client IN (
  'demo-linux-gpu',
  'demo-windows-highio',
  'demo-macos-arm',
  'demo-edge-highload',
  'demo-offline-legacy',
  'demo-hidden-admin'
)
OR task_id IN (SELECT id FROM ping_tasks WHERE name LIKE 'Demo - %');

DELETE FROM gpu_records
WHERE client IN (
  'demo-linux-gpu',
  'demo-windows-highio',
  'demo-macos-arm',
  'demo-edge-highload',
  'demo-offline-legacy',
  'demo-hidden-admin'
);

DELETE FROM records
WHERE client IN (
  'demo-linux-gpu',
  'demo-windows-highio',
  'demo-macos-arm',
  'demo-edge-highload',
  'demo-offline-legacy',
  'demo-hidden-admin'
);

DELETE FROM offline_notifications
WHERE client IN (
  'demo-linux-gpu',
  'demo-windows-highio',
  'demo-macos-arm',
  'demo-edge-highload',
  'demo-offline-legacy',
  'demo-hidden-admin'
);

DELETE FROM ping_tasks WHERE name LIKE 'Demo - %';
DELETE FROM load_notifications WHERE name LIKE 'Demo - %';
DELETE FROM audit_logs WHERE action LIKE 'demo_%';

INSERT OR REPLACE INTO clients (
  uuid, token, name, cpu_name, virtualization, arch, cpu_cores, os,
  kernel_version, gpu_name, ipv4, ipv6, region, remark, public_remark,
  mem_total, swap_total, disk_total, version, price, billing_cycle,
  auto_renewal, currency, expired_at, "group", tags, hidden, traffic_limit,
  traffic_limit_type, created_at, updated_at
) VALUES
(
  'demo-linux-gpu',
  'demo-token-linux-gpu',
  'Tokyo GPU Node',
  'AMD EPYC 7763 16-Core Processor',
  'KVM',
  'x86_64',
  16,
  'Ubuntu 24.04 LTS',
  '6.8.0-cloudflare',
  'NVIDIA GeForce RTX 4090 / NVIDIA L4',
  '203.0.113.10',
  '2001:db8:54::10',
  'Tokyo',
  'Demo: basic info, live metrics, dual GPU, IPv4/IPv6, traffic limit.',
  'Source: vendor hardware specs, RFC documentation IP ranges, and deterministic GPU compute monitoring profile.',
  68719476736,
  8589934592,
  1099511627776,
  'v2.0.0-demo',
  99.00,
  30,
  1,
  'CNY ',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+28 days'),
  'Asia',
  'GPU<iris>;IPv6<green>;HighPerf<amber>',
  0,
  2199023255552,
  'sum',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
),
(
  'demo-windows-highio',
  'demo-token-windows-highio',
  'Singapore Windows Node',
  'Intel Xeon Gold 6226R CPU @ 2.90GHz',
  'Hyper-V',
  'amd64',
  12,
  'Windows Server 2022 Datacenter',
  '10.0.20348',
  'NVIDIA Tesla T4',
  '198.51.100.21',
  '2001:db8:54::21',
  'Singapore',
  'Demo: Windows, TCP connections, high downstream traffic, T4 GPU.',
  'Source: vendor hardware specs, RFC documentation IP ranges, and deterministic gateway/high-connection profile.',
  34359738368,
  4294967296,
  536870912000,
  'v2.0.0-demo',
  14.90,
  30,
  0,
  '$',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+6 days'),
  'Asia',
  'Windows<blue>;RDP<cyan>;Monthly<green>',
  0,
  0,
  'bandwidth:1Gbps',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-13 days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
),
(
  'demo-macos-arm',
  'demo-token-macos-arm',
  'Silicon Valley macOS ARM',
  'Apple M2 Pro',
  'None',
  'arm64',
  10,
  'macOS 14 Sonoma',
  '23.6.0',
  'Apple M2 Pro 16-Core GPU',
  '192.0.2.33',
  '2001:db8:54::33',
  'Silicon Valley',
  'Demo: ARM architecture, macOS, low load, one-time billing.',
  'Source: Apple public technical specs, RFC documentation IP ranges, and deterministic low-load build profile.',
  17179869184,
  2147483648,
  549755813888,
  'v2.0.0-demo',
  399.00,
  -1,
  0,
  'CNY ',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+3650 days'),
  'America',
  'ARM<jade>;macOS<gray>;OneTime<gold>',
  0,
  549755813888,
  'max',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
),
(
  'demo-edge-highload',
  'demo-token-edge-highload',
  'Frankfurt High Load Edge',
  'AMD Ryzen 9 7950X',
  'Docker',
  'x86_64',
  8,
  'Debian GNU/Linux 12',
  '6.1.0-21-amd64',
  '',
  '203.0.113.44',
  '',
  'Frankfurt',
  'Demo: high CPU, memory, disk, and temperature for alert/bar checks.',
  'Source: vendor hardware specs, RFC documentation IP ranges, and deterministic high-load alert profile.',
  8589934592,
  1073741824,
  107374182400,
  'v2.0.0-demo',
  -1,
  30,
  1,
  'CNY ',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 days'),
  'Europe',
  'HighLoad<red>;Edge<orange>;Free<green>',
  0,
  107374182400,
  'up',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
),
(
  'demo-offline-legacy',
  'demo-token-offline-legacy',
  'London Offline Archive',
  'Intel Xeon E5-2680 v4',
  'OpenVZ',
  'x86_64',
  2,
  'CentOS 7',
  '3.10.0-1160.el7.x86_64',
  '',
  '198.51.100.55',
  '',
  'London',
  'Demo: latest record is older than online grace for offline sorting and notifications.',
  'Source: vendor hardware specs, RFC documentation IP ranges, and deterministic offline archive profile.',
  4294967296,
  0,
  53687091200,
  'v0.9.9-demo',
  3.50,
  30,
  0,
  '$',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'),
  'Europe',
  'Offline<red>;Legacy<brown>',
  0,
  53687091200,
  'sum',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-300 days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')
),
(
  'demo-hidden-admin',
  'demo-token-hidden-admin',
  'Hidden Admin Node',
  'Ampere Altra Q80-30',
  'LXC',
  'aarch64',
  4,
  'Alpine Linux 3.20',
  '6.6.33-0-virt',
  '',
  '192.0.2.66',
  '2001:db8:54::66',
  'Hong Kong',
  'Demo: hidden=1, hidden from public page but visible in admin list.',
  'Source: vendor hardware specs, RFC documentation IP ranges, and deterministic hidden-node visibility profile.',
  8589934592,
  1073741824,
  214748364800,
  'v2.0.0-demo',
  5.00,
  92,
  1,
  '$',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+70 days'),
  'Internal',
  'Hidden<gray>;Admin<iris>',
  1,
  214748364800,
  'sum',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

INSERT INTO records (
  client, time, cpu, gpu, ram, ram_total, swap, swap_total, load, temp,
  disk, disk_total, net_in, net_out, net_total_up, net_total_down,
  process_count, connections, connections_udp, uptime
) VALUES
('demo-linux-gpu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'), 18.4, 24.0, 12884901888, 68719476736, 536870912, 8589934592, 0.82, 43.5, 343597383680, 1099511627776, 5242880, 3145728, 698932185088, 987842478080, 238, 920, 110, 3454200),
('demo-linux-gpu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'), 42.8, 58.0, 19327352832, 68719476736, 1073741824, 8589934592, 2.36, 55.2, 359703511040, 1099511627776, 9437184, 6291456, 724775731200, 1005022347264, 261, 1380, 190, 3455400),
('demo-linux-gpu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 seconds'), 63.7, 72.0, 25769803776, 68719476736, 2147483648, 8589934592, 4.18, 62.6, 375809638400, 1099511627776, 14680064, 7340032, 751619276800, 1030792151040, 282, 1832, 244, 3456000),

('demo-windows-highio', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 minutes'), 22.0, 18.0, 13958643712, 34359738368, 536870912, 4294967296, 1.10, 48.0, 279172874240, 536870912000, 4194304, 8388608, 397284474880, 805306368000, 311, 2100, 320, 820200),
('demo-windows-highio', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 minutes'), 36.4, 32.0, 20401094656, 34359738368, 1073741824, 4294967296, 1.82, 52.3, 322122547200, 536870912000, 6291456, 12582912, 413390602240, 836518674432, 356, 2780, 480, 821200),
('demo-windows-highio', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 seconds'), 51.2, 44.0, 23622320128, 34359738368, 1610612736, 4294967296, 2.64, 59.5, 343597383680, 536870912000, 8388608, 18874368, 429496729600, 858993459200, 394, 3480, 650, 821700),

('demo-macos-arm', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes'), 7.2, 9.0, 5368709120, 17179869184, 268435456, 2147483648, 0.45, 38.1, 118111600640, 549755813888, 1048576, 524288, 78383153152, 126164664320, 152, 410, 72, 532000),
('demo-macos-arm', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 minutes'), 12.9, 14.0, 7516192768, 17179869184, 536870912, 2147483648, 0.72, 41.4, 128849018880, 549755813888, 2097152, 1048576, 79456894976, 128849018880, 166, 520, 88, 532840),
('demo-macos-arm', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 seconds'), 18.5, 20.0, 8589934592, 17179869184, 805306368, 2147483648, 1.08, 44.2, 137438953472, 549755813888, 2621440, 1572864, 80530636800, 132070244352, 174, 610, 98, 533120),

('demo-edge-highload', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes'), 78.0, 0.0, 6120328397, 8589934592, 402653184, 1073741824, 6.50, 72.0, 83751862272, 107374182400, 10485760, 12582912, 73014444032, 60129542144, 98, 780, 90, 188000),
('demo-edge-highload', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'), 91.5, 0.0, 7043746365, 8589934592, 671088640, 1073741824, 8.80, 81.0, 92341796864, 107374182400, 15728640, 16777216, 82678120448, 69793218560, 114, 1180, 140, 188600),
('demo-edge-highload', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 seconds'), 96.2, 0.0, 7301444403, 8589934592, 805306368, 1073741824, 10.25, 86.7, 96636764160, 107374182400, 20971520, 22020096, 91268055040, 76235669504, 126, 1510, 188, 189000),

('demo-offline-legacy', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'), 12.4, 0.0, 1879048192, 4294967296, 0, 0, 0.72, 49.1, 32212254720, 53687091200, 524288, 262144, 17179869184, 21474836480, 76, 210, 42, 987654),
('demo-hidden-admin', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-9 seconds'), 31.7, 0.0, 3758096384, 8589934592, 268435456, 1073741824, 1.64, 46.3, 64424509440, 214748364800, 3145728, 2097152, 35433480192, 44023414784, 96, 620, 105, 172800);

INSERT INTO gpu_records (
  client, time, device_index, device_name, mem_total, mem_used, utilization, temperature
) VALUES
('demo-linux-gpu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'), 0, 'NVIDIA GeForce RTX 4090', 25769803776, 6442450944, 24.0, 44),
('demo-linux-gpu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'), 1, 'NVIDIA L4', 24159191040, 4294967296, 18.0, 39),
('demo-linux-gpu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'), 0, 'NVIDIA GeForce RTX 4090', 25769803776, 13958643712, 58.0, 57),
('demo-linux-gpu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'), 1, 'NVIDIA L4', 24159191040, 9663676416, 42.0, 51),
('demo-linux-gpu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 seconds'), 0, 'NVIDIA GeForce RTX 4090', 25769803776, 18253611008, 72.0, 64),
('demo-linux-gpu', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 seconds'), 1, 'NVIDIA L4', 24159191040, 12884901888, 61.0, 58),
('demo-windows-highio', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 minutes'), 0, 'NVIDIA Tesla T4', 17179869184, 5368709120, 32.0, 50),
('demo-windows-highio', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 seconds'), 0, 'NVIDIA Tesla T4', 17179869184, 8589934592, 44.0, 56),
('demo-macos-arm', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 seconds'), 0, 'Apple M2 Pro 16-Core GPU', 8589934592, 2684354560, 20.0, 44);

INSERT INTO ping_tasks (name, clients, all_clients, type, target, interval_sec) VALUES
-- Ping targets use Cloudflare public resolver documentation and public HTTPS endpoint naming.
('Demo - Cloudflare ICMP', '[]', 1, 'icmp', '1.1.1.1', 60),
('Demo - IPv6 DNS', '[]', 1, 'icmp', '2606:4700:4700::1111', 60),
('Demo - HTTPS 443', '["demo-linux-gpu","demo-windows-highio","demo-edge-highload"]', 0, 'tcp', 'cloudflare.com:443', 120);

INSERT INTO ping_records (client, task_id, time, value) VALUES
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'), 36),
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes'), 34),
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'), 41),
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 seconds'), 38),
('demo-windows-highio', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 minutes'), 58),
('demo-windows-highio', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes'), 52),
('demo-windows-highio', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 minutes'), 49),
('demo-windows-highio', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 seconds'), 51),
('demo-macos-arm', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes'), 142),
('demo-macos-arm', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'), 138),
('demo-macos-arm', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 minutes'), 146),
('demo-macos-arm', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 seconds'), 141),
('demo-edge-highload', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes'), 23),
('demo-edge-highload', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'), 28),
('demo-edge-highload', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes'), 31),
('demo-edge-highload', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 seconds'), 29),
('demo-offline-legacy', (SELECT id FROM ping_tasks WHERE name = 'Demo - Cloudflare ICMP'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'), 72);

INSERT INTO ping_records (client, task_id, time, value) VALUES
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'), 42),
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'), 45),
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 seconds'), 44),
('demo-windows-highio', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 minutes'), 61),
('demo-windows-highio', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 seconds'), 57),
('demo-macos-arm', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes'), 151),
('demo-macos-arm', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 seconds'), 149),
('demo-edge-highload', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes'), 34),
('demo-edge-highload', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 seconds'), 36),
('demo-offline-legacy', (SELECT id FROM ping_tasks WHERE name = 'Demo - IPv6 DNS'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours'), 88);

INSERT INTO ping_records (client, task_id, time, value) VALUES
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - HTTPS 443'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'), 52),
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - HTTPS 443'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'), 49),
('demo-linux-gpu', (SELECT id FROM ping_tasks WHERE name = 'Demo - HTTPS 443'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 seconds'), 47),
('demo-windows-highio', (SELECT id FROM ping_tasks WHERE name = 'Demo - HTTPS 443'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 minutes'), 71),
('demo-windows-highio', (SELECT id FROM ping_tasks WHERE name = 'Demo - HTTPS 443'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-12 seconds'), 68),
('demo-edge-highload', (SELECT id FROM ping_tasks WHERE name = 'Demo - HTTPS 443'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-15 minutes'), 19),
('demo-edge-highload', (SELECT id FROM ping_tasks WHERE name = 'Demo - HTTPS 443'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-8 seconds'), 22);

INSERT OR REPLACE INTO offline_notifications (client, enable, grace_period, last_notified) VALUES
('demo-linux-gpu', 1, 180, NULL),
('demo-windows-highio', 1, 300, NULL),
('demo-macos-arm', 0, 180, NULL),
('demo-edge-highload', 1, 60, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')),
('demo-offline-legacy', 1, 180, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour')),
('demo-hidden-admin', 0, 180, NULL);

INSERT INTO load_notifications (name, clients, metric, threshold, ratio, interval_min, last_notified) VALUES
('Demo - CPU High Load', '[]', 'cpu', 85.0, 0.80, 10, NULL),
('Demo - Memory Pressure', '["demo-edge-highload","demo-windows-highio"]', 'ram', 75.0, 0.70, 15, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 hours')),
('Demo - Temperature Alert', '["demo-linux-gpu","demo-edge-highload"]', 'temp', 80.0, 0.60, 5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')),
('Demo - Disk Usage', '[]', 'disk', 90.0, 0.90, 30, NULL);

INSERT INTO audit_logs (time, user, action, detail, level) VALUES
(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes'), 'system', 'demo_seed', 'Seeded local demo clients, records, GPU, ping, and notification rules', 'info'),
(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-10 minutes'), 'system', 'demo_highload', 'Frankfurt high-load node crossed CPU and temperature demo thresholds', 'warning'),
(strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'), 'system', 'demo_offline', 'London offline archive node exceeded offline grace period', 'warning');
