# 读写额度优化复审报告

日期: 2026-06-14

目标: 在不影响核心体验的前提下，复审当前代码中的 D1 / Durable Object / Workers 请求读写消耗，并给出后续可落地的优化方向。

## 实施进度

更新时间: 2026-06-14

| 项目 | 状态 | 本次处理 |
| --- | --- | --- |
| P1 公共 GET 先查缓存，再触发 RateLimitDO | 已完成 | `public.ts` 的 metadata/history/live 可缓存 GET 已调整为 cache hit 先返回；history 保留 public clients snapshot 可见性判断，避免 hidden client 旧缓存泄漏；登录、管理写请求未绕过限流。 |
| P1 降低后台节点页全量 clients 轮询 | 已完成 | `Dashboard.tsx` 从 10 秒轮询改为页面进入、窗口可见/聚焦、手动刷新、60 秒兜底；`admin.ts` 增加 60 秒 `adminClientsCache`，客户端增删改、排序、批量、Token 轮换、备份恢复后失效。 |
| P1 合并 Ping 结果 DO storage 元数据 | 已完成 | `LiveDataDO` 将 `lastAcceptedMs/value/persistedAt` 合并到 `ping-result:<client>:<task>` 单 key，并加内存 Map；兼容旧的数字 `lastAcceptedMs`，不再读取 `ping-result-meta:*`。 |
| P1 离线检测按 client IN 聚合查询 | 已完成 | `getLatestRecordTimesForClients()` 改为 `SELECT client, MAX(time) ... WHERE client IN (...) GROUP BY client`，按批查询。 |
| P2 负载通知按规则窗口分组 | 已完成 | `runLoadCheck()` 按 `metric + threshold + time window` 合并查询，统计结果再分发给规则；同一规则本轮只更新一次 `last_notified`。 |
| P2 公共 settings/client 数据前端共享缓存 | 已完成 | 新增轻量 `frontend/src/utils/publicSettings.ts` module cache；`LiveDataContext`、`Layout`、安装命令弹窗复用 `/api/public` 结果；设置更新事件会同步写入缓存。 |
| P2 通知页复用后台 clients 数据 | 已完成 | `Notifications.tsx` 增加页面级 `ensureClientsLoaded()`，offline/expiry/load tab 复用同一次 `/admin/clients` 请求；通知配置刷新不再重复刷新 clients。 |
| P2 登录失败限流批量读写 | 已完成 | 增加 `getLoginRateLimitsByBuckets()`、`setLoginRateLimits()`、`clearLoginRateLimits()`；登录失败和成功清理改为批量 D1 操作。 |
| P2 健康检查短 TTL / deep 模式 | 已完成 | `/admin/health` 默认 30 秒缓存并跳过 schema PRAGMA；`?deep=1` 或 `?refresh=1` 才执行完整 schema 检查。 |
| P3 设置保存 batch | 已完成 | `POST /admin/settings` 保留 changed-only 判断，改用 `setSettings()` 批量写入。 |
| P3 通知配置批量编辑 batch | 已完成 | 离线/到期通知批量编辑改用 batch helper，继续使用 `ON CONFLICT ... WHERE changed` 并返回 changed count。 |
| P3 修正容量估算 agent auth cache 秒数 | 已完成 | `routes/client.ts` 导出真实 `AGENT_AUTH_CACHE_MS`，后端容量估算和前端设置页估算都使用 60 秒而不是旧的 15 秒。 |
| 额外低风险优化 | 已完成 | 公开首页 `/api/clients` 60 秒刷新增加可见性判断，隐藏标签页不继续刷新。 |

## 未改和保留项

