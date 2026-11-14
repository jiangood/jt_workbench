# ADR: Agent Script Runtime（编译期业务脚本架构）

- 状态：Accepted（架构方向已确认；分阶段实施）
- 日期：2026-11-14
- 范围：`agent/` 为主；涉及 `worker/core/node.ts`、`worker/core/ingest.ts` 的兼容边界
- 决策：业务脚本在 GitHub 中独立组织和维护，构建时静态编译进 Agent 镜像，随现有发布流程部署

## 背景

当前 Agent 已具备 handler 注册表和统一 runner：任务通过 `type` 查找本地 handler，执行结果通过现有节点协议回传 Worker。但业务 handler 仍由 Agent 入口静态导入，业务代码与执行框架在目录和职责上尚未形成清晰边界。

仓库约定明确 Agent 是“哑执行器”：任务是数据不是代码；`type` 只是查表键；不执行网络下发代码、不动态安装依赖。该约定继续有效。

## 决策

采用 **Build-time Script Plugin Architecture（编译期脚本插件架构）**：

1. Agent Core 只负责任务接收、handler 路由、执行生命周期、心跳/租约协作、取消/超时、结果回传和通用日志。
2. 具体业务逻辑放在独立的业务脚本包中，例如 RSS、股票、知识星球、TTS。
3. 每个脚本包可导出一个或多个 task handler；脚本包与任务 `type` 不要求一对一。
4. 脚本源码只在 GitHub 仓库管理，通过 PR、CI 和现有 tag/release 流程发布。
5. 构建时生成或维护静态 manifest，并由 esbuild 编译进现有 Agent 单文件镜像。Agent 启动时注册 manifest 中的 handler。
6. 不引入运行时脚本下载、`eval`、动态代码执行、R2 脚本仓库、Dynamic Workers、运行时 npm 安装或独立脚本服务。
7. 保持现有 Worker-Agent 任务协议和结果回传协议兼容；本 ADR 不要求同时重写 Worker 的 ingest 数据映射。

## 目标目录（建议态）

```text
agent/src/
  core/
    runner.ts
    client.ts
    context.ts
    logger.ts
  scripts/
    manifest.ts             # 编译期静态注册表（后续可由构建工具生成）
    rss/
      index.ts
      ...
    stock/
      index.ts
      ...
    zsxq/
      index.ts
      ...
    tts/
      index.ts
      ...
  shared/
    types.ts
    ...
  main.ts                   # 创建 runtime 并加载 manifest，不包含业务分支
```

迁移期间允许保留现有文件路径或通过薄适配器过渡；目录重排不是一次性目标。不得为了追求目录整齐而扩大 PR 的行为变更范围。

## 脚本契约

概念接口如下，实施时应优先适配现有 `JobHandler` / runner 类型，避免无必要地引入第二套并行抽象：

```ts
type ScriptHandler = {
  // 一个 task type 对应一个 handler；脚本包可导出多个 handler
  type: string
  execute(job: Job, ctx: ScriptContext): Promise<ScriptResult>
}

type ScriptPackage = {
  id: string
  version: string
  handlers: ScriptHandler[]
}
```

约束：

- handler 只接收任务数据和受控 context，不接收 Worker 下发的可执行代码。
- context 只暴露经过审计的公共能力；不得直接暴露 Agent 内部状态、节点密钥或任意文件系统访问。
- HTTP 出站继续遵守现有 30 秒超时和 SSRF 防护约定。
- 结果仍走现有通用 `items` 回传协议；业务数据清洗和持久化继续由 Worker 侧对应 ingest 负责。
- 共享代码只有在确实跨业务复用时才进入 `shared/`；业务包之间禁止互相依赖。

## 运行与发布

