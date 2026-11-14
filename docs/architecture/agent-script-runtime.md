# ADR: Agent Remote Script Runtime（服务端下发的动态脚本架构）

- 状态：Accepted（架构方向已确认；分阶段实施）
- 日期：2026-11-14
- 范围：Agent 运行时、Worker 节点协议与脚本分发
- 决策：Agent 从 Worker 获取可信 JavaScript 脚本，在本地 Node.js 进程中动态加载执行；脚本同步与任务领取共用一个接口

## 背景

当前 Agent 将 RSS、股票、知识星球、TTS 等业务 handler 静态导入，并通过 `register()` 注册到 runner。业务脚本随 Agent 镜像构建和发布，新增或修改业务逻辑必须重新构建并升级整个 Agent。

目标是把 Agent Core 与业务脚本解耦：Agent 保留稳定的任务生命周期、心跳、结果回传和通用运行能力；业务脚本由服务端发布，Agent 在领取任务前按需同步，并动态执行本地缓存的脚本。

## 决策

采用 **Remote JavaScript Script Runtime（远程 JavaScript 脚本运行时）**：

1. 业务脚本使用原生 JavaScript（ES Module），不要求先编译成 TypeScript，也不编译进 Agent 主程序。
2. Agent 在每次请求下一步任务时上报本地脚本清单；Worker 对比服务端期望清单，返回缺失或哈希不一致的脚本，以及需要删除的脚本 ID。
3. Agent 下载脚本，校验 SHA-256，并以临时文件 + 原子 rename 更新本地缓存。更新完成后再次调用同一个接口。
4. Worker 再次对账；只有脚本清单完全一致时，才调用任务领取管线并返回任务。校验不通过时继续返回更新清单，不领取任务。
5. 唯一的脚本同步 / 任务领取接口为 `POST /node/agent/next`。不新增独立脚本查询接口。
6. 暂不做 VM、容器或进程隔离。脚本在 Agent 的 Node.js 进程内执行，拥有该进程可访问的宿主机权限。**这是明确接受的高风险选择：只能执行经过可信代码评审和发布流程下发的脚本；绝不允许任务 payload 携带或拼接可执行代码。**
7. SHA-256 用于确认下载内容与发布元数据一致，不证明发布者可信。脚本可信性依赖 Worker 身份认证、受控发布权限、代码审查和部署链路。
8. 不在 Agent 运行时安装 npm 依赖。脚本第一阶段应只使用 Node.js 内置 API 与 Agent 显式提供的公共能力；确需第三方库时，先设计兼容的依赖交付方式，不允许脚本自行安装依赖。

## 单接口协议

Agent 请求 `POST /node/agent/next`：

```json
{
  "agentVersion": "0.14.0",
  "scripts": [
    { "id": "rss", "version": "1.1.0", "sha256": "..." },
    { "id": "stock", "version": "1.0.0", "sha256": "..." }
  ]
}
```

需要同步时，Worker 返回：

```json
{
  "code": 0,
  "data": {
    "status": "scripts_update",
    "scripts": [
      {
        "id": "rss",
        "version": "1.2.0",
        "sha256": "...",
        "url": "https://worker.example/agent-scripts/rss/1.2.0.js"
      }
    ],
    "remove": ["retired-script"]
  },
  "message": "ok"
}
```

Agent 完成下载、哈希校验、原子替换和删除后，再次请求同一个接口。Worker 对账通过后：

```json
{
  "code": 0,
  "data": {
    "status": "task",
    "task": { "id": 123, "type": "rss_fetch", "payload": {} }
  },
  "message": "ok"
}
```

没有可执行任务时返回 `status: "idle"`。实际响应继续遵循仓库现有 `{code, data, message}` 信封。

协议约束：

- `id` 是稳定脚本标识；`version` 用于管理和诊断；`sha256` 是内容是否一致的最终判断依据。
- 服务端返回完整的目标脚本集合差异：新增 / 更新列表和删除列表。Agent 不得自行推断哪些脚本应该保留。
- 服务端清单对账必须发生在 `claimPipeline()` 之前。同步未完成时不能创建任务租约。
- 每次领取下一项任务都重新上报清单并校验；任务完成、失败、心跳和结果回传端点不再捎带领取下一任务，避免绕过脚本检查。
- 脚本更新失败、下载失败或哈希不匹配时不领取任务；Agent 记录错误并重试。不能用未校验文件覆盖当前可用版本。
- Agent 只有在本地脚本缓存完整写入并原子替换后，才在下一次请求中上报新哈希。
- Worker 清单在两次请求之间发生变化时，第二次对账以最新清单为准；不一致则继续同步，不发任务。
- Agent 本地脚本目录只存服务端管理的脚本；脚本 ID 必须经过路径安全校验，禁止路径穿越。

## 脚本存储与发布边界

