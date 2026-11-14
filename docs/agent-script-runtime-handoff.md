# Issue #30 接手说明：Agent 远程脚本运行时

> 状态快照：2026-11-14（Asia/Shanghai）
>
> 本文用于把 Issue #30 的后续工作交给其他开发者。它记录当前 PR 栈、已完成内容、CI 状态、剩余风险和接手顺序。PR 尚未合并，不能把分支上的实现当成线上已生效功能。

## 1. 目标与范围

总任务：[Issue #30](https://github.com/jiangood/jt_workbench/issues/30)

把原先编译进 Agent 镜像的业务 handler，逐步迁移到永久单 Agent 的远程 JavaScript 运行架构：

- Agent 同步可信发布的脚本，校验 SHA-256 和 metadata，原子更新缓存；脚本更新后必须二次对账。
- Agent 本地按 `Asia/Shanghai` 六字段 Cron 调度。
- Worker/D1 是执行许可、execution、租约、重试和结果状态的权威。
- `best_effort` 任务允许错过触发、不做持续重试；`reliable` 任务需要持久化恢复、同一 execution 重试、业务游标和断点续跑。
- 第一版永久单 Agent，不做多 Agent 选举/自动接管；不做沙箱；不运行时安装 npm 依赖。
- 所有脚本都是可信代码，在 Agent Node.js 进程内执行，具有宿主进程权限。SHA-256 只校验内容一致性，不是安全边界。

## 2. 当前 GitHub 状态

截至本文快照，PR #31–#40 **全部 Open，全部未合并**。这些 PR 是一条串联依赖链，不是十个可以任意顺序合并的独立 PR。

| 顺序 | PR | 内容 | Head 分支 | Base 分支 |
|---:|---|---|---|---|
| 1 | [#31](https://github.com/jiangood/jt_workbench/pull/31) | 架构、AGENTS、README 文档 | `feat/agent-reliability-aware-runtime` | `main` |
| 2 | [#32](https://github.com/jiangood/jt_workbench/pull/32) | Node 22 动态 ESM、镜像生产依赖验证 | `feat/agent-runtime-dependency-validation-v2` | #31 分支 |
| 3 | [#33](https://github.com/jiangood/jt_workbench/pull/33) | Worker 静态脚本 manifest/content 发布协议 | `feat/agent-script-sync-protocol` | #32 分支 |
| 4 | [#34](https://github.com/jiangood/jt_workbench/pull/34) | Agent 脚本同步、hash 校验、原子缓存更新 | `feat/agent-local-script-sync` | #33 分支 |
| 5 | [#35](https://github.com/jiangood/jt_workbench/pull/35) | 动态脚本执行 runtime/context | `feat/agent-dynamic-script-runtime` | #34 分支 |
| 6 | [#36](https://github.com/jiangood/jt_workbench/pull/36) | Agent 本地 Asia/Shanghai Cron scheduler | `feat/agent-local-cron-scheduler` | #35 分支 |
| 7 | [#37](https://github.com/jiangood/jt_workbench/pull/37) | Worker/D1 execution、owner、lease、恢复协调 | `feat/agent-worker-execution-coordinator` | #36 分支 |
| 8 | [#38](https://github.com/jiangood/jt_workbench/pull/38) | Agent 主循环接入同步、调度、执行和回传 | `feat/agent-runtime-main-loop` | #37 分支 |
| 9 | [#39](https://github.com/jiangood/jt_workbench/pull/39) | RSS（best_effort）和知识星球（reliable）迁移 | `feat/agent-rss-remote-script` | #38 分支 |
| 10 | [#40](https://github.com/jiangood/jt_workbench/pull/40) | 股票日线收盘任务迁移 | `feat/agent-stock-remote-script` | #39 分支 |

### CI 快照

- PR #32–#40 当前 head SHA 对应的最近一次 `ci` workflow 均为 **completed / success**；PR #39、#40 的 Agent 和 Worker 两个 job 均成功。
- PR #31 只改文档，当前 CI workflow 的 paths filter 不包含纯 docs 变更，因此没有 CI run；这不代表它经过了自动化测试。
- 早期提交曾出现过失败的 CI run，后续 head 提交有新的成功 run。检查时应以 PR 当前 head SHA 对应的最新 run 为准，不要把旧失败误认为当前失败，也不要忽略它。
- 以上是 CI 结果，不等于完成代码审查、业务验收或线上验证。

### 合并顺序注意

1. 先审查 #31，再按 #32 → #40 的顺序逐个处理。
2. 当前每个 PR 的 base 都是前一个 PR 的分支。前序 PR 合并后，应检查后续 PR 的 diff 是否只包含自身变更；必要时把后续 PR 的 base 调整到 `main`，或按团队采用的 stacked-PR 流程更新分支。
3. 不要直接把 #40 合并到 main，也不要把整条 PR 栈 squash 成一个未经审查的大提交。
4. 每次合并后都检查 CI 和 auto-tag/release workflow。只有 PR 合并到 main 才会触发自动 tag 和线上发布。
5. 本文对应的 PR #41 是独立文档 PR，不属于 Issue #30 的功能依赖链。

## 3. 已完成的实现（仍待 PR 合并）

### 基础运行时

- Worker 侧版本化脚本发布目录：`worker/agent-scripts/<id>/<version>.mjs`。
- Worker 构建脚本生成静态 Assets manifest 和版本化脚本内容。
- `POST /node/agent/next` 承担脚本清单对账、更新/删除、二次确认、触发申请、执行许可/续租和结果协调。
- Agent 侧有脚本同步、SHA-256/metadata 校验、受控缓存目录、临时文件 + rename 原子更新、动态 ESM import。
- Agent 本地 Cron、统一执行 context、超时/取消信号、单脚本互斥和主循环已经分 PR 实现。
- Worker/D1 增加 Agent owner、execution、schedule checkpoint、lease 和恢复状态相关迁移。
- owner Agent 仍可处理尚未迁移的 legacy job；manifest 中已迁移的任务类型应从 legacy 队列排除，避免双重执行。
- Agent 镜像预装依赖；远程脚本不运行时 npm install。共享 helper 通过版本化 bundle 路径引用，避免镜像升级改变历史 execution 的 helper 语义。

### 已迁移的业务脚本

| Script ID | 可靠性 | 当前行为 | PR |
|---|---|---|---|
| `rss_fetch` | `best_effort` | 每 2 小时抓取启用的 RSS 源；单个源失败不影响其他源；稳定 external ID；有单源和总结果上限 | #39 |
| `zsxq_sync` | `reliable` | 每 3 小时运行；复用版本化 Zsxq helper；承接原 backfill/comments/probe/groups 子任务 | #39 |
| `stock_eod` | `best_effort` | 工作日 15:35 从启用的自选股生成日线收盘同步；复用版本化股票 helper | #40 |

未迁移的 `tts_synthesize` 等仍由 owner Agent 的 legacy runner 处理。不要因为存在远程脚本架构，就擅自删除这些 legacy handler 或 Worker 内部基础设施 tick。

## 4. 接手后优先做的事

### P0：先把现有 PR 栈审查清楚

- [ ] 逐个审查 #31–#40 的完整 diff、review thread 和 CI；尤其确认 stacked PR 的 base/head 关系及每个 PR 是否只包含预期改动。
- [ ] 检查 #37 的 D1 migration（`0035_agent_execution_runtime.sql`）和 #38 的 migration（`0036_agent_owner_legacy_filter.sql`）：唯一约束、状态转换、租约过期、owner claim、回滚/兼容窗口是否正确。
- [ ] 检查 Worker 先升级、Agent 后升级，以及旧 Agent 先运行的混合版本场景。不能假设 Worker 与 Agent 同时部署。
- [ ] 检查 legacy job filter：已迁移的 RSS/Zsxq/Stock 不能再由 legacy runner 执行；未迁移任务必须仍可正常执行。
- [ ] 检查脚本 manifest 的启用版本选择、旧版本保留、撤销语义和静态 Assets 缓存策略。
- [ ] 对 #39/#40 做业务 diff 审查，不能仅凭 CI 通过就认为数据正确。

### P1：补齐可靠性和故障恢复验收

- [ ] 对 `reliable` Zsxq 做故障注入：分页中途崩溃、数据写入后回传前崩溃、Worker 短暂不可用、lease 过期、Agent 重启、重复触发。
- [ ] 证明数据先持久化、游标后推进；同一页重复处理不会产生重复业务数据或跳过数据。
- [ ] 证明重试沿用同一 `execution_id` 和创建时固定的脚本版本/hash。
- [ ] 检查执行状态 `pending/running/succeeded/failed/interrupted/expired/needs_attention` 的转换是否完整，未知副作用不能误判成功。
- [ ] ADR 已说明重试策略为 5 分钟起始、指数退避、最长 6 小时、最多 8 次；达到阈值保留 `needs_attention`。**告警通知仍未补齐**，需要实现告警或明确单独的后续任务，不能把状态保留当作已经告警。
- [ ] 测试 reliable 启动 catch-up 合并为一次 reconcile，而不是逐槽重放；Worker 不可用时不能绕过许可离线执行。
- [ ] 验证 `best_effort` 错过时间槽/Worker 不可用/执行失败均按预期丢弃，不会形成隐式补跑队列。

### P2：业务迁移与兼容收尾

- [ ] 检查 RSS 单源失败、全部失败、超大响应、超量 item、重复抓取和 D1 分批写入。
- [ ] 检查 Zsxq payload 是否正确包含启用的星球、token、游标和待回填目标；验证旧的四类任务确实由一个远程脚本承接。
- [ ] 检查股票脚本的交易日语义。当前 Cron 是周一至周五 15:35，并不天然排除 A 股法定节假日；确认 helper 对非交易日/无行情日的行为是否安全，必要时使用交易日历或幂等 no-op。
- [ ] 盘点所有剩余 legacy job type。当前文档明确 TTS 尚未迁移；先决定它是否属于 Issue #30 本轮范围，再单独迁移，不要扩大当前 PR。
- [ ] 确认所有 Worker 内部 tick（邮件扫描、清理等）仍在运行；它们不是业务 Cron，不能误删。
- [ ] 完成 Worker local D1 migrations、Agent/Worker typecheck、测试、镜像构建和端到端协议测试。

## 5. 建议验证命令

在仓库根目录执行；Agent 和 Worker 是两套独立依赖树：

```bash
cd agent
npm ci
npm run check
npm test
npm run build

cd ../worker
npm ci
npm run scripts:build
npx wrangler d1 migrations apply jt_workbench --local --persist-to /tmp/jt-workbench-d1
npm run check
```

CI 定义见 `.github/workflows/ci.yml`。本地 D1 迁移必须使用 `--local`，不要连接生产数据库。

## 6. 开发和发布红线

- 开始任何新工作前，重新读取当前目标分支上的 `AGENTS.md`、`README.md`、`docs/architecture/agent-script-runtime.md`，以及将修改到的代码/迁移/测试。
- 当前 `main` 上的 ADR 仍是旧的“编译期静态脚本”方案；新架构文档在 PR #31 分支上。PR #31 合并前，阅读文档时要明确区分 main 现状和 PR 栈目标设计。
- 功能和文档修改均从分支开发并通过 PR；不要直接在 main 上提交。
- 禁止直接写生产环境：不运行线上 `wrangler deploy`、`wrangler d1 execute --remote`、`migrations apply --remote`、生产 API 写请求或手工回滚。
- PR 合并到 main 后由 `.github/workflows/auto-tag.yml` 自动递增 patch tag，再触发 `.github/workflows/release.yml`。合并后必须检查 CI、auto-tag 和 release 的最终结果。
- 绝不在 Agent 进程中执行远程任务 payload 提供的代码；只允许 Worker 发布链路中的可信脚本。
- 不做沙箱承诺。远程脚本拥有 Agent 进程权限，发布审查是当前信任边界。
- 不要在未审查兼容性前删除 legacy handler、基础设施 tick 或旧协议路径。

## 7. 当前明确未完成 / 不应误报为完成

1. PR #31–#40 都尚未合并，线上没有因为这些 PR 自动更新。
2. #31 没有 CI run；#32–#40 当前 head 的 CI 为绿色，但业务正确性和故障恢复还需要审查。
3. Zsxq 的告警通知仍未完成。
4. TTS 等未迁移任务仍在 legacy runner。
5. 股票 Cron 当前按工作日而不是交易日运行，需确认节假日行为。
6. Issue #30 的验收标准需要结合故障注入、兼容升级和真实业务回归进一步验证，不能只以构建成功为准。

## 8. 推荐接手入口

1. 从 [Issue #30](https://github.com/jiangood/jt_workbench/issues/30) 阅读需求和可靠性约定。
2. 从 [PR #31](https://github.com/jiangood/jt_workbench/pull/31) 的 head 分支读取新版架构文档和开发约定。
3. 先审查 PR #31，再按 #32 → #40 逐个审查、合并或要求修改。
4. 先处理 P0，再做 P1 故障注入，最后决定 P2 的 TTS/交易日历/迁移收尾。
5. 不要在未完成上述验证前关闭 Issue #30。
