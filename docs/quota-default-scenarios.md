# 默认配置配额消耗分析报告

生成时间：2026-06-09  
分析对象：当前仓库实际代码，不按旧版本或猜测计算。

## 结论先读

生产默认迁移只创建 `ping_tasks` 表，不会自动创建 Ping 任务。`worker/migrations/002_seed_demo.sql` 里的 3 个 Ping 任务只属于 demo seed，不属于默认生产部署。

因此，严格的生产默认配置下：

- VPS 10 / 20 / 30 / 50 台都不会因为 Ping 历史写入而增加 D1 写入。
- D1 写入主要来自 `records` 监控历史。
- Worker 请求主要来自 agent 每 60 秒拉取一次 `/api/clients/ping/tasks`，即使没有 Ping 任务也会拉取。
- 默认安装脚本使用 WebSocket 模式，3 秒实时上报不是每 3 秒一个新的 Worker HTTP 请求，而是 WebSocket 消息进入 Durable Object。

如果用户新增了一个或多个“全节点、60 秒”的 Ping 任务，那么 50 台 VPS 会明显超过 Workers Free 的 100,000 requests/day；D1 写入也会超过 Free 的 100,000 rows written/day。这个是当前默认使用方式下最容易踩的免费额度坑。

## 官方配额口径

Cloudflare D1 官方口径：

- Rows read：Workers Free 为 5,000,000/day。
- Rows written：Workers Free 为 100,000/day。
- Storage：Workers Free 为 5 GB total。
- `rows_read` / `rows_written` 以查询实际扫描/写入行数计，且包含索引。
- 写入被索引列会额外写索引行。

参考：

- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.cloudflare.com/d1/best-practices/use-indexes/
- https://developers.cloudflare.com/d1/observability/metrics-analytics/

Cloudflare Workers / Durable Objects 官方口径：

- Workers Free requests：100,000/day。
- Durable Objects Free requests：100,000/day。
- Durable Object WebSocket 建连算请求；进入 DO 的 WebSocket 消息按 20:1 折算为计费请求。

参考：

- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/pricing/

## 当前代码默认值

来自 `worker/migrations/001_init.sql`、`worker/src/settings/schema.ts`、`agent/main.go`、`worker/src/routes/admin.ts`：

| 项目 | 默认值 | 作用 |
| --- | ---: | --- |
| `record_enabled` | `true` | 开启监控历史 |
| `record_preserve_time` | 72 小时 | 监控历史保留 |
| `ping_record_preserve_time` | 72 小时 | Ping 历史保留 |
| `record_persist_interval_sec` | 60 秒 | D1 历史最短持久化间隔 |
| `live_poll_active_interval_sec` | 3 秒 | 有 viewer 时实时上报间隔 |
| `live_poll_idle_interval_sec` | 600 秒 | 无 viewer 时上报间隔 |
| `live_poll_active_max_duration_sec` | 600 秒 | viewer 活跃窗口 |
| `capacity_daily_view_minutes` | 60 分钟 | 后台容量页默认估算：每天看 1 小时 |
| agent `--mode` | `websocket` | 默认安装脚本使用 WebSocket |
| agent `--ping-interval` | 60 秒 | 每 60 秒拉取 Ping 任务 |
| Ping 任务数量 | 0 | 生产默认不创建 Ping 任务 |

本报告主表采用后台容量页的默认估算口径：每天有 60 分钟处于 active，其余 23 小时 idle。这与当前容量估算代码一致。

## 精确公式

设：

- `N` = VPS 数量。
- 无 GPU，除非后面单独说明 GPU 增量。
- 生产默认 Ping 任务数 = 0。
- 每台 VPS 每天 1 次 WebSocket 建连；如果连接跨天不断线，实际 Worker/DO 建连请求会更低；如果频繁重连，会更高。
- 不含管理员登录、打开页面、静态资源、迁移、导入 seed、告警发送、错误重试。

监控历史业务行：

