# D1 配额消耗分析与优化记录

日期：2026-06-09

## 结论

在“不降低 3 秒实时监控密度”的前提下，当前最值得优化的不是实时上报本身，而是 D1 历史写入、Ping 历史索引、容量保护 COUNT、健康状态写入、Ping 任务轮询。

Cloudflare D1 的免费额度按 `rows_read` 和 `rows_written` 计算。`batch()` 能减少 Worker 到 D1 的往返和子请求压力，但如果最终读写的行数不变，D1 行读写配额不会自动下降。真正省 D1 配额的办法是减少扫描行数、减少写入行数、减少被写入的索引、减少不必要的热路径查询。

## 官方规则依据

参考文档：

- Cloudflare D1 Pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare D1 Metrics and analytics: https://developers.cloudflare.com/d1/observability/metrics-analytics/
- Cloudflare D1 Return objects: https://developers.cloudflare.com/d1/worker-api/return-object/

关键规则：

- D1 免费额度包含每天 5M rows read 和 100k rows written。
- `rows_read` 主要反映查询扫描了多少行，不等于返回给前端多少行。
- 索引能减少查询扫描，降低读行数。
- 写入被索引的列会增加索引维护写入。Cloudflare 文档明确说明，写入索引列至少会增加额外 rows written。
- Dashboard、Wrangler、应用代码执行的查询都会计入使用量。

## 当前默认场景账单模型

用户给出的场景：

- 1 台 VPS
- 监控实时上报默认 3 秒
- 历史记录默认 60 秒持久化一次
- 3 个 Ping 任务，默认每 60 秒执行一次
- 8 小时实际用量：读取 324.52k / 5M，写入 7.29k / 100k

按当前模型估算 8 小时写入：

| 来源 | 业务行 | 旧索引数量 | 估算 rows written |
| --- | ---: | ---: | ---: |
| 资源历史 `records` | 480 | 2 | 480 * 3 = 1440 |
| Ping 历史 `ping_records` | 3 * 480 = 1440 | 3 | 1440 * 4 = 5760 |
| 合计 | 1920 | | 7200 |

这与用户看到的 7.29k 非常接近，说明写入消耗主要来自 Ping 历史和索引写放大，而不是 3 秒实时上报直接写了 3 秒一条历史。

按 24 小时推算旧模型：

| 来源 | 每日业务行 | 旧 rows written 估算 |
| --- | ---: | ---: |
| 资源历史 | 1440 | 4320 |
| Ping 历史，3 个任务 | 4320 | 17280 |
| 合计 | 5760 | 21600 |

## 打包与不打包对比

这里要区分两件事：

1. 打包上传：多条数据一次 HTTP 请求或一次 D1 batch 写入。
2. 聚合存储：多条数据合成更少的 D1 行。

只做打包上传，不改变最终写入的 D1 行数时：

| 项目 | 不打包 | 打包 | D1 配额变化 |
| --- | ---: | ---: | --- |
| Worker 请求数 | 高 | 低 | 会下降 |
| D1 round trip | 高 | 低 | 会下降 |
| D1 rows written | 相同业务行数 | 相同业务行数 | 基本不变 |
| D1 rows read | 相同查询扫描 | 相同查询扫描 | 基本不变 |

如果是聚合存储，例如把 60 秒内 20 个 3 秒样本压成 1 行，D1 写入才会明显下降。但这个项目当前默认已经是实时 3 秒、历史 60 秒，所以历史库已经做了“降采样存储”。继续把 60 秒历史再压成更少，会降低历史曲线密度，不符合当前“不降低监控密度”的约束。

### 合并读写方案深度判断

用户提出的“5 个节点写到一个地方”要分三类看：

| 方案 | 示例 | 是否减少 D1 rows written | 是否减少 D1 rows read | 当前建议 |
| --- | --- | --- | --- | --- |
| D1 `batch()` 合并写入 | 5 条 `INSERT records` 放进一个 `db.batch()` | 不明显，仍是 5 行业务写入加对应索引写入 | 不减少扫描行数 | 可用于降延迟/队列压力，但不能当作省 D1 配额主方案 |
| 单节点多指标合并到一行 | 1 个节点 1 分钟的 CPU/RAM/磁盘/网络写进同一行 | 当前已经是这样 | 当前已经是这样 | 已完成，不需要再拆/合 |
| 跨节点同时间桶合并到一行 | 5 个节点同一分钟写成 1 行 JSON | 会下降，约按分组大小降低业务行写入 | 看查询形态；查全局趋势可能下降，查单节点未必下降 | 理论可行，但不建议作为当前默认方案 |
| 跨时间合并到一行 | 1 个节点 5 分钟/1 小时写成 1 行数组 | 会下降 | 历史曲线点数下降或查询需读大 JSON | 会降低历史密度，不符合当前目标 |
| 预聚合读模型 | 保留原始 60 秒历史，再额外写 5 分钟汇总 | 读会下降 | 写会增加 | 不适合免费 D1 写配额优先场景 |

当前 `records` 表已经是一行包含一个节点一次历史采样的全部指标：CPU、GPU 汇总、RAM、Swap、Load、温度、磁盘、网络、进程数、连接数、uptime 都在同一行。也就是说“1 个节点 1 次合并写入所有 CPU/RAM/磁盘等数据”已经实现了；如果把这些指标拆成多张表反而会更耗 D1 rows written。

真正能进一步降低写入的只有“减少 D1 行数”，例如把 5 个节点同一分钟合成 1 行：

```text
当前：
records: (node-a, 12:00, ...)
records: (node-b, 12:00, ...)
records: (node-c, 12:00, ...)
records: (node-d, 12:00, ...)
records: (node-e, 12:00, ...)

跨节点聚合：
record_buckets: (bucket=12:00, group=0, payload_json=[node-a..node-e])
```

它的收益和代价：

- 写入：5 个节点每分钟从 5 行降到 1 行，表行写入约降 80%；索引写入也会下降。
- 查询单节点历史：需要按时间范围读取 bucket 行，然后在 Worker 里从 JSON 里挑出目标节点；如果每个 bucket 都包含该节点，rows read 可能和当前单节点查询接近，但 CPU/内存/响应体处理更重。
- 查询单节点最新记录：不能直接用 `(client, time)` 索引定位，只能额外维护索引表或扫描 bucket。
- 删除单节点：当前可以 `DELETE FROM records WHERE client=?`；聚合后需要重写很多 JSON bucket 行，反而产生大量写入。
- 隐藏/删除节点、容量估算、过期清理、导出备份、图表分页都会复杂很多。
- 负载告警、离线判断、按节点查看历史都依赖“节点维度可索引”。把节点藏进 JSON 后，这些功能要么变慢，要么需要额外索引表，抵消一部分省配额收益。

因此当前判断：

- 小规模默认场景，例如 1-10 个节点：不建议跨节点聚合。当前主要瓶颈是 Ping 历史、索引写放大、COUNT 扫描和重复配置读取，已经在优化这些点。
- 中规模场景，例如 50-200 个节点：可以考虑“可选归档层”，而不是替换主历史表。保留最近 72 小时按节点可查询的 `records`，超过 72 小时后压缩成 JSON/R2 归档更合理。
- 超大规模场景，例如几百到上千节点且只看总览：可以设计 `record_buckets`，但这是一次数据模型重构，需要重新设计查询、清理、备份、告警和 UI，不应作为当前默认一键部署模型。

最适合当前项目的折中路线：

1. 保持 `records` 一行一个节点一个历史采样，保证查询简单、图表准确、删除节点便宜。
2. 对写入密集的 Ping 历史继续减索引、缓存任务表、按任务间隔限频。
3. 对读取密集的历史接口做短缓存、`limit + 1` 分页、避免 `COUNT(*)`。
4. 后续如果要做“合并存储”，优先做可选归档或 R2 压缩文件，而不是把热数据主表改成 JSON bucket。

## Ping 查询是否应该 60 秒一次

可以，而且已修正默认值。

当前前端节点详情页的 Ping 历史不是每 3 秒查询 D1。它进入节点页时加载一次 Ping 任务和 Ping 历史，实时 3 秒刷新走 WebSocket 内存数据。

真正的问题在 agent：主监控默认 3 秒，Ping 任务本身默认 60 秒，但 agent 安装脚本和二进制参数以前默认每 30 秒拉一次 `/api/clients/ping/tasks`。这会产生额外 Worker 请求和 D1 读取。现在默认改成 60 秒：

- `agent/main.go`: `--ping-interval` 默认 60。
- `agent/install-linux.sh`: `PING_INTERVAL=60`，帮助文案同步。
- `agent/install-windows.ps1`: 默认 60。

如果以后用户手动创建 5 秒或 10 秒 Ping 任务，agent 会在下一次拉到任务列表后按最短任务间隔自适应检查，不会继续固定按旧的 30/60 秒节奏跑。`--ping-interval` 仍可作为没有任务间隔或拉取失败时的兜底值。

## 已实施优化

### 1. 减少 Ping 写放大

旧 `ping_records` 有 3 个索引：

- `idx_ping_records_client_time`
- `idx_ping_records_task`
- `idx_ping_records_time`

新方案保留 2 个索引：

- `idx_ping_records_client_task_time`：服务 `WHERE client = ? AND task_id = ? ORDER BY time DESC`
- `idx_ping_records_time`：服务定时清理

新增迁移：

- `worker/migrations/010_optimize_ping_indexes.sql`

效果：

| 场景 | 每条 Ping 写入 | 3 任务每日 rows written |
| --- | ---: | ---: |
| 旧索引 | 表 1 + 索引 3 = 4 | 4320 * 4 = 17280 |
| 新索引 | 表 1 + 索引 2 = 3 | 4320 * 3 = 12960 |

在用户当前场景下，Ping 写入约下降 25%，总写入约下降 20%。

### 2. 减少热路径设置读取

原逻辑在每个实时 report 进入 `persistReport()` 后，先读取 D1 设置、容量，再判断是否到了 60 秒历史入库时间。默认 3 秒上报时，20 条里 19 条并不需要写历史，却仍可能触发 D1 查询。

新逻辑先用 Durable Object 内存和 DO storage 判断是否到历史持久化间隔；未到间隔直接返回。只有真正要写历史时才读取 D1 设置和做容量保护。

这不降低 3 秒实时监控密度，也不降低 60 秒历史入库密度。

### 3. 降低容量保护 COUNT 频率

`canPersistWithinCapacity()` 从固定 60 秒检查改为自适应检查：远离高水位时最多 60 分钟才做一次容量 COUNT，接近高水位时收紧到 10 分钟/1 分钟。容量保护仍保留，但避免频繁 `COUNT(*)` 扫描 `records`、`gpu_records`、`gpu_snapshots`、`ping_records`、`ping_snapshots`。

这对 rows read 的下降很关键。用户 8 小时读 324k，最可疑的读放大就是周期性全表 COUNT 和启动 bootstrap，而不是页面浏览。

### 4. Schema bootstrap 加哨兵

`ensureSchema()` 增加 `schema_bootstrap_version` 哨兵。Worker isolate 冷启动时先查 1 个 settings key，如果版本匹配就跳过几十条 `CREATE TABLE IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`、`ALTER TABLE` 兼容语句。

这减少冷启动时的 D1 元数据查询和写入风险。

### 5. 健康状态成功写入节流

热路径成功状态以前会频繁写 `settings` 和 `audit_logs`。现在：

- `/api/admin/health` 的 D1 write probe 不再同时写 `health:d1_write_probe:last_probe` 和 `health:d1_write_probe` 两个 settings key；健康事件写入本身就是写探针，每次健康检查少 1 次 D1 settings 写入。
- `/api/admin/health` 的 D1 write probe 连续 OK 10 分钟内不重复写 `health:d1_write_probe`。重复打开健康页时仍会读取健康状态并执行其它探针，但不再每次写 settings；如果之前状态是 error，下一次 OK 会立即写入恢复状态。
- DO 内 `do_record_persistence`、`ping_persistence` 成功事件 10 分钟内最多写一次。
- 这层节流同时存在于 DO 内存和 D1 `settings` 中。DO 冷启动或跨 isolate 后，连续 OK 仍会先读已有健康状态并跳过重复写入；但如果之前状态是 error，下一次 OK 不会被节流，会立即恢复健康状态。
- 定时任务成功事件 1 小时内最多写一次。
- Ping result 路由删除了重复成功健康写入。

错误事件仍保留，便于排障。

### 6. 定时清理减少空跑读写

定时清理现在先删除过期行。如果没有删除任何行，直接返回，不再额外计算 before/after backlog，也不写 audit log。

### 7. 复用 Agent 认证读取结果

HTTP 上报路径进入 `/api/clients/report` 时，认证中间件已经通过 token 读取了完整 `clients` 行。旧逻辑随后为了 IP 变更检测又按 uuid 读取同一行一次。

现在认证中间件会把 client 行放入请求上下文，`/api/clients/report` 和 `/api/clients/uploadBasicInfo` 直接复用它。默认安装走 WebSocket，上报阶段不受这个问题影响；但如果用户切到 HTTP 模式或 WebSocket 不稳定回落到 HTTP，上报热路径可从每次 2 次 client 读取降到 1 次。按 3 秒上报估算，HTTP 模式单节点每天少约 28800 次 client 行读取，不降低实时监控密度。

### 8. 运行时间参数链路对齐

