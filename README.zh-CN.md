<p align="right"><a href="./README.md">English</a></p>

# dsh-codex-ultra-mode

[![npm version](https://img.shields.io/npm/v/dsh-codex-ultra-mode.svg)](https://www.npmjs.com/package/dsh-codex-ultra-mode)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

给 DeepSeek Harness 增加一个 `/ultra` 动态多 Agent 模式：主 Agent 按任务形状即时创建子 Agent，并行调查、继续追问、等待结果、验证冲突，最后由主 Agent 统一完成用户目标。

> 这是依据 OpenAI 公开文档实现的 **Ultra-like 行为复刻**。它不包含 OpenAI 私有代码，也不声称复刻 Codex 未公开的路由提示词、调度算法或模型能力。

## 为什么不是 Agent Team 2.0

Agent Team 适合长期命名成员、任务板、DAG 和成员互聊；Ultra 适合一个复杂目标内的动态拆分和回收。这个插件不创建团队文件、邮箱或第二套 scheduler，而是直接使用 DSH 0.2.x（`0.2.0-rc.1` 及以上）的 continuable subagent runtime。

插件只在 `/ultra` 激活后，为当前 Agent 树增加三个作用域工具：

- `spawn_agent`：创建可继续、可递归分叉的子 Agent；支持 `fork_turns=none|all`。
- `followup_task`：复用同一个子 Agent 上下文开始后续轮次。
- `wait_agent`：按 revision 游标事件驱动等待，不轮询，也不确认或删除 DSH 原始消息。

其余能力直接复用 DSH 原生工具：

- `send_message`
- `interrupt_agent`
- `list_agents`
- 子 Agent 的 `report`

## 当前能力

- 模型驱动的动态委派，不要求预先生成静态 DAG。
- 子 Agent 可以继续创建孙 Agent。
- 整棵树默认最多 3 个活跃子 Agent、深度 3、总计 12 个。
- 同一条模型回复可并行调用多个 `spawn_agent`；跨分支的创建、原生 `send_message` 和 `followup_task` 冷唤醒共享原子并发槽。
- `subagent/start/end`、报告和结算消息进入单调 revision 的有界事件镜像；默认保留最近 512 条，正文镜像最多 2000 字符，DSH 原始会话仍是完整事实源。
- 主/子 Agent 尝试在后代仍运行时结束，会收到 completion barrier steering；超过配置预算后，运行时精确释放该 Agent 的 Ultra 直属分支及其后代森林，并要求披露失败后完成综合，不会无限追加模型步骤。
- 默认 single-writer：子 Agent 必须只读，插件会阻断标准 DSH shell/文件写工具；第三方或 MCP 写工具必须加入 `childDenyTools`。这是协作护栏，不是通用安全沙箱。
- DSH 原生 `subagent` / `subagent_fork` 在 Ultra 树中禁用，避免 one-shot、detached job 与 continuable 生命周期混算；统一使用 `spawn_agent`。
- 工具只注入已激活的 Agent 树，普通 DSH 会话没有额外工具和提示词开销。
- 复用 DSH 原生子 Agent UI 和会话存储，无额外前端。Ultra 拓扑、revision 游标和并发计数本身是进程内状态。

## 安装

要求 DeepSeek Harness `0.2.0-rc.1` 或更新的 0.2.x。安装 npm 发布包：

```bash
dsh plugin --profile web add dsh-codex-ultra-mode@0.2.0
```

如果 `dsh` 不在 `PATH`：

```bash
npx @deepseek-ai/dsh@0.2.1-rc.3 plugin --profile web add dsh-codex-ultra-mode@0.2.0
```

验证配置并重启 DSH Web：

```bash
dsh --profile web --dump-config
dsh web
```

插件是 host-only，不需要单独构建浏览器 bundle。

源码开发：

```bash
git clone https://github.com/null5069/dsh-codex-ultra-mode.git
cd dsh-codex-ultra-mode
npm install --ignore-scripts
npm test
dsh plugin --profile web add link:"$PWD"
```

## 使用

```text
/ultra 审计这个项目的鉴权实现，修复高风险问题并完成回归测试
```

`/ultra` 表示允许主动动态委派，并不强制每个任务都创建 Agent。对于很小、严格串行或共享写冲突严重的任务，主 Agent应直接完成。

推荐让 Agent Team 与 Ultra 共存：

- `/agent-teams`：长周期、持久任务板、成员互聊。
- `/ultra`：当前目标的一键并行调查、验证和综合。

两者可以安装在同一 profile，但当前应在不同会话中使用：一个会话只选择一种调度协议。Ultra 不会把 Agent Team 成员计入自己的并发预算、事件等待或完成屏障，因此不要在同一个任务中混用 `/ultra` 与 `/agent-teams`。

## 配置

```yaml
- id: codex-ultra-mode
  name: dsh-codex-ultra-mode
  config:
    spawnProvider: spawn
    forkProvider: fork
    maxConcurrentSubagents: 3
    maxDepth: 3
    maxTotalSubagents: 12
    maxWaitMs: 30000
    maxBarrierSteps: 8
    barrierDrainMs: 10000
    eventHistory: 512
    singleWriter: true
    childDenyTools: []
    allowWorkflow: false
    slashCommand: true
```

`allowWorkflow=false` 是有意的默认值：DSH workflow 是固定脚本前台扇出，默认并发取决于 CPU，语义上不同于 Ultra 的逐轮模型决策。若确实需要数十到上千个同构任务，可打开它或在非 Ultra 会话使用 workflow。

`maxBarrierSteps` 是完成屏障的模型步骤预算；耗尽后插件会通过 DSH 的精确 child drain 释放未完成分支（而非仅发送可恢复的 interrupt）。热路径最多等待 `barrierDrainMs`，超时的 drain 会继续在后台完成，同时分支在本地标记为失败并禁止再创建/唤醒工作，避免卡住主 Agent 的取消或收尾。后台 drain 真正 settle 前，再次 `/ultra` 也不会解除 closing；settle 后可重新执行 `/ultra`，即使 DSH 同时返回了 teardown 诊断。只有永不 settle 的底层 drain 才需要通过重载恢复。`slashCommand=false` 会同时关闭命令注册和原始 `/ultra` 手势激活。

如果安装了会写外部系统或工作区的第三方工具，请把其精确工具名加入 `childDenyTools`。例如：

```yaml
childDenyTools: [apply_patch, github_create_pull_request]
```

## 与 Codex Ultra 的已知差异

- 只复刻公开可观察行为，不可能复制未公开的内部路由与模型训练。
- DSH 当前的 `send_message` 会排入子 Agent 的下一轮并在空闲时唤醒；它不具备 OpenAI API 中“只投递、不唤醒”的完全相同语义。
- `fork_turns` 首版只支持 `none` 和 `all`，不支持精确的最近 N 轮。
- DSH 的 follow-up 只允许直属父 Agent 发给直属子 Agent；没有 sibling P2P。
- `/ultra` 激活状态目前是进程内状态。DSH 子 Agent 会话可持久化，但重启后 Ultra 的树、事件镜像和计数不会自动重建；需要在主会话重新执行 `/ultra`，旧 child 只能通过 DSH 原生会话能力另行处理。
- 插件卸载或热重载会精确 drain 当前 Ultra 根直接创建的分支，然后撤销作用域工具；不会取消同一 root 下非 Ultra 创建的子 Agent。重载后需重新执行 `/ultra`。
- 精确 child drain 会释放对应 Activation/后代森林，并丢弃该分支尚未领取的 pending inbox；底层 DSH 会话记录仍保留，之后仍可按 DSH 原生规则冷恢复。若 drain 超过 `barrierDrainMs` 后才在后台 settle，迟到的 settlement notice 仍可能唤醒已经收尾的 root，应把它视为上一 run 的诊断而非新结果。
- 默认单写者模式只强制阻断标准工具和 `childDenyTools` 中列出的名称，无法自动识别任意第三方工具的副作用。关闭后必须自行确保写入范围不重叠。
- `wait_agent` 的 revision 事件镜像是有界摘要，不是完整审计日志；旧游标溢出时返回 `truncated=true`，应回看 DSH 原始会话或重新收集结论。
- `wait_agent.agent_ids` 只控制精确唤醒目标和状态快照；由于 revision 是整棵树的全局游标，返回的 `events` 始终包含该游标之后的全部树事件，避免切换目标时跳过其他分支更新。
- 当前适配 DSH 0.2.x 预发布 API（`0.2.0-rc.1` 及以上均支持；`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-alpha.1` 仍使用 `startContinuable`）；升级 DSH 时应重新运行集成测试。

## 开发验证

```bash
npm test
npm pack --dry-run
```

测试覆盖首步激活时序、命令边界、层级树、并发/深度/总量限制、冷恢复失败、启动回滚、完成屏障、消息游标、截断/取消、工具输出 schema、卸载清理和包结构。当前 smoke 使用 DSH 的真实 JSON Schema validator 配合 host 模拟生命周期；完整模型路由质量仍需在代表性任务上比较单 Agent、Agent Team 和 Ultra 的成功率、耗时与 Token 使用。

## 名称说明

Codex 与 Ultra 是 OpenAI 的相关产品/功能名称。本项目是独立的社区兼容插件，与 OpenAI 无隶属或背书关系。
