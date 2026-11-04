# DSH × Claude Code 原生桥接方案

> 保存自 2026-11-03 上一会话的实现方案（原始消息时间 2026-11-03T14:46:31Z，31,808 字符）。
>
> **状态说明（2026-11-03）**：本文是方案原文，保留设计推理与代码草案。后续会话进一步核对了 DSH 实际 API，最终落点调整为：**不自定义 Agent，而是在 `Sessions.decorate` 中给 worker 的 `ReactLoopAgent` 挂一个持久 `ClaudeCodeDriver`，覆写实例的 `step(decision)`**。原文中与真实 API 不一致的片段以文末「实现勘误」为准。

---
基于对 **DeepSeek Harness (DSH)** 核心包（`x-dsh-*`）、`dsh-superagent-prototype` 编排架构以及 `@anthropic-ai/claude-agent-sdk` / `claude.exe` 原生控制协议的完整源码逆向与分析，下面给出**可行性结论、源码级约束剖析、以及完整的落地实现方案**。

---

## 一、 核心结论：**完全可以实现，但必须绕开内置的 `dsh-subagent`**

你要实现的目标是：
1. **外层**：DSH 主 Agent 作为总控调度器（Orchestrator）与你对话，理解需求并派发任务；
2. **下层**：可动态派发给 **原生 Claude Code** 或其他 Agent（DSH 原生 Agent / Codex / ACP 等）；
3. **原生会话直投 DSH UI**：Claude Code 的完整多轮会话（含流式思考、文本、工具调用与结果、状态流转）直接作为一等公民呈现在 DSH Web UI 左侧会话列表和主聊天面板中，支持随时在 UI 中点开直接插话、追问；
4. **非 `-p` 单次调用、非阉割版**：保留完整原生 `claude.exe` 进程能力（CLAUDE.md、Skills、Plugins、Hooks、MCP、内置工具集、`--resume` 会话持久化）；
5. **双向交互（提问与审批）**：Claude Code 调用 `AskUserQuestion` 或触发工具权限审批时，直接在 DSH 界面弹出原生问题卡片/审批卡片与你交互，你的回答实时回传给 Claude Code 恢复当前轮次执行。

### 为什么 DSH 内置的 `@deepseek-ai/dsh-subagent` 做不到？（源码级原因）

在 DSH 源码中，内置的 `subagent` 机制存在**三条硬性架构封锁**：

1. **外部 Provider 仅支持单次 `start()`，不支持多轮续接**：
   - 在 [dsh-core/x-dsh-subagent/package/lib/index.js](dsh-core/x-dsh-subagent/package/lib/index.js) 中，`SubagentManager.startExternal` 将所有外部 Provider（Claude Code、Codex、ACP）硬编码为 `mode: "external"`。
   - 当尝试向其发送后续消息时，`SubagentManager.send` 直接抛出 `NOT_CONTINUABLE`（*"subagent does not accept follow-up messages"*），且 `external` 模式根本不创建本地 `Session` 事件流，UI 无法渲染多轮对话。
2. **Subagent 会话在 UI 侧被隐藏且禁止直接控制**：
   - 凡是通过 `dsh-subagent` 创建的会话，`SessionHeader.origin` 均被标记为 `"subagent"`，且在 `AgentRegistry.enter(agent, parentAgent)` 中绑定了父 Agent。
   - 在 [dsh-core/x-dsh-api-session-controller/package/lib/index.js](dsh-core/x-dsh-api-session-controller/package/lib/index.js) 中，`hasApiSessionSubagentOwner` 会拦截所有針對 `origin === "subagent"` 会话的直接控制操作；Web UI 也会将 `origin === "subagent"` 折叠在父会话内部，不作为独立顶层会话展示。
3. **非 Root Agent 被硬编码禁止向用户提问（最关键限制）**：
   - 在 [dsh-core/x-dsh-user-questions/package/lib/index.js](dsh-core/x-dsh-user-questions/package/lib/index.js) 的 `UserQuestionService.assertLiveRoot(agent)` 中有如下硬检查：
     ```js
     if (!agents.roots().includes(agent)) {
       throw new UserQuestionError("DELEGATED_CALLER",
         `agent "${agent.id}": human interaction is unavailable while the calling agent is owned by another live agent`);
     }
     ```
   - 同时，`dsh-subagent` 的 `captureDelegatedPolicyOverrides` 会强制把子 Agent 的审批策略锁死为 `approvalPolicy: "never"`。

---

## 二、 破局架构：Peer Root Agent + Claude Code Stdio 双向控制桥

[dsh-superagent-prototype](dsh-superagent-prototype/docs/007-architecture.md) 已经为我们验证了前半套模式：**主调度器（Orchestrator Session）与干活的 Worker Session 之间不走 `parentAgent` 父子从属关系，而是平级的顶层 Root Session（`worker-<id>`）**，通过 Cordis 事件总线（`ctx.on('agent/status')`、`ctx.on('session/event')`）和工具集进行跨会话调度与结果回传（Relay）。

在此基础上，我们只需要将 Worker Session 的底层驱动从单一的 DSH `ReactLoopAgent` 扩展为**多引擎可插拔的 Peer Root Agent**（支持 `claude-code` 原生桥接驱动 + `dsh-native` 原生驱动 + 其他 Agent 驱动）。

