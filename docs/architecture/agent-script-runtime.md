# ADR: Agent Remote JavaScript Runtime and Reliability-aware Scheduler

- 状态：Accepted（架构决策已确认；按阶段实施）
- 日期：2026-11-14
- 关联：Issue #30
- 范围：Agent 运行时、Worker 节点协议、脚本发布与执行记录；涉及 `worker/core/node.ts`、`worker/core/ingest.ts` 和 D1 schema 的迁移边界

## 背景

现有 Agent 将业务 handler 编译进镜像，Worker 侧维护任务调度和领取流程。目标架构改为：业务任务以独立原生 JavaScript 脚本发布，脚本自己声明名称、元数据和 Cron；永久单 Agent 在本地调度并执行。不同业务的漏执行成本不同，新闻 RSS 可以尽力执行，而知识星球同步需要失败恢复、游标和数据完整性保障。

本 ADR 取代此前“编译期静态 manifest/业务脚本随 Agent 镜像发布”的方案。脚本从服务端下载并动态执行，不再把业务脚本编译进 Agent 镜像。

## 决策摘要

1. **永久单 Agent**：正式环境只有一个 Agent。第一版不实现多 Agent 竞争、节点分组、备用节点接管或调度选举；Agent 故障由人工恢复。
2. **远程原生 JavaScript**：Worker 管理已发布脚本清单和内容；Agent 下载、校验、缓存并动态执行 JavaScript。
3. **不做沙箱**：第一版在 Agent 的 Node.js 进程内执行脚本，脚本拥有宿主进程权限。只接受可信发布链路中的代码，禁止任务 payload 携带代码。
4. **Agent 本地 Cron**：脚本头部 JSON metadata 声明 schedule；Agent 使用固定 `Asia/Shanghai` 时区和 6 字段 Cron。
5. **可靠性分级**：第一版只实现 `best_effort` 和 `reliable` 两档。调度器负责触发和执行生命周期，业务脚本负责幂等、游标、断点续跑和数据完整性。
6. **Worker/D1 是执行权威**：Worker 授予执行许可并持久化 execution、租约、重试状态和结果；Agent 内存不作为恢复依据。
7. **至少一次而非 exactly-once**：同一逻辑执行重试沿用 execution ID 和固定脚本版本；业务脚本必须幂等。

## 目标职责边界

| 组件 | 职责 |
|---|---|
| 脚本 | 声明 metadata；执行业务抓取/解析/同步；实现幂等、业务游标和数据完整性检查 |
| Agent | 脚本对账与下载、hash 校验、原子缓存、metadata 解析、Cron、单脚本互斥、超时、执行和结果回传 |
| Worker | 脚本发布清单/内容访问控制、节点认证、执行许可、execution 唯一性、租约、重试/恢复状态和结果接收 |
| D1 | 脚本发布元数据、执行记录、租约/重试信息，以及由业务 ingest 管理的同步游标 |
| Worker Static Assets | 保存版本化脚本内容和生成的 manifest；源码由 PR 审查后随 Worker release 发布 |

Worker 不负责计算业务脚本 Cron。Worker 内部用于邮件扫描、过期数据清理等基础设施 tick 不属于业务脚本调度，不因本 ADR 自动移除。

## 脚本 metadata

脚本源码头部使用 JSON 注释声明元数据，例如：

```javascript
// @script
// {
//   "id": "rss",
//   "name": "RSS 新闻抓取",
//   "version": "1.0.0",
//   "description": "定期抓取启用的 RSS 订阅源",
//   "schedule": "0 */30 * * * *",
//   "enabled": true,
//   "timeout": 300,
//   "reliability": "best_effort"
// }
```

第一版字段：

- `id`：稳定、唯一的脚本 ID。
- `name`、`description`：展示和维护信息。
- `version`：脚本发布版本。
- `schedule`：6 字段 Cron（秒、分、时、日、月、星期）。
- `enabled`：是否参与调度。
- `timeout`：单次执行超时秒数。
- `reliability`：`best_effort` 或 `reliable`。

时区固定为 `Asia/Shanghai`，不在每个脚本重复声明。并发限制、基础重试策略和节点选择不做逐脚本配置。第一版不支持秒级高频任务，必须定义并验证最小调度间隔。业务参数放在 Worker 配置/context，不放进 metadata。

metadata 必须严格解析和校验：未知等级、无效 Cron、重复 ID、非法 timeout、缺失必需字段均不得注册执行。脚本内容与 manifest 中的 SHA-256 必须绑定。

## 脚本同步与节点接口

只使用一个节点动作接口：

`POST /node/agent/next`

第一版脚本发布采用 Worker 静态 Assets，不单独引入 R2 脚本桶或运行时数据库脚本编辑器：

- 可信脚本源码放在 `worker/agent-scripts/<id>/<version>.mjs`，每个文件头部声明 JSON metadata。
- `worker/scripts/build-agent-scripts.mjs` 在 Worker dev、CI 和 release 前校验 metadata/Cron，计算源码 SHA-256，并生成 `worker/public/agent-scripts/manifest.json` 与不可变的 `<id>/<version>.mjs` 静态资源。
- Worker 通过 `ASSETS` binding 读取 manifest 和脚本内容；`POST /node/agent/next` 在节点鉴权后对账本地清单，最多返回 5 个更新脚本和 20 个撤销版本。响应中的源码 hash 会在 Worker 侧再次核对。
- 静态脚本资源本身可被公开读取，因此脚本中严禁包含凭据；可信边界是 PR 审查和 release 权限，而不是 URL 隐藏。节点动作 API 仍要求节点密钥。
- D1 不保存发布脚本源码；后续 D1 迁移只保存执行实例、租约和恢复状态。版本化静态资源保留旧版本，以支持执行实例固定版本。

Agent 请求包含 Agent 版本、本地脚本清单（id/version/sha256），并可携带 runtimeReady、Cron 触发、运行中租约心跳或执行结果报告。Worker 响应动作：

- sync：返回需要下载/更新的脚本清单及撤销删除清单；此时不授予新执行。
- execute：脚本对账完成后，授权一个执行实例及其固定脚本版本/hash。
- running：确认当前执行租约仍有效。
- idle：当前没有同步或执行动作。

协议流程：

1. Agent 上报本地脚本清单；Worker 对比权威发布清单。对账不一致时只返回同步动作，不处理新的触发、不授予执行。
2. Agent 下载脚本到临时文件，校验 SHA-256、metadata 和目标路径；校验成功后原子 rename 替换。删除清单只删除受控缓存目录中的脚本。
3. Agent 再次请求同一接口并上报新清单；Worker 二次对账确认完全一致后，才处理触发申请。
4. Agent 发送 Cron/startup/catch-up 触发，Worker 校验当前发布 metadata 和 schedule revision，在 D1 创建唯一 execution。只有 Worker 发放 execution lease 后 Agent 才能执行。
5. 执行期间 Agent 使用 execution ID + lease token 心跳；结束后用稳定 report ID 回传结果。Worker 通过现有 ingest 写入数据，再将 execution 标记为成功/失败。

Agent 缓存目录默认为工作目录下的 .agent-scripts/<id>/<version>.mjs（容器中为 /app/.agent-scripts/）。Agent 在每轮领取/执行新任务前完成同步；执行中的任务只续租，不在运行期间切换脚本版本。

脚本缓存路径必须防止路径穿越；禁止由 metadata 的路径字段决定任意文件位置。任务 payload 永远是数据，不得携带 JavaScript、动态 import 地址、表达式或其他可执行内容。节点认证、结果回传和现有 API envelope 尽量复用。

升级兼容必须在实现前设计：Worker 新接口发布不能让旧 Agent 失联。应通过兼容窗口/版本门控/双协议过渡完成滚动升级；不可假设 Agent 镜像与 Worker 同时更新。

## 执行与调度语义

- Agent 启动后先完成脚本同步和校验，再计算 reliable 启动 catch-up，最后启动未来 Cron 定时器。
- 时间基准固定 Asia/Shanghai；六字段 Cron，最小间隔 60 秒。超过 60 秒宽限期的迟到 best_effort 触发丢弃；迟到 reliable 触发合并成一次 catch-up。
- schedule_revision = SHA256(schedule + NUL + enabled) 的前 32 位十六进制；不包含脚本版本/hash。调度定义变化才产生新 revision。
- 每个逻辑 execution 的唯一键为 script_id + schedule_revision + scheduled_at。Worker 在 agent_script_state 持久化 last_scheduled_at；启动 catch-up 使用第一个错过槽作为稳定键，同时把检查点推进到 catch-up 的时间上界，因此不会逐槽回放。
- Cron 触发是执行申请，不等于执行许可。只有 Worker 创建/恢复 D1 execution 并发放 lease 后 Agent 才能运行脚本。
- Worker 一次只发放一个 execution lease；同一脚本已有 pending/running/interrupted/needs_attention 实例时，不再创建并行实例。普通触发不排队；不同脚本的待执行实例由 Worker 顺序发放。
- 重试沿用原 execution_id、原脚本版本/hash 和原始计划时间；新时间槽才创建新 execution。
- Agent 执行期间定期续租。Agent 进程重启后，Worker 将遗留的 reliable running execution 标记为 interrupted 并用同一 ID/版本恢复；遗留 best_effort execution 标记 expired，不重试。
- execution 状态：pending/running/succeeded/failed/interrupted/expired/needs_attention。副作用发生后、成功回传前崩溃时，结果视为未知；依靠可靠任务幂等和同一 execution 重试恢复。
- Worker 不可用时 Agent 不离线执行；best_effort 本次触发丢弃，reliable 触发在 Agent 存活期间退避重试，重启后由 D1 checkpoint 重建 catch-up。
- Worker 内部 tick（提醒扫描/清理）独立于业务脚本 Cron，切换 Agent 协议后仍必须运行。
- runtimeReady=true 的 Agent 在脚本同步成功后原子 claim 永久 owner；D1 只允许一个 owner，之后旧 /node/poll 返回 426。没有自动接管或选举；人工恢复需先停止旧 Agent，再显式清理 owner 记录。
- Worker owner claim 之前旧 Agent 协议仍可用；新 Agent 完成同步后才 claim，避免首次同步失败时永久锁定旧协议。

## 可靠性等级

### best_effort

用于新闻 RSS 等允许漏采、后续正常轮次可覆盖的任务。

- 错过 Cron 时间槽直接丢弃；Agent 重启不补跑。
- 单次执行失败记录错误，不要求通用持续重试；下一次正常 Cron 再执行。
- Worker 不可用或未授予许可时，本次触发丢弃，不离线执行、不排队。
- 不保证历史数据完整覆盖；业务写入仍应使用稳定 ID 去重，避免重复数据。

### reliable

用于知识星球内容同步等漏数据成本较高的任务。

- 不逐个回放错过的 Cron 时间槽。Agent 启动时为 reliable 脚本提交一次合并的 reconcile/catch-up 申请；同脚本已有未完成 execution 时恢复该实例，避免创建并行同步。
- Cron 负责定期启动同步检查；业务游标决定数据从哪里继续。多个错过时间槽合并为一次补偿同步，而不是连续执行 N 次历史 Cron。
- Worker/D1 持久化未完成 execution 和恢复状态；Agent 重启后可以重新取得许可并恢复，不能依赖内存队列。
- 失败按退避策略自动重试；重试沿用同一 execution ID 和脚本版本。当前 Worker 策略为 5 分钟起始、指数退避、最长 6 小时、最多 8 次；达到阈值后保留 needs_attention 状态。告警通知仍需补齐，不能把状态保留等同于已告警。
- Worker 不可用时不执行脚本；reliable 恢复意图必须由持久化状态表达，Worker 恢复后继续协调。
- 脚本必须实现幂等、稳定业务 ID 去重、分页/分批处理和断点续跑。
- 同步游标只在对应数据已可靠持久化后推进；游标语义由业务脚本和 Worker ingest/存储契约共同定义。
- 可靠性不等于 exactly-once。外部副作用与执行记录无法跨系统原子提交时，仍可能重试，必须由业务幂等保护。