这次继续审查了前端、Worker、agent 三端的 3 秒、60 秒、600 秒、72 小时等运行参数，目标是后台保存后不能出现“后台是 60 秒，其他地方还在 30 秒跑”的情况。

后台可配置参数与当前链路：

| 后台设置 key | 默认 | Worker 使用位置 | 前端使用位置 | agent 使用位置 |
| --- | ---: | --- | --- | --- |
| `live_poll_active_interval_sec` | 3 秒 | DO policy `sample_interval_sec`，活跃 viewer 时 `report_interval_sec` | HTTP fallback 可见页面轮询间隔 | WebSocket/HTTP policy 动态采样间隔 |
| `live_poll_idle_interval_sec` | 600 秒 | DO policy 空闲 `report_interval_sec` | 页面隐藏或 WS 已连接后的低频 fallback | WebSocket/HTTP policy 动态上传间隔 |
| `live_poll_active_max_duration_sec` | 600 秒 | viewer token TTL / DO viewer TTL | 前端 viewer 窗口过期时间 | policy `viewer_ttl_sec` 只作提示 |
| `record_persist_interval_sec` | 60 秒 | DO 历史入库间隔 | 管理容量估算 | 不直接控制 agent；agent 仍按实时策略上报，Worker 负责历史降采样 |
| `record_preserve_time` | 72 小时 | cron/手动清理 `records`、`gpu_records` | 管理设置与容量估算 | 不使用 |
| `ping_record_preserve_time` | 72 小时 | cron/手动清理 `ping_records` | 管理设置与容量估算 | 不使用 |
| `audit_log_preserve_time` | 2160 小时 | cron/手动清理 `audit_logs`，容量过期统计 | 后台设置返回值 | 不使用 |
| Ping 任务 `interval_sec` | 60 秒 | Ping 结果 DO 去重/限频、容量估算 | Ping 任务表单与图表点数估算 | agent 执行 Ping 的任务间隔 |

已修正的对齐点：

- agent `--ping-interval` 默认从 30 秒改为 60 秒。
- agent Ping 轮询现在会根据后台返回的最短 Ping 任务间隔自适应。任务全是 60 秒时按 60 秒拉取；如果后台把某任务设为 10 秒，agent 下一轮看到任务后会按 10 秒检查，不会继续按旧默认 30/60 秒错跑。
- `/api/clients/policy` 的 DO 异常兜底现在也读取后台设置生成 policy，不再硬编码 3/600/600。
- 后台保存实时策略成功后，前端同 tab 的 `LiveDataContext` 会收到 `cf-monitor:live-poll-settings-updated` 事件，立即更新 HTTP fallback 的 3/600/600 秒配置，不需要刷新页面。
- 后台保存设置、编辑/新增/删除/排序 Ping 任务、隐藏/删除/排序节点后，会立即清理 Worker isolate 内的公开元数据缓存。这样 `/api/public`、`/api/clients`、`/api/task/ping`、`/api/nodes` 不会继续吐出旧的 30 秒缓存数据。
- `/api/ws/live-token` 的 `expires_at` 现在跟随 `live_poll_active_max_duration_sec`。以前 token 响应固定约 60 秒，DO viewer TTL 却按后台 600 秒，这会让前端看到的保活时间和后台设置不一致。
- `audit_log_preserve_time` 补进初始化 SQL、schema bootstrap 和迁移，容量页过期行统计也改为使用后台设置，不再固定按 2160 小时。
- E2E 现在断言后台保存 `live_poll_active_interval_sec=5`、`live_poll_idle_interval_sec=300`、`live_poll_active_max_duration_sec=300` 后，WebSocket policy 和 HTTP policy 都返回对应值。
- E2E 现在断言后台保存实时策略后，`/api/public` 立即返回新值，`/api/ws/live-token` 有效期也变成约 300 秒，不再保留旧 600/60 秒。
- E2E 现在断言后台把某个 Ping 任务从 60 秒改为 5 秒后，Ping 结果持久化限频会按新 5 秒间隔接受，不会继续按旧 60 秒阻塞。

仍保留的固定 30 秒不是运行采样频率：

- agent WebSocket heartbeat 默认 30 秒，用于连接保活。
- 前端 WebSocket 断线重连延迟上限 30 秒，且会受 idle 间隔限制。
- Worker HTTP live TTL 最小 30 秒，防止极端低 TTL 造成抖动。

这些 30 秒不代表监控、历史入库或 Ping 任务在 30 秒运行。

### 9. Agent Ping 任务读取缓存

`/api/clients/ping/tasks` 和 `/api/clients/ping/result` 以前都会读取 `ping_tasks`。在多节点场景下，即使所有节点拿到的是同一份任务配置，也会形成：

```text
节点数 * agent 拉取频率 * ping_tasks 表扫描
```

现在 Worker isolate 内增加了 30 秒的 Agent Ping 任务缓存：

- agent 拉任务时复用同一份 `ping_tasks` 元数据。
- agent 上报 Ping 结果时也复用同一份任务元数据做校验和 interval 映射。
- 新增、编辑、排序、删除 Ping 任务、删除节点导致任务引用被裁剪、导入备份恢复后，都会立即清理该缓存。

这不会降低 Ping 执行频率，也不会降低 Ping 历史保存密度。它只是把“同一 isolate 内多节点重复读取同一任务表”的 D1 rows read 降下来。Cloudflare 可能同时运行多个 isolate，所以这是 per-isolate 优化；跨 isolate 最多仍会各读一次。

按默认 60 秒拉取估算：

| 节点数 | 无缓存任务读取 | 30 秒 isolate 缓存后 |
| ---: | ---: | ---: |
| 1 | 约 1 次/分钟 | 约 1 次/分钟 |
| 10 | 约 10 次/分钟 | 每个活跃 isolate 约 1-2 次/分钟 |
| 100 | 约 100 次/分钟 | 每个活跃 isolate 约 1-2 次/分钟 |

如果节点集中命中同一个 isolate，这个优化对 D1 read 很明显；如果 Cloudflare 将请求分散到多个 isolate，收益会按 isolate 数折减，但仍不影响监控密度。

### 10. Agent Token 认证短缓存

Agent 的所有受保护接口都会先通过 token 找到 `clients` 行。默认推荐 WebSocket 上报时，这个认证主要发生在连接建立和 Ping 任务/结果接口上；如果用户切换到 HTTP 模式，3 秒上报会变成：

```text
每节点每天 86400 / 3 = 28800 次 token -> client 查询
```

这类查询不提升监控密度，只是在重复证明同一个短期内稳定的 token。现在 Worker isolate 内增加了 15 秒 Agent 认证缓存：

- `/api/clients/report`
- `/api/clients/uploadBasicInfo`
- `/api/clients/policy`
- `/api/clients/ping/tasks`
- `/api/clients/ping/result`
- `/api/clients/report` WebSocket 握手

都会先查短缓存，未命中才读 D1 的 `clients` 表。

无效 token 也增加了 5 秒短负缓存，并设置 512 项上限。这样同一个错误安装命令、旧 token 重试、扫描请求不会在短时间内每次都查询 `clients.token`。负缓存不影响正常监控密度；新建节点和 token 轮换会清理对应缓存，避免同一 isolate 内刚创建的 token 被旧负缓存挡住。WebSocket agent 握手现在复用同一套缓存，网络抖动重连或旧 token 重试时也不会重复放大 D1 读取。

失效策略：

- 管理端编辑节点、隐藏节点、删除节点、批量删除节点、token 轮换、备份恢复后，会立即清理同一 isolate 内的认证缓存。
- Agent 自己上传基础信息或 HTTP report 触发 IP/version 写入后，也会清理对应节点缓存，避免旧 IP 信息导致重复 IP 变更通知。
- Cloudflare 可能同时运行多个 isolate；跨 isolate 的旧 token 理论上最多可能保留 15 秒。这是用很短 TTL 换 D1 热路径读数下降的折中。

按 HTTP 3 秒上报估算，单节点认证读从约 28800 次/天，下降到最多约 `86400 / 15 = 5760` 次/天；WebSocket 模式下收益较小，但 Ping 任务和 Ping 结果接口仍能减少重复 token 查询。

### 11. 容量页行数统计缓存

后台“采集与记录策略”页会展示 D1 预计存储、写入/天、过期待清理等信息。其中估算值只需要读取 settings、clients、ping_tasks；但真实行数和过期 backlog 会执行多次 `COUNT(*)`：

- `records`
- `gpu_records`
- `ping_records`
- `audit_logs`
- 以及带 `WHERE time < ?` 的过期行统计

这些 COUNT 对管理判断有用，但不属于监控采样密度的一部分。现在容量页行数统计增加 60 秒 per-isolate 缓存：

- 普通打开容量页时复用最近一次精确行数快照。
- `/api/admin/capacity?refresh_counts=true` 可强制刷新。
- 手动“维护清理”后会清理缓存，前端随后使用强制刷新拿最新行数。
- 当前输入、每日观看分钟、保存间隔、Ping 任务估算仍按最新 settings/clients/ping_tasks 计算；缓存只覆盖真实行数和过期 backlog 的 COUNT。

这样可以避免管理页反复打开、刷新、切换时重复扫描历史大表，不影响 agent 上报、WebSocket 实时数据、历史保存频率、Ping 频率。

### 12. 批量节点管理减少重复读取

后台批量隐藏、批量删除以前按节点循环执行：

```text
每个 uuid -> getClient()
每个 uuid -> syncLiveClientMeta() 再 getClient()
每个 uuid -> pruneClientReferences() 扫描 ping_tasks 和 load_notifications
```

当一次处理 100 个节点时，这会把管理端低频操作放大成数百次 D1 读取，尤其是 `ping_tasks` 和 `load_notifications` 会被重复扫描。

现在改为：

- `getClientsByIds()` 使用 `WHERE uuid IN (...)` 按批次读取目标节点。
- 批量隐藏只更新未隐藏节点，并直接用已有 client 元数据同步 DO，不再同步前二次读取 `clients`。
- 批量删除使用 `deleteClients()`、`clearClientsRecords()` 一次处理一批 uuid。
- `pruneClientReferencesForClients()` 只扫描一次 `ping_tasks` 和一次 `load_notifications`，然后一次性裁剪所有被删除节点引用。
- smoke 测试用 fake D1 断言批量读取 clients 为 1 次，批量裁剪 ping/load 配置也各 1 次。

这不影响实时监控密度，也不影响 60 秒历史或 Ping 保存密度；它只降低后台批量操作时的 D1 rows read 和查询往返。

### 13. 设置保存 no-op 写入去重

前端的站点设置、通用设置、通知设置页面通常会把整份 `settings` 对象发回后端。旧逻辑对请求里的每个 key 都执行：

```text
INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
```

这意味着用户只改 1 个字段，甚至没有改任何字段直接点“保存”，也可能写入二十多个 settings 行，并额外写一条 `settings_edit` 审计日志。D1 rows written 是免费额度里最紧的部分，默认每天只有 100k 行写入，因此这类 no-op 写入应该尽量消掉。

现在 `/api/admin/settings` 会：

- 先读取一次当前 settings，并通过同一套 schema 补齐默认值。
- 只对值真正变化的 key 执行 `setSetting()`。
- 如果没有任何变化，直接返回 `noop: true`，不写 settings、不写 audit、不刷新 DO。
- 只有实时策略相关 key 改变时才刷新 DO policy。
- 只有历史持久化相关 key 改变时才刷新 DO record settings。
- 只有 public setting 改变时才清公开元数据缓存。

这会用 1 次 settings 读取换掉大量无意义 settings 写入。对于管理页保存这种低频路径，读配额更宽、写配额更紧，这个交换更符合 D1 免费额度约束。

### 14. 离线/到期通知 no-op 写入去重

离线通知和到期通知的编辑接口支持单个和批量保存。旧逻辑使用 `INSERT OR REPLACE`：

```text
INSERT OR REPLACE INTO offline_notifications ...
INSERT OR REPLACE INTO expiry_notifications ...
```

这会在值没有变化时仍然写表。后台通知页常见操作是“打开页面 -> 保存当前配置”，或者批量保存一批节点，其中很多节点配置没有变。这些写入不会提升监控密度，也不会影响提醒准确性，只消耗 D1 rows written。

现在改为 UPSERT，并在 `DO UPDATE` 上加 `WHERE` 条件：

```text
ON CONFLICT(client) DO UPDATE ...
WHERE old_value IS NOT excluded.value
```

效果：

- 新建通知配置仍会插入 1 行。
- 真实变更 enable / grace_period / advance_days 时才 UPDATE。
- 完全相同的重复保存返回 `noop: true`、`changed: 0`。
- 批量保存仍返回 `updated` 作为兼容字段，同时返回真实写入的 `changed`。

这不改变离线检测周期、不改变到期检测周期、不改变任何监控采样或历史保存密度，只减少管理端配置保存产生的 D1 写入。

### 15. 负载通知规则 no-op 更新去重

负载通知规则属于管理配置，不属于监控采样本身。旧的编辑接口只要提交成功就执行：

```text
UPDATE load_notifications SET ... WHERE id = ?
```

即使 name、clients、metric、threshold、ratio、interval_min 都没有变化，也会写表。现在 `updateLoadNotification()` 会把每个待更新列同时放进变化判断：