### 整体架构全景图

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           DeepSeek Harness Web UI                             │
│  ┌─────────────────────────┐    ┌──────────────────────────────────────────┐  │
│  │ 左侧会话栏 (Root列表)     │    │ 会话主视图 (Chat / Tool / Question Card) │  │
│  │ • 主调度台 (Orchestrator) │    │ • 实时流式输出 (agent/assistant-stream)  │  │
│  │ • [CC] 任务-1 (Worker)   │    │ • 原生提问卡片 (ctx.userQuestions)       │  │
│  │ • [DSH] 任务-2 (Worker)  │    │ • 原生权限审批卡片 (ctx.approval)        │  │
│  └─────────────────────────┘    └──────────────────────────────────────────┘  │
└───────────────▲───────────────────────────────────────▲───────────────────────┘
                │ Typert RPC / Session Events           │
┌───────────────┴───────────────────────────────────────┴───────────────────────┐
│                        DSH Cordis Runtime (Node.js)                           │
│                                                                               │
│  ┌──────────────────────────────┐         ┌────────────────────────────────┐  │
│  │ Orchestrator Root Agent      │         │ ClaudeCodeWorkerAgent (Root)   │  │
│  │ (DeepSeek 调度主会话)         │         │ • 注册于 ctx.agents.enter(a)   │  │
│  │ • 接收用户需求                │ 派发/Steer│ • 绑定真实 DSH Session 日志    │  │
│  │ • 调度工具:                   ├────────►│ • 位于 ctx.agents.roots() 中   │  │
│  │   - dispatch_worker(engine)  │         │ • 可合法调用 ctx.userQuestions │  │
│  │   - send_to_worker           │◄────────┤   与 ctx.approval              │  │
│  │   - inspect_worker           │ 完成/状态 │                                │  │
│  └──────────────────────────────┘ 自动Relay└───────▲────────────────┬───────┘  │
└───────────────────────────────────────────────────┼────────────────┼──────────┘
                                     stdout (NDJSON)│                │stdin (NDJSON)
                                                    │                ▼
┌───────────────────────────────────────────────────┴───────────────────────────┐
│            原生 Claude Code CLI 常驻子进程 (`claude.exe` / `claude`)           │
│  参数: --print --input-format stream-json --output-format stream-json          │
│        --verbose --include-partial-messages --permission-prompt-tool=stdio    │
│        --permission-prompts host [--resume <cc_session_id>]                   │
│  能力: 100% 原生 (CLAUDE.md, Skills, MCP, Hooks, Worktree, Bash, Edit, etc.)  │
└───────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、 关键技术点拆解（源码级对齐）

### 1. 为什么在 `probe3.ps1` 中没抓到 `control_request`？如何正确开启 Claude Code 原生双向控制协议？