第一版不实现 `strict` 等级，也不构建通用工作流引擎。

## 知识星球类 reliable 脚本要求

知识星球脚本需要以业务游标而非 Cron 时间槽作为恢复依据，例如上次成功持久化的帖子 ID/时间戳。至少保证：

1. 从持久化游标开始分页读取。
2. 使用帖子/评论等稳定业务 ID 幂等写入。
3. 每页数据持久化成功后再推进对应游标。
4. 中断后从已确认的游标继续；允许重复拉取，但不能跳过未持久化数据。
5. 能处理分页边界、排序变化、删除/编辑等源端行为；必要时提供周期性历史完整性扫描。
6. 对无法自动恢复的连续失败、游标异常和数据缺口保留可观测状态并告警。

Agent 不理解知识星球业务语义；通用运行时只提供 execution lifecycle 和 context，具体游标/回填逻辑留在业务脚本及其 ingest 契约。

## 脚本执行 context 与安全边界

远程模块必须导出 `async function run(ctx, payload)`，返回 `{ items: unknown[], summary: string }`。Agent 通过缓存文件的 `file:` URL 动态 import，模块可按正常 Node ESM 规则解析镜像内预装依赖。第一版结果限制为最多 10000 条 item、summary 最多 2000 字符；后续 Worker 结果回传负责分批。

context 字段：`logger`、`config`、`fetch`、`signal`、`executionId`、`scriptId`、`scriptVersion`、`scheduledAt`。其中 `fetch` 由 Agent 注入 SSRF 守卫和 30 秒网络超时；脚本必须将 `signal` 传给长请求并在循环中检查取消。

**超时边界**：第一版在同一个 Node.js 进程内运行，不使用 Worker Thread/子进程沙箱。metadata 的 timeout 会触发 AbortSignal，Agent 等待脚本响应取消后将执行判为超时；这是协作式超时，不是硬 CPU 隔离。脚本若忽略 signal 或陷入同步死循环，Node 事件循环无法及时中断它。不要把 timeout 描述成能强制终止任意脚本。

第一版 context 不传入 NODE_KEY，但同进程脚本仍可访问 `process.env`、文件系统、网络和子进程；因此唯一安全边界仍是可信 PR + release 发布链路。

运行时提供稳定的 context，建议包含：

- `logger`：结构化日志。
- `config`：当前脚本所需业务配置。
- `fetch`：带超时、取消和 SSRF 防护的 HTTP 能力。
- `signal`：本次执行的 AbortSignal。
- `executionId`、`scriptId`、`scriptVersion`、`scheduledAt`：执行身份和追踪元数据。

第一版脚本与 Agent 在同一 Node.js 进程中执行，因此脚本仍可能直接访问 `process`、文件系统、网络、子进程和环境变量。context 限制只是 API 约定，不是安全隔离。必须限制脚本发布权限、经 PR 审查并由受信任流水线发布。SHA-256 仅用于内容一致性校验，不证明来源可信。严禁记录或输出 NODE_KEY、第三方密钥和敏感配置。

## 版本、依赖与发布

- 脚本内容按不可变版本发布；清单的 hash 与实际字节绑定。
- 已创建 execution 固定引用脚本版本/hash；脚本升级只影响之后创建的 execution。
- Agent 镜像包含 Node 运行时及预装依赖，不包含业务脚本的静态副本。
- 禁止运行时 npm install。必须用技术验证确认远程 ES Module 能解析镜像预装依赖；必要时设计受控的 module resolution/import strategy。
- 脚本源码发布走 GitHub PR、CI 和受信任发布链路；Worker Static Assets 提供 manifest 和版本化脚本内容，D1 只保存执行状态、检查点和租约。
- Worker 与 Agent 的升级需有兼容窗口；不能依赖 Watchtower 与 Worker 同时更新。
- D1 迁移遵循 expand/contract；新旧 Agent/Worker 协议过渡必须可回滚。

## 分阶段实施

### PR 1：架构与协议文档
- [x] 用本 ADR 替换旧静态 manifest ADR。
- [x] 同步 AGENTS.md 与 README.md，明确目标架构、可信代码风险和分级可靠性。
- [x] 定义接口协议、metadata schema、执行状态机和兼容升级策略。

### PR 2：运行时技术验证
- [x] 验证 Node 22 动态加载远程/缓存 ES Module：缓存为 `.mjs` 文件后通过 `file:` URL 动态 import。
- [x] 验证模块如何解析镜像预装依赖，不引入运行时 npm install：脚本缓存放在 `/app/.agent-scripts/`，依赖放在 `/app/node_modules/`，Node ESM 按父目录查找依赖；镜像单独复制 `npm ci --omit=dev` 的生产依赖。
- [x] 验证本地缓存原子替换、撤销、SHA-256/metadata 校验和失败不覆盖；动态运行时支持 AbortSignal 协作式超时。
- [x] 在 Node 22 CI 中运行动态导入依赖和缓存同步测试。

### PR 3：脚本发布与同步协议
- [x] Worker 侧版本化脚本 manifest/content 管理（静态 Assets，保留历史版本）。
- [x] 实现 `POST /node/agent/next` 的脚本对账、更新和二次校验响应。
- [x] Agent 实现本地清单、SHA-256 校验、原子更新和安全撤销。

### PR 4：动态执行运行时
- [x] metadata parser/validator、统一 context、动态加载和执行结果结构校验。
- [ ] 单脚本互斥、Worker 授权执行、结果回传、执行版本固定和日志追踪（等待 execution coordinator）。
- [x] 缓存脚本按版本路径保存，执行前再次校验确定 hash。

### PR 5：调度和 Worker 执行状态
- [x] Agent 本地 `Asia/Shanghai` Cron 计算器、60 秒最小间隔、触发宽限期和 best_effort 迟到丢弃（scheduler 模块已实现，待接入 Worker）。
- [x] reliable 启动 catch-up 只生成一个合并 reconcile 触发请求（Worker 持久化检查点和重试待实现）。
- [ ] D1 execution 状态、唯一性、单 Agent 所有权、租约、interrupted/unknown 处理。
- [ ] 结果回传幂等与同一 execution ID 重试。

## 验收标准

- Agent 每次请求下一步动作前上报脚本清单；脚本更新后完成二次对账；校验通过前不执行。
- 下载/hash/metadata 失败不覆盖当前可用脚本、不授予执行许可。
- Worker 与 Agent 升级存在兼容窗口，旧 Agent 不会因 Worker 先发布新接口而失联。
- Agent 重启不补跑 best_effort 错过的时间槽；reliable 只进行合并恢复，不机械回放所有 Cron。
- 同一脚本不并发；每个时间槽至多一个逻辑 execution；重试沿用 execution ID 和脚本版本。
- Worker 不可用时 Agent 不离线执行；reliable 恢复意图可持久化等待恢复。
- RSS 采用 best_effort；知识星球采用 reliable，并通过故障注入证明游标推进安全、分页可续跑、重复写入幂等。
- 动态脚本能使用镜像预装依赖，不需要运行时 npm install。
- 脚本权限和 SHA-256 的安全边界有明确文档；没有把同进程 context 误称为沙箱。
- Agent 类型检查、构建、测试通过；Worker 迁移测试通过。
- PR 合并后检查 CI 和发布工作流；禁止直接操作生产环境。

## 非目标（第一版）

- 多 Agent 竞争、备用 Agent 自动接管和调度选举。
- 不可信第三方脚本沙箱、多租户代码隔离。
- 运行时 npm install。
- 每个错过 Cron 时间槽逐个补跑的工作流引擎。
- strict 可靠性等级。
- 通用插件市场或复杂脚本路由系统。