- 新脚本随 Agent 源码一起编译；无需脚本运行时注册或远程拉取。
- PR 合并后沿用 `.github/workflows/auto-tag.yml` 和 `.github/workflows/release.yml`。
- 只有 `agent/` 有 diff 时才构建并推送 Agent 镜像；节点继续通过现有 Watchtower 更新。
- 任务执行应记录 Agent 版本；后续可补充 script package / handler 版本字段，便于定位问题。版本字段的存储改动不属于第一阶段。
- 发布期间必须考虑新旧 Agent 节点并存：Worker 不应向不支持新 task type 的旧节点派发新任务。能力协商应作为独立兼容性改进评估，不在第一阶段偷偷改变协议。

## Worker 边界

- `worker/core/ingest.ts` 负责把通用 items 映射到业务表，保留字段校验、归一化、幂等入库等职责；它不是 Agent 业务脚本的替代品。
- `worker/core/node.ts` 中针对特定 task type 的调度/续跑分支属于待治理的业务耦合。尤其 `zsxq_backfill` 的续跑规则，应在后续单独设计通用续跑契约后再移除。
- 不在本 ADR 中将业务数据写入迁移到 Agent，也不让 Agent 直接访问 D1。

## 非目标

- 不做通用插件市场或第三方插件生态。
- 不做运行时热更新；修改脚本必须经过 GitHub PR、构建和发布。
- 不在本次引入沙箱或多租户不可信代码执行。
- 不重写任务调度、租约、重试、断点续传和 Worker 数据模型。
- 不把所有业务数据映射从 Worker 移到 Agent。

## 分阶段实施

### PR 1：建立脚本包边界（低风险、无业务行为变化）

- [ ] 审计现有 `JobHandler`、`register()`、runner 输入输出和所有 handler 的实际签名。
- [ ] 新建 `agent/src/scripts/` 和脚本包目录；先允许薄适配器，避免大规模移动文件。
- [ ] 定义脚本包/handler 的最小类型，优先复用现有类型。
- [ ] 建立静态 manifest；入口只遍历 manifest 注册，不再逐个写业务注册语句。
- [ ] 首批将现有 handler 纳入 manifest，执行行为、task type、payload、结果格式保持不变。
- [ ] 增加 manifest 完整性检查：task type 不重复、handler 非空、导出结构合法。
- [ ] 补充脚本开发说明和新增脚本模板。
- [ ] 验证 `cd agent && npm ci && npm run check && npm run build`（以仓库实际 scripts 为准），并运行现有测试。
- [ ] 确认 Docker 单文件构建产物仍可运行；不改 Worker 协议和 D1 schema。

### PR 2：迁移低耦合脚本

- [ ] 选择 RSS、股票、TTS 等相对独立的业务逐个迁入脚本包。
- [ ] 每次迁移保持 handler 的 task type、payload schema、网络行为和返回 items 结构不变。
- [ ] 为关键 parser / mapper 补充单元测试或 fixture。
- [ ] 确认业务包不互相 import；真正通用的工具才抽入 shared。

### PR 3：迁移知识星球脚本

- [ ] 梳理 sync、backfill、comments、probe、groups 等 handler 及共享客户端。
- [ ] 保留分页、游标、断点续传、重试和批量结果语义。
- [ ] 通过回归测试对比迁移前后的 items schema。
- [ ] 不同时修改 Worker ingest 或任务调度语义。

### PR 4：治理跨层业务耦合（单独评审）

- [ ] 设计通用续跑/任务延续契约，再处理 `node.ts` 中的 `zsxq_backfill` 特殊分支。
- [ ] 评估 Agent 能力协商，保证新旧节点混跑时不会派发不支持的 task type。
- [ ] 评估是否记录 script package / handler 版本。
- [ ] 仅在有明确收益和兼容方案时调整 Worker 协议或 D1 schema。

## 验收标准

- Agent Core 不包含 RSS、股票、知识星球、TTS 等业务判断。
- 新增一个 handler 时，不需要修改 Agent 主循环或 runner；只需新增脚本包并更新/生成 manifest。
- 所有脚本都在编译期静态纳入镜像，不存在运行时下载或执行远程代码的路径。
- 现有任务 type、payload、items 回传和 Worker ingest 兼容。
- Agent 的类型检查、构建和测试通过。
- PR 合并后按仓库约定检查 CI 和发布工作流；不得直接操作生产环境。