看你工作区里的 [probe/probe3.ps1:10](probe/probe3.ps1#L10)，当时的启动参数只传了：
`--print --input-format stream-json --output-format stream-json --verbose --permission-prompts host --permission-mode default`
结果在 [probe/probe3.log:8](probe/probe3.log#L8) 中，`Bash` 重定向直接输出了 `permission_denied`，并且 `sawControl=False`！

**源码真相**：在 [dsh-core/x-sdk/package/sdk.mjs:152](dsh-core/x-sdk/package/sdk.mjs#L152) 中可以看到，Claude Code CLI 只有在显式传入 **`--permission-prompt-tool=stdio`** 时，才会将权限审批和 `AskUserQuestion` 转为 stdin/stdout 上的双向 `control_request` / `control_response` 协议！

**完整的原生常驻进程启动参数应为**：
```bash
claude \
  --print \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --permission-prompt-tool=stdio \
  --permission-prompts host \
  --permission-mode default \
  --resume <claude_session_id> # 首次创建可用 --session-id <uuid>，后续重连用 --resume
```
> 注：虽然带了 `--print`，但在同时指定 `--input-format stream-json` 且**不关闭 stdin** 的情况下，`claude.exe` **不会退出**，而是一个常驻的多轮会话进程（你在 `probe2.log` 和 `probe3.log` 中发送第二轮消息并拿到上下文记忆已经证实了这一点）。

启动后，首先通过 `stdin` 发送一行 `initialize` 握手包：
```json
{
  "type": "control_request",
  "request_id": "init-1",
  "request": {
    "subtype": "initialize",
    "supportedDialogKinds": ["ask_user_question", "elicitation"]
  }
}
```
这样 `claude.exe` 就会处于完整的原生双向受控模式。

---

### 2. Claude Code 提问 (`AskUserQuestion`) 与权限审批如何无缝映射到 DSH UI？

当 Claude Code 在执行过程中需要向你提问（调用 `AskUserQuestion`）或请求工具执行权限（如写文件/执行危险命令）时，`claude.exe` 会在 `stdout` 输出一条 `type: "control_request"` 的 JSON（见 [dsh-core/x-sdk/package/sdk.d.ts:5061-5117](dsh-core/x-sdk/package/sdk.d.ts#L5061-L5117)）：

```json
{
  "type": "control_request",
  "request_id": "req_abc123",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "AskUserQuestion",
    "tool_use_id": "toolu_01XYZ",
    "input": {
      "questions": [
        {
          "header": "Database",
          "question": "Which database should we use?",
          "multiSelect": false,
          "options": [
            { "label": "PostgreSQL", "description": "Relational DB" },
            { "label": "SQLite", "description": "Local embedded DB" }
          ]
        }
      ]
    }
  }
}
```

我们的 `ClaudeCodeWorkerAgent` 拦截到这条消息后，分两种情况桥接到 DSH 原生 UI 服务：

#### 情况 A：`tool_name === "AskUserQuestion"`（或 `subtype === "request_user_dialog"`） -> 桥接到 `ctx.userQuestions`
DSH 的 `@deepseek-ai/dsh-user-questions`（见 [dsh-core/x-dsh-user-questions/package/lib/index.js](dsh-core/x-dsh-user-questions/package/lib/index.js)）会在满足以下条件时，在 DSH Web UI 聊天窗口底部渲染出原生的多选/单选交互式问题卡片：
1. 当前 Agent 位于 `ctx.agents.roots()` 中（我们的 `ClaudeCodeWorkerAgent` 作为 Root Agent 注册，天然满足）；
2. Session 中记录了包含 `ask_user_question` schema 的 `request/header` 以及对应的 `tool/call` 事件；
3. 调用 `await ctx.userQuestions.ask({ agent, sessionId: agent.id, callId: tool_use_id, questions, signal })`。

**数据格式转换（100% 兼容）**：
- Claude Code 的 `question`: `{ question, header, options: [{ label, description }], multiSelect }`
- DSH `ctx.userQuestions` 的 `question`: `{ id: q.header || "q_0", header: q.header, question: q.question, options: q.options, multiSelect: q.multiSelect }`
- 当你在 DSH Web UI 上点击选项或输入自定义回答并提交后，`ctx.userQuestions.ask()` 返回 ` { status: "answered", answers: { [id]: { selected: [...], customText: "..." } } }`。
- 我们将 `answers` 转换为 Claude Code `AskUserQuestion` 预期的 `updatedInput: { questions, answers: { [questionText]: selectedLabelOrCustomText } }`，然后向 `claude.exe` 的 `stdin` 写回：
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "req_abc123",
    "response": {
      "behavior": "allow",
      "updatedInput": {
        "questions": [...],
        "answers": { "Which database should we use?": "PostgreSQL" }
      }
    }
  }
}
```
Claude Code 收到后，其内部的 `AskUserQuestion` 工具立即拿到你的选择并返回给 Claude 模型继续执行！

#### 情况 B：普通工具权限审批（如 `Bash`, `Edit`, `Write`, `mcp__*`） -> 桥接到 `ctx.approval` 或 `ctx.userQuestions`
- 可以直接调用 DSH 的 `ctx.approval` 服务（或在 UI 上弹出带“允许本次 / 本会话始终允许 / 拒绝并附带原因”的 `ctx.userQuestions` 卡片）。
- 若你点击“允许”，向 `claude.exe` 返回 `{ behavior: "allow", updatedInput: req.input }`（若选了“始终允许”，附带 `updatedPermissions: req.permission_suggestions`）。
- 若你点击“拒绝”并填写原因，向 `claude.exe` 返回 `{ behavior: "deny", message: userReason }`，Claude Code 会将该反馈作为 tool_result 交给模型调整方案。

---

### 3. 如何把 Claude Code 的原生会话实时投影到 DSH 界面？

DSH Web UI 的聊天界面（`@deepseek-ai/dsh-client-ui-workspace` + `@deepseek-ai/dsh-api-session-controller`）完全是**事件驱动**的。它并不关心底层是不是 `ReactLoopAgent`，它只认两件事：
1. **持久化事件日志 (`Session.append`)**：
   - `turn/start` (`{ turn }`)
   - `step/start` (`{ turn, step }`)
   - `user/message`（用户消息或调度器派发的任务消息）
   - `assistant/message`（包含 `{ type: "thinking", thinking }`、`{ type: "text", text }`、`{ type: "tool-call", id, name, arguments }`）
   - `tool/call` (`{ turn, step, callId, name, arguments }`)
   - `tool/result` (`{ turn, step, callId, name, content, isError }`)
   - `step/end` (`{ turn, step }`)
   - `turn/end` (`{ turn, reason: { kind: "completed" | "aborted" | "error" } }`)
2. **实时流式帧广播 (`agent/assistant-stream`)**：
   - 当 `claude.exe` 开启 `--include-partial-messages` 时，会实时输出 `type: "stream_event"`（包含 `content_block_start`、`content_block_delta`（`thinking_delta` / `text_delta` / `input_json_delta`））。
   - 我们直接复用 `@deepseek-ai/dsh-agent-loop` 中的 `AssistantStreamAttempt` 状态机（见 [dsh-core/x-dsh-agent-loop/package/lib/index.js:244-415](dsh-core/x-dsh-agent-loop/package/lib/index.js#L244-L415)），将 `stream_event` 喂给它，由它触发 `this.dispatch.emit("agent/assistant-stream", { frame })`。
   - 这样你在 DSH 界面看到的 Claude Code 打字机效果、思考过程折叠框、工具调用卡片，与 DSH 原生 Agent **100% 视觉一致、零延迟**。

---

### 4. 如何构造自定义 `ClaudeCodeWorkerAgent` 并挂载进 DSH？

阅读 [dsh-core/x-dsh-agent/package/lib/index.js](dsh-core/x-dsh-agent/package/lib/index.js) 和 [dsh-core/x-dsh-agent-loop/package/lib/index.js:1786-1804](dsh-core/x-dsh-agent-loop/package/lib/index.js#L1786-L1804) 可知，`ctx.agents` (`AgentRegistry`) 接纳任何实现了 `Agent` 接口的对象：

```ts
// Agent 契约核心接口（见 dsh-core/x-dsh-agent/package/lib/types/runtime-types.d.ts）
interface Agent {
  readonly id: SessionId;
  readonly session: Session;
  readonly ctx: Context;
  readonly options: Readonly<AgentOptions>;
  readonly status: 'idle' | 'running' | 'maintenance';
  readonly inbox: AgentInbox;
  send(message: UserMessage, options?: AgentSendOptions): void;
  followup(content: string | readonly UserContentBlock[], options?: AgentPromptOptions): UserMessage;
  steer(content: string | readonly UserContentBlock[], options?: AgentPromptOptions): UserMessage;
  inject(content: string | readonly UserContentBlock[], label: string, options?: AgentInjectOptions): UserMessage;
  cancel(cause?: AgentCancelCause, options?: AgentCancelOptions): void;
  whenIdle(): Promise<void>;
  runMaintenance<T>(task: () => Promise<T>): Promise<T>;
}
```

将自定义 `ClaudeCodeWorkerAgent` 注册为 DSH 顶层会话只需 4 步（与 `AgentLoop.prepare` 完全一致）：
1. **准备 Session 与持久化句柄**：
   - 调用 `const prep = ctx.sessions.prepare(sessionId, { meta: { cwd, title, agentPreset: 'claude-code-worker' } })`
   - 调用 `const handle = await ctx.sessionPersistence.create(prep.session.header, { inheritedEventCount: 0 })`
2. **写入初始 `request/header`**：
   - 在 `prep.session` 中追加一条包含 `ask_user_question` 工具 schema 的 `request/header`（确保 `userQuestionProjectionDefinition` 激活）。
3. **注册到 `ctx.sessions` 与 `ctx.agents`（不传 `parentAgent`！）**：
   - `ctx.sessions.enter(session)`
   - `ctx.agents.enter(agent, undefined)` 👈 **关键：`owner` 传 `undefined`，使其成为 `ctx.agents.roots()` 中的 Root Agent！**
   - `ctx.sessions.announce(session)`
   - `await ctx.agents.announce(agent, 'startup')`
4. **注册 Workspace**：
   - `await ctx.workspaceRegistry.create(cwd)`，这样 DSH Web UI 左侧工作区列表会自动展示该会话。

---

## 四、 具体实现方案（分模块落地指南）

我们可以直接在你现有的 `dsh-superagent-prototype` 基础上改造，或者封装为一个独立的 Cordis 插件包（如 `dsh-claude-orchestrator`）。下面给出可直接落地的模块设计：

### 模块 1：多引擎执行器路由（支持选择 Claude Code 或其他 Agent）

在 `dsh-superagent-prototype` 的设置与调度工具中增加 `engine` 选择参数：
- `'claude-code'`：使用我们的 `ClaudeCodeWorkerAgent`（原生 `claude.exe` 进程桥接）
- `'dsh-native'`：使用 DSH 原生的 `ReactLoopAgent`（可指定 DeepSeek / Sonnet / GPT 等任意 DSH 配置的模型）
- `'codex'` / `'acp'`：通过 ACP 协议或对应 CLI 桥接

在 Orchestrator（主调度 Agent）中暴露给 DeepSeek 的调度工具集：
1. **`orchestrator_create_worker`**：
   - 参数：`{ title, cwd, engine: 'claude-code' | 'dsh-native', model?, initialPrompt, permissionMode?: 'default' | 'acceptEdits' | 'auto' }`
   - 作用：创建一个顶层 Worker Session（例如 `cc-worker-<slug>`），在 UI 侧边栏立即可见，并将 `initialPrompt` 发送给 Worker 启动第一轮工作。
2. **`orchestrator_send_worker`**：
   - 参数：`{ workerSessionId, message, mode: 'steer' | 'followup' }`
   - 作用：向正在运行或已空闲的 Claude Code / DSH Worker 发送追问或中途修正指令（如果 Worker 正在运行且 `mode === 'steer'`，直接写入 `claude.exe` 的 stdin 或触发中断重发）。
3. **`orchestrator_inspect_worker` / 自动 Relay**：
   - 当 Worker 完成一个 Turn（收到 `claude.exe` 的 `type: "result"`）、或者出错时，自动触发 `sessions.relay()` 将摘要推送回主调度 Session，主调度器无需轮询 `sleep`。

---

### 模块 2：`ClaudeCodeWorkerAgent` 核心实现（Stdio 协议桥 + 事件投影 + 提问桥接）

这是整个方案最核心的类。下面给出它的完整实现骨架与关键逻辑：

```ts
// src/executor/claude-code-agent.ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentCancelCause, AgentCancelOptions, AgentInbox } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'

// 激活 @deepseek-ai/dsh-user-questions 投影所需的工具 Schema
const ASK_USER_QUESTION_TOOL_SCHEMA = {
  name: 'ask_user_question',
  description: 'Ask the user structured questions on DSH UI',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            header: { type: 'string' },
            question: { type: 'string' },
            multiSelect: { type: 'boolean' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, description: { type: 'string' } },
                required: ['label', 'description'],
              },
            },
          },
          required: ['id', 'header', 'question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
}