- 未默认关闭实时上报、WebSocket、鉴权、CSRF、登录失败限流、审计日志或 schema bootstrap；这些属于核心体验或安全/可靠性边界。
- 未延长 public history TTL；仍保持短 TTL，并在客户端隐藏/删除等操作后继续清理公开缓存。
- 未删除旧 `ping-result-meta:*` DO storage key；新代码不再读取它们，历史遗留 key 可自然闲置，避免引入迁移风险。
- 尚未做线上 Cloudflare Analytics 对比；需要部署后观察 D1 rows read/write、Worker requests、DO storage reads/writes。

## 本次验证

- 已运行 `npm run build`，Worker 类型检查和前端 Vite 构建通过。

## 复审范围

本次覆盖了仓库内主要运行路径:

- `worker/src`: Worker 路由、D1 查询层、Durable Object、定时任务、认证、观测和配额估算。
- `frontend/src`: 实时数据上下文、公开页、后台节点页、通知页、Ping 图表、设置页。
- `agent/main.go`: agent 上报、WebSocket/HTTP 策略、Ping 任务拉取和结果上报。
- `worker/migrations`、`wrangler.toml`: 表结构、索引、定时任务和绑定配置。

## 额度口径

仓库当前主要按 `worker/src/utils/quota.ts` 估算:

- D1 写入: `records`、`gpu_snapshots`、`ping_snapshots` 都按 1 行业务数据 + 索引写放大估算。
- D1 读取: 历史查询、列表查询、认证查询、定时任务扫描、容量统计。
- Durable Object 存储: rate limit bucket、ping 结果节流元数据、GPU 快照签名、viewer/session alarm。它不等同于 D1 rows read/write，但仍是 Cloudflare 侧的存储/计算消耗。
- Workers 请求: agent 上报、ping 任务轮询、前端 API、cron、DO stub fetch。

下面的建议把 D1 读写和 DO 存储操作分开描述。

## 当前已经做得好的地方

这些优化已经在代码中存在，建议保留:

- 监控历史落库有开关和间隔: `record_enabled`、`record_persist_interval_sec`、`ping_record_persist_interval_sec`，默认监控 60 秒、Ping 300 秒。
- Agent 空闲降频: 无 viewer 时策略会把 report interval 拉到 `live_poll_idle_interval_sec`，默认 600 秒。
- 历史高水位保护: `LiveDataDO.canPersistWithinCapacity()` 会在历史行数超过 `record_high_watermark_rows` 时暂停历史落库，实时体验不受影响。
- Ping/GPU 快照化: `ping_snapshots` 和 `gpu_snapshots` 已经减少了旧模式下一任务/一设备多行写入。
- Ping/GPU 变化节流: Ping 结果小幅不变时用 30 分钟 heartbeat，GPU 用签名和 30 分钟 heartbeat。
- 公共接口已有内存/edge cache: 元数据 30 秒，历史 10 秒，live 2 秒。
- Agent 鉴权、Ping 任务、公共 metadata、定时任务上下文都有短 TTL cache。
- 多处写操作已有 no-op 判断: 例如 `updateClient`、`updatePingTask`、`updateLoadNotification`、通知配置更新都尽量避免重复 UPDATE。
- 审计和健康事件有 throttle，错误日志不会无限写入。

## 主要消耗热点

| 路径 | 主要消耗 | 说明 |
| --- | --- | --- |
| Agent 实时上报 `/api/clients/report` / WebSocket | Worker 请求、DO 调用、D1 历史写 | 实时广播是核心体验；历史写已按间隔降频。 |
| Ping 任务 `/api/clients/ping/tasks`、`/api/clients/ping/result` | Worker 请求、D1 auth/task 读、D1 ping snapshot 写、DO storage 元数据读写 | 默认 300 秒统一 Ping 间隔，任务和设置有 30 秒 cache。 |
| 公开历史 `/api/records/*` | D1 历史读 | 有 10 秒内存/edge cache，批量 Ping 接口已减少多任务重复扫描。 |
| 公开 API rate limit | RateLimitDO fetch + DO storage get/put | 当前在公共 GET cache 命中前就执行，每个请求都可能写 DO bucket。 |
| 后台节点页 `/api/admin/clients` | D1 全量 clients 读 | 前端每 10 秒刷新一次，而在线状态已经由 LiveDataContext 提供。 |
| cron 每 10 分钟 | D1 删除、列表读、历史统计读、审计写 | 由 `wrangler.toml` 的 `*/10 * * * *` 触发。 |
| `/api/admin/health` | D1 健康事件读写、schema PRAGMA 读 | 用户打开健康页时会做较深检查。 |

## 优化建议

### P1. 公共 GET 先查缓存，再触发 RateLimitDO

相关位置: `worker/src/routes/public.ts`

当前 `publicRoutes.get('/clients')`、`/public`、`/task/ping`、`/nodes`、`/records/*`、`/live` 都先执行 `guardPublic*()`，再查内存/edge cache。启用 `RATE_LIMIT` Durable Object 后，即使响应可从 cache 命中，也会产生一次 DO fetch 和一次 DO storage get/put。

建议:

- 对完全公开、可缓存的 GET，先尝试 edge/memory cache。
- cache miss 时再做 rate limit 和 D1 查询。
- 历史接口要保留 hidden client 防泄漏: 可以先用 `publicClientVisibilityCache` 或 `getPublicClientsSnapshot()` 的可见性缓存判断，再读 history cache；可见性未知时才查 D1。

预期收益:

- 高流量公开页下，cache hit 可避免大部分 RateLimitDO storage 写。
- 不改变用户可见数据，只改变 cache/rate-limit 顺序。

注意:

- 登录、live-token、管理写请求不应绕过 rate limit。
- hidden client 的旧历史 cache 仍需在隐藏/删除时失效，当前 `invalidatePublicMetadataCache()` 逻辑要继续保留。

### P1. 降低后台节点页全量 clients 轮询

相关位置:

- `frontend/src/pages/admin/Dashboard.tsx`
- `worker/src/routes/admin.ts`

后台节点页当前每 10 秒调用 `/api/admin/clients` 拉全量节点元数据。在线状态、CPU/RAM/流量等实时值已经由 LiveDataContext 提供，因此 10 秒刷新静态元数据不是核心体验必需。

建议:

- 前端改为页面进入、窗口重新可见、手动刷新、节点增删改/排序后刷新。
- 常规后台静态元数据 TTL 可放到 60 秒。
- 服务端可加一个 `adminClientsCache`，在 client add/edit/remove/reorder/batch 操作后统一失效。

预期收益:

- 后台打开期间 D1 `listClients` 读从每分钟 6 次降到每分钟 0-1 次。
- 实时体验不变，因为实时状态仍由 WebSocket/LiveDataDO 驱动。

### P1. 合并 Ping 结果的 DO storage 元数据

相关位置: `worker/src/do/live-data.ts`

当前每个 Ping result 可能触发:

- 读取 `ping-result:<client>:<task>` 判断最小间隔。
- 读取 `ping-result-meta:<client>:<task>` 判断值是否变化。
- 写 `ping-result:<client>:<task>` 更新 last accepted。
- 真正持久化后再写 `ping-result-meta:<client>:<task>`。

建议:

- 合并成单 key: `{ lastAcceptedMs, value, persistedAt }`。
- 热路径先用内存 `Map`，DO 重启或 key 缺失时再读 storage。
- 只有 `lastAcceptedMs` 跨过较长间隔或 value/persistedAt 变化时写 storage。

预期收益:

- Ping 任务多、节点多时，DO storage 读写会明显下降。
- D1 写入策略不变，历史图表体验不变。

风险:

- DO 重启后内存丢失，需要继续以 storage 为真源。
- 必须保留防 agent 高频伪造结果的最小间隔判断。

### P1. 离线检测改成按 client IN 聚合查询

相关位置:

- `worker/src/index.ts`
- `worker/src/db/queries.ts`

`getLatestRecordTimesForClients()` 当前对每个 client 做一条 `SELECT ... ORDER BY time DESC LIMIT 1`，通过 `db.batch()` 分批提交。节点多且离线通知开启时，cron 每 10 分钟会产生较多 D1 statements。

建议:

```sql
SELECT client, MAX(time) AS last_time
FROM records
WHERE client IN (...)
GROUP BY client
```

按 100 个 client 一批即可。

预期收益:

- 离线通知节点多时，D1 查询条数从 O(n) 降为 O(n/100)。
- 通知语义不变。

### P2. 负载通知按规则窗口分组，减少重复历史扫描

相关位置: `worker/src/index.ts`

`runLoadCheck()` 当前每条负载规则都会调用一次 `getLoadMetricWindowStatsForClients()`。当多条规则使用相同 `metric + threshold + interval_min`，或目标 client 重叠时，会重复扫描 `records`。

建议:

- 按 `metric + threshold + interval_min` 分组。
- 每组取所有目标 clients 的并集，查询一次。
- 再把结果分发给该组内各规则判断。

预期收益:

- 负载通知规则越多收益越明显。
- 不改变告警结果，只减少重复读。

### P2. 公共 settings/client 数据做前端共享缓存

相关位置:

- `frontend/src/contexts/LiveDataContext.tsx`
- `frontend/src/pages/Layout.tsx`
- `frontend/src/pages/admin/Dashboard.tsx`

多个组件会各自请求 `/api/public`，后台安装命令弹窗也会单独读一次。虽然公共接口有 edge cache，但在当前 rate-limit 顺序下仍可能触发 DO rate-limit 消耗。

建议:

- 做一个 PublicSettingsContext 或轻量 module cache。
- 同一页面生命周期内共享 `/api/public` 结果。
- 设置保存成功后继续用现有 `LIVE_POLL_SETTINGS_UPDATED_EVENT` 做失效/更新。

预期收益:

- 减少重复 Workers 请求和公共 rate-limit 写。
- 不影响配置实时生效。

### P2. 通知页复用后台 clients 数据

相关位置: `frontend/src/pages/admin/Notifications.tsx`

通知页已经按 tab 懒加载，但 offline、expiry、load 三个 tab 都会各自请求 `/api/admin/clients`。用户切换多个 tab 时会重复读全量 clients。

建议:

- 页面级 `ensureClientsLoaded()`，clients 已加载且未强制刷新时直接复用。
- 编辑通知成功后只刷新对应通知列表，不刷新 clients。

预期收益:

- 后台操作中的 D1 listClients 重复读减少。
- 交互不变。

### P2. 登录失败限流做批量读写

相关位置:

- `worker/src/routes/public.ts`
- `worker/src/db/queries.ts`

登录失败限流会检查 IP bucket 和 username bucket。当前是循环 `getLoginRateLimit()`、循环 `setLoginRateLimit()` / `clearLoginRateLimit()`。

建议:

- 增加 `getLoginRateLimitsByBuckets(db, buckets)`。
- `recordLoginFailure()` 和 `clearLoginFailures()` 使用 `db.batch()`。

预期收益:

- 不削弱安全能力。
- 登录攻击或误输频繁时 D1 roundtrip 更少。

### P2. 健康检查增加短 TTL 或 deep 模式

相关位置: `worker/src/routes/admin.ts`

`/api/admin/health` 会运行 D1 write probe、读取健康事件、检查 schema tables，并对每张表执行 `PRAGMA table_info`。这适合作为深度自检，不适合被频繁打开或自动轮询。

建议:

- 默认返回 30-60 秒内存缓存的健康结果。
- `?deep=1` 或“刷新”按钮才执行 schema PRAGMA。
- D1 write probe 的成功写入 throttle 已存在，继续保留。

预期收益:

- 后台健康页频繁打开时减少 D1 metadata 读。
- 故障定位能力保留。

### P3. 设置保存改成 batch

相关位置:

- `worker/src/routes/admin.ts`
- `worker/src/db/queries.ts`

`POST /api/admin/settings` 当前对 changed settings 逐项 `setSetting()`。这是低频路径，但实现简单。

建议:

- 增加 `setSettings(db, settings)`，内部 `db.batch()`。
- 保留 changed-only 写入和现有 cache invalidation。

预期收益:

- 设置页一次保存多个字段时 D1 roundtrip 更少。
- 用户体验不变。

### P3. 通知配置批量编辑落库 batch

相关位置:

- `worker/src/routes/admin.ts`
- `worker/src/db/queries.ts`

离线/到期通知批量编辑会逐项调用 `setOfflineNotification()` / `setExpiryNotification()`。这些函数已经能避免 no-op 写，但仍是逐项 statement。

建议:

- 增加 batch 版本，继续使用 `ON CONFLICT ... WHERE changed`。
- 返回 changed count。

预期收益:

- 批量编辑很多节点时减少 roundtrip。
- 低频，优先级低于公开/agent 热路径。

### P3. 修正容量估算中的 agent auth cache 秒数

相关位置:

- `worker/src/routes/admin.ts`
- `worker/src/routes/client.ts`

实际 `AGENT_AUTH_CACHE_MS` 是 60 秒，但容量估算里 `AGENT_AUTH_CACHE_SEC` 是 15 秒。这个不会直接增加额度消耗，但会让后台容量页对 agent auth D1 read 的估算偏悲观。

建议:

- 将估算常量改为 60，或从共享常量导出。

预期收益:

- 容量页预测更接近真实值，避免用户误判需要过度降频。

## 不建议做的优化

- 不建议为了省额度默认关闭实时上报。实时在线状态是核心体验。
- 不建议移除鉴权、CSRF、登录失败限流或审计错误日志。安全边界比少量写入更重要。
- 不建议把 public history cache TTL 拉得过长。节点隐藏/删除后的可见性一致性需要优先保证。
- 不建议删除 schema bootstrap。当前 `ensureSchema()` 已经有 isolate 级缓存，冷启动只读一次版本；它对部署可靠性有价值。

## 推荐实施顺序

1. 先改公共 GET cache/rate-limit 顺序，并补 hidden client 测试。这是收益最高且不影响核心体验的点。
2. 改后台 clients 刷新策略和共享 clients cache，减少后台常驻读。
3. 合并 DO ping 元数据，降低 Ping 任务较多时的 DO storage 操作。
4. 优化 cron 查询: 离线 latest time 聚合、负载规则分组。
5. 收尾批量写: settings、通知配置、登录限流。
6. 修正容量估算常量，便于后续观察。

## 验证建议

- `npm run build` 确认前后端类型通过。
- 用 wrangler dev 验证:
  - `/api/clients`、`/api/public`、`/api/task/ping` cache hit 不触发 D1 查询。
  - hidden client 的 `/api/records/*` 不返回旧缓存。
  - `/api/admin/clients` 在增删改/排序后立即刷新。
  - Ping 结果仍按 `ping_record_persist_interval_sec` 落库。
- 观察 Cloudflare Analytics:
  - D1 rows read / rows written。
  - Worker requests。
  - Durable Objects storage reads/writes 或相关计费项。
- 对 cron 手动运行 `/api/admin/cron/run`，确认离线、到期、负载通知行为不变。

## 总结

当前代码已经把最大 D1 写入源从“每次上报都写历史”收敛到了“按间隔/快照/变化节流写入”，方向是对的。剩余优化空间主要不在削弱实时体验，而在减少 cache hit 仍产生的 DO rate-limit 写、后台重复拉全量 clients、cron 重复历史扫描，以及 Ping 元数据的 DO storage 热路径。优先处理这些点，可以在不牺牲核心体验的情况下继续降低读写额度消耗。
