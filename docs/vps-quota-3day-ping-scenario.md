# VPS 监控 + Ping 默认场景配额估算

生成时间：2026-06-10  
场景：有人看时 3 秒、无人看时 10 分钟、每天只看 1 小时、每台 VPS 有 3 个 Ping 链接、历史保留 3 天。

## 结论

在当前代码的默认 Ping 策略下，`ping_record_persist_interval_sec = 300` 秒会统一控制 Ping 采集、上报和 D1 写入。也就是说，每台 VPS 的 3 个 Ping 链接默认不是每 60 秒入库，而是每 300 秒采集并写入一次快照。

按 10 / 20 / 30 / 50 台 VPS 估算，D1 rows written、Workers requests、Durable Objects requests 都低于 Free 每日配额。50 台时 D1 写入约 73.48%，已经需要留意余量；30 台以内比较稳。

## 官方 Free 配额

当前 Cloudflare 官方文档口径：

- D1 Free：rows read 5,000,000/day，rows written 100,000/day，storage 5 GB total。
- Workers Free：requests 100,000/day。
- Durable Objects Free：requests 100,000/day。
- D1 rows written 会包含索引写入；写入被索引列会增加 rows written。
- WebSocket 建连算 Workers request；WebSocket 消息不算 Workers request。Durable Object 对 incoming WebSocket messages 按 20:1 折算为计费 requests。

来源：

- Cloudflare D1 Pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare Workers Pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare Durable Objects Pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/

## 估算假设

| 项目 | 使用值 |
| --- | ---: |
| 前台有人查看时间 | 1 小时/天 |
| 有人看时上报间隔 | 3 秒 |
| 无人看时上报间隔 | 600 秒 |
| 资源历史 D1 写入间隔 | 60 秒 |
| Ping 采集/上报/D1 写入统一间隔 | 300 秒 |
| 每台 VPS Ping 链接数 | 3 个 |
| 资源历史保留 | 72 小时 |
| Ping 历史保留 | 72 小时 |
| `records` 索引数 | 2 |
| `ping_snapshots` 索引数 | 2 |

说明：3 个 Ping 链接会写进同一条 `ping_snapshots.values_json`，所以同一台 VPS 同一轮 Ping 仍是 1 条 Ping 快照行，不是 3 条 D1 行。

## 每台 VPS 每天触发量

资源历史：

```text
active_monitor_records = 3600 / 60 = 60
idle_monitor_records = 82800 / 600 = 138
monitor_records_per_vps_per_day = 198
```

Ping 历史：

```text
ping_snapshots_per_vps_per_day = 86400 / 300 = 288
```

D1 rows written：

```text
monitor_d1_rows_written = 198 * (1 table row + 2 indexes) = 594 / VPS / day
ping_d1_rows_written = 288 * (1 table row + 2 indexes) = 864 / VPS / day
health_settings_rows_written = 576 / day fixed estimate

total_d1_rows_written = VPS_count * 1458 + 576
```

Workers requests：

```text
ping_task_pulls = 288 / VPS / day
ping_result_reports = 288 / VPS / day
basic_info_refresh = 48 / VPS / day
websocket_connect = 1 / VPS / day

worker_requests = VPS_count * 625
```

Durable Objects requests：

```text
raw_ws_messages = 3600 / 3 + 82800 / 600 = 1338 / VPS / day
do_billable_requests = websocket_connects + ceil(raw_ws_messages / 20) + ping_result_reports
```

## 配额估算表

| VPS 数 | D1 rows written/天 | D1 写入占比 | 3 天业务行保留 | D1 存储估算 | D1 存储占比 | Workers requests/天 | Workers 占比 | DO requests/天 | DO 占比 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 15,156 | 15.16% | 14,580 | 4.19 MiB | 0.08% | 6,250 | 6.25% | 3,559 | 3.56% |
| 20 | 29,736 | 29.74% | 29,160 | 8.38 MiB | 0.16% | 12,500 | 12.50% | 7,118 | 7.12% |
| 30 | 44,316 | 44.32% | 43,740 | 12.58 MiB | 0.25% | 18,750 | 18.75% | 10,677 | 10.68% |
| 50 | 73,476 | 73.48% | 72,900 | 20.96 MiB | 0.41% | 31,250 | 31.25% | 17,795 | 17.80% |

## Rows read 说明

D1 rows read 不能只靠 VPS 数精确推出，因为它取决于：

- 页面打开次数、历史图表查询次数、后台容量页访问次数。
- Worker isolate 缓存命中情况。
- D1 是否按索引命中，以及 Cloudflare 实际 `meta.rows_read`。
- 定时清理、告警、备份、登录、审计日志等非默认热路径。

默认热路径下，读配额最值得关注的是 `/api/clients/ping/tasks`、client token 认证、历史图表查询和后台容量页。真实 rows read 应以 D1 `meta.rows_read`、Cloudflare Dashboard 或 GraphQL Analytics 为准。

## 风险判断

| VPS 数 | 判断 |
| ---: | --- |
| 10 | 很安全 |
| 20 | 安全 |
| 30 | 安全，D1 写入约 44% |
| 50 | 仍低于 Free，但 D1 写入约 73%，建议留余量 |

如果把后台 `Ping 采集与写入间隔` 从默认 300 秒改成最低 60 秒，Ping 写入和 Ping 请求都会变成 5 倍，30 台会超过 D1 Free rows written。保持 300 秒默认值更适合 20-30 台、每台 3 个 Ping 链接的目标规模。