export class ClaudeCodeWorkerAgent implements Agent {
  readonly id: SessionId
  readonly session: Session
  readonly ctx: Context
  readonly options: Readonly<{ provider: string; model: string }>
  status: 'idle' | 'running' | 'maintenance' = 'idle'

  private proc?: ChildProcessWithoutNullStreams
  private claudeSessionId: string
  private isResumedSession: boolean
  private turnCount = 0
  private stepCount = 0
  private currentTurnAbort?: AbortController
  private idleResolvers: Array<() => void> = []

  constructor(
    private readonly hostCtx: Context,
    session: Session,
    private readonly config: {
      cwd: string
      claudeBin?: string
      model?: string
      permissionMode?: 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions'
      claudeSessionId?: string // 若从持久化恢复，传入已有的 UUID
    },
  ) {
    this.id = session.id
    this.session = session
    this.ctx = hostCtx.extend()
    this.options = Object.freeze({
      provider: 'claude-code-native',
      model: config.model ?? 'sonnet',
    })
    this.isResumedSession = Boolean(config.claudeSessionId)
    this.claudeSessionId = config.claudeSessionId ?? randomUUID()

    // 确保写入 request/header 以激活 DSH 的 userQuestionProjectionDefinition
    if (!this.session.requestHeader()) {
      this.session.append('request/header', {
        header: {
          config: { provider: this.options.provider, model: this.options.model },
          tools: [ASK_USER_QUESTION_TOOL_SCHEMA],
        },
        reason: 'initial',
        startsSeries: true,
      })
    }
  }