```text
UPDATE load_notifications
SET ...
WHERE id = ?
  AND (column_a IS NOT ? OR column_b IS NOT ? ...)
```

效果：

- 管理端重复编辑完全相同的规则时返回 `noop: true`、`changed: 0`。
- 真正改规则时仍正常写入。
- 定时负载告警触发后的 `last_notified` 更新仍走同一个 helper；时间变化时会写入，重复同值才跳过。
- 删除节点时裁剪负载规则引用也使用真实 changed 结果计数。

这不改变负载告警检查周期、不改变监控采样、不改变历史写入，只减少管理配置重复保存导致的 D1 rows written。

### 16. 节点和 Ping 任务排序只更新变化行

节点排序和 Ping 任务排序属于后台管理操作，不影响 agent 上报密度、Ping 执行密度或历史保留策略。旧逻辑在每次提交排序时会对最终列表里的所有行执行 UPDATE：

```text
UPDATE clients SET sort_order = ? WHERE uuid = ?
UPDATE ping_tasks SET sort_order = ? WHERE id = ?
```

即使用户拖动后又回到原顺序，或者只交换前两项，也会写入整张排序列表。这类写入低频，但在节点数或 Ping 任务数变多后，会形成明显的 D1 rows written 放大。

现在排序逻辑会：

- 先读取当前排序，校验提交的 uuid / id 是否存在。
- 拼出最终排序列表，保留未提交项的相对顺序。
- 只对 `sort_order` 真正变化的行执行 UPDATE。
- 完全相同的排序直接返回 `0`，不写 D1。
- 返回值使用 D1 `meta.changes` 汇总真实变化行数。

示例影响：

| 操作 | 旧写入 | 新写入 |
| --- | ---: | ---: |
| 100 个节点保存原顺序 | 100 行 | 0 行 |
| 100 个节点只交换 2 个节点 | 100 行 | 2 行 |
| 30 个 Ping 任务保存原顺序 | 30 行 | 0 行 |
| 30 个 Ping 任务只交换 2 个任务 | 30 行 | 2 行 |

这不会降低任何监控密度，只减少后台拖拽排序或重复保存排序产生的无意义 D1 写入。`worker/scripts/smoke-e2e.mjs` 已增加 fake D1 断言，覆盖“同序不写”和“交换两项只写两行”。

### 17. 单节点编辑和 Ping 任务编辑 no-op 写入去重

后台单节点编辑和 Ping 任务编辑也是管理路径，不参与实时采样。旧逻辑只要提交合法，就会执行 UPDATE，并继续：

- 刷新公开元数据缓存。
- 刷新 agent 认证缓存或 Ping 任务缓存。
- 写入 `audit_logs`。

这意味着用户打开编辑弹窗后直接点保存，也会产生至少 1 行业务表写入 + 1 行审计写入，并触发缓存失效。Ping 任务编辑还会让 agent 下一轮重新读取任务配置。它不会增加监控密度，只增加 D1 rows written 和后续 rows read。

现在 `updateClient()` 和 `updatePingTask()` 会在 SQL 层加入变化条件：

```text
UPDATE ... SET ...
WHERE id_or_uuid = ?
  AND (column_a IS NOT ? OR column_b IS NOT ? ...)
```

效果：

- 完全相同的节点编辑返回 `noop: true, changed: 0`。
- 完全相同的 Ping 任务编辑返回 `noop: true, changed: 0`。
- no-op 时不写 `clients` / `ping_tasks`，不写 `audit_logs`，不刷新公开缓存，也不刷新 agent 任务缓存。
- 真实变化时仍正常更新，并继续清缓存、写审计。
- agent 端基础信息上报和版本刷新也复用这层保护；即使上层漏判相同值，D1 也不会写无变化 UPDATE。

这不改变 3 秒实时、不改变 60 秒历史、不改变 60 秒 Ping，只减少后台重复保存和上报元数据重复写入。

### 18. 公开历史接口增加 10 秒 isolate 内存缓存

公开历史接口包括：

- `/api/recent/:uuid`
- `/api/records/load`
- `/api/records/gpu`
- `/api/records/ping`

这些接口本来已经设置了 `Cache-Control: public, max-age=10`，浏览器和边缘缓存命中时可以减少请求。但在以下场景中仍可能重复读 D1：

- 同一页面内多个组件短时间重复请求同一个 URL。
- 用户快速切换图表/标签后又切回来。
- CDN 或浏览器缓存没有命中，但请求仍落到同一个 Worker isolate。
- Ping 图表按任务拆分请求，多个图表实例可能重复拉同一任务历史。

现在公开历史接口增加了 per-isolate 内存缓存：

- TTL 使用现有公开历史缓存语义：10 秒。
- key 使用完整路径和排序后的 query 参数，避免不同节点、任务、分页、时间范围互相污染。
- 上限 256 项，超过后按插入顺序淘汰最旧项，避免 isolate 内存无界增长。
- 管理端公开元数据失效时同步清空历史缓存，减少节点隐藏/排序/任务变化后的短暂残留。
- 响应头 `X-CF-Monitor-History-Cache: miss|hit` 方便 smoke 和线上排查确认命中情况。

效果：

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| 同 URL 10 秒内重复打开历史 | 每次可能读 D1 | 第一次读 D1，后续同 isolate 直接返回缓存 JSON |
| Ping 历史同任务重复请求 | 每次可能读 `ping_records` | 10 秒内命中内存缓存 |
| 节点隐藏/任务编辑后 | 依赖外部缓存自然过期 | 同 isolate 公开缓存立即清空 |

这不改变 agent 采样、不改变历史写入间隔、不改变 D1 中实际保留的数据，只减少用户查看页面时的重复 rows read。由于公开接口已经声明 10 秒缓存，新内存缓存与现有可见一致性预期一致。

### 19. 登录限流过期清理按 isolate 节流

登录接口每次请求都会做几类事情：

- 检查当前 IP / IP+用户名的失败桶是否锁定。
- 登录失败时更新失败次数和锁定时间。
- 登录成功时清除当前相关失败桶。
- 清理 24 小时以前且不再锁定的旧失败桶。

前三项是安全逻辑，必须逐次执行。旧失败桶清理属于维护逻辑，不需要每次登录都执行。旧逻辑在每次登录开始前都会执行：

```text
DELETE FROM login_rate_limits
WHERE last_failed_at < ?
  AND (locked_until IS NULL OR locked_until < ?)
```

这条语句有索引辅助，但在正常登录、频繁刷新登录页、或遭遇撞库时仍会反复触发过期扫描。它不提高监控密度，也不提高单次登录校验准确性。

现在改为同一 Worker isolate 最多 10 分钟执行一次旧桶清理：

- 每次登录仍会检查锁定状态。
- 每次失败仍会更新失败计数。
- 每次成功仍会清除当前登录相关桶。
- 只有“清理 24 小时以前旧桶”的维护 SQL 会被节流。
- smoke 使用 fake D1 覆盖：首次执行、10 分钟内跳过、10 分钟后再次执行。

同时，失败登录路径合并了限流桶读取：

- 登录开始时一次性读取 `login:ip:*` 和 `login:ip-user:*` 两个桶。
- 锁定判断复用这两个桶。
- 如果用户名不存在或密码错误，失败计数更新继续复用这两个桶，不再二次 SELECT。
- smoke 使用 fake D1 覆盖：两个桶只读 2 次，记录失败只写 2 次，不再额外读 D1。

登录失败审计也做了短期去重：

- 同一 Worker isolate 内，同 IP + 同用户名 + 同失败原因，60 秒内只写 1 条 `login_failed` 审计日志。
- 不同失败原因仍独立记录，例如 `unknown_user` 和 `invalid_password` 分开节流。
- 这层只影响审计日志写入，不影响登录限流桶的失败计数、锁定判断或成功清桶。
- throttle Map 上限 512 项，避免异常登录流量撑大内存。

这不影响监控数据，不降低登录限流防护，只减少登录路径上的 D1 rows read / rows written 噪声。

### 20. CSRF 拒绝审计日志短时间去重

管理员写接口缺少或携带无效 CSRF token 时，系统仍会立即返回 403。旧逻辑每次拒绝都会写一条 `csrf_rejected` 审计日志；如果浏览器插件、旧页面、脚本或攻击流量反复提交同一个管理写接口，会把 `audit_logs` 写入放大。

现在增加 60 秒 per-isolate 去重：

- 同用户名 + 同 IP + 同路径的 CSRF 拒绝，60 秒内只写 1 条审计日志。
- 不同路径仍独立记录。
- 60 秒后再次出现仍会重新记录。
- 403 拒绝行为不变，CSRF 校验不放松，只合并重复审计写入。
- throttle Map 上限 512 项，避免异常流量撑大内存。
- smoke 使用 fake D1 覆盖：重复同路径只写一次，不同路径和过期后会继续写。

这不影响监控数据，也不降低后台安全防护；只减少重复失败请求造成的 D1 rows written 噪声。

### 21. 后台容量估算页增加 30 秒完整估算缓存

后台容量页用于估算 D1 写入和保留行数，不参与 agent 上报或历史持久化。旧逻辑虽然已经把真实行数 `COUNT(*)` 缓存 60 秒，但每次打开容量页仍会读取：

- `clients` 全量列表，用于节点数和 Ping all_clients 估算。
- `settings` 全量设置，用于保留时间、历史写入间隔、活跃/空闲间隔。
- `ping_tasks` 全量任务，用于 Ping 写入估算。
- 在行数缓存过期或强制刷新时，再读 records / gpu_records / ping_records / audit_logs 的 COUNT。

这意味着用户反复刷新后台容量页时，即使行数 COUNT 命中缓存，仍会重复消耗 `clients`、`settings`、`ping_tasks` 的 rows read。

现在容量页增加 30 秒完整估算缓存：

- `/api/admin/capacity` 第一次计算返回 `capacity_estimate_cache: "miss"`。
- 30 秒内重复打开返回 `capacity_estimate_cache: "hit"`，不重复读取 `clients`、`settings`、`ping_tasks`。
- `/api/admin/capacity?refresh_counts=true` 返回 `capacity_estimate_cache: "refresh"`，绕过完整估算缓存并强制刷新真实行数。
- 节点新增/编辑/删除/排序/批量隐藏/批量删除、Ping 任务新增/编辑/删除/排序、系统设置保存、历史清理、维护清理、备份恢复都会清空容量估算缓存。

效果：

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| 30 秒内重复打开容量页 | 每次读 clients/settings/ping_tasks | 第一次读 D1，后续命中估算缓存 |
| 修改节点或 Ping 任务后打开容量页 | 重新读取 | 仍重新读取，缓存已失效 |
| 手动刷新真实行数 | 读 COUNT | 仍读 COUNT，显式强制刷新 |

这不会降低监控密度，也不会改变历史保留；只减少后台估算页反复查看产生的 D1 rows read。

### 22. 后台客户端 ID 校验增加短缓存

后台新增/编辑 Ping 任务、离线通知、到期通知、负载通知时，需要校验配置里引用的客户端 UUID 是否存在。旧逻辑每次都调用 `listClients()`，也就是读取完整 `clients` 行；连续保存多条规则或节点较多时，会造成不必要的完整客户端表读取。

现在改为：

- 校验只读取 `SELECT uuid FROM clients`，不再读取 token、备注、系统信息等完整列。
- Worker isolate 内缓存允许引用的客户端 UUID 集合 30 秒。
- Ping 任务选择“全部节点”时不读取客户端 UUID；负载通知 `clients=[]` 表示全节点，也不读取客户端 UUID。
- 新增客户端、删除单个客户端、批量删除客户端、恢复备份后立即清理该缓存。
- 返回给校验逻辑的是 `Set` 的防御性拷贝，调用方修改不会污染缓存。
- smoke 使用 fake D1 覆盖：全节点配置完全不读 `clients`，连续定向校验只读取一次 `clients.uuid`，显式失效后才重新读。

这不会改变 Ping 执行间隔、历史持久化间隔或告警规则语义，只减少后台配置保存时的 D1 rows read 和结果序列化体积。隐藏、编辑名称、排序、轮换 token 不会改变 UUID 是否存在，因此不需要失效；删除和恢复备份会立即失效，避免继续接受已删除节点。

### 23. Durable Object 内缓存 Ping 任务表

HTTP agent 路由已经有 30 秒 `ping_tasks` 缓存，但默认推荐的 WebSocket agent 模式里，Ping 结果会直接进入 `LiveDataDO`，旧逻辑在 DO 内再次读取 `ping_tasks` 来校验任务归属和间隔。多节点同一轮 60 秒 Ping 上报时，这会变成：

```text
节点数 * Ping 上报轮次 * ping_tasks 表读取
```

现在 `LiveDataDO` 内也增加 30 秒 Ping 任务缓存：

- WebSocket Ping 结果持久化复用 DO 实例内的任务表。
- HTTP fallback 进入 DO 的 `/ping-result` 也复用同一缓存。
- 后台新增、编辑、排序、删除 Ping 任务会调用 DO `/ping-tasks-refresh` 清理缓存。
- 删除节点、批量删除节点、备份恢复会因为可能裁剪 Ping 任务引用，也同步清理 DO 缓存。
- smoke 直接实例化 DO，用 fake D1 覆盖：两个不同节点连续 Ping 上报只读一次 `ping_tasks`；调用刷新端点后下一次重新读取。

这不改变 agent 执行 Ping 的间隔，也不改变 `ping_records` 的保存密度；只减少 WebSocket 模式下同一 DO 实例内重复读取任务配置的 rows read。跨 DO 实例/跨 isolate 仍各自缓存，这是 Cloudflare Durable Object 实例边界内的保守优化。

### 24. 负载告警按规则批量聚合节点窗口

负载告警 cron 不参与实时采样，也不决定历史入库密度。旧逻辑已经避免把窗口内完整历史行拉回 Worker，但仍然是：

```text
每条负载规则 * 每个目标节点 -> 1 次 SELECT COUNT/SUM/AVG
```

例如 3 条规则、50 个节点时，一轮 cron 会执行最多 150 次窗口聚合查询。现在改为同一规则一次批量聚合：

```sql
SELECT client, COUNT(*), SUM(...), AVG(...)
FROM records
WHERE client IN (...) AND time >= ? AND time <= ?
GROUP BY client
```

效果：

- 同一负载规则的多个节点共用一次 D1 查询，超过 100 个节点时按 chunk 分批。
- 仍然按 `(client, time)` 索引和同一个时间窗口统计，不改变阈值、超标比例、冷却时间或通知语义。
- 节点没有样本时不返回统计，行为等价于旧逻辑的 `samples < 2` 跳过。
- smoke 使用 fake D1 覆盖：3 个目标节点同一规则只执行 1 次 grouped stats 查询。

这主要减少查询次数、D1 round trip 和 Worker 调度压力；rows read 仍取决于窗口内被扫描的历史样本数，但不再为每个节点单独发起一条 SQL。

### 25. 公开节点接口收窄 clients 读取列

公开接口 `/api/clients`、`/api/nodes`、`/api/task/ping` 以及历史接口的可见性检查只需要公开展示字段和 `hidden` 状态。旧逻辑复用后台的 `listClients()` / `getClient()`，会读取完整 `clients` 行，包括 agent token、后台备注、系统元数据等公开接口不需要的列。

现在拆成两个窄查询：

- 公开节点快照使用 `listPublicClientRows()`，只读取公开页面需要的字段、排序字段、`ipv4/ipv6` 是否存在标记所需字段，不再读取 token 和后台私有备注。
- 单节点历史可见性检查使用 `getClientVisibility()`，只读取 `uuid, hidden`，不再 `SELECT *`。
- 现有 30 秒公开元数据缓存和单节点可见性缓存继续保留；后台节点变更仍会清理这些缓存。
- smoke 覆盖：公开节点 helper 不能 `SELECT *`，不能读取 `token` / 私有 `remark`；可见性 helper 必须只执行 `SELECT uuid, hidden FROM clients WHERE uuid = ?`。

这不会改变实时监控、历史写入、Ping 执行间隔或公开字段语义。收益主要体现在公开首页、节点页和历史图表入口反复访问时，减少 D1 需要读取和序列化的列，也避免把不需要的敏感字段带进公开路由处理链路。

### 26. 定时通知按需读取节点子集

定时任务每 10 分钟运行一次，包含清理、负载告警、离线告警、到期提醒。旧 `ScheduledRunContext.getClients()` 复用后台 `listClients()`，一旦任意通知步骤需要节点信息，就读取完整 `clients` 表的完整行。

但通知逻辑实际只需要少量字段：

- 离线告警：`uuid`、`name`、`created_at`。
- 到期提醒：`uuid`、`name`、`expired_at`。
- 负载告警：`uuid`、`name`。

现在改为 scheduled 专用窄查询：

- `listScheduledClientRows()` 只读 `uuid, name, created_at, expired_at`。
- `getScheduledClientRowsByIds()` 支持按通知涉及的 UUID 子集读取，不再总是扫全量节点。
- 离线/到期通知只读取启用通知的节点集合。
- 负载通知只有存在“全节点规则”时才读取全量节点；如果所有规则都指定了节点，只读取这些规则引用的节点并复用同一份缓存。
- 同一 scheduled run 内，相同 UUID 子集按排序后的 cache key 复用 Promise；如果已经读取过全量节点，后续子集直接从全量结果中过滤。
- smoke 覆盖：scheduled context 不允许 `SELECT *`，不读取 token；相同 UUID 子集重复调用只触发 1 次 D1 读取。

这不改变 cron 频率、告警判断窗口、通知语义或监控采样密度。收益在“节点很多，但只给少数节点开离线/到期/负载规则”的场景最明显：rows read 从“全部节点”降为“规则涉及节点数”。如果负载规则设置为全节点，仍会按原语义读取全量节点。

### 27. 容量估算页只读取节点容量计数

后台容量估算页需要节点数来计算：

- 资源历史预计写入量：`clientCount * active/idle seconds / persist interval`。
- 全节点 Ping 任务预计写入量：`clientCount * 86400 / interval`。
- GPU 快照预计写入量：`gpuClientCount * active/idle seconds / persist interval`。

旧逻辑为此调用 `listClients()`，读取完整 `clients` 行后只使用 `clients.length`。这会把 token、系统信息、备注、价格、流量等与容量估算无关的列都拉进 Worker。

现在改为：

- `countClientCapacityTargets()` 执行一次聚合查询，返回 `clients` 和 `gpu_clients`。
- 容量估算页并行读取 `clientCapacityCounts`、`settings`、`ping_tasks`。
- 全节点 Ping 任务使用 `clientCount`，定向 Ping 任务仍按任务里的 `clients` 数组长度估算。
- GPU 快照估算使用 `gpuClientCount`，避免多卡快照落地后低估每日写入和 72 小时保留行数。
- 30 秒完整容量估算缓存继续保留；节点/Ping/设置变化仍会失效缓存。
- smoke 覆盖：`buildCapacityEstimate()` 不允许 `SELECT * FROM clients`，并断言全节点 Ping 估算使用 `clients`，GPU 快照估算使用 `gpu_clients`。

这不改变历史写入或 Ping 执行密度。收益是后台容量页首次打开或强制刷新时不再读取完整节点表；节点越多，减少的数据搬运和敏感字段暴露越明显。容量估算公式现在同时覆盖 `records`、`gpu_snapshots`、`ping_snapshots` 三类默认热历史表。

### 28. 后台节点存在性校验使用 SELECT 1

后台新增节点和 Token 轮换有几类只需要“是否存在”的判断：

- 新增节点前检查 UUID 是否已存在。
- 新增节点前检查 token 是否已存在。
- Token 轮换生成随机 token 后检查是否碰撞。

旧逻辑复用 `getClient()` / `getClientByToken()`，会读取完整 `clients` 行。现在改为：

- `clientExists()` 执行 `SELECT 1 AS found FROM clients WHERE uuid = ? LIMIT 1`。
- `clientTokenExists()` 执行 `SELECT 1 AS found FROM clients WHERE token = ? LIMIT 1`。
- 新增节点冲突检查通过 `getClientCreateConflict()` 复用这两个窄查询。
- Token 轮换通过 `generateUniqueClientToken()` 使用窄 token 存在性查询重试。
- smoke 覆盖：后台新增/轮换的存在性检查不允许 `SELECT *`，只能使用 `SELECT 1` 查询。

这不影响节点创建、token 唯一性、token 轮换、agent 认证缓存失效或审计日志语义。收益是后台管理路径减少读取整行 client 的次数，尤其避免把 token 之外的系统元数据、备注、价格、流量等无关字段带入“存在性判断”。

### 29. 后台 Token 查看/轮换只读取 token 元数据

后台查看节点 token 和轮换 token 前需要确认节点存在。轮换时还需要旧 token 用于清理 agent 认证缓存，以及节点名用于审计日志。旧逻辑直接 `getClient()`，读取完整 `clients` 行。

现在新增 `getClientTokenMeta()`：

```sql
SELECT uuid, token, name FROM clients WHERE uuid = ?
```

并用于：

- `GET /api/admin/clients/:uuid/token`
- `POST /api/admin/clients/:uuid/token/rotate`

这保留了全部原有语义：

- 不存在的节点仍返回 404。
- 查看 token 仍返回当前 token。
- 轮换 token 后仍清理旧 token 和新 token 的 agent 认证缓存。
- 审计日志仍使用节点名。

smoke 覆盖：`getClientTokenMeta()` 必须只执行 `SELECT uuid, token, name FROM clients WHERE uuid = ?`，不允许 `SELECT *`。

这不会影响 agent 认证或采样密度，只减少管理员打开 token 弹窗、轮换 token 时的无用列读取。

### 30. 合并写入/合并读取是否值得做

用户提出的新方向是：既然 D1 读取次数有限，能不能把多节点、多指标合并写入和合并读取，例如 5 个节点写到一个地方，或者 1 个节点一次写入所有 CPU、RAM、磁盘等数据。

结论要分层看：

| 合并方式 | 当前项目状态 | 是否降低 D1 rows written | 是否降低 D1 rows read | 判断 |
| --- | --- | ---: | ---: | --- |
| 单节点多指标合并成一行 | 已经实现。`records` 一行包含 CPU/GPU 汇总/RAM/Swap/Load/温度/磁盘/网络/连接数/uptime | 已经省了 | 已经省了 | 正确，保持现状 |
| 单节点多 GPU 明细合并成快照行 | 已实现为 `gpu_snapshots`。新写入一节点一时间点一行 JSON，旧 `gpu_records` 兼容读取 | 多 GPU 节点会减少写入行数 | GPU 曲线查询保持旧返回结构 | 已落地，旧历史自然过期 |
| 5 个节点同一分钟合并成一个 JSON bucket | 未实现 | 会明显降低主表业务行，理论上约按 bucket 大小下降 | 查全局概览可能下降；查单节点历史未必下降 | 不建议做热数据主表默认方案 |
| `db.batch()` 一次执行多条 INSERT | 部分地方已用，例如 GPU 批量写 | 不改变最终行数，主要省 round trip | 不改变扫描行数 | 适合性能，不是配额主方案 |
| 后台/前端把多个接口合并成一次读取 | 部分已通过缓存和窄查询优化 | 不直接影响写 | 能减少重复读取和请求数 | 值得继续做 |
| 保留热表，超过 72 小时后归档到 JSON/R2 | 当前保留 72 小时后清理 | 不影响默认 72 小时；若延长历史可省 D1 | 冷数据查询读 D1 少 | 适合作为未来增强 |

官方计费规则里最关键的一点是：D1 统计的是行扫描/行写入，不是“字段数量”。一行 1 KB 和一行 100 KB 都按一行计，但读/写多大的 JSON 会增加 Worker CPU、响应序列化、内存和传输成本。也就是说，把 CPU/RAM/磁盘等字段放在同一行是正确方向；但把多个节点塞到同一行，只是把 D1 行数问题转移成 JSON 解包、局部更新和索引丢失问题。

#### 当前已经是“单节点指标合并写”

`records` 主历史表已经是一行一个节点一次历史采样，包含：

- `cpu`、`gpu`
- `ram`、`ram_total`
- `swap`、`swap_total`
- `load`、`temp`
- `disk`、`disk_total`
- `net_in`、`net_out`、`net_total_up`、`net_total_down`
- `process_count`、`connections`、`connections_udp`
- `uptime`

所以“1 个节点 1 次合并写入所有 CPU/RAM/磁盘等数据”已经做到了。继续把这些字段合并成 JSON 不会让 D1 从多行变一行，只会让 SQL 查询、排序、告警聚合和前端字段兼容变差。

#### 最有讨论价值的是 GPU 明细

GPU 明细已经从“每张 GPU 一行”演进为“每个节点每个时间点一行快照”。一次历史采样如果有 2 张 GPU，旧模型额外写 2 行；如果有 8 张 GPU，旧模型额外写 8 行。新模型统一写 1 行 `gpu_snapshots`：

```text
新模型：
records       1 行：节点总览
gpu_snapshots 1 行：同一时间点所有 GPU 明细 JSON
```

这样对 GPU 节点的写入收益比较直接。以 1 个节点、60 秒历史、2 张 GPU估算：

| 模型 | GPU 业务行/天 | 主要索引写放大 | 粗略 rows written/天 |
| --- | ---: | ---: | ---: |
| 旧 `gpu_records` | 2880 | 表 1 + 索引 2 | 8640 |
| 新 `gpu_snapshots` | 1440 | 表 1 + 索引 2 | 4320 |

以 1 个节点、60 秒历史、8 张 GPU估算：

| 模型 | GPU 业务行/天 | 粗略 rows written/天 |
| --- | ---: | ---: |
| 旧 `gpu_records` | 11520 | 34560 |
| 新 `gpu_snapshots` | 1440 | 4320 |

这次没有把 GPU JSON 塞进 `records`，而是单独建 `gpu_snapshots`，原因是：

- 普通 CPU/RAM/磁盘历史仍保持轻量列式 `records`，不被 GPU 大 JSON 拖累。
- GPU 图表接口仍返回旧结构 `{ client, time, device_index, device_name, mem_total, mem_used, utilization, temperature }`。
- 读取时合并 `gpu_snapshots` 与旧 `gpu_records`，按 `client/time/device_index` 去重。
- 删除节点、批量删除、孤儿数据清理、定时历史清理、容量行数统计都同时覆盖 `gpu_records` 和 `gpu_snapshots`。
- 备份仍只导出配置，不导出历史；`gpu_snapshots` 加入历史排除列表。

