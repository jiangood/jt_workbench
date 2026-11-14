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

Agent 请求至少包含 Agent 版本、本地脚本清单（`id/version/sha256`），以及可选的待申请触发信息。Worker 响应动作状态：

- `sync`：返回需要下载/更新的脚本清单及撤销删除清单。
- `task` / 执行许可：脚本对账通过后，授权一个执行实例及其固定脚本版本。
- `idle`：当前没有同步或执行动作。

协议流程：

1. Agent 上报本地脚本清单。
2. Worker 对比权威发布清单；若有差异，只返回同步动作，不授予执行许可。
3. Agent 下载脚本到临时文件，校验 SHA-256、metadata 和目标路径；校验成功后原子 rename 替换。删除清单只删除受控缓存目录中的脚本。
4. Agent 再次请求同一接口并上报新清单。
5. Worker 二次对账确认完全一致后，才可处理触发申请/发放执行许可。

Agent 缓存目录默认为工作目录下的 `.agent-scripts/<id>/<version>.mjs`（容器中为 `/app/.agent-scripts/`）。Agent 先验证源码 SHA-256、metadata 与 Worker 返回的描述符一致，再写同目录临时文件并原子 rename；撤销操作只接受经过 id/version 白名单校验的缓存路径。Agent 在每轮旧任务 poll 之前先完成同步，Worker 不可用或同步未收敛时不会进入旧任务领取流程。
6. 若再次不一致则继续同步；下载失败、hash 不匹配或 metadata 无效时不覆盖现有可用版本、不执行任务，并按退避策略重试。

脚本缓存路径必须防止路径穿越；禁止由 metadata 的路径字段决定任意文件位置。任务 payload 永远是数据，不得携带 JavaScript、动态 import 地址、表达式或其他可执行内容。节点认证、结果回传和现有 API envelope 尽量复用。

升级兼容必须在实现前设计：Worker 新接口发布不能让旧 Agent 失联。应通过兼容窗口/版本门控/双协议过渡完成滚动升级；不可假设 Agent 镜像与 Worker 同时更新。

## 执行与调度语义

- Agent 启动后先完成脚本同步和校验，再解析 metadata 并注册 Cron。
- 时间基准固定 `Asia/Shanghai`；Agent 重启后不回放 `best_effort` 停机期间错过的时间槽，只计算未来触发。
- Cron 触发是一次执行申请，不等于执行许可。只有 Worker 授权后 Agent 才能运行脚本。
- Worker 不可用时 Agent 不绕过 Worker 离线执行。
- 同一脚本最多一个并发执行。普通 Cron 触发时若该脚本仍在执行，跳过本次触发，不排队。
- 每个 Cron 时间槽最多一个逻辑 execution，建议唯一键为 `script_id + schedule_revision + scheduled_at`。
- `schedule_revision` 只在调度定义（schedule/enabled 或其语义）改变时变化，不使用整个脚本 hash；仅修改业务代码不应改变时间槽身份。
- 重试沿用原 `execution_id`、原脚本版本和原始计划时间；新时间槽才创建新 execution。
- 迟到触发需有明确宽限期，超过宽限期的普通触发丢弃；宽限期在实现阶段定值并测试，不能因事件循环阻塞而无限执行陈旧任务。
- 执行记录至少区分 pending/running/succeeded/failed/interrupted(or unknown)/expired。Agent 在副作用发生后、成功回传前崩溃时，结果属于未知，不能伪装成确定失败或成功。
- 对取消/超时，Agent 尽力传递 AbortSignal；但不能假定脚本或外部服务一定能及时停止。

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
- 失败按退避策略自动重试；重试沿用同一 execution ID 和脚本版本。达到阈值后保留待人工处理状态并告警，不能静默丢弃。
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
- 脚本源码发布仍走 GitHub PR、CI 和受信任发布链路；服务端脚本内容存储的具体实现（R2 对象 key、版本索引和访问 URL）在实现阶段确定。
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