  /** 启动或复用常驻 claude.exe 进程 */
  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
      return this.proc
    }
    const bin = this.config.claudeBin ?? 'C:\\Users\\10655\\.local\\bin\\claude.exe'
    const args = [
      '--print',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-prompt-tool=stdio',
      '--permission-prompts', 'host',
      '--permission-mode', this.config.permissionMode ?? 'default',
    ]
    if (this.config.model) args.push('--model', this.config.model)
    if (this.isResumedSession) {
      args.push('--resume', this.claudeSessionId)
    } else {
      args.push('--session-id', this.claudeSessionId)
      this.isResumedSession = true
    }

    const proc = spawn(bin, args, {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    })
    this.proc = proc

    // 发送 initialize 控制协议握手
    this.writeStdin({
      type: 'control_request',
      request_id: `init_${randomUUID()}`,
      request: {
        subtype: 'initialize',
        supportedDialogKinds: ['ask_user_question', 'elicitation'],
      },
    })

    const rl = createInterface({ input: proc.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      try {
        const msg = JSON.parse(line)
        void this.handleStdoutMessage(msg)
      } catch (err) {
        this.hostCtx.logger.warn('Failed to parse claude stdout JSON: %s', String(err))
      }
    })

    proc.on('exit', () => {
      if (this.status === 'running') {
        this.finishTurn({ kind: 'aborted', reason: { kind: 'user' } })
      }
    })

    return proc
  }

  private writeStdin(payload: unknown): void {
    const proc = this.ensureProcess()
    proc.stdin.write(JSON.stringify(payload) + '\n')
  }

  /** 当用户在 DSH Web UI 输入框直接发消息，或 Orchestrator 派发消息时触发 */
  send(message: any, _options?: any): void {
    // 1. 记录 user/message 到 DSH Session，UI 立即显示用户消息气泡
    this.session.append('user/message', message, { surfaceOp: 'append' })

    // 2. 若当前处于 idle，开启新 Turn
    if (this.status === 'idle') {
      this.startTurn()
    }

    // 3. 提取纯文本或图文内容转发给 claude.exe stdin
    const text = message.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')

    this.writeStdin({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    })
  }

  /** 处理 claude.exe stdout 发出的所有流式事件与控制请求 */
  private async handleStdoutMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'assistant': {
        // 完整或分步的 assistant 消息（含 thinking, text, tool_use）
        this.stepCount++
        this.session.append('step/start', { turn: this.turnCount, step: this.stepCount })

        const dshBlocks: any[] = []
        const toolUses: any[] = []

        for (const block of msg.message?.content ?? []) {
          if (block.type === 'thinking') {
            dshBlocks.push({ type: 'thinking', thinking: block.thinking ?? '' })
          } else if (block.type === 'text') {
            dshBlocks.push({ type: 'text', text: block.text })
          } else if (block.type === 'tool_use') {
            dshBlocks.push({
              type: 'tool-call',
              id: block.id,
              name: block.name,
              arguments: block.input ?? {},
            })
            toolUses.push(block)
          }
        }

        if (dshBlocks.length > 0) {
          this.session.append('assistant/message', {
            turn: this.turnCount,
            step: this.stepCount,
            message: createAssistantMessage({
              content: dshBlocks,
              source: { provider: this.options.provider, model: msg.message?.model ?? this.options.model },
            }),
          }, { surfaceOp: 'append' })
        }

        for (const tu of toolUses) {
          this.session.append('tool/call', {
            turn: this.turnCount,
            step: this.stepCount,
            callId: tu.id,
            name: tu.name,
            arguments: tu.input ?? {},
          })
        }
        break
      }

      case 'user': {
        // Claude Code 内部工具执行完毕后产生的 tool_result
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_result') {
            const textContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)
            this.session.append('tool/result', {
              turn: this.turnCount,
              step: this.stepCount,
              callId: block.tool_use_id,
              name: 'claude_tool',
              content: [{ type: 'text', text: textContent }],
              isError: Boolean(block.is_error),
            }, { surfaceOp: 'append' })
          }
        }
        this.session.append('step/end', { turn: this.turnCount, step: this.stepCount })
        break
      }

      case 'control_request': {
        // 核心：拦截 AskUserQuestion 和工具权限请求，转发到 DSH Web UI！
        await this.handleControlRequest(msg)
        break
      }

      case 'result': {
        // 当前轮次结束
        this.finishTurn({ kind: 'completed' })
        break
      }
    }
  }

  /** 将 Claude Code 的 AskUserQuestion / 权限请求桥接到 DSH 原生 UI 组件 */
  private async handleControlRequest( envelope: any ): Promise<void> {
    const { request_id, request } = envelope
    if (request.subtype !== 'can_use_tool') return

    // 1. Claude Code 调用了 AskUserQuestion 工具
    if (request.tool_name === 'AskUserQuestion') {
      const rawQuestions = Array.isArray(request.input?.questions) ? request.input.questions : []
      const dshQuestions = rawQuestions.map((q: any, idx: number) => ({
        id: `q_${idx}`,
        header: (q.header ?? `Q${idx + 1}`).slice(0, 32),
        question: q.question,
        multiSelect: Boolean(q.multiSelect),
        options: (q.options ?? []).map((opt: any) => ({
          label: opt.label,
          description: opt.description ?? '',
        })),
      }))

      // 在 Session 中记录 ask_user_question 调用，以便 DSH UI 渲染问题卡片
      const callId = request.tool_use_id ?? `ask_${request_id}`
      this.session.append('tool/call', {
        turn: this.turnCount,
        step: this.stepCount,
        callId,
        name: 'ask_user_question',
        arguments: { questions: dshQuestions },
      })

      try {
        // 调用 DSH 原生提问服务，DSH Web UI 会立即弹出问题卡片等待用户点击
        const result = await this.hostCtx.userQuestions.ask({
          agent: this,
          sessionId: this.id,
          callId,
          questions: dshQuestions,
          signal: this.currentTurnAbort?.signal ?? new AbortController().signal,
        })

        if (result.status === 'answered') {
          // 组装回 Claude Code AskUserQuestion 所需的 answers 字典（以 question 文本为 key）
          const ccAnswers: Record<string, string> = {}
          rawQuestions.forEach((q: any, idx: number) => {
            const ans = result.answers[`q_${idx}`]
            if (!ans) return
            const parts = [...(ans.selected ?? [])]
            if (ans.customText) parts.push(ans.customText)
            ccAnswers[q.question] = parts.join(', ')
          })

          this.writeStdin({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id,
              response: {
                behavior: 'allow',
                updatedInput: {
                  ...request.input,
                  answers: ccAnswers,
                },
              },
            },
          })
          return
        }
      } catch (err) {
        // 用户取消或超时
      }

      this.writeStdin({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id,
          response: { behavior: 'deny', message: 'User cancelled or skipped the question.' },
        },
      })
      return
    }

    // 2. 其他工具（如 Bash / Write / Edit）触发了权限询问：同样通过 DSH UI 卡片让用户审批
    const callId = `perm_${request_id}`
    const title = request.title ?? `Claude Code 请求执行 ${request.tool_name}`
    const desc = [
      request.decision_reason,
      request.description,
      `参数: ${JSON.stringify(request.input).slice(0, 300)}`,
    ].filter(Boolean).join('\n')

    const dshApprovalQuestion = [{
      id: 'decision',
      header: request.display_name?.slice(0, 12) ?? request.tool_name.slice(0, 12),
      question: `${title}\n${desc}`,
      multiSelect: false,
      options: [
        { label: 'Allow', description: '允许本次执行' },
        { label: 'Always Allow', description: '在本会话中始终允许此类操作' },
        { label: 'Deny', description: '拒绝执行（可在自定义输入框填写修改意见）' },
      ],
    }]

    this.session.append('tool/call', {
      turn: this.turnCount,
      step: this.stepCount,
      callId,
      name: 'ask_user_question',
      arguments: { questions: dshApprovalQuestion },
    })

    const decision = await this.hostCtx.userQuestions.ask({
      agent: this,
      sessionId: this.id,
      callId,
      questions: dshApprovalQuestion,
      signal: this.currentTurnAbort?.signal ?? new AbortController().signal,
    })

    const picked = decision.status === 'answered' ? decision.answers.decision : undefined
    const selected = picked?.selected?.[0]

    if (selected === 'Allow' || selected === 'Always Allow') {
      this.writeStdin({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id,
          response: {
            behavior: 'allow',
            updatedInput: request.input,
            ...(selected === 'Always Allow' && request.permission_suggestions
              ? { updatedPermissions: request.permission_suggestions }
              : {}),
          },
        },
      })
    } else {
      const rejectMsg = picked?.customText?.trim() || 'User denied permission for this tool call.'
      this.writeStdin({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id,
          response: { behavior: 'deny', message: rejectMsg },
        },
      })
    }
  }

  /** 用户在 DSH UI 点击 Stop 按钮时触发，向 claude.exe 发送 interrupt 控制指令而非粗暴杀进程 */
  cancel(cause: AgentCancelCause = { kind: 'user' }, _options?: AgentCancelOptions): void {
    if (this.status !== 'running') return
    this.currentTurnAbort?.abort(cause)
    if (this.proc && !this.proc.killed) {
      this.writeStdin({
        type: 'control_request',
        request_id: `int_${randomUUID()}`,
        request: { subtype: 'interrupt' },
      })
    }
    this.finishTurn({ kind: 'aborted', reason: cause })
  }

  private startTurn(): void {
    this.status = 'running'
    this.turnCount++
    this.stepCount = 0
    this.currentTurnAbort = new AbortController()
    this.session.append('turn/start', { turn: this.turnCount })
    this.hostCtx.emit('agent/status', { agent: this, status: 'running' })
  }

  private finishTurn(reason: any): void {
    if (this.status === 'idle') return
    this.session.append('turn/end', { turn: this.turnCount, reason })
    this.status = 'idle'
    this.hostCtx.emit('agent/status', { agent: this, status: 'idle' })
    for (const resolve of this.idleResolvers.splice(0)) resolve()
  }

  whenIdle(): Promise<void> {
    if (this.status === 'idle') return Promise.resolve()
    return new Promise(resolve => this.idleResolvers.push(resolve))
  }

  async runMaintenance<T>(task: () => Promise<T>): Promise<T> {
    return await task()
  }
}
```

---

### 模块 3：与 `dsh-superagent-prototype` 的集成点改造

你现有的 [dsh-superagent-prototype](dsh-superagent-prototype/) 已经把 **Orchestrator 主会话 + 多 Ticket Worker 会话 + UI 跳转 + 结果自动 Relay** 的骨架搭好了，只需修改 3 个文件即可把 Claude Code 原生 Worker 接进去：

1. **[dsh-superagent-prototype/src/policy.ts](dsh-superagent-prototype/src/policy.ts)**：
   - 在 `Settings.executor`（或每个 Ticket 的 Assessment / 创建参数）中增加 `engine: 'claude-code' | 'dsh'` 字段，默认可设为 `'claude-code'`，同时允许主调度器根据任务类型按需选择（例如重度代码库改造派给 `'claude-code'`，轻量脚本或特定模型任务派给 `'dsh'`）。
2. **[dsh-superagent-prototype/src/app/sessions.ts](dsh-superagent-prototype/src/app/sessions.ts)**：
   - 在 [sessions.ts:138-155](dsh-superagent-prototype/src/app/sessions.ts#L138-L155) 的 `Sessions.ensure(id, cwd, title, role, engine)` 中：
     - 当 `role === 'worker' && engine === 'claude-code'` 时，不再调用 `ctx.sessionController.create()` 创建默认的 `ReactLoopAgent`，而是实例化上面的 `ClaudeCodeWorkerAgent`，通过 `ctx.sessions.enter` + `ctx.agents.enter(agent, undefined)` + `ctx.sessions.announce` + `ctx.agents.announce` 注册为顶层 Root Agent。
     - 将 `claudeSessionId` 保存在 `Store` 的 `KV` 中（与 `worker-${ticketId}` 绑定），这样即使 DSH 重启，也能通过 `claude --resume <claudeSessionId>` 恢复同一个 Claude Code 原生会话。
3. **[dsh-superagent-prototype/src/executor/dsh.ts](dsh-superagent-prototype/src/executor/dsh.ts)**：
   - `DshExecutor` 原本就已经通过监听 `ctx.on('agent/status')`（见 [dsh.ts:479-487](dsh-superagent-prototype/src/executor/dsh.ts#L479-L487)）和读取 `agent.session.snapshotEvents()` 中的最后一条 `assistant/message`（见 [dsh.ts:659-671](dsh-superagent-prototype/src/executor/dsh.ts#L659-L671)）来感知 Worker 轮次结束并自动 `relay()` 给主 Session。
   - 因为 `ClaudeCodeWorkerAgent` 严格遵循了 `agent/status` 事件和 `assistant/message` Session 日志格式，`DshExecutor` 的队列、槽位控制（`WorkerSlots`）、自动向主调度器汇报（`resultRelay`）、以及你在 Worker 会话里直接打字插话（`this.personal` 检测）**无需改动即可直接复用**！

---

## 五、 这套方案运行起来的真实交互体验

1. **派活阶段**：
   你在 DSH 主会话（Orchestrator）对 DeepSeek 说：*“帮我重构 `auth` 模块，派给 Claude Code 干，另一个文档翻译任务派给自带的 DeepSeek Worker 干。”*
2. **原生会话出现在左侧栏**：
   DSH 界面左侧会话列表立刻多出两个顶层会话：`[CC] worker-auth-refactor` 和 `[DSH] worker-doc-translate`。
3. **实时观看与提问交互**：
   - 你可以随时点进 `[CC] worker-auth-refactor` 会话，看到原生 Claude Code 正在流式输出 Thinking、调用它自己的原生 `Read`/`Grep`/`Edit`/MCP/Skills。
   - 当 Claude Code 对架构拿不准、调用它原生的 `AskUserQuestion` 时，或者需要权限审批时，**DSH 界面上直接弹出交互式选项卡**（同时主调度会话也能收到提醒告诉你某个 Worker 正在等你拍板）。
   - 你在 DSH 界面上点选答案后，Claude Code 立即在同一个进程、同一个上下文中继续往下写代码。
   - 你甚至可以直接在 `[CC] worker-auth-refactor` 的聊天框里随时打字插话（Steer）或者追问，完全就是原生 Claude Code 的体验。
4. **交工汇总**：
   Claude Code 干完活进入 `idle` 后，最后一条总结会自动通过 `relay` 推送回外层的 DeepSeek 主调度器，由主调度器向你汇总全局进度或触发下一步流水线。

---

如果你认可这个方案，下一步我可以：
1. 先写一个精简的测试脚本（在 `probe/` 下加上 `--permission-prompt-tool=stdio` 和 `initialize` 握手），现场实测验证 `claude.exe` 的 `AskUserQuestion` 和权限审批 `control_request` / `control_response` 完整闭环；
2. 然后直接在 `dsh-superagent-prototype` 中为你编写并集成 `ClaudeCodeWorkerAgent` 和多 Agent 引擎选择器。

你想先跑一下 `AskUserQuestion` 的 stdio 控制协议实测验证，还是直接开始在 `dsh-superagent-prototype` 里写代码实现？
---

## 实现勘误（2026-11-03 后续会话核对）

1. `ctx.userQuestions.ask(request)` 的真实签名是 `ask({ questions, agent?, signal?, wait?: { callId, timed? } })`，没有 `sessionId` 参数；问题对象用 `multi_select`（工具 schema），投影层再映射为 `multiSelect`。
2. DSH 内容块使用 `{ type: 'reasoning', text }`，不是 `{ type: 'thinking' }`。
3. `tool/call` 事件的 `arguments` 必须是 JSON 字符串；`tool/result` 必须用 `createToolResultMessage({ callId, content, isError })` 构造 `message`。
4. `turn()` 内部负责 `step/start`、`step/end` 与 `turn/end`，driver 覆写 `step()` 时不得重复追加这些生命周期事件。
5. `Sessions.ensure` 对 worker 设置 `danger-full-access`（approval policy `never`），因此工具审批必须全部经 `ctx.userQuestions` 变成 UI 卡片；不能依赖 `ctx.approval.request`。
6. Claude Code 的 `AskUserQuestion` 需映射为 DSH 的 `ask_user_question`；答案通过 `control_response` 的 `updatedInput.answers` 回传，同时移除 DSH 产生的 `user-question-reply` inbox 消息，避免后续步骤重复投递同一答案。
7. 真实 CLI 需要 `initialize` control_request 握手后才发送 `can_use_tool`；stdout 事件为 `system/init`、`assistant`、`user`（tool_result）、`control_request`、`result`。
8. 子代理（`parent_tool_use_id != null`）的消息默认只记录日志、不投影为主会话消息，避免侧链污染主线程；其结论由 Task 工具的 tool_result 带回。

---

## 实现状态（2026-11-03，2026-11-04 补真实 CLI 冒烟）

方案已落地，最终没有自定义 `ClaudeCodeWorkerAgent`，而是在 `Sessions.decorate` 中给 worker 的现有 `ReactLoopAgent` 挂载 `ClaudeCodeDriver`，只覆写实例 `step(decision)`。DSH 继续负责 turn/step 生命周期、Session 持久化、顶层 Session 注册、状态、inbox 和 relay。

已实现：

| 文件 | 内容 |
| --- | --- |
| `src/executor/claude-code.ts` | 持久 `claude` 进程、stream-json 投影、卡片资源经 `orchestrator_read` 展开、`AskUserQuestion` / 工具权限卡片、`DSH_REPORT` 经 `orchestrator_report` 执行、`--resume` 失败重试，并把 `DSH_SUPERAGENT_*` 执行变量传给原生进程 |
| `src/core/model.ts` | `EngineName` 与 `Execution.engine` |
| `src/policy.ts` | Executor 的 `engine`、`claudeBin`、`claudeModel`、`claudePermissionMode` |
| `src/app/sessions.ts` | worker 装饰时按 engine 提前挂载 driver；Claude worker 不再初始化 DSH 模型 |
| `src/app/tools/main.ts` | 接单时可按工单覆盖 engine |
| `src/kv.ts` | 按 Session 保存 Claude Code session id |
| `src/app/settings.ts` | Claude 相关设置只允许面板修改 |
| `src/client/execution.tsx`、`src/client/locales.ts` | Execution 设置中的引擎选择与 Claude 字段 |
| `docs/003-execution.md`、`docs/007-architecture.md` | 引擎行为、模块与测试表 |
| `tests/claude-code.spec.ts`、`tests/claude-code-driver.spec.ts` | 纯映射测试，以及用假 stream-json 进程覆盖回合投影、报告、resume 重试、问题与权限控制流；后者另含一个 `CLAUDE_CODE_SMOKE=1` 才运行的真实 CLI 冒烟用例 |

启用方式：打开 DSH 面板 → Execution 设置 → Worker engine 选 `claude-code`（可按需填写可执行文件、模型、权限模式）→ 新接单的工单即运行在原生 Claude Code 进程上。工单在接单时记录引擎，之后改设置不回改已有工单。

验证：`tsc --noEmit`、上述测试与 `tsdown` 构建通过；2026-11-04 以 `CLAUDE_CODE_SMOKE=1` 在 `probe/` 目录跑通一次真实原生 CLI 回合（启动、流式投影、`DSH_REPORT` → `orchestrator_report`、session id 落库）。全量测试中剩余的失败均为仓库原有的 Windows 环境/路径用例（commands、deployment、docs 路径分隔符、environment、prompts、runtime、service-script、sources、store 权限）。当前工作区没有可运行的 DSH host，因此尚未在真实 DSH Web UI 中做端到端冒烟；CLI 的 `initialize`、`AskUserQuestion` 控制协议已由 `probe/probe4.ps1` 单独验证。

## 直接派单：不依赖 GitHub 触发（2026-11-04）

个人使用时不需要先建 Issue 或评论；主 Session 现在可以直接接单：

- 在 DSH Web UI 打开主 Session（标题 `dsh-superagent orchestrator`），直接说需求，例如“把 Hajimi 工作台的首页标题和卡片间距调大，用 claude-code 做；再把‘提交’按钮文案改成‘保存’，用 dsh 做”。
- 主 Session 调 `orchestrator_task_start`，每个任务生成一个 `operator` Trigger 和一个显式接单的 Ticket；`engine` 按你指定的来（`claude-code` 或 `dsh`），不指定就用 Execution 设置。
- 追加要求用 `orchestrator_task_message`，停止用 `orchestrator_task_stop`，查看进度用 `orchestrator_read` 或直接看左侧的 worker Session。
- 这些 Ticket 没有外部渠道，worker 的报告和提问会回到主 Session，直接在对话框回答即可；不会调用 `orchestrator_reply`，也不会代你去 GitHub 留言。

实现：`src/core/operator.ts`（内部 operator Source）、`Engine.startTask` / `Engine.instruct`、`src/policy.ts` 对 operator Trigger 的显式准入、`src/app/tools/main.ts` 的三个工具、`prompts/operator.md` 主 Session 提示。GitHub Source 是否开启都不影响直接派单。