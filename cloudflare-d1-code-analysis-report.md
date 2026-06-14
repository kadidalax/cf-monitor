# Cloudflare / D1 代码深度分析报告

日期：2026-06-14
范围：`worker` Cloudflare Worker、D1 schema / migrations / queries、Durable Objects、`frontend` Vite React、`agent` Go 客户端、CI / 部署配置。
重点：D1 数据库配置、迁移、写入路径、容量控制、备份恢复、数据一致性与安全链路。

> 说明：本报告基于当前工作区代码静态审计、Cloudflare D1 官方文档对照，以及本地可运行命令结果。行号基于当前工作区，后续代码变动后需重新定位。

## 修复进度

| ID | 状态 | 本轮变更 | 验证 |
| --- | --- | --- | --- |
| SEC-01 | 已修复 | Agent 鉴权缓存改为显式 `hit/miss`，负缓存不再伪造 client；中间件增加非空 `uuid` 防线；新增 `worker/src/__tests__/client-auth-cache.test.ts` 回归测试。 | 通过：`npm --prefix worker run test`，`npm --prefix worker run build` |
| D1-01 | 已修复 | `wrangler.toml`、`worker/wrangler.toml`、`worker/wrangler.example.toml` 补充 `migrations_dir` 与排除 reset/seed 的 `migrations_pattern`；README 改为明确新账号必须使用自己的 D1 `database_id`，不再承诺无 D1 ID 一键部署。 | 通过：根/worker 配置下 `wrangler d1 migrations list cf-monitor-db --local` 均显示 no migrations |
| D1-02 | 已修复 | 根 `deploy` 和 worker `deploy` 在 `wrangler deploy` 前执行远端迁移；根迁移脚本显式传入根 `wrangler.toml`，worker 脚本保留自身默认配置。 | 通过：`npm run db:migrate:local` 使用根配置完成并记录迁移 |
| D1-03 | 已修复 | 自定义 D1 migration runner 增加兼容 Wrangler 的 `d1_migrations(id,name,applied_at)` 表，已应用迁移会跳过，成功后记录；local reset 会清空迁移表避免 reset 后误跳过。 | 通过：`npm --prefix worker run db:migrate:local` 首次补记录成功；再次运行跳过已应用迁移 |
| D1-04 | 已修复 | 查询主路径集中 `db.batch()` 改为统一 `runD1Batch()`，超过安全语句数时提前失败；runtime bootstrap 的 token hash 迁移改为分批执行；通用 `batchOperations()` 增加语句数 guard；备份恢复增加 client 引用预检，避免缺失 client 引用进入 D1 写入阶段；新增 `worker/src/__tests__/d1-safety.test.ts`。 | 通过：`npm --prefix worker run test`，`npm --prefix worker run build`，`npm run build`，`npm test` |
| D1-05 | 已修复 | client 删除和手动记录清理返回历史删除计数并写入审计日志；备份恢复在恢复前校验通知、Ping 任务、负载通知引用；新增缺失引用恢复测试。 | 通过：`npm --prefix worker run test`，`npm --prefix worker run build` |
| D1-06 | 已修复 | `clearClientRecords()` 和 `clearClientsRecords()` 改为复用 `deleteRowsByIdBatch()`，按 row id 分批删除五张历史表，不再直接大 DELETE。 | 通过：`npm --prefix worker run test`，`npm --prefix worker run build` |
| D1-07 | 已修复 | `LiveDataDO` 的 WebSocket 后台持久化和 last-seen 更新改为通过 `state.waitUntil()` 注册，避免纯 `void` Promise 缺少生命周期保障；后台异常写入健康事件。 | 通过：`npm --prefix worker run test`，`npm --prefix worker run build` |
| D1-08 | 已修复 | D1 容量计数检查失败时改为短暂 fail-closed，暂停历史写入并记录健康事件；监控记录的持久化间隔标记移动到主记录 insert 成功之后。 | 通过：`npm --prefix worker run test`，`npm --prefix worker run build` |
| D1-09 | 已修复 | 新增 `024_latest_records.sql`、runtime bootstrap 兜底和 `latest_records` 触发器，`getLatestRecords()` / `getLatestRecordTimes()` 改读物化 latest 表，避免每次对 `records` 做全表 `GROUP BY client`。 | 通过：`npm --prefix worker run db:migrate:local`，`npm run db:migrate:local`，根/worker 配置下 `wrangler d1 migrations list cf-monitor-db --local` 均显示 no migrations，`npm --prefix worker run test`，`npm --prefix worker run build` |
| TEST-01 | 已修复 | 移除 `db.test.ts` 中的占位 D1 测试；新增 auth token 回归测试；CI 增加本地 D1 migration smoke，覆盖 worker/root 两套 Wrangler 配置的迁移清单。 | 通过：`npm --prefix worker run test`，`npm --prefix worker run db:migrate:local`，`npm run db:migrate:local`，根/worker 配置下 `wrangler d1 migrations list cf-monitor-db --local` 均显示 no migrations |
| CI-01 | 已修复，待 CI 首跑 | CI 增加 Go agent job，执行 `go test ./...` 与 `go build` smoke，避免 agent 只做安装脚本语法检查。 | 本地环境无 `go`，未能本地执行；CI 配置已加入 |
| SEC-02 | 已修复 | 新增 `025_password_reset_tokens.sql` 与 runtime bootstrap 表/index 兜底；密码重置 token 改为 Web Crypto 生成并在 D1 中仅保存 SHA-256 hash；refresh token JTI 改用 Web Crypto。 | 通过：`npm --prefix worker run test`，`npm --prefix worker run build`，`npm --prefix worker run db:migrate:local`，`npm run db:migrate:local` |
| AGT-01 | 已修复，待 Go/CI 验证 | Agent ping 目标校验从注释改为执行路径：默认阻止 loopback/link-local/metadata 目标，保留 RFC1918 内网监控；新增严格阻止私网与显式允许 local 的 flag/env；Linux/Windows 安装脚本写入策略环境变量；`reportInterval` 运行时策略读写改为 atomic；修正 HTTP reporter policy 分支结构；新增 Go 纯函数测试。 | 通过：Windows installer PowerShell 语法检查；未能本地执行 `bash -n`、`gofmt`、`go test ./...`、`go build`，原因是当前环境缺少 `bash`、`gofmt`、`go` |
| FE-01 | 已修复 | 旧 `frontend/src/utils/api.ts` 明确为 public API helper，并在 `apiFetch` / `publicFetch` 中拒绝 `/api/admin/*` 路径，避免绕过 `useApi()` 的 CSRF 注入；新增前端单测。 | 通过：`npm --prefix frontend run test`，`npm --prefix frontend run build`，`npm run build`，`npm test` |

## 执行摘要

当前代码已经有不少面向 Cloudflare/D1 的好设计：使用 D1 prepared statements、历史表索引、历史行计数器、写入高水位、设置校验、备份加密、管理端 CSRF、WebSocket + HTTP fallback、DO 内实时广播与容量缓存。这些说明项目不是简单堆功能，而是在认真控制 D1 成本和 Worker 延迟。

原始审计中发现的优先问题包括：

1. **P0：Agent token 负缓存实现存在鉴权绕过风险。** `getAgentClientByToken()` 和 `getAgentClientIdentityByToken()` 在未命中时缓存了伪造 client 对象，后续同一无效 token 在负缓存 TTL 内会通过 `if (!client)` 检查，可能以空 `uuid` 进入 `/policy`、`/ping/tasks`、`/ping/result`、`/report` 等路径。
2. **P1：D1 部署配置与 README/脚本承诺不一致。** 根 `wrangler.toml` 和 `worker/wrangler.toml` 固定了某个 `database_id`，README 又声称 deploy button 可在没有预先 D1 ID 时完成；根 `deploy` 脚本也没有执行远端迁移。
3. **P1：D1 schema 有双源管理风险。** 一边是 `worker/migrations/*.sql`，一边是运行时 `schema-bootstrap.ts` 自动建表/补列/补触发器；自定义 migration runner 使用 `wrangler d1 execute`，没有利用 Wrangler 原生 `d1_migrations` 跟踪。
4. **P1：D1 大批量操作风险集中在备份恢复、replaceAll、清除指定客户端历史。** 多处一次性 `db.batch()` 或直接 `DELETE ... WHERE client = ?`，数据量增大后容易触发 D1 语句数、耗时、rows read/written 或 Worker 执行时长边界。
5. **P1：真实 D1 测试覆盖不足。** 当前构建和单测通过，但 Worker D1 测试仍含占位测试，没有真实 Miniflare / `cloudflare:test` 的迁移、查询、容量、备份恢复、鉴权负缓存回归测试。

本轮已按上述顺序完成主要修复：先阻断 Agent 鉴权负缓存问题，再补齐 D1 部署/迁移/批处理/清理/查询热点，随后补强测试、CI、安全预留功能、agent ping 边界与前端 CSRF helper 边界。剩余风险主要是当前本地环境没有 Go/bash，Agent 新增 Go 测试和 Linux installer 语法检查需要 CI 首次运行确认。

## 验证结果

已执行并通过：