```text
active_seconds_per_day = 60 * 60 = 3600
idle_seconds_per_day = 86400 - 3600 = 82800
effective_active_persist = max(3, 60) = 60
effective_idle_persist = max(600, 60) = 600

active_monitor_records_per_day = ceil(N * 3600 / 60) = 60N
idle_monitor_records_per_day = ceil(N * 82800 / 600) = 138N
monitor_records_per_day = 198N
monitor_records_retained_72h = 594N
```

D1 rows written 计费行：

当前 `records` 表有 2 个索引：

- `idx_records_client_time`
- `idx_records_time`

所以每插入 1 条 `records` 业务行，D1 rows written 至少为：

```text
1 table row + 2 index rows = 3 rows_written
```

监控持久化成功健康状态 `health:do_record_persistence` 最多每 10 分钟写 1 次 settings。`settings.key` 是主键，因此按当前索引口径计：

```text
144 settings writes/day * (1 table row + 1 primary-key index row) = 288 rows_written/day
```

因此无 Ping、无 GPU 的默认 D1 写入计费公式：

```text
D1_rows_written_per_day = 198N * 3 + 288 = 594N + 288
```

代码容量页存储估算使用：

```text
ESTIMATED_MONITOR_RECORD_BYTES = 420
estimated_storage_bytes = monitor_records_retained_72h * 420
```

注意：这是当前代码的估算字节，不是 Cloudflare SQLite 物理文件精确字节；实际 D1 storage 会包含 SQLite page、索引和元数据开销。

Workers 请求：

默认 WebSocket 模式下：

```text
ping task pull = N * 1440/day
basic info refresh = N * 48/day
websocket connect = N/day

Workers_requests_per_day = 1489N
```

Durable Object 计费请求：

后台容量默认口径下，每天 active 60 分钟、idle 23 小时：

```text
raw websocket report messages = N * (3600 / 3 + 82800 / 600)
                              = N * (1200 + 138)
                              = 1338N

DO_billable_requests = websocket_connects + ceil(raw_messages / 20)
                     = N + ceil(1338N / 20)
```

## 严格默认：0 个 Ping 任务，无 GPU

这是“刚部署、没有导入 demo seed、没有新增 Ping 任务”的生产默认持续消耗。

| VPS 数 | 监控业务行/天 | D1 rows written/天，含索引和健康写 | D1 Free 写入占比 | 72h 保留业务行 | 代码估算存储 | Workers requests/天 | Workers Free 占比 | DO 原始 WS 消息/天 | DO 计费 requests/天 | DO Free 占比 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 1,980 | 6,228 | 6.23% | 5,940 | 2.38 MiB | 14,890 | 14.89% | 13,380 | 679 | 0.68% |
| 20 | 3,960 | 12,168 | 12.17% | 11,880 | 4.76 MiB | 29,780 | 29.78% | 26,760 | 1,358 | 1.36% |
| 30 | 5,940 | 18,108 | 18.11% | 17,820 | 7.14 MiB | 44,670 | 44.67% | 40,140 | 2,037 | 2.04% |
| 50 | 9,900 | 29,988 | 29.99% | 29,700 | 11.90 MiB | 74,450 | 74.45% | 66,900 | 3,395 | 3.40% |

判断：

- D1 写入：50 台仍低于 Free 的 100,000/day。
- Workers 请求：50 台约 74.45%，仍低于 Free，但余量不大。
- DO 请求：远低于 Free。
- D1 读：不能只靠 VPS 数严格计算，见后文。

## 如果新增全节点 60 秒 Ping 任务

当前代码使用 `ping_snapshots` 合并写入：同一节点、同一时间窗口内的多个 Ping 任务会写到一条 `ping_snapshots`。

因此，对于“一个或多个全节点、60 秒、同频 Ping 任务”：

- 1 个任务和 3 个同频任务的 Ping 历史业务行数相同。
- 写入行数相同。
- JSON 内容大小会变大，但代码容量估算目前仍用固定 `ESTIMATED_PING_SNAPSHOT_BYTES = 220`，不会按任务数放大。
- 如果任务间隔不同，按每台节点最小 Ping 间隔估算。

Ping 业务行：

```text
ping_snapshots_per_day = N * 86400 / 60 = 1440N
ping_snapshots_retained_72h = 4320N
```

当前 `ping_snapshots` 有 2 个索引：

- `idx_ping_snapshots_client_time`
- `idx_ping_snapshots_time`

每条 Ping snapshot 的 D1 rows written：

```text
1 table row + 2 index rows = 3 rows_written
```

Ping 持久化成功健康状态 `health:ping_persistence` 最多每 10 分钟写 1 次：

```text
144 settings writes/day * 2 = 288 rows_written/day
```

Ping 增量公式：

```text
Ping_D1_rows_written_addon = 1440N * 3 + 288 = 4320N + 288
Ping_Workers_requests_addon = 1440N
Ping_DO_requests_addon = 1440N
```

注意：这里的 `Ping_DO_requests_addon` 是 HTTP stub request 到 DO，不是 WebSocket message，因此不使用 20:1 折算。

### 总量：默认监控 + 一个或多个全节点 60 秒 Ping 任务

| VPS 数 | D1 rows written/天 | D1 Free 写入占比 | 72h 监控+Ping 业务行 | 代码估算存储 | Workers requests/天 | Workers Free 占比 | DO 计费 requests/天 | DO Free 占比 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 49,716 | 49.72% | 49,140 | 11.44 MiB | 29,290 | 29.29% | 15,079 | 15.08% |
| 20 | 98,856 | 98.86% | 98,280 | 22.89 MiB | 58,580 | 58.58% | 30,158 | 30.16% |
| 30 | 147,996 | 148.00% | 147,420 | 34.33 MiB | 87,870 | 87.87% | 45,237 | 45.24% |
| 50 | 246,276 | 246.28% | 245,700 | 57.22 MiB | 146,450 | 146.45% | 75,395 | 75.39% |

判断：

- 20 台 + 60 秒全节点 Ping 已经非常接近 D1 Free 写入上限。
- 30 台 + 60 秒全节点 Ping 会超过 D1 Free 写入上限。
- 50 台 + 60 秒全节点 Ping 同时超过 D1 Free 写入和 Workers Free 请求上限。
- 多个同频 60 秒全节点 Ping 任务不会继续增加写入行数，但会增加每条 `values_json` 的大小和查询/序列化成本。

## 如果完全无人打开页面

上面的主表使用当前后台容量页默认估算：每天 active 60 分钟。实际运行中，如果 24 小时完全没有 viewer，WebSocket policy 会走 idle，agent 默认每 600 秒上报一次。

无 Ping、无 GPU 时：

```text
monitor_records_per_day = 144N
D1_rows_written_per_day = 144N * 3 + 288 = 432N + 288
raw_DO_messages = 144N
DO_billable_requests = N + ceil(144N / 20)
```

| VPS 数 | 监控业务行/天 | D1 rows written/天 | D1 Free 写入占比 | 72h 保留业务行 | 代码估算存储 | DO 计费 requests/天 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 1,440 | 4,608 | 4.61% | 4,320 | 1.73 MiB | 82 |
| 20 | 2,880 | 8,928 | 8.93% | 8,640 | 3.46 MiB | 164 |
| 30 | 4,320 | 13,248 | 13.25% | 12,960 | 5.19 MiB | 246 |
| 50 | 7,200 | 21,888 | 21.89% | 21,600 | 8.65 MiB | 410 |

Workers requests 不变，仍主要由每 60 秒拉 Ping 任务决定：

```text
Workers_requests_per_day = 1489N
```

## GPU 增量

当前代码使用 `gpu_snapshots`，一台 VPS 不管有几张 GPU，同一时间点写 1 条 snapshot。

在后台容量页默认口径下，每 1 台 GPU-capable VPS 增加：

```text
gpu_snapshots_per_day = 198
gpu_D1_rows_written_addon = 198 * 3 = 594/day
gpu_snapshots_retained_72h = 594
code_estimated_storage_addon = 594 * 420 bytes = 0.238 MiB
```

如果 10 / 20 / 30 / 50 台 VPS 全部都有 GPU：

| GPU VPS 数 | GPU snapshot 业务行/天 | D1 rows written 增量/天 | 72h 保留业务行增量 | 代码估算存储增量 |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 1,980 | 5,940 | 5,940 | 2.38 MiB |
| 20 | 3,960 | 11,880 | 11,880 | 4.76 MiB |
| 30 | 5,940 | 17,820 | 17,820 | 7.14 MiB |
| 50 | 9,900 | 29,700 | 29,700 | 11.90 MiB |

GPU 不是默认必然消耗，只有 agent 上报 `gpus` 数组时才会写。

## D1 rows read 为什么不能只靠 VPS 数精确计算

只用 `N = VPS 数量` 无法严格推出 D1 rows read。原因：

- agent 每 60 秒请求 `/api/clients/ping/tasks`，但后端有 token 缓存、Ping task 缓存，命中率取决于同一 Worker isolate、请求时间分布和冷启动。
- 公开页面、管理页面、历史图表、登录、审计日志、容量页都会读 D1，但访问次数不属于默认配置。
- DO 内部的持久化设置读取缓存为 5 秒，容量高水位 COUNT 是自适应 60 分钟 / 10 分钟 / 1 分钟，真实 rows read 取决于当前历史表行数和是否接近高水位。
- Cloudflare D1 的 `rows_read` 包含索引扫描，精确值应以 `D1Result.meta.rows_read`、Cloudflare Dashboard 或 GraphQL Analytics 为准。

可以严格写出默认热路径的触发次数：

| 触发源 | 默认频率 | 10 台 | 20 台 | 30 台 | 50 台 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/api/clients/ping/tasks` 请求次数 | 每台 1440/day | 14,400 | 28,800 | 43,200 | 72,000 |
| `/api/clients/uploadBasicInfo` 请求次数 | 每台 48/day | 480 | 960 | 1,440 | 2,400 |
| WebSocket report 原始消息，容量默认口径 | 每台 1338/day | 13,380 | 26,760 | 40,140 | 66,900 |
| WebSocket report 原始消息，无 viewer | 每台 144/day | 1,440 | 2,880 | 4,320 | 7,200 |

但这些请求最终读多少 D1 行，必须看缓存命中和 D1 meta，不能从 VPS 数单独精确推出。

## 免费额度风险分级

严格生产默认，0 Ping、无 GPU：

| VPS 数 | 风险 |
| ---: | --- |
| 10 | 很安全 |
| 20 | 安全 |
| 30 | 安全 |
| 50 | D1 写入安全；Workers 请求约 74.45%，需要注意余量 |

新增一个或多个全节点 60 秒 Ping 任务：

| VPS 数 | 风险 |
| ---: | --- |
| 10 | 安全，但 D1 写入接近一半 |
| 20 | D1 写入约 98.86%，几乎顶满 |
| 30 | 超 D1 Free 写入 |
| 50 | 超 D1 Free 写入，且超 Workers Free 请求 |

## 关键建议

1. 生产默认 0 Ping 任务时，50 台以内主要瓶颈不是 D1 写入，而是 Workers requests 余量。
2. 一旦开启全节点 60 秒 Ping，20 台左右就接近 D1 Free 写入上限。
3. 50 台如果要使用全节点 Ping，建议至少做一个：
   - 升级 Workers Paid；
   - 把 agent `--ping-interval` 和 Ping 任务间隔提高到 120 秒或更长；
   - 只对部分节点启用 Ping；
   - 继续优化 agent：没有 Ping 任务时降低 `/api/clients/ping/tasks` 轮询频率或支持服务端返回 `next_poll_sec`。
4. D1 rows read 必须用实际 `meta.rows_read` 或 Dashboard 校验；不要用“SQL 次数”推断读配额。
5. 当前最需要继续优化的免费额度瓶颈不是 3 秒实时 WebSocket，而是默认每 60 秒每节点一次的 Ping task pull 请求。