注意：GPU 快照只对 GPU 节点有收益。无 GPU 节点不会写 GPU 明细；单 GPU 节点写入行数与旧模型基本相同；多 GPU 节点不再按 GPU 数量线性放大写入行数。

#### 5 个节点写到一个地方：能省，但不是热数据好方案

如果把 5 个节点同一分钟写成一个 bucket 行，写入行数确实会下降。例如 50 个节点、60 秒历史：

| 模型 | `records` 业务行/天 | 带 2 个索引粗略 rows written/天 |
| --- | ---: | ---: |
| 当前一节点一行 | 50 * 1440 = 72000 | 216000 |
| 5 节点一 bucket | 10 * 1440 = 14400 | 43200 |

看起来很香，但热数据功能会被连环影响：

- 单节点历史：当前 `WHERE client=? AND time BETWEEN ? AND ?` 可走 `(client, time)`；bucket 后只能按时间读 bucket，再在 Worker 里过滤 JSON。
- 最新状态：当前可以按节点取最新行；bucket 后需要额外维护 `latest_records` 或从 bucket 解析。
- 删除节点：当前删除一个节点是 `DELETE FROM records WHERE client=?`；bucket 后要重写 72 小时内每个 bucket，把 JSON 里的该节点删掉，反而制造大量 UPDATE。
- 隐藏节点、公开查询、导出备份、清理孤儿数据都会更复杂。
- 负载告警现在能用 SQL 聚合 `COUNT/SUM/AVG`；bucket 后要么把窗口样本拉回 Worker 算，要么额外维护列式索引表，抵消省下来的写入。

所以跨节点 bucket 只适合两个场景：

1. 只看总览、不怎么查单节点历史的大规模实例。
2. 冷数据归档，例如 72 小时之外压缩进 R2 或 D1 JSON 归档表。

它不适合当前“一键部署、小白可用、单节点详情/图表/告警都要准”的默认模型。

#### 合并读取最值得继续做的方向

合并读取不是把所有数据塞一行，而是让同一类页面/任务少做重复查询：

- 同一页面需要多个节点元数据时，优先一次读取需要的窄字段，不用 `SELECT *`。
- 同一轮 cron 对多个节点做告警时，用 `WHERE client IN (...) GROUP BY client`，不要每节点一条 SQL。
- Ping 任务、公开节点列表、容量估算这类短时间不变的数据继续用 per-isolate 缓存和明确失效。
- 历史图表保持按节点和时间索引查询，再配合 10 秒公共缓存，避免用户刷新页面重复打 D1。

这类优化不会破坏数据模型，而且更贴近 D1 的 rows read 规则：减少扫描行、减少重复扫描、保留索引命中。

最终建议：

1. 热数据继续坚持“一个节点一个时间点一行”的主表模型。
2. 不要默认做“5 个节点一行”的跨节点 JSON bucket。
3. 可以把“GPU 明细嵌入主记录”列为后续可选优化，尤其面向多 GPU 节点。
4. 若以后要保留超过 72 小时，优先做 R2/JSON 冷归档，而不是改热表。
5. 继续优先做窄查询、缓存、索引、no-op 写入消除、cron 批量聚合，这些是低风险、省配额且不降低监控密度的路线。

### 31. Agent 低频设置读取改为按 key 窄查询

继续审查 agent 路由后发现两个路径仍复用完整 settings 表读取：

- IP 变更通知只需要 `enable_ip_change_notification`、`telegram_bot_token`、`telegram_chat_id`。
- `/api/clients/policy` 在 DO 失败时的兜底 policy 只需要 `live_poll_active_interval_sec`、`live_poll_idle_interval_sec`、`live_poll_active_max_duration_sec`。

旧逻辑每次执行这些路径都会 `SELECT key, value FROM settings`，读取整张 settings 表。虽然这两个路径不是 3 秒常规热路径，但在以下场景仍可能造成不必要的 rows read：

- 动态 IP 节点重连或 HTTP report 中 IP 变化较频繁。
- Durable Object 短暂异常时，多 agent 同时请求 policy 兜底。
- settings 表后续继续增加配置项，全表读取成本随配置项数量增长。

现在新增 `getSettingsByKeys()`：

```sql
SELECT key, value FROM settings WHERE key IN (?, ?, ...)
```

并替换上述两个 agent 路径。这样保持行为不变：

- IP 变更通知开关、Telegram token、chat id 仍按后台设置生效。
- DO policy 正常路径仍由 DO 返回；只有兜底路径改成读取 3 个必要 key。
- 不改变 3 秒实时上报、60 秒历史持久化、60 秒 Ping 或 600 秒 idle 策略。

收益：

- rows read 从“settings 全表行数”降为“实际需要的 3 行以内”。
- 不引入缓存一致性问题，因为每次仍读 D1 的当前 key。
- 后续新增 settings key 时不会放大 agent 兜底/通知读取。

smoke 覆盖：`getSettingsByKeys()` 必须执行 `SELECT key, value FROM settings WHERE key IN (...)`，空 key 列表不读 D1，重复 key 会去重。

### 32. 公开设置和 viewer token TTL 避免 settings 全表读取

继续检查前端公开入口后，发现两个页面访问路径仍会读取完整 settings：

- `/api/public` 只需要公开设置，例如站点标题、语言、实时策略、主题背景，却读取了全部 settings。
- `/api/ws/live-token` 只需要 `live_poll_active_max_duration_sec` 来计算 viewer token 有效期，却通过公开设置构建间接读取全部 settings。

这两个路径不属于 agent 3 秒上报热路径，但它们会在真实访问中比较频繁：

- 首页、节点页加载时会请求公开设置。
- 每个浏览器前台观看实时数据前会请求 live-token。
- 多个访客或反复刷新会让这些公开读取成为 rows read 噪声。

现在改为：

- `PUBLIC_SETTING_KEYS` 由 settings schema 自动导出，只包含 `public: true` 的 key。
- `/api/public` 使用 `getSettingsByKeys(DB, PUBLIC_SETTING_KEYS)`，不再读取 Telegram、记录保留、容量水位、通知等私有配置。
- `/api/ws/live-token` 使用 `getSetting(DB, 'live_poll_active_max_duration_sec')`，只读单个 TTL key。

行为保持不变：

- 公开设置仍通过 `buildPublicSettings()` 补默认值并输出相同结构。
- 后台保存公开设置时仍会清理公开元数据缓存。
- viewer token 有效期仍跟随 `live_poll_active_max_duration_sec`，30 秒 per-isolate TTL 缓存仍保留。
- 不改变 3 秒实时、不改变 60 秒历史、不改变 60 秒 Ping、不改变 600 秒 idle。

收益：

- `/api/public` 的 D1 rows read 从“settings 全表行数”降为“公开设置 key 数量”。
- `/api/ws/live-token` 的 D1 rows read 从“settings 全表行数”降为 1 行，且 30 秒缓存命中时不读 D1。
- 后续新增私有 settings key 不再增加公开路径读取成本。

smoke 覆盖：

- `PUBLIC_SETTING_KEYS` 必须只包含 schema 中 `public: true` 的 key。
- public 路由必须使用 `getSettingsByKeys(database, PUBLIC_SETTING_KEYS)`。
- viewer token TTL 必须使用单 key `getSetting()`，不允许退回 `buildPublicSettings(await getAllSettings())`。

### 33. Durable Object policy / history settings 改为窄读取

Durable Object 是实时上报、viewer policy 和历史持久化的核心位置。上一轮已经把“未到 60 秒历史入库间隔时不读 D1 设置”做掉，但真正需要读取设置时，旧逻辑仍会读取完整 settings 表：

- `getAgentPolicySettings()` 只需要实时策略 3 个 key：
  - `live_poll_active_interval_sec`
  - `live_poll_idle_interval_sec`
  - `live_poll_active_max_duration_sec`
- `isRecordPersistenceEnabled()` 只需要历史持久化 3 个 key：
  - `record_enabled`
  - `record_persist_interval_sec`
  - `record_high_watermark_rows`

现在这两处都改为 `getSettingsByKeys()`，然后继续交给 `buildAdminSettings()` 做默认值补齐和范围归一化。

行为保持不变：

- 后台保存实时策略后仍通过 `/policy-refresh` 让 DO 立即刷新 policy。
- 后台保存历史持久化策略后仍通过 `/record-settings-refresh` 让 DO 立即刷新。
- 未配置或非法值仍回退到 schema 默认值。
- 不改变 3 秒实时、不改变 60 秒历史、不改变 60 秒 Ping、不改变 600 秒 idle。

收益：

- policy 刷新从读取整张 settings 表降为最多 3 行。
- 历史持久化设置刷新从读取整张 settings 表降为最多 3 行。
- settings 表未来继续增加站点、主题、通知等配置时，不会放大 DO 核心路径的 rows read。

smoke 覆盖：DO 源码必须通过 `getSettingsByKeys(this.env.DB, AGENT_POLICY_SETTING_KEYS)` 和 `getSettingsByKeys(this.env.DB, RECORD_PERSISTENCE_SETTING_KEYS)` 读取设置，不允许退回 `getAllSettings(this.env.DB)`。

### 34. Cron 和后台容量/维护清理改为按 key 读取 settings

继续审查定时任务和后台低频管理路径后，发现还有几个“只需要少量设置却读取完整 settings 表”的场景：

- `createScheduledRunContext().getSettings()`：cron 一轮内会用于 Telegram、记录清理、离线提醒。
- `buildCapacityEstimate()`：容量估算页只需要记录保留、采样/持久化间隔、水位、观看分钟等估算字段。
- `runMaintenanceCleanup()`：手动维护清理只需要记录、Ping、审计日志保留时间。

现在这些路径都改为 `getSettingsByKeys()`：

- cron 读取：
  - `notification_method`
  - `telegram_bot_token`
  - `telegram_chat_id`
  - `record_preserve_time`
  - `ping_record_preserve_time`
  - `audit_log_preserve_time`
  - `offline_notify_never_reported`
- 容量估算读取：
  - `record_enabled`
  - `record_preserve_time`
  - `ping_record_preserve_time`
  - `live_poll_active_interval_sec`
  - `live_poll_idle_interval_sec`
  - `record_persist_interval_sec`
  - `record_high_watermark_rows`
  - `audit_log_preserve_time`
  - `capacity_daily_view_minutes`
- 手动维护清理读取：
  - `record_preserve_time`
  - `ping_record_preserve_time`
  - `audit_log_preserve_time`

行为保持不变：

- cron 仍每 10 分钟执行。
- 清理仍按后台保留时间删除过期 `records`、`gpu_records`、`ping_records`、`audit_logs`。
- Telegram 通知仍读取当前通知方式和凭据。
- 容量估算仍补默认值、保留 30 秒完整估算缓存和 60 秒真实行数缓存。
- 备份下载仍读取完整 settings，因为备份确实要包含完整配置。

收益：

- cron 每轮 settings rows read 从“整张 settings 表”降为最多 7 行。
- 容量估算页 settings rows read 从“整张 settings 表”降为最多 9 行，且 30 秒完整估算缓存命中时不读。
- 手动维护清理 settings rows read 从“整张 settings 表”降为最多 3 行。
- 后续新增公开主题、站点、通知等设置时，不再增加这些 quota 管理路径的读取成本。

smoke 覆盖：

- scheduled context 必须使用 `SELECT key, value FROM settings WHERE key IN (...)`，且同一 cron 运行上下文内仍只读一次 settings。
- 容量估算 fake D1 断言只绑定容量估算需要的 key。
- admin 源码断言容量估算和手动维护清理不得退回 `getAllSettings(database)`；备份路径不受此限制。

### 35. 后台设置保存和 Telegram 测试避免 settings 全表读取

后台还有两个容易被重复操作的 settings 读取路径：

- 保存系统设置时，旧逻辑读取完整 settings 后再比较本次提交的值是否变化。
- Telegram 测试发送只需要 `telegram_bot_token` 和 `telegram_chat_id`，旧逻辑也读取完整 settings。

现在改为：

- 设置保存只按 `Object.keys(normalized.settings)` 读取当前值，再比较变化。
- Telegram 测试只读取 `telegram_bot_token`、`telegram_chat_id`。

行为保持不变：

- `/api/admin/settings` GET 仍返回完整后台设置。
- 备份下载仍导出完整 settings。
- 设置保存仍会识别 no-op，不写无变化的 settings，也不写无意义审计日志。
- Telegram 测试仍使用当前 token/chat id，错误和健康事件语义不变。

收益：

- 如果前端或脚本只提交 1-3 个设置，保存前读取从“整张 settings 表”降为提交 key 数量。
- Telegram 测试读取从“整张 settings 表”降为 2 行。
- 后续新增更多 settings key 时，不会增加这两个后台操作的读取成本。

smoke 覆盖：admin 源码断言设置保存必须使用 `getSettingsByKeys(c.env.DB, Object.keys(normalized.settings))`，Telegram 测试必须使用 `getSettingsByKeys(c.env.DB, TELEGRAM_CREDENTIAL_SETTING_KEYS)`，不允许退回相关全表读取写法。

### 36. 后台容量估算 Ping 任务改为窄字段读取

后台容量估算页只需要 Ping 任务的以下字段：

- `id`
- `name`
- `clients`
- `all_clients`
- `interval_sec`