```text
npm run build
npm test
npm audit --omit=dev --audit-level=high
npm --prefix worker audit --omit=dev --audit-level=high
npm --prefix frontend audit --omit=dev --audit-level=high
npm --prefix worker run db:migrate:local
npm run db:migrate:local
node ./worker/node_modules/wrangler/bin/wrangler.js d1 migrations list cf-monitor-db --local --config worker/wrangler.toml
node ./worker/node_modules/wrangler/bin/wrangler.js d1 migrations list cf-monitor-db --local --config wrangler.toml
PowerShell Parser.ParseFile('agent/install-windows.ps1')
```

结果摘要：

- 根构建通过：frontend `tsc -b && vite build` 通过，worker `tsc --noEmit` 通过。
- 测试通过：frontend 2 个测试文件、15 个测试；worker 4 个测试文件、16 个测试。
- 生产依赖 audit：root / worker / frontend 均未发现 high 级以上漏洞。
- D1 本地迁移通过：worker 配置和根配置均成功应用并记录 `025_password_reset_tokens.sql`；随后两套 Wrangler 配置均显示 `No migrations to apply`。
- Windows installer PowerShell 语法检查通过。

未能执行：

```text
bash -n agent/install-linux.sh
gofmt -w agent/main.go agent/main_test.go
go test ./...
go build
```

原因：当前环境没有 `bash`、`gofmt`、`go` 命令。CI 已新增 Go agent job 与 D1 local migration smoke，待下一次 CI 首跑确认。

## Cloudflare / D1 官方文档对照

对照 Cloudflare D1 文档后，和本项目最相关的点是：

- D1 binding 配置要求 `binding`、`database_name`、`database_id`；`preview_database_id` 可选，但 `wrangler dev --remote` 需要它。
- Wrangler 原生 D1 migrations 会把应用过的迁移记录在数据库的 `d1_migrations` 表中。
- 迁移涉及外键约束时，可能需要 `PRAGMA defer_foreign_keys = true`。
- 官方文档建议使用 migrations 管理 schema 演进；当前项目的自定义 runner 与 runtime bootstrap 都能工作，但会削弱迁移审计和漂移检测。

相关官方文档：

- https://developers.cloudflare.com/d1/reference/migrations/
- https://developers.cloudflare.com/workers/wrangler/configuration/

## 风险分级

> 下表保留原始审计风险便于追踪；当前修复状态以“修复进度”表为准。

| ID | 等级 | 模块 | 问题 | 主要证据 | 建议优先级 |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | P0 | Agent 鉴权 | 无效 token 负缓存可变成伪 client | `worker/src/routes/client.ts:86-115`, `:427-465`; `worker/src/utils/lru-cache.ts:23-40` | 立即修复 |
| D1-01 | P1 | 部署配置 | 固定 D1 `database_id` 与一键部署说明冲突 | `wrangler.toml:8-11`, `worker/wrangler.toml:8-11`, `README.md:43-52` | 高 |
| D1-02 | P1 | 迁移流程 | 根 `deploy` 不跑 remote migrations，README 说会跑 | `package.json:14`, `README.md:165-168` | 高 |
| D1-03 | P1 | Schema 管理 | migrations 与 runtime bootstrap 双源，且自定义 runner 不写 `d1_migrations` | `worker/scripts/run-migrations.mjs`, `worker/src/db/schema-bootstrap.ts:9-13`, `:549-613` | 高 |
| D1-04 | P1 | 批处理 | 备份恢复和 replaceAll 一次性 `db.batch()` 可能越界 | `worker/src/db/queries.ts:291-296`, `:1201-1213`, `:1306-1333`, `:2348-2486` | 高 |
| D1-05 | P1 | 数据一致性 | client 删除与历史/引用清理非原子，历史表无 FK | `worker/src/db/schema-bootstrap.ts:53-144`, `:227-245`; `worker/src/routes/admin.ts:1090-1094` | 高 |
| D1-06 | P1 | 清理性能 | 指定 client 历史清理直接大 DELETE，未按 id 分块 | `worker/src/db/queries.ts:1004-1024` | 高 |
| D1-07 | P2 | DO 写入 | WebSocket 持久化用 `void` 异步，不清楚生命周期保障 | `worker/src/do/live-data.ts:912-958` | 中 |
| D1-08 | P2 | 容量保护 | 容量检查失败时 fail-open，写入失败前已 mark persist attempt | `worker/src/do/live-data.ts:1090-1121`, `:1173-1222` | 中 |
| D1-09 | P2 | 查询性能 | Ping JSON 快照查询和全表 latest 查询可能成为热点 | `worker/src/db/queries.ts:944-990`, `:1467-1583` | 中 |
| TEST-01 | P1 | 测试 | D1 真实测试缺失，placeholder 仍存在 | `worker/src/__tests__/db.test.ts:18-30`, `:138-177` | 高 |
| CI-01 | P2 | CI | CI 不编译 Go agent | `.github/workflows/ci.yml:13-122` | 中 |
| SEC-02 | P2 | 预留安全功能 | password reset token 表缺失且 token 用 `Math.random()` | `worker/src/auth/password-reset.ts:119-167` | 中 |
| AGT-01 | P2 | Agent | Ping 目标 SSRF/内网探测校验函数存在但未启用 | `agent/main.go:683-741` | 中 |
| DOC-01 | P3 | 文档 | cron 说明与配置不一致 | `README.md:50`, `wrangler.toml:6`, `worker/wrangler.toml:6` | 低 |