- Worker 持有脚本发布清单（ID、版本、SHA-256、下载地址）；Agent 不自行发现脚本。
- 脚本内容由 Worker 发布链路托管，首选使用 Worker 已配置的静态资源发布能力；脚本文件与清单必须由同一受控发布流程更新，避免元数据和文件版本错配。
- 脚本 URL 只提供代码内容，不包含 token、节点密钥或其他运行时秘密。
- Agent 仍通过现有 `x-node-key` 完成节点认证；脚本下载必须限制为 Worker 清单返回的 HTTPS 地址，并校验内容哈希。
- 任务仍只携带业务数据。第三方 token 等配置仍由 Worker 在任务下发时注入 payload，Agent 不把它们写入脚本文件或脚本清单。

## 脚本执行契约

每个脚本是一个 ES Module，导出稳定的脚本元信息和任务 handler。概念接口：

```js
export const id = 'rss'
export const version = '1.2.0'

export async function execute(task, context) {
  return { items: [], summary: 'ok' }
}
```

- 一个脚本可处理多个 task type；由脚本元数据声明它支持的 task type。
- Core 负责加载脚本、按 task type 分发、创建执行上下文、管理心跳 / 租约、回传结果和统一记录日志。
- 脚本不得自行调用任务领取、心跳、结果回传或完成 / 失败接口。
- 脚本使用现有统一结果结构 `{ items, summary }`，Worker 继续通过现有 ingest 做字段校验、归一化和幂等入库。
- 脚本代码可以访问宿主进程能力（当前不隔离），因此不得接收不可信第三方脚本，也不得将用户可编辑内容拼进脚本源码。

## 兼容与迁移

- 新 Agent 使用 `POST /node/agent/next`；旧 Agent 在升级窗口内仍需有兼容路径，避免 Worker 先发布后 Watchtower 尚未升级时节点立刻失联。
- 旧 `POST /node/poll` 的兼容策略应在协议实现 PR 中明确；过渡期旧接口不得领取只存在于远程脚本中的新 task type。
- 新接口每次只领取一个任务。现有 heartbeat / results / complete / fail 端点保留，但它们不再捎带领取下一任务。
- `worker/core/ingest.ts` 的业务数据映射和 D1 schema 暂不迁入 Agent；保留现有任务 type、payload 与 items 结构。
- 任务调度、租约、重试、断点续传和知识星球续跑语义保持不变；只调整“下一任务从哪里领取”的时序。

## 非目标

- 不做脚本市场或第三方脚本生态。
- 不做 VM / Worker isolate / 容器隔离；这是后续安全增强，不是当前阶段。
- 不允许 Agent 根据任务 payload 执行代码，也不接受任务携带脚本 URL。
- 不允许运行时 npm install 或由脚本修改 Agent Core。
- 不把业务数据持久化从 Worker 迁移到 Agent。
- 不在首阶段重构所有业务逻辑或重写 Worker ingest。

## 分阶段实施

### PR 1：协议与运行时基础

- [ ] 定义 Worker 脚本发布清单和脚本内容托管方式。
- [ ] 实现 `POST /node/agent/next`：清单对账、返回更新列表 / 删除列表、对账通过后领取单个任务。
- [ ] Agent 实现本地脚本清单、下载、SHA-256 校验、原子更新和删除。
- [ ] Agent 实现原生 JS ES Module 动态加载与 task type 分发。
- [ ] 调整任务完成 / 心跳 / 结果回传端点，不再绕过脚本校验直接领取下一任务。
- [ ] 保留旧 Agent 协议的升级兼容路径，并防止旧 Agent 领取远程脚本专属任务。
- [ ] 为脚本对账、更新失败、哈希错误、脚本删除和任务领取增加测试。
- [ ] 验证 Agent 类型检查、构建和 Worker 类型检查；不触碰生产环境。

### PR 2：迁移低耦合脚本

- [ ] 先迁移 RSS、股票或 TTS 中最适合独立运行的脚本。
- [ ] 保持 task type、payload schema、网络行为和 items schema 不变。
- [ ] 对比迁移前后输出并补充 fixture 测试。

### PR 3：迁移知识星球脚本

- [ ] 梳理 sync、backfill、comments、probe、groups 的共享逻辑和任务语义。
- [ ] 保留分页、游标、断点续传、重试和批量结果语义。
- [ ] 通过回归测试对比迁移前后的 items schema。

### 后续安全增强（独立评审）

- [ ] 评估脚本签名 / 发布者密钥，补充超出 TLS + SHA-256 的发布真实性校验。
- [ ] 评估进程隔离、权限收敛和脚本资源限制。
- [ ] 评估脚本依赖的版本化交付机制。

## 验收标准

- Agent 不再把业务 handler 静态编译进主程序。
- 每次领取任务前，Worker 与 Agent 的脚本 ID / SHA-256 清单一致。
- 有差异时只下发脚本更新，不创建任务租约；二次校验通过才允许领取任务。
- 脚本更新具备 SHA-256 校验、原子替换、失败重试和删除同步。
- 任务仍是数据；任何任务 payload 都不能触发任意代码执行。
- 现有 task type、payload、items 回传和 Worker ingest 兼容。
- Agent 与 Worker 检查 / 构建通过；PR 合并后检查 CI 和发布工作流，不直接操作生产环境。