旧逻辑复用 `listPingTasks()`，会读取 `type`、`target`、`sort_order` 等估算不需要的字段。D1 的 `rows_read` 主要按扫描行数计算，所以这个改动不应被误解为“按列数降低 rows_read”；它的价值在于：

- 降低 Worker 与 D1 之间的结果传输量和 JSON 解析量。
- 减少后台容量页暴露 Ping 目标地址的机会。
- 让容量估算路径和管理 Ping 任务路径解耦，后续 Ping 任务增加更多字段时，不会自动增加容量页读取负担。
- smoke 明确锁住容量估算不得退回 `SELECT * FROM ping_tasks`。

新增 helper：

- `listPingTaskEstimateRows()`
- SQL：`SELECT id, name, clients, all_clients, interval_sec FROM ping_tasks ORDER BY sort_order ASC, id ASC`

行为保持不变：

- `/api/admin/capacity` 的任务估算结果仍包含任务名、目标节点数、间隔、估算写入量。
- `/api/admin/ping`、公开 Ping 任务、agent Ping 任务仍使用完整 `listPingTasks()`，因为这些路径需要 `type` 和 `target`。

### 37. 不降低监控密度前提下的下一层结构性优化：Ping 快照表

当前最大写入来源仍然是 Ping 历史。默认 3 个 Ping 任务、60 秒一次、1 个节点时：

```text
ping_records 业务行/天 = 3 * 1440 = 4320
rows written 估算 = 4320 * (表 1 + 索引 2) = 12960
```

当节点数到 5 个时，仅 Ping 历史就约为：

```text
5 * 3 * 1440 * 3 = 64800 rows written / day
```

这已经接近 D1 Free 每天 100k rows written 的主要压力来源。继续靠 `batch()` 只能减少往返和队列压力，不能把 3 条 Ping 业务行变成 1 条；真正要省写入，必须减少最终落库行数。

推荐的结构性方案不是“5 个节点写到一个 JSON bucket”，而是“单节点同一时间点的多个 Ping 任务合并成一行快照”：

```sql
CREATE TABLE IF NOT EXISTS ping_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  time TEXT NOT NULL,
  values_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ping_snapshots_client_time ON ping_snapshots(client, time);
CREATE INDEX IF NOT EXISTS idx_ping_snapshots_time ON ping_snapshots(time);
```

写入示例：

```json
{
  "1": 38,
  "2": 44,
  "3": 47
}
```

收益估算：

| 场景 | 当前 `ping_records` rows written / day | `ping_snapshots` rows written / day | 下降幅度 |
| --- | ---: | ---: | ---: |
| 1 节点，3 个 60 秒任务 | 12960 | 4320 | 约 66.7% |
| 5 节点，3 个 60 秒任务 | 64800 | 21600 | 约 66.7% |
| 10 节点，3 个 60 秒任务 | 129600 | 43200 | 约 66.7% |

这个方案不降低监控密度：

- Ping 仍然每个任务按自己的 `interval_sec` 执行。
- 60 秒默认 Ping 历史仍然保留每分钟一个点。
- 只是把同一节点、同一时间点收到的多个任务结果写进同一行。

为什么它比跨节点 JSON bucket 更适合当前项目：

| 维度 | 跨节点 bucket | 单节点 Ping snapshot |
| --- | --- | --- |
| 单节点查询 | 需要从多节点 JSON 中筛节点，失去 `client` 精准索引 | 仍可用 `(client, time)` 查询 |
| 删除节点 | 要重写大量 JSON bucket | `DELETE WHERE client = ?` 仍然简单 |
| 隐藏节点 | 查询和过滤复杂 | 与当前模型基本一致 |
| Ping 多任务写入 | 能省，但模型侵入大 | 正好命中主要写入来源 |
| 告警/容量估算 | 需要重写大量逻辑 | 只影响 Ping 历史读取和写入 |

主要坑：

- 按单个 `task_id` 查询曲线时，不能再直接 `WHERE task_id = ?`，需要从 `values_json` 里取值。
- 如果不同 Ping 任务间隔不同，例如 60 秒和 600 秒混合，同一快照不一定包含所有任务。读取单任务曲线时需要过滤没有该任务值的快照。
- 如果依赖 SQLite JSON 函数，需要在 D1/Miniflare 两边验证 `json_extract(values_json, '$."1"')` 可用；若不用 JSON 函数，则需要 Worker 多读一小段快照后在 JS 里过滤。
- 删除 Ping 任务时，旧 `ping_records` 可以 `DELETE WHERE task_id=?`；快照表里可以选择不重写历史 JSON，只让 UI 不再查询已删除任务，历史自然随 72 小时清理过期。
- 备份/恢复、容量估算、清理、导出需要认识新表。

推荐分阶段上线：

1. 新增 `ping_snapshots` 表和索引，不立刻删除旧 `ping_records`。
2. 写入路径从 `accepted.map(INSERT ping_records)` 改成单条 `INSERT ping_snapshots`。
3. 读取路径优先读 `ping_snapshots`，旧数据兼容读 `ping_records`，必要时合并排序。
4. 容量估算同时展示 legacy `ping_records` 和 snapshot 模式的写入对比。
5. 观察真实 `rows_written` 下降后，再考虑是否保留旧表到自然过期。

这个方案是当前“默认不降低密度”的最大潜在收益点。它比调低 Ping 间隔、调低历史保留时间更符合项目目标；代价是需要一次有测试保护的数据模型演进。

### 38. Ping 快照表已落地：写入行数按任务重合度下降

已新增迁移：

- `worker/migrations/012_ping_snapshots.sql`

新表：

```sql
CREATE TABLE IF NOT EXISTS ping_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    values_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ping_snapshots_client_time ON ping_snapshots(client, time);
CREATE INDEX IF NOT EXISTS idx_ping_snapshots_time ON ping_snapshots(time);
```

运行时行为：

- WebSocket/DO Ping 结果写入从多条 `INSERT INTO ping_records` 改为单条 `INSERT INTO ping_snapshots`。
- `values_json` 使用 task id 作为 key，例如 `{"1":38,"2":44,"3":47}`。
- `/api/records/ping` 仍返回旧格式 `{ client, task_id, time, value }`，前端无需为了快照表改图表数据结构。
- 读取时优先读 `ping_snapshots`，同时兼容旧 `ping_records`。两边按 `client/task/time` 去重后排序分页。
- 删除节点、批量删除、孤儿数据清理、定时历史清理、容量行数统计都同时覆盖 `ping_records` 和 `ping_snapshots`。
- 备份仍只导出配置，不导出历史；`ping_snapshots` 加入历史排除列表。

容量估算同步更新：

- `ping_records_per_day` 现在表示快照模式下的 Ping 历史业务行数。
- `legacy_ping_records_per_day` 表示旧的按任务逐行写入业务行数。
- `ping_records_saved_per_day` 表示快照模式每天少写的业务行数。
- `ping_storage_mode` 固定为 `snapshots`，方便前端和后续排障识别当前模型。

默认估算变化：

| 场景 | 旧 `legacy_ping_records_per_day` | 新 `ping_records_per_day` | 每日少写业务行 |
| --- | ---: | ---: | ---: |
| 1 节点，3 个 60 秒任务 | 4320 | 1440 | 2880 |
| 5 节点，3 个 60 秒任务 | 21600 | 7200 | 14400 |
| 10 节点，3 个 60 秒任务 | 43200 | 14400 | 28800 |

如果按当前两索引模型估算 rows written，1 节点 3 任务的 Ping 历史从：

```text
旧：4320 业务行 * (表 1 + 索引 2) = 12960 rows written / day
新：1440 业务行 * (表 1 + 索引 2) = 4320 rows written / day
```

也就是 Ping 历史写入约下降 66.7%。这不降低 Ping 执行频率，也不降低 60 秒历史密度；只是同一节点同一轮上报内的多个任务结果合并为一行。

不同间隔任务的估算规则：

- 如果某节点有 60 秒和 600 秒两个任务，新模型按 60 秒快照频率估算，600 秒任务只在对应快照 JSON 中出现。
- 如果全节点任务是 120 秒，但某个定向节点还有 60 秒任务，则全体节点按 120 秒算，定向节点补足到 60 秒。
- 如果完全没有全节点任务，则按每个定向节点命中的最短 Ping 间隔估算。

仍需注意：

- 快照读取依赖 SQLite JSON 函数从 `values_json` 中取单个 task id。需要持续用 Miniflare/local smoke 覆盖，防止兼容性回退。
- 删除 Ping 任务时不重写旧快照 JSON；UI 不再查询已删除任务，历史会随 72 小时清理自然过期。这样避免“删除一个任务导致重写大量历史 JSON”的反向写放大。
- 旧 `ping_records` 不立刻迁移到 `ping_snapshots`。这避免一次性迁移消耗大量 D1 写入，也避免部署时长不可控。旧历史在保留期内兼容读取，过期后自然清理。
- 如果任务间隔非常不一致，按单任务读取时快照查询会过滤没有该任务值的行；已通过 `json_type(values_json, '$."taskId"') IS NOT NULL` 避免把空值返回给前端。

### 39. GPU 快照表已落地：多卡节点不再按卡数线性写入

已新增迁移：

- `worker/migrations/013_gpu_snapshots.sql`

新表：

```sql
CREATE TABLE IF NOT EXISTS gpu_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    time TEXT NOT NULL,
    devices_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_client_time ON gpu_snapshots(client, time);
CREATE INDEX IF NOT EXISTS idx_gpu_snapshots_time ON gpu_snapshots(time);
```

运行时行为：

- WebSocket/DO 历史入库时，GPU 明细从多条 `INSERT INTO gpu_records` 改为单条 `INSERT INTO gpu_snapshots`。
- `devices_json` 是同一节点同一时间点的 GPU 数组。
- `/api/records/gpu` 返回结构保持不变，前端无需知道数据来自 `gpu_records` 还是 `gpu_snapshots`。
- 读取时合并新旧表，快照优先，旧表补齐，按 `client/time/device_index` 去重。
- 旧 `gpu_records` 不迁移，避免一次性写入成本；旧历史在保留期内兼容读取并自然过期。

收益估算：

| 场景 | 旧 `gpu_records` 业务行/天 | 新 `gpu_snapshots` 业务行/天 | GPU 历史写入下降 |
| --- | ---: | ---: | ---: |
| 1 节点，1 GPU，60 秒历史 | 1440 | 1440 | 0% |
| 1 节点，2 GPU，60 秒历史 | 2880 | 1440 | 50% |
| 1 节点，8 GPU，60 秒历史 | 11520 | 1440 | 87.5% |

它不降低监控密度：

- GPU 仍随 60 秒历史持久化节奏保存。
- 每张 GPU 的 `device_index`、`device_name`、显存、利用率、温度仍保留。
- 只是同一时间点的多张 GPU 明细放进同一行。

主要坑与处理：

- 新旧表兼容读取短期会让 GPU 历史接口同时查两张表；旧 `gpu_records` 过期后成本自然下降。
- 分页是按返回的 GPU 明细行兼容旧接口，不是按快照行分页。多 GPU 节点可能一次读取较少快照却展开出多条明细，这是预期行为。
- 如果未来要按 GPU 型号/温度做后台 SQL 过滤，JSON 不如列式表直接；当前项目主要是按节点/时间画图，快照模型更适合配额优先目标。

容量估算同步更新：

- `gpu_clients` 表示带 `gpu_name` 的节点数，作为 GPU 快照写入估算目标数。
- `gpu_snapshots_per_day` 表示新快照模型下的 GPU 历史业务行数。
- `estimated_gpu_snapshots_retained` 会进入 `estimated_rows_retained` 和 `estimated_storage_bytes`。
- `total_estimated_writes_per_day` 现在包含 `monitor_records_per_day + gpu_snapshots_per_day + ping_records_per_day`。
- 默认无 GPU 节点场景数值不变；一旦节点有 GPU 元数据，后台容量页会把 GPU 快照行单独列入预算。

### 40. 合并读写的最终取舍

针对“5 个节点写到一个地方”或“全部指标合并写”的想法，当前项目的推荐边界是：

| 优化动作 | 是否推荐 | 原因 |
| --- | --- | --- |
| CPU/RAM/磁盘/网络等同一节点同一时间点写成一行 `records` | 推荐，已实现 | 直接减少业务行，仍保留可索引列 |
| 同一节点同一时间点的多 GPU 写成一行 `gpu_snapshots` | 推荐，已实现 | 多卡节点从按卡数写入变成按节点写入 |
| 同一节点同一轮的多个 Ping 任务写成一行 `ping_snapshots` | 推荐，已实现 | 多任务 Ping 从按任务写入变成按节点/轮次写入 |
| 用 `db.batch()` 提交多条 SQL | 推荐作为性能优化 | 降低 round trip 和排队风险，但 rows written 不会因为 batch 自动减少 |
| 把 5 个节点的热历史塞进一个 JSON bucket | 暂不推荐做默认热表 | 写入行数下降，但单节点查询、删除节点、隐藏节点、清理孤儿、告警聚合都会丢失索引并产生复杂 UPDATE |
| 72 小时外的冷历史按天/小时归档到 R2/JSON | 适合作为未来增强 | 冷数据少查、少改，适合牺牲 SQL 灵活性换取 D1 配额 |

因此，真正节约 D1 配额的顺序应该是：

1. 先把“天然属于同一节点同一时间点”的多行改成快照行。
2. 再把读路径改成窄列、索引友好、`limit + 1` 探测、短 TTL 缓存。
3. 对仍然需要多条 SQL 的地方使用 `db.batch()` 降低延迟和排队，不把它误认为 rows 配额优化。
4. 只有当历史保留从 72 小时扩展到更长周期时，再考虑 R2/JSON 冷归档。

### 41. Ping 历史批量读取：避免同一快照被多任务重复扫描

Ping 写入已经合并为 `ping_snapshots`，但详情页的旧读取方式仍是：

```text
GET /api/task/ping
GET /api/records/ping?task_id=1
GET /api/records/ping?task_id=2
...
GET /api/records/ping?task_id=8
```

在快照模型下，这会让同一节点同一小时的 `ping_snapshots` 被按任务重复读取。比如详情页展示 8 条 Ping 曲线、每条取最近 1 小时，旧方式最多会对同一批快照做 8 次查询。

已新增批量接口：

```text
GET /api/records/ping/batch?uuid=<node>&task_ids=1,2,3&limit=360
```

行为：

- 新接口一次读取最近一批 `ping_snapshots`，在 Worker 内按 `task_id` 展开 `values_json`。
- 旧 `ping_records` 仍用一个 `task_id IN (...)` 查询补齐，兼容 72 小时内未过期的旧历史。
- 返回结构是 `{ "1": [...], "2": [...] }`，前端直接映射到原来的多条曲线。
- 前端优先调用批量接口；如果失败，自动回退旧的逐任务接口，避免部署过程中新旧版本交错导致页面空白。
- 公开历史 10 秒缓存仍生效，重复打开同一节点同一范围时返回 `X-CF-Monitor-History-Cache: hit`。

收益估算：

| 场景 | 旧读取 | 新读取 | D1 rows read 变化 |
| --- | --- | --- | --- |
| 1 节点，3 个 Ping 任务，详情页 1 小时 | 3 次快照查询 | 1 次快照查询 + 1 次 legacy 补齐查询 | 快照扫描约降到 1/3 |
| 1 节点，8 个 Ping 任务，详情页 1 小时 | 8 次快照查询 | 1 次快照查询 + 1 次 legacy 补齐查询 | 快照扫描约降到 1/8 |

这不改变 Ping 执行频率，不改变 60 秒历史密度，也不改变公开图表显示的数据点；只减少同一页面为了多条曲线重复扫描同一批快照行。

### 42. 删除 clients 冗余索引：减少节点表写入放大

官方 D1 计费会把索引维护计入写入。`clients.token` 字段本身已经定义为 `UNIQUE`：

```sql
token TEXT NOT NULL UNIQUE
```

SQLite/D1 会为 `UNIQUE` 约束维护自动索引，因此额外的：

```sql
CREATE INDEX idx_clients_token ON clients(token);
```

是重复索引。`getClientByToken()`、`clientTokenExists()` 仍能使用唯一约束的自动索引完成 token 查询，不需要再维护第二棵普通索引。

同时，`idx_clients_group ON clients("group")` 当前没有任何查询使用。前端分组是在读取节点列表后按内存分组，后端没有 `WHERE "group" = ?` 或按 group 排序的路径。

已新增迁移：

- `worker/migrations/014_drop_redundant_client_indexes.sql`

行为：

- 新库初始化不再创建 `idx_clients_token` 和 `idx_clients_group`。
- 老库部署时执行 `DROP INDEX IF EXISTS idx_clients_token`、`DROP INDEX IF EXISTS idx_clients_group`。
- `schema-bootstrap` 也加入同样维护语句，防止一键部署、旧库或半迁移库保留冗余索引。
- smoke 使用 `PRAGMA index_list('clients')` 断言这两个普通索引不存在，同时确认 SQLite 自动索引仍存在。

收益：

| 写入场景 | 删除前 | 删除后 |
| --- | --- | --- |
| 新增节点 | 写 clients 表 + token 唯一索引 + `idx_clients_token` + `idx_clients_group` 等 | 少维护重复 token 索引和未使用 group 索引 |
| token 轮换 | token 唯一索引 + `idx_clients_token` 都要更新 | 只维护唯一索引 |
| 节点基础信息/隐藏/排序更新 | 如果 group 索引存在，相关行更新仍可能触发额外索引维护 | 不维护未使用 group 索引 |

这不改变监控频率、历史密度、agent 鉴权语义或后台分组显示；只是减少无用索引写放大。

### 43. 自动清理不再做清理后全量过期 COUNT

定时任务清理过期历史时，旧行为是：

1. 分批删除 `records`、`gpu_records`、`gpu_snapshots`、`ping_records`、`ping_snapshots`、`audit_logs` 的过期行。
2. 如果删到了数据，再调用 `getExpiredRowCounts()` 对所有历史表做一次 `WHERE time < ?` 的过期行统计。
3. 把 `expired_backlog_after` 写入 `cron_cleanup` 审计日志。

这对排障有帮助，但在 backlog 很大时，自动 cron 每次清理后都会多做 6 个 `COUNT(*) WHERE time < ?` 查询。`COUNT` 仍会消耗 D1 rows read；这些统计不影响清理正确性，也不影响监控密度。

现在改为：

- 自动 cron 仍按原保留时间删除过期历史。
- 自动 cron 审计日志保留 `deleted` 计数和清理 cutoff。
- 自动 cron 的 `expired_backlog_after` 标记为 `skipped_for_quota`，不再做清理后的全量过期统计。
- 手动维护清理 `/api/admin/maintenance/cleanup` 仍保留 `expired_backlog_before` 和 `expired_backlog_after`，用于管理员主动排查 backlog。
- 后台容量页仍可刷新真实行数和过期行数，但有缓存，不是每次 cron 都做。

收益：

| 场景 | 旧行为 | 新行为 |
| --- | --- | --- |
| 正常无过期 backlog | 无额外统计 | 不变 |
| 有大量过期历史，cron 每轮删一批 | 每轮删除后再对多张表做过期 `COUNT` | 只记录删除计数，不做全量 backlog `COUNT` |
| 管理员手动维护 | 返回精确前后 backlog | 保持精确 |

这属于“减少维护型 rows read”，不改变 3 秒实时、60 秒历史、60 秒 Ping 或 72 小时保留策略。

### 44. 孤儿数据清理只读取 clients.uuid

后台维护里的孤儿数据清理只需要知道“哪些 UUID 仍然是合法节点”，用于裁剪 Ping 任务、负载通知里的失效引用，并删除不再属于任何节点的历史行。旧逻辑调用 `listClients()`：

```sql
SELECT * FROM clients ORDER BY sort_order ASC, name COLLATE NOCASE ASC, created_at ASC
```

这会读取 token、系统信息、备注、价格、流量等与孤儿清理无关的列。节点越多，后台维护时搬运的数据越多，也增加误把敏感字段带入维护路径的风险。

现在改为复用 `listClientIds()`：

```sql
SELECT uuid FROM clients
```

语义不变：

- Ping 任务仍会移除不存在的定向节点引用。
- 负载通知仍会移除不存在的节点引用；引用清空时仍删除该规则。
- 离线/到期通知、`records`、`gpu_records`、`gpu_snapshots`、`ping_records`、`ping_snapshots` 仍通过 `DELETE ... WHERE client NOT IN (SELECT uuid FROM clients)` 清理孤儿行。

这不影响实时采样、历史保存、Ping 执行频率或保留时间。收益是后台维护路径不再为了构造 UUID 集合读取完整 `clients` 行。smoke fake D1 已锁定：孤儿清理必须读取 `SELECT uuid FROM clients`，不能退回完整客户端读取。

### 45. Agent 身份认证路径收窄 client token 查询

Agent 受保护接口以前统一通过 `getClientByToken()`：

```sql
SELECT * FROM clients WHERE token = ?
```

这对 `/api/clients/report` 和 `/api/clients/uploadBasicInfo` 是合理的，因为它们要用完整节点行做 IP、版本、基础信息 no-op 比对。但以下路径只需要确认 token 有效，并拿到 `uuid/name/hidden`：

- WebSocket agent 握手 `/api/ws/clients/report`
- HTTP fallback policy `/api/clients/policy`
- Ping 任务拉取 `/api/clients/ping/tasks`
- Ping 结果上报 `/api/clients/ping/result`

这些路径默认会随 agent 周期触发，尤其 Ping 任务/结果默认 60 秒一轮。读取完整节点行会把 CPU/系统信息、备注、价格、流量等与认证无关的列一起拉出来。

现在新增身份窄查询：

```sql
SELECT uuid, token, name, hidden FROM clients WHERE token = ?
```

并为身份查询保留独立的 15 秒正缓存和 5 秒负缓存。`invalidateAgentClientAuthCache()` 同时清理完整认证缓存和身份认证缓存，新增节点、删除节点、token 轮换后不会继续使用旧身份。

语义不变：

- WebSocket 握手仍把 `uuid/name/hidden` 传给 Durable Object。
- Ping 任务仍按 `uuid` 过滤定向任务。
- Ping 结果仍按 `uuid` 校验任务归属，并交给 DO 按任务间隔去重/持久化。
- HTTP report / uploadBasicInfo 仍使用完整 client 行，不牺牲 IP 变更、版本更新和基础信息 no-op 写入保护。

收益是默认 agent 周期路径减少 D1 数据搬运和敏感列暴露；rows read 行数仍是 1 行，但每次读取的列更少，Worker CPU/序列化/内存压力也更低。smoke 覆盖：完整认证必须继续走 `SELECT *`，身份认证必须走 `SELECT uuid, token, name, hidden`，两者正/负缓存和 targeted invalidation 都要生效。

### 46. 历史容量保护 COUNT 改为自适应频率

历史写入前的高水位保护很重要：它能在 D1 历史行数接近 `record_high_watermark_rows` 时暂停历史持久化，只保留实时数据，避免把免费 D1 写爆。旧逻辑固定每 10 分钟执行一次容量统计。现在容量检查改为自适应频率，并且只统计高水位真正保护的历史表：

- `records`
- `gpu_records`
- `gpu_snapshots`
- `ping_records`
- `ping_snapshots`

这些 COUNT 不影响监控密度，但历史表越大，固定周期扫描越贵。现在改成按距离高水位自适应：

| 当前历史行数 / 高水位 | 下一次容量 COUNT |
| ---: | ---: |
| < 80% | 60 分钟后 |
| 80% - 95% | 10 分钟后 |
| >= 95% 或已阻塞 | 1 分钟后 |
| COUNT 查询异常 | 10 分钟后重试，期间允许继续写入 |

这不改变：

- 3 秒实时上报。
- 60 秒默认历史持久化。
- 60 秒默认 Ping。
- 72 小时默认保留。
- 高水位达到后暂停历史写入的保护语义。

收益是默认健康状态、远离高水位时，容量保护从“每小时约 6 次多表 COUNT”降到“每小时约 1 次多表 COUNT”。接近阈值时会自动收紧到 10 分钟/1 分钟，避免为了省读取而让保护反应太慢。

### 47. 历史高水位检查不再 COUNT audit_logs

后台容量页和维护页需要展示 `audit_logs` 的真实行数和过期 backlog，所以管理接口仍然使用完整 `getStorageRowCounts()`。但 Durable Object 的历史高水位保护只决定是否继续写入监控历史，后台文案也明确只保护：

- `records`
- `gpu_records`
- `gpu_snapshots`
- `ping_records`
- `ping_snapshots`

旧 DO 容量检查复用完整 `getStorageRowCounts()`，每次还会额外执行：

```sql
SELECT COUNT(*) AS count FROM audit_logs
```

随后计算 `recordCapacityRows` 时又不使用 `audit_logs`。这是一条纯多余的 D1 rows read，尤其在审计日志较多时会放大后台/热路径容量检查成本。

现在新增 `getHistoryStorageRowCounts()`，DO 高水位检查只统计 5 张历史表；后台容量页仍保留完整行数展示。这样不改变审计日志保留、不改变维护清理、不改变历史高水位保护语义，只减少 DO 历史写入前容量检查的一次无效 COUNT。smoke 覆盖：历史行数 helper 不允许统计 `audit_logs`，DO `canPersistWithinCapacity()` 不允许退回完整 `getStorageRowCounts()`。

### 48. Ping 批量历史按任务间隔扩大快照扫描窗口

Ping 快照表把同一节点、同一轮次的多个 Ping 任务结果合并到 `ping_snapshots.values_json`，核心收益在写入侧：

- 多个同频任务从多行 `ping_records` 变成 1 行 `ping_snapshots`。
- 仍保持 60 秒默认 Ping 和 60 秒默认历史持久化，不牺牲监控密度。
- 查询多个任务时，批量接口可以一次扫描最近的快照行，再在 Worker 内拆成各任务序列，避免每个任务重复扫描同一段快照。

但这里有一个容易踩的坑：不同 Ping 任务可能有不同间隔。例如一个 60 秒任务和一个 600 秒任务同时展示，如果后端只按 `limit=5` 扫最近 5 条 `ping_snapshots`，600 秒任务最多只能命中 1 个点；图表看起来像“数据缺失”，实际是读取窗口太窄。

现在前端 `/api/records/ping/batch` 请求会发送：

```text
task_specs=<taskId>:<requestedLimit>:<intervalSec>,...
base_interval=<本次展示任务中的最小 intervalSec>
```

后端 `getPingRecordsForTasks()` 会按每个任务的 `requestedLimit * ceil(intervalSec / baseIntervalSec)` 计算需要扫描的快照窗口，并设置 5000 行硬上限。这样：

- 60 秒任务请求 5 个点时，仍只需要最近约 5 条快照。
- 600 秒任务请求 3 个点、基础间隔 60 秒时，会扫描最近约 30 条快照。
- 老的 `task_ids=1,2&limit=120` 仍兼容，只是没有任务间隔信息时按默认保守窗口处理。

这个优化的性质要分清：

- 它不减少写入行数；写入行数已经由 `ping_snapshots` 合并写入降低。
- 它减少多任务图表重复读取同一快照段的 D1 查询次数和 rows read。
- 对低频任务，它可能比旧的错误窄窗口读取更多快照行，但这是为了返回正确的数据点，不是额外采样或额外写入。
- 前端 `base_interval` 只按本次实际展示的任务计算，避免未展示的更高频任务把扫描窗口放大。

smoke 已覆盖：30 条 60 秒快照中，600 秒任务只在第 0/10/20 条出现；批量接口请求 60 秒任务 5 个点、600 秒任务 3 个点时，必须同时返回完整结果。前端测试覆盖：图表请求会发送 `task_specs` 和 `base_interval`，后端能够获得每个任务的 interval 上下文。

## 优化后默认场景估算

1 台 VPS、3 秒实时、60 秒历史、3 个 60 秒 Ping：

| 项目 | 旧估算 rows written / day | 新估算 rows written / day |
| --- | ---: | ---: |
| 资源历史 | 4320 | 4320 |
| Ping 历史 | 17280 | 4320 |
| 合计 | 21600 | 8640 |

读配额的下降更依赖实际 Worker 冷启动频率、是否打开管理页、是否触发容量页、是否有定时清理 backlog。代码层面已减少几个固定热点：

- 大多数 3 秒 report 不再读 D1 设置。
- HTTP 模式 3 秒 report 不再重复读取同一个 client 行。
- 容量 COUNT 从约每分钟降低为自适应频率：远离高水位时约 60 分钟，接近高水位时 10 分钟/1 分钟。
- DO 历史高水位检查只 COUNT 5 张热历史表，不再额外 COUNT `audit_logs`。
- schema bootstrap 命中哨兵后跳过完整初始化。
- Ping 任务轮询默认从 30 秒降低到 60 秒。
- 批量隐藏/删除节点不再对每个 uuid 重复读取 clients、ping_tasks、load_notifications。
- 后台设置保存不再写入没有变化的 settings key，也不再为 no-op 保存写审计日志。
- 离线/到期通知重复保存相同值不再写 `offline_notifications` / `expiry_notifications`。
- 负载通知规则重复编辑相同值不再写 `load_notifications`。
- 节点排序和 Ping 任务排序只更新 `sort_order` 真正变化的行；重复保存原顺序不再写 D1。
- 单节点编辑和 Ping 任务编辑重复保存相同内容时不再写业务表、审计表，也不触发无意义缓存失效。
- 公开历史接口同 URL 10 秒内重复访问会命中 Worker isolate 内存缓存，不再重复读 D1。
- 公开节点列表和历史可见性检查不再读取完整 `clients` 行；公开列表跳过 token/私有备注，可见性检查只读 `uuid, hidden`。
- 登录限流的旧桶清理在同一 isolate 内最多 10 分钟执行一次，不再每次登录都扫描过期限流表。
- 重复 CSRF 拒绝审计同用户名/同 IP/同路径 60 秒内只写 1 条；拒绝行为仍逐次执行。
- 后台容量页 30 秒内重复查看会命中完整估算缓存，不再重复读取 clients/settings/ping_tasks。
- 后台容量估算页只读取 `clients/gpu_clients` 聚合计数，不再为了节点数量读取完整 `clients` 行。
- 后台新增节点和 token 轮换的存在性校验改为 `SELECT 1`，不再为了判断是否存在读取完整 `clients` 行。
- 后台 token 查看和 token 轮换前置读取改为 `SELECT uuid, token, name`，不再读取完整节点系统信息。
- 后台 Ping/通知规则校验 30 秒内复用客户端 UUID 集合；全节点 Ping/负载通知完全不读 clients。
- 后台孤儿数据清理只读取 `clients.uuid` 构造合法节点集合，不再读取完整 `clients` 行。
- Agent WebSocket 握手、policy、Ping 任务和 Ping 结果认证只读取 `uuid/token/name/hidden`，不再读取完整节点行。
- WebSocket agent Ping 结果进入 DO 后 30 秒内复用 `ping_tasks`，不再每个节点每轮都读任务表。
- 负载告警 cron 同一规则按目标节点批量 `GROUP BY client`，不再每节点发起一次窗口聚合查询。
- Ping 图表批量接口按 `task_specs` 一次读取多个任务的快照历史，低频任务按 interval 扩大扫描窗口，避免重复扫描和错误截断。

## 仍需注意的坑

- 如果节点数增加，Ping 历史会线性增长。`节点数 * Ping任务数 * 每日次数 * (表 + 索引数)` 是写入主公式。
- 如果用户把 Ping 任务间隔改到 5 秒，agent 最多要等当前轮询周期结束后才会发现新设置；发现后会按新的最短任务间隔运行。若想让变更更快生效，可以重启 agent 或安装时设置更短的 `--ping-interval` 兜底。
- Worker isolate 内存缓存只能保证当前 isolate 立即失效；Cloudflare 边缘可能同时存在多个 isolate。公开接口已经带 30 秒 Cache-Control，因此跨 isolate 的公开元数据最多仍可能短暂滞后。Agent policy、历史写入和 Ping 结果限频走 DO/D1，不依赖这层公开缓存。
- 管理页的容量页、历史分页、导出、备份恢复会真实读取 D1，不能把 Dashboard 读数全部归咎于 agent。
- 建索引、迁移、导入 demo 数据也会计入 D1 使用量。
- 过度删索引会省写入但增加历史查询扫描。当前新组合索引是针对现有查询形态的折中。

## 后续可选优化

- 给 `/api/clients/ping/tasks` 做短期内存缓存或 ETag，减少多节点重复读取 `ping_tasks`。
- 继续优化公开历史查询：普通图表查询尽量避免 paged 模式的 `COUNT(*)`，分页总数改成“按需精确统计”或“下一页探测”。这会减少打开详情页时的 D1 rows read，不影响采样/上报密度。
- 公开历史分页已经改为 `limit + 1` 下一页探测，不再默认执行精确 `COUNT(*)`。`has_more` 是准确的，`total` 是前端兼容用的下界估算，不再代表精确总数。
- 离线告警已经从 `SELECT client, MAX(time) GROUP BY client` 全表聚合，改为只对启用离线告警的节点按 `(client, time)` 索引查询最新一条。
- 负载告警已经改为按规则批量窗口聚合查询，并且先判断冷却期；cron 不再把每个规则、每个节点窗口内的完整历史行对象全部拉回 Worker，也不再每节点发起一次聚合 SQL。
- Agent Ping 任务表已经增加 30 秒 per-isolate 缓存，减少多节点重复读取任务配置；后台变更任务或备份恢复会立即失效缓存。
- Agent token 认证已经增加 15 秒 per-isolate 短缓存；HTTP 3 秒上报模式下可明显减少 `clients` token 查询，WebSocket 握手也复用同一缓存，同时 token 轮换同 isolate 立即失效。
- Agent token 认证同时增加 5 秒无效 token 负缓存；同一个错误 token 的重复请求不再每次读 D1，缓存有 512 项上限，避免异常流量撑大内存。
- 后台容量页真实行数和过期待清理行数已经增加 60 秒 per-isolate 缓存；手动维护清理后强制刷新。
- 后台审计日志分页已经改为 `limit + 1` 下一页探测，不再为显示总页数执行 `COUNT(*)`。前端显示“至少 N 条”时表示还有下一页，最后一页才显示精确“共 N 条”。
- 实时 viewer token / WebSocket 连接读取的 viewer TTL 增加 30 秒 per-isolate 缓存，后台保存 `live_poll_*` 设置时立即失效，减少前端刷新和重连造成的 `settings` 重复读取。
- 管理健康检查的 D1 write probe 已从双 settings 写入改成单健康事件写入，并且连续 OK 10 分钟内不重复写 `health:d1_write_probe`。重复打开健康页时仍能看到健康状态，失败和错误恢复不会被这层成功节流隐藏。
- Agent 基础信息和 report 中的版本号已经做 no-op 写入去重：CPU/系统/容量/IP/版本等元数据没有变化时不再更新 `clients.updated_at`，避免每 30 分钟基础信息刷新或每次历史持久化都产生无意义 D1 写入。
- 定时任务单次运行内的 `settings` 读取已经合并为一个懒加载缓存。清理、离线检查、负载告警、到期提醒、Telegram 发送共享同一份设置，避免一次 cron 内多条通知反复读取 `settings` 表。
- 定时任务单次运行内的 `clients` 读取也合并为一个懒加载缓存，并收窄为 `uuid/name/created_at/expired_at`；离线/到期/定向负载规则只读取涉及的节点子集，只有全节点负载规则才读全量节点。
- 定时任务触发的 Telegram 成功健康状态写入增加 1 小时节流；连续多条通知仍会正常发送，但不会每条都写 `settings.health:telegram`。如果之前状态是 error，下一次成功不会被节流，会立即恢复健康状态。
- DO 热路径 `do_record_persistence`、`ping_persistence` 成功健康状态写入增加 D1 持久节流；跨 isolate/冷启动时也不会反复写连续 OK，但错误恢复为 OK 仍会立即写入。
- 后台批量隐藏、批量删除节点已经改为批量读取 clients、批量清理历史、一次性裁剪 Ping/负载通知引用；批量操作时不再按节点重复扫描配置表。
- 后台设置保存已经增加 no-op 写入去重。前端发送整份 settings 时，后端只写变化的 key；完全相同的保存不会写 settings、audit，也不会刷新 DO。
- 离线通知和到期通知编辑已经从 `INSERT OR REPLACE` 改为带变化条件的 UPSERT。重复保存相同配置时 `changed=0`，不会写对应通知表。
- 负载通知规则编辑已经增加 no-op 更新去重。重复保存相同规则时 `changed=0`，不会写 `load_notifications`；cron 的 `last_notified` 仍在实际变化时正常更新。
- 节点排序和 Ping 任务排序已经改为只更新变化行。大列表重复保存原顺序时写入为 0，局部换位时写入量约等于实际变动行数。
- 单节点编辑和 Ping 任务编辑已经增加 SQL 层 no-op 更新保护。重复保存相同内容不会写业务表和审计表，也不会让 agent 因缓存失效提前重读配置。
- 公开历史接口已经增加 10 秒 per-isolate 缓存。`/api/recent/:uuid`、`/api/records/load`、`/api/records/gpu`、`/api/records/ping` 同 URL 重复请求会返回 `X-CF-Monitor-History-Cache: hit`，减少页面查看造成的 D1 rows read。
- Ping 历史批量接口已经支持 `task_specs`，前端会传入每个任务的请求点数和 interval。多任务图表不再逐任务重复扫描快照；60 秒/600 秒混合展示时也不会因为统一 `limit` 过窄导致低频任务缺点。
- 登录限流旧桶清理已经增加 10 分钟 per-isolate 节流，失败登录也复用登录开始时读取的两个限流桶。同 IP + 同用户名 + 同失败原因的 `login_failed` 审计日志 60 秒内只写 1 条。安全相关的失败计数、锁定检查和成功清桶仍逐次执行，只有过期维护扫描、重复桶读取和重复审计日志被合并。
- CSRF 拒绝审计日志已经增加 60 秒 per-isolate 去重。同用户名 + 同 IP + 同路径的重复拒绝只写 1 条 `csrf_rejected`，但所有请求仍会被 403 拒绝。
- 后台容量估算页已经增加 30 秒 per-isolate 完整估算缓存。重复打开返回 `capacity_estimate_cache: hit`；设置/节点/Ping/清理/备份恢复会失效缓存；`refresh_counts=true` 仍强制刷新真实行数。
- 后台容量估算页已经改为聚合查询获取节点数和 GPU 节点数，不再为了 `clients.length` 读取完整节点行。
- 后台节点 UUID/token 存在性校验已经改为 `SELECT 1 ... LIMIT 1`；新增节点和 token 轮换不会为了冲突判断读取完整 client 行。
- 后台 token 查看和 token 轮换已经改为 token 元数据窄查询；旧 token 清缓存和审计日志语义不变。
- 后台 Ping/通知规则的客户端存在性校验已经增加 30 秒 per-isolate UUID 集合缓存，并收窄为 `SELECT uuid FROM clients`；全节点 Ping/负载通知不读 clients；新增/删除节点和备份恢复会立即失效。
- `LiveDataDO` 已增加 30 秒 Ping 任务缓存。WebSocket agent Ping 结果和 DO `/ping-result` 复用任务表；后台任务变更、节点删除、备份恢复会通过 `/ping-tasks-refresh` 立即失效。
- 增加 admin-only D1 query meta 采样，把关键查询的 `meta.rows_read`、`meta.rows_written` 暴露出来，方便定位真实热点。
- 为 Ping 历史提供独立的 `ping_record_persist_interval_sec`。这会降低 Ping 历史密度，默认不启用，除非用户明确接受。