## D1 专项深度分析

### 1. D1 配置与部署可复现性

代码事实：

- 根 `wrangler.toml` 与 `worker/wrangler.toml` 都绑定 `DB`，`database_name = "cf-monitor-db"`，并固定 `database_id = "6571d29a-848b-4561-b475-2d56d196f9c5"`。
- `worker/wrangler.example.toml` 使用占位 `REPLACE_WITH_YOUR_D1_DATABASE_ID`。
- README 同时说 deploy button 会读取根 `wrangler.toml` 并完成 D1 provisioning，又说 first request 会初始化 schema，使 deploy button 可在没有预先 D1 `database_id` 时完成。
- 根 `deploy` 脚本是 `npm run build && wrangler deploy --config wrangler.toml`，不包含 `db:migrate:remote`。

风险：

- 新用户或 Cloudflare Deploy Button 场景大概率无法使用当前固定 `database_id`，因为这个 ID 属于特定账号。
- README 让用户相信“不需要预先 D1 database_id”，但 Wrangler D1 binding 配置需要有效 `database_id`。这会在部署阶段失败，而不是到 first request bootstrap。
- 根 `wrangler.toml` 与 `worker/wrangler.toml` 双配置需要人工同步，已经和 README/脚本产生了漂移迹象。

建议：

1. 明确二选一：
   - 若目标是 deploy button 一键部署，需要采用 Cloudflare 支持的 provisioning 流程/模板变量，并让 README 与配置一致。
   - 若目标是 CLI 部署，则 README 应明确 `wrangler d1 create cf-monitor-db`、复制 ID、执行迁移、部署。
2. 根 `deploy` 要么改名为 `deploy:worker`，要么包含远端迁移步骤；避免 README 说“build + remote D1 migrations + Worker deploy”但脚本实际不做。
3. 给 D1 binding 补充 `migrations_dir`，必要时补 `preview_database_id` 或清晰说明本地/远端 dev 策略。

### 2. 迁移与 runtime bootstrap 双源

代码事实：

- 正式迁移文件存在于 `worker/migrations/001_init.sql` 到 `023_client_report_interval.sql`。
- `worker/src/db/schema-bootstrap.ts` 在每次 Worker `fetch` 和 `scheduled` 开始时调用 `ensureSchema(env.DB)`，当 `schema_bootstrap_version` 不匹配时执行运行时建表、建索引、补列、触发器创建、token hash 迁移。
- `worker/scripts/run-migrations.mjs` 使用固定列表和 `wrangler d1 execute` 逐文件执行 SQL。
- Cloudflare 官方 D1 migrations 会记录 `d1_migrations`；当前自定义 runner 不会自动写入官方迁移表。

风险：

- schema 真实状态可能由“迁移文件是否跑过”和“某次线上请求是否触发 bootstrap”共同决定，难以审计。
- 新增迁移时必须同时维护 SQL migration 与 `schema-bootstrap.ts`，遗漏任一边都会产生漂移。
- 运行时 bootstrap 在 first request / scheduled 上执行 DDL，可能增加冷启动延迟；多实例并发进入时虽然多用 `IF NOT EXISTS`，但补列/数据迁移仍需谨慎。
- 自定义 SQL splitter 去掉注释行并按分号切分，目前迁移简单时可用，但未来包含复杂 trigger、字符串中的分号或更复杂 SQL 时会脆弱。

建议：

1. 选定一个主源：
   - 推荐以 Wrangler 原生 `d1 migrations apply` 作为生产主源。
   - runtime bootstrap 保留为“空库兜底”时，应有严格 drift test，且不替代迁移记录。
2. 增加 schema drift 检查：从迁移建库得到 schema，再从 bootstrap 建库得到 schema，比对表、列、索引、触发器、默认设置。
3. 如果继续保留自定义 runner，至少记录已应用迁移表，并支持幂等、失败恢复、dry-run/list。

### 3. 外键、孤儿数据与删除一致性

代码事实：

- `records`、`gpu_records`、`gpu_snapshots`、`ping_records`、`ping_snapshots` 都有 `client` 字段，但没有 FK 到 `clients(uuid)`。
- `offline_notifications` 和 `expiry_notifications` 有 `FOREIGN KEY (client) REFERENCES clients(uuid) ON DELETE CASCADE`。
- 单 client 删除路由先 `deleteClient()`，再 `removeLiveClient()`，再 `clearClientRecords()`，再 `pruneClientReferences()`。
- 批量删除同样先删 clients，再清历史，再清引用。
- 存在 `cleanupOrphanClientData()` 手动清理孤儿历史和引用。

风险：

- 删除流程不是单个事务，任何中间失败都可能留下孤儿历史、ping task 引用或通知引用。
- 历史表无 FK 是可以理解的：高写入历史表加 FK 可能增加写入成本，也会让批量删除更复杂。但当前需要更强的补偿机制和可观测性。
- `cleanupOrphanClientData()` 是兜底而不是强一致保障；如果管理员不触发维护清理，孤儿历史可能长期占用 D1 存储和 rows read/write。

建议：

1. 对删除流程引入“删除任务/墓碑”或可恢复状态，确保失败后 scheduled cleanup 能继续完成。
2. 历史表不一定要加 FK，但应将按 client 删除改为分块删除，并记录每张表删除进度。
3. `cleanupOrphanClientData()` 加入 scheduled 周期与告警指标，不只依赖手动维护。

### 4. 批量 D1 操作与 D1 限额边界

风险集中点：

- `restoreBackupData()` 把 settings、clients、ping_tasks、offline_notifications、expiry_notifications、load_notifications 的 delete 与所有 insert 全部塞进一个 `statements` 数组，最后一次 `await db.batch(statements)`。
- `replaceAllClients()`、`replaceAllSettings()`、`replaceAllPingTasks()`、`replaceAllOfflineNotifications()`、`replaceAllExpiryNotifications()`、`replaceAllLoadNotifications()` 都是一类模式：delete + 全量 insert 批处理。
- `clearClientRecords()` 对五张历史表直接按 client 删除；`clearClientsRecords()` 只按 client 列表分块，不按历史 row id 分块。
- 项目已经有较好的 `deleteRowsByIdBatch()`，用于过期清理和全量清理，批大小限制在 100，最多批次数有限制。

风险：

- 大备份恢复可能超过 D1 batch 语句数、请求耗时、Worker CPU/执行时长或 rows written 边界。
- 直接大 DELETE 会让 D1 一次处理大量历史行，数据规模大时更容易超时。
- 全量 replace 如果中途失败，具体结果取决于 D1 batch 语义与失败点；即便原子性满足，也会形成“要么巨大事务成功，要么完全失败”的运维压力。
- 恢复备份时如果 notifications 引用了备份 clients 中不存在的 client，外键可能在插入 notification 时失败，后续 `cleanupOrphanClientData()` 来不及执行。

建议：

1. 给备份恢复做预检：统计将执行的 statements、预计 rows written、备份对象数量、引用完整性。
2. 对恢复采用分阶段策略：
   - 小备份允许单 batch。
   - 大备份改为 chunk + progress + 可恢复任务。
3. 将 `clearClientRecords()` 和 `clearClientsRecords()` 改用类似 `deleteRowsByIdBatch()` 的 row id 分块删除。
4. 为 replaceAll 类函数设置上限，超过上限时走分块恢复或拒绝并给出明确错误。
5. 对外键相关恢复，在迁移/恢复前后明确使用 D1 支持的 FK 策略；若需要临时 defer，应按官方文档使用 `PRAGMA defer_foreign_keys = true` 并测试。

### 5. 历史写入、容量高水位与 Durable Object

好的设计：

- DO 里区分实时广播与 D1 历史写入，Agent 可先收到 ack，减少 D1 延迟对实时链路的影响。
- `record_enabled`、`record_persist_interval_sec`、`ping_record_persist_interval_sec`、`record_high_watermark_rows` 给了 D1 成本控制旋钮。
- `history_row_counters` 通过触发器维护五张历史表行数，比频繁 `COUNT(*)` 更适合 D1 成本控制。
- `canPersistWithinCapacity()` 使用缓存周期，接近高水位时缩短检查间隔。

风险：

- WebSocket 消息处理里 `void this.persistPingResult()`、`void this.persistReportsSequential()`、`void this.persistReport()` 没有显式等待或 `waitUntil`。在 Durable Object WebSocket 生命周期里这种设计可能是为了降低 ack 延迟，但需要验证异步 D1 写入是否有足够生命周期保障。
- `canPersistWithinCapacity()` 在 capacity check 异常时返回 true。这个 fail-open 策略保证实时历史尽量不断写，但如果 D1/counter 出错，可能继续写入并放大问题。
- `persistReport()` 在实际 insert 前调用 `markPersistAttempt()`。这可以抑制失败重试风暴，但也会导致一次写失败后该 client 在持久化间隔内不再尝试，历史样本丢失。

建议：

1. 明确产品策略：D1 异常时是 fail-open 继续尝试写，还是 fail-closed 保护配额与数据库。
2. 为 DO 持久化路径加测试：模拟 D1 insert 失败、counter 失败、高水位阻断、WebSocket 批量上报。
3. 如果保持 ack 优先，建议引入内部队列/重试上限/丢弃计数指标，而不是纯 `void`。
4. `markPersistAttempt()` 可改为 insert 成功后更新；若担心失败风暴，可以单独记录失败冷却时间。

### 6. 查询与索引

已有索引：

- `records(client, time)`、`records(time)`
- `gpu_records(client, time)`、`gpu_records(time)`
- `gpu_snapshots(client, time)`、`gpu_snapshots(time)`
- `ping_records(client, task_id, time)`、`ping_records(time)`
- `ping_snapshots(client, time)`、`ping_snapshots(time)`

查询风险：

- `getLatestRecordTimes()` 使用 `SELECT client, MAX(time) FROM records GROUP BY client`，会随着 `records` 增长变重。
- `getLatestRecords()` 用子查询 `GROUP BY client` 再 join，也可能在历史表大时成为热点。
- Ping snapshot 单任务查询使用 `json_extract/json_type(values_json, '$."taskId"')`，无法利用 task 维度索引。
- `getPingRecordsForTasks()` 先按 client 扫最新 `ping_snapshots`，最多 5000 条，再在 Worker 中 JSON parse 并按 task 聚合；任务多、历史密集时会增加 D1 rows read 与 Worker CPU。

建议：

1. 为 latest record 维护单独表或物化状态，例如 `latest_records`，写入历史时同步 upsert，公开列表直接读 latest。
2. Ping snapshots 适合节省写入行数，但历史查询要接受 JSON scan 成本；若需要高频按 task 查询，可考虑：
   - 保留 snapshots 用于容量友好存储。
   - 为最近窗口维护 `latest_ping_task_values` 或较短 TTL 的 task 维度表。
3. 对公开 API 加 rows read 预算测试：N clients、M tasks、T retention 下估算 D1 读取和响应时间。

### 7. D1 备份与恢复

好的设计：

- 备份下载要求 reauth。
- 只支持加密完整备份导入，拒绝明文恢复。
- 使用 AES-GCM、PBKDF2-SHA256，密码长度校验，恢复前要求 `confirm_restore` 与 `acknowledge_overwrite`。
- 备份不包含账号、审计和历史记录，减少恢复 blast radius。

风险：

- D1 恢复仍然是一个巨大 batch，规模大时不稳。
- 备份恢复成功后才执行 orphan cleanup；外键不满足时可能先失败。
- HMAC 相关工具存在，但实际加密备份主要依赖 AES-GCM 完整性；如果后续恢复 HMAC 流程，需要确认签名稳定序列化是否真正覆盖嵌套对象。

建议：

1. 增加 dry-run 详情：将执行的删除/插入数量、引用错误、预计 batch 数。
2. 大备份走分块事务/任务队列，不要一次性 `db.batch()`。
3. 恢复前校验 notification client 引用、ping task clients 引用，避免依赖恢复后的 cleanup。

## Worker / API / 安全分析

### SEC-01：Agent token 负缓存鉴权绕过

代码事实：

- `LRUCacheWithStats.get()` 只区分 `null` 与非 `null`。
- `getAgentClientByToken()` 查不到 token 时缓存 `{ uuid: '', name: '', hidden: false } as any`。
- 下次同 token 命中缓存后，`cached !== null` 直接返回伪 client。
- `clientAuth()` 和 `clientIdentityAuth()` 只判断 `if (!client)`，伪对象会通过。

影响：

- 无效 token 第一次请求会 401，但会写入负缓存；随后短时间内同 token 请求可能通过鉴权。
- 对 `/api/clients/policy`，可能返回空 client 的策略。
- 对 `/api/clients/ping/tasks`，如果任务是 all_clients，空 client 也可能拿到任务。
- 对 `/api/clients/ping/result`，`validatePingResults()` 对非 all_clients 应该能拦一部分，但 all_clients 任务风险仍在。
- 对 `/api/clients/report`，可能进入 DO/DB 路径，尝试以空 client 写入或更新实时状态。

建议修复：

1. 不要用伪 client 表示负缓存。改成显式 union：
   - `{ kind: 'hit', client }`
   - `{ kind: 'miss' }`
2. 或者缓存 `false`，但函数返回前必须把 `false` 转回 `null`。
3. 中间件增加强校验：`client && typeof client.uuid === 'string' && client.uuid.length > 0`。
4. 增加回归测试：同一无效 token 连续请求两次，第二次仍必须 401。
5. 修复后清理生产环境缓存无需额外操作，因为 Worker isolate 会自然替换，但代码层应支持 `invalidateAgentClientAuthCache()`。

### 管理端安全

正向观察：

- 管理 API 使用 HttpOnly session cookie。
- 非 GET/HEAD/OPTIONS 的 `/api/admin/*` 请求要求 `X-CSRF-Token` 与 cookie 匹配。
- CSRF 拒绝会写审计日志，并有限流。
- 高风险操作如删除 client、清记录、备份下载/恢复、token rotate 都要求重新输入管理员密码。
- 备份导入只接受加密备份，且需要恢复确认。

风险与建议：

- `password-reset.ts` 像是预留功能，但没有 `password_reset_tokens` 建表迁移；如果未来接入路由会直接失败。
- `generateResetToken()` 使用 `Math.random()`，不能作为密码重置 token 随机源。应改为 `crypto.getRandomValues()` 或 `crypto.randomUUID()` 加足够熵。
- `refresh-token.ts` 的 JTI 也使用 `Math.random()`，它不是直接密钥，但建议统一改为 `crypto.randomUUID()`。
- `safe image URL`、公开隐私模式、tag 过滤整体方向正确，建议给 public payload 建快照测试，确保 IP、token、内部备注永远不泄漏。

## Durable Objects / WebSocket

正向观察：

- `LiveDataDO` 把实时状态放在 DO 内，适合 WebSocket 广播和 viewer 计数。
- Agent WebSocket 有 Origin 校验、viewer token、有 rate limit DO 辅助。
- 实时链路与 D1 历史写入分离，用户体验好。

风险与建议：

- `LIVE_DATA` 和 `RATE_LIMIT` DO migrations 使用 `new_sqlite_classes`。这可能是当前 Wrangler 对 SQLite-backed DO 的正确配置，但建议用当前 Wrangler 版本执行 `wrangler deploy --dry-run` 或实际部署验证；不要仅凭静态判断。
- DO 内很多 best-effort 操作吞掉异常，适合实时系统，但需要把失败计数暴露到 admin capacity/health，避免长期静默丢历史。

## Frontend 分析

正向观察：

- `AuthContext.useApi()` 对 `/admin/` unsafe method 自动带 CSRF token。
- 登录、logout、`/me` 都使用 same-origin cookie。
- LiveDataContext 优先 WS，失败后 HTTP polling fallback，并有 viewer 过期逻辑。
- 设置页有 D1 配额估算、实际行数刷新、维护清理入口，对运维很有帮助。

风险与建议：

- `frontend/src/utils/api.ts` 是旧式 helper，不自动加 CSRF；当前只看到 `Instance.tsx` 导入 `publicFetch/normalizeListResponse`，管理页主要用 `useApi()`。建议明确命名为 `publicApi.ts` 或禁止 admin 页面导入，防止未来误用。
- D1 配额估算依赖 fallback 常量和后端 `capacity` 返回值；Cloudflare 免费/付费额度可能变化，UI 文案应明确“参考值，以 Cloudflare 当前配额为准”。
- SettingsGeneral 里估算逻辑复杂，已有前端测试但建议增加容量公式单元测试，覆盖节点数、GPU 节点、Ping 任务、无人/有人观看等组合。

## Agent 分析

正向观察：

- Agent 支持 HTTP 与 WebSocket 上报。
- WebSocket 有 reconnect backoff、heartbeat、policy 动态调整采样/上传间隔。
- Ping task 支持 server 返回 `nextPollSec`，可减少不必要拉取。
- Linux 安装脚本用 env file 保存 token，并设置 `600` 权限。

风险与建议：

- 当前环境无法编译 Go，CI 也没有 Go build/test。建议加入 `actions/setup-go`、`go test ./...`、交叉编译 smoke check。
- `validatePingTarget()` 已实现私网/loopback 解析校验，但 ICMP/TCP 执行处注释掉了调用。若 Ping 任务目标只允许管理员配置，这属于受信任远程控制；但如果管理员账号被盗或任务导入被污染，agent 会从内网主机发起探测。建议提供显式配置：默认阻止私网，或清楚标注“允许内网监控”。
- `reportInterval` 是全局变量，被 HTTP/WS policy 动态修改，同时 ping poller / report preparer / basic info goroutine 读取；Go 下可能存在 data race。建议用 `atomic.Int64` 或集中配置结构加锁。
- `globalGPUDetails` 全局读写也没有锁；若并发采集/上报，建议加锁或通过 channel 更新。
- Windows 安装脚本把 token 写入 runner PowerShell 脚本环境变量，需确认文件 ACL 仅管理员/服务用户可读。

## 测试与 CI 缺口

当前测试能证明：

- 前端部分工具函数和 UI 相关逻辑通过。
- Worker 部分设置 schema、通知 helper、审计 helper 通过。
- TypeScript 能编译。

当前测试不能证明：

- D1 migrations 能在空库、旧库、远端库上成功执行。
- Runtime bootstrap 与 migrations schema 完全一致。
- 负缓存鉴权 bug 不存在。
- D1 批量恢复在大备份下稳定。
- 历史行计数器触发器在 insert/delete/restore/cleanup 后一致。
- `cleanupOrphanClientData()` 对异常中断后的数据库能修复到一致状态。
- DO WebSocket 异步持久化不会因生命周期或异常造成不可见丢写。
- Agent Go 代码可编译、无 data race。

建议新增测试：

1. Worker 使用 `cloudflare:test` 或 Miniflare D1：
   - 空库跑 migrations。
   - 空库只跑 bootstrap。
   - 两者 schema diff。
2. D1 查询测试：
   - client CRUD。
   - 历史写入、latest 查询、Ping snapshots 查询。
   - 删除 client 后 orphan cleanup。
   - row counters verify/repair。
3. 安全回归：
   - 无效 agent token 连续两次仍 401。
   - admin unsafe request 无 CSRF 必须 403。
   - public payload 不含 token/IP/raw remark。
4. 备份恢复：
   - dry-run。
   - 小备份成功。
   - 缺失 client 引用的备份给出明确错误。
   - 大备份触发 chunk/拒绝策略。
5. CI：
   - `go test ./...`
   - agent release build smoke test。
   - `wrangler d1 migrations list/apply --local` 或等价 Miniflare 流程。

## 建议修复路线图

### 第一阶段：阻断高风险

1. 修复 agent auth 负缓存：miss 不能返回伪 client。
2. 为负缓存、`/policy`、`/ping/tasks`、`/ping/result`、`/report` 增加回归测试。
3. 文档临时标注当前部署需要手动 D1 ID，避免新用户被 README 误导。
4. 给 Go agent 加 CI 编译，至少能发现语法和依赖问题。

### 第二阶段：D1 可复现与可运维

1. 统一 D1 migration 主源，优先接入 Wrangler 原生 `d1 migrations apply`。
2. 处理根/worker 双 wrangler 配置漂移，明确 deploy button 与 CLI 两条路径。
3. 增加 schema drift test。
4. 将 D1 deploy 脚本、README、CI 调成同一套流程。

### 第三阶段：D1 大数据量安全

1. 把 `clearClientRecords()`、`clearClientsRecords()` 改为 row id 分块。
2. 备份恢复加预检和引用完整性校验。
3. `restoreBackupData()` 和 replaceAll 类函数支持 chunk 或限制上限。
4. 对历史表维护/清理暴露进度、失败次数、最后成功时间。

### 第四阶段：性能和容量优化

1. 引入 latest 状态表，减少 `GROUP BY client` 扫描。
2. 根据真实使用量决定 Ping snapshots 是否需要 task 维度辅助表。
3. 对 DO 持久化 fail-open/fail-closed 策略做产品化选择。
4. 将容量估算与 Cloudflare 当前配额配置化，避免硬编码过时。

## 不下结论、需要进一步确认的点

- `new_sqlite_classes` 是否完全匹配当前项目使用的 Wrangler/DO storage 配置，需要用实际 `wrangler deploy --dry-run` 或 Cloudflare 环境验证。
- D1 batch 精确语句数、耗时、rows read/write 限额会随 Cloudflare 计划和时间变化；本报告只指出代码结构上的越界风险，不给固定数字结论。
- Runtime bootstrap 是否在目标部署场景中是必要兜底，需要根据 deploy button 方案决定；如果一键部署必须依赖它，就要把它测试到和 migrations 一样可靠。
- Agent Ping 内网目标是否属于产品目标。如果项目定位就是内网监控，则应保留但明确风险和权限；如果定位是公网监控，则应默认启用私网/loopback 阻断。

## 附：值得保留的设计

- D1 prepared statements 使用比较充分，未见明显字符串拼接注入主路径。
- 历史表索引覆盖了大部分按 client/time 查询。
- 历史行计数器与高水位保护是控制 D1 成本的正确方向。
- 管理端 CSRF、reauth、备份加密、公开隐私模式等安全意识较强。
- WebSocket 实时优先、HTTP fallback、agent policy 动态采样是合理架构。
- 维护清理、容量估算和实际行数刷新已经给后续运维加强打了基础。
