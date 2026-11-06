# 003 Execution

This document follows an accepted Ticket through execution, delivery and recovery. It builds on [001 Domain model](001-domain.md) and [002 Authorization](002-authorization.md).

## Ticket stages

Each open Ticket has one stage, determined by what it is waiting for. Read the table from top to bottom; the first matching row wins.

| Stage | Condition | Panel label |
| --- | --- | --- |
| person / delivery | Delivering an Input to the Executor Session failed; it is retried after 2 seconds, then after a delay that doubles up to a minute, and a success, a new Assignment or the Ticket's end clears it | Input undelivered |
| person / answer | It has an Attention | Awaiting answer |
| person / review | The latest Report is `ready` | Awaiting review |
| person / blocked, failed | The latest Report is `blocked` or `failed`, and no person's message reached the Ticket since | Blocked · Failed |
| working / queued | No Assignment, or a pending one | Queued |
| idle | The latest Report is `waiting`, or the Assignment ended | Waiting for a Trigger |
| working | Everything else | Working |

A `person` stage means the Ticket cannot continue without human input. A new human message releases a `blocked` or `failed` Ticket to its Executor, so it moves to the next matching stage, usually `working`.

An `idle` Ticket has finished its turn without an outstanding question. A Trigger on a subscribed Thread can continue it.

## The Executor

Each Ticket gets an Executor Session named `worker-<ticket id>`. Its directory depends on the execution directory mode. `per-ticket`, the default, creates a directory named after the Ticket's short name under the configured execution root, which defaults to `<stateDir>/work`; `fixed` runs every Ticket in the root itself. The fixed mode suits a deployment that works directly in one checkout, and concurrent Tickets then share that workspace, so their branches and files can collide.

### Task types

With no types configured, the executor root and mode above apply unchanged, and `execution.taskTypeSource` is `legacy`. Once Execution settings define task types, the Ticket's type decides instead: its `directory` and `directoryMode` replace the executor root and mode, its `model` (or the executor model when empty and both use the same engine) becomes the worker's model, and its `instructions` join the worker system prompt. The type also carries its execution profile: `engine` (the worker engine), `prepare` and `blockedCommands`, the Claude Code parameters `permissionMode`, `approval` and `ultracode`, and the opencode parameters `agent`, `approval` and `permissionPreset`. Each null field inherits the executor's fallback, while an empty `prepare` command or an empty `blockedCommands` list is an explicit "none". The model is one three-part route (provider, model, reasoning effort) for every engine: the panel asks the chosen engine for its catalog, so switching the engine changes the providers, models and efforts the picker offers, and a route belongs to one engine (an engine's default is not inherited by a type on another engine).

There is no default task type, and work cannot proceed unclassified: every accepted Ticket and every accepted Eval decision must name one of the configured type ids. Work that cannot be classified is refused with `unclassifiedWork`, and an id that is not among the configured types is refused with `unknownTaskType`.

The type comes from the first available evidence, in order: an explicit id from the sorter or operator, the Source's default for the Trigger, then the assessor's chosen type. An explicit id is always final: an unknown explicit id is refused even when a Source default exists, and when no evidence names a type the work is refused. The sorter chooses only a type id; the host resolves and snapshots the profile (the engine and its source, `prepare`, `blockedCommands` and the engine parameters), so a later settings edit does not move an in-flight Ticket.

A Source can set its own default. A Feishu chat row's `taskType` covers messages in that chat, and a GitHub Source's `taskType` covers every Trigger from its repository; both apply only when the sorter omits the type. The panel shows how a Ticket's type was chosen next to it, from `execution.taskTypeSource`: **Sorter specified**, **Source default**, **Assessor chosen**, or **Legacy**.

Executor Sessions run commands without approval as the operator's OS user. Their `dsh-superagent-worker` preset contains the tools needed for work and moves foreground shell commands to background jobs after 5 seconds. This lets a worker receive new messages at the next step instead of waiting for a long command to finish.

A task type can set `readOnly: true`. Its Executor Sessions are created under the `dsh-superagent-worker-readonly` preset, whose tool surface is only the skills plus the BQA read-only MCP retrieval tools (`mcp__bqa__search_knowledge`, `mcp__bqa__search_code`, `mcp__bqa__read_excerpt`): it has no shell, file, web or delegation tools, so nothing in the Session can write a file or regain that through a subagent. The Session also runs under the deployment's `read-only` file sandbox permission preset with approvals disabled, so a write attempt fails closed instead of prompting a person. A deployment that defines no `read-only` permission preset refuses such a Ticket rather than running its worker writable. A `ready` report of such a Ticket records the worker Session's provider-reported token usage and its BQA retrieval calls, which the BQA channel relays with the answer for display and evidence.

The main Session uses `dsh-superagent-router`, with the same 5-second shell and job-wait limits and a smaller tool set for routing. Sessions retain the preset selected at creation. Worker subagents use DeepSeek Harness's `standard` preset.

### The worker engine

The Ticket's task type chooses the engine for newly accepted Tickets; an explicit engine on the acceptance overrides it, and the executor's global engine is the fallback. Each Ticket keeps the engine recorded when it was accepted (`execution.engine`, with `execution.engineSource` naming which evidence chose it: `explicit`, `type` or `global`). The global engine, prepare command, blocked commands and engine fallbacks remain in the settings API, but the panel hides them in favor of the task types. The model and reasoning effort are the type's shared execution model on every engine (see above). Under `dsh`, the Executor is DeepSeek Harness's own model loop with the presets, tools and shell limits above. Under `claude-code`, one persistent native `claude` process drives the Executor Session:

- The first step starts `claude` in the Ticket directory with stream-json input and output. The process stays alive across turns, so its multi-turn conversation remains native rather than a series of one-shot calls.
- The assignment, Triggers, Inputs and messages a person types into the Session are sent as user messages. A card's `read` reference is expanded through the worker's `orchestrator_read` tool first, so the native worker sees the full request instead of only its preview. The worker uses Claude Code's own tools, skills, plugins, hooks, MCP servers and `CLAUDE.md`; DeepSeek Harness's work-tool set and shell job limits do not apply to it. The Ticket directory and prepare command still do, and the process inherits the worker command shims and git configuration, so `gh` and `lark-cli` act as the agent account and blocked commands fail by name.
- The worker reports by ending its final message with a `DSH_REPORT` line. The host executes the worker's `orchestrator_report` tool with that report, so Ticket state, relays to the main Session and handoff rules are the same as for a DSH worker. The line is removed from the visible conversation.
- The permission mode decides what Claude Code does without asking: `auto` reviews actions with its classifier, `default` (Manual) asks for most of them, `acceptEdits` accepts edits, `plan` only reads, and `bypassPermissions` skips the checks. A tool call the mode still routes to the bridge is answered by the approval setting: `approve` allows it without a person, `deny` refuses it, and `ask` shows a DSH question card with Allow once and Deny. The default is `auto` with `approve`, so a Ticket runs unattended. `AskUserQuestion` always becomes a question card with its options, because it asks for a decision rather than a permission.
- The Claude Code session id is stored with the worker Session, so a restarted plugin resumes the same native conversation. A missing stored session is replaced by a fresh one and the step's messages are sent again.
- The configured executable, and the shared execution model and permission mode a Ticket accepted, apply to new worker processes: `--model` carries the model alias or id, `--effort` carries the reasoning effort, and `--settings '{"ultracode":true}'` turns on dynamic workflows. Without an executable, the host looks for `CLAUDE_CODE_BIN`, the per-user install, then `claude` on `PATH`.
- The worker instructions a DSH worker reads in its system prompt (the composed worker prompt, the Mandate and the task type's instructions) are appended to the bridge prompt, so a native worker follows the same policy and task-type text. The first card also carries the Mandate scope, such as BQA's `requestId`, which the DSH engine gets from the Ticket resource; a referenced resource beyond the card is expanded through the worker's `orchestrator_read` tool.

Under `opencode`, one persistent native `opencode acp` process per worker Session drives the Executor Session:

- The first step starts `opencode acp` in the Ticket directory. It speaks ACP v1 over stdio (JSON-RPC, one message per line); the process stays alive across turns, and closing its input makes it exit. The worker uses opencode's own tools, skills, agents, plugins, MCP servers and configuration; DeepSeek Harness's work-tool set and shell job limits do not apply to it. The Ticket directory and prepare command still do, and the process inherits the worker command shims and git configuration, so `gh` and `lark-cli` act as the agent account and blocked commands fail by name.
- ACP messages, thinking and tool calls are projected into the Session as the same `assistant/message`, `tool/call` and `tool/result` events the panel already renders; opencode's tool names are mapped to DSH's (`shell` to `bash`, `patch` to `edit`, `webfetch` to `web_fetch`, and so on). Subagent child sessions are logged but not projected into the main conversation.
- A question opencode asks through ACP (`elicitation/create`, the `question` tool) becomes a DSH question card: each field is one question with its options, and the person's answer returns to the same turn. Dismissing the question ends that turn (see the deviation below).
- A permission request (`session/request_permission`) is answered by the Ticket's `approval` setting: `smart` (the default) allows reads, searches and skills without a person and asks for writes, executions, paths outside the workspace and unknown tools; `ask` always asks; `approve` allows; `deny` refuses. A card offers only **Allow once** and **Reject**: there is no Always allow, because that would write a durable rule into the opencode project configuration and widen every later worker. A request nobody answers fails closed.
- **Known deviation:** rejecting a permission, or declining or dismissing a question, makes opencode end the whole prompt turn with `stopReason: "cancelled"`, not just fail that one tool call. DSH records the step as completed instead of failing the Ticket: the Executor reports waiting, and the person or a later input decides what happens next. Answering a card continues the same turn.
- The model and agent (`mode`) come from the Ticket's shared execution model and its snapshotted opencode profile, and are applied to the ACP session with `session/set_config_option` and `session/set_mode` before the first prompt. The model value is `provider/model`, with `#effort` when a reasoning effort is chosen. DSH does not move API keys: opencode uses the providers authenticated on this machine (`opencode auth login`, `opencode models`). An opencode task type must choose a model in the same picker every engine uses; the settings save refuses one without a model because the fallback default may be a free model this machine cannot authenticate ("provider authentication required").
- The ACP session id and its cwd are stored with the worker Session. After a restart the driver resumes the same conversation with `session/load`, which requires the same cwd; the history opencode replays after the load is discarded rather than duplicated. A load that fails starts a fresh session and resends the step's messages once.
- The executable is resolved from the executor's API-only `opencodeBin`, then `OPENCODE_BIN`, then the Windows npm-global install (`@opencode/cli/bin/opencode.exe`), then `PATH`; the `.cmd` wrapper is never used. A missing binary, an opencode older than 2.2, or a provider authentication error fails the launch with an actionable message (install/update opencode, `opencode auth login`); it never falls back silently to the DSH model loop.
- A read-only task type does not confine opencode's own tools. DSH withholds its own work tools and sets its read-only preset and approval policy for the Session, but the native opencode process runs with its own file and shell tools and its own permission model, and this build injects no per-type opencode rules. Do not point a read-only task type at opencode expecting a read-only worker.
- Each running worker owns one opencode process; the process count follows `maxWorkers` (three by default), and each process loads the user's opencode configuration and MCP servers. Give workers more memory and CPU headroom than a DSH-only worker needs.
- **Phase 1 limitation (Q4b=A):** the permission preset is not injected per type. It relies on the operator's global opencode configuration (an agent-scoped smart preset is the safe form; a top-level rule set also affects the person's own opencode sessions), and the panel records the choice without applying it. `opencode.permissionRules` stays in the API only and is hidden in the panel; injecting it per worker is Phase 2.

### Background work and worker slots

When a turn ends with shell jobs or subagents still running, the Ticket keeps its worker slot and stays working. It is not reported as waiting, and the main Session receives no waiting report. A completed job or subagent wakes the Executor with its result in the same slot. Once a turn ends with no background work, the Executor reports waiting normally.

After each turn, background work has at most 30 minutes to finish. At that limit, shell jobs are killed and the Ticket is reported waiting. The report includes the Executor's last words and which jobs were killed or subagents remain active. Subagents are allowed to continue. The Executor reads killed-job results on its next turn.

A handoff to a person frees the slot immediately and leaves the Report in effect. This applies after a `ready` Report or a question, unless another Input arrived since, and after any `blocked` or `failed` Report.

At handoff, subagents stop. Shell jobs, such as a server offered for review, may continue until the Assignment ends. They hold no slot and are exempt from the 30-minute limit, including after later turns. Their completion does not wake the Executor; it reads the results on its next turn.

A person can also start a turn by writing directly in the Executor Session. Its background work follows the same rules.

When an Assignment ends, its shell jobs are killed without waking the Session. Its subagents are released, and any completion turns they wake are dropped. The replacement Assignment and its waiting Inputs start after that shutdown finishes.

Stopping or restarting the plugin inside the DeepSeek Harness process uses the same shutdown path. Inputs not yet taken into Session history are retained. Shutdown waits up to 10 seconds for each worker's background work; a process restart ends that work outright. An Assignment interrupted while busy restarts with a recovery note.

Worker subagents, including nested ones, use DeepSeek Harness's `standard` preset with the worker's permissions. They retain only the worker's allowed work tools, and lose those tools when the Ticket ends. Under `standard`, a shell command moves to the background after 60 seconds. A subagent's jobs are killed when it ends.

### Preparing a Ticket directory

Before the first Assignment, if the Ticket directory does not exist, the prepare command runs once with `sh` in the execution root. It has ten minutes to finish. Without a prepare command, the worker starts in an empty directory. In the fixed directory mode the directory is the configured root itself, so the prepare command is skipped: the deployment already points at the workspace the worker should use.

The command comes from the Ticket's acceptance snapshot: its type's `prepare`, or the executor's when the type inherits (an empty value runs none). A Ticket accepted before per-type prepare commands existed resolves its type's command when it first launches. A fixed type's own `prepare` is stored and shown in the panel with a "does not run" note, but it never runs: the shared checkout must not be rewritten by concurrent Tickets.

A failed command fails the Ticket and records its output. A retry or a person's message on one of the Ticket's Threads tries preparation again. A typical command uses `git worktree` to create a checkout. A pull request belongs to the Ticket when its branch's last path segment matches the Ticket's short name.

### Concurrency

A Ticket holds a worker slot from the start of a launch, including preparation, or from the delivery that wakes its idle Executor. It also holds the slot throughout an active turn.

The configured concurrency limit applies to these slots, with one extra slot for a person's message or a status request. Such a wake can use the extra slot when normal slots are full, and takes the next free slot before a new launch. New work therefore cannot prevent a person from continuing an existing Ticket.

Other Inputs, such as CI results, wait for a normal slot. A launch waits in `working / queued` until a slot is free. Launches run concurrently, so a slow prepare command delays only its own Ticket.

### Execution variables

The prepare command and Executor instructions receive the same execution variables. The command reads environment variables; the Executor reads their values and descriptions in its prompt. None contains credentials.

| Variable | Registered by | Value |
| --- | --- | --- |
| `DSH_SUPERAGENT_DIR`, `DSH_SUPERAGENT_NAME`, `DSH_SUPERAGENT_TICKET` | Executor | The Ticket's directory, short name and id |
| `DSH_SUPERAGENT_BLOCKED_COMMANDS` | Executor | The commands the Ticket's task type declares; the deployment enforces every type's declared commands' union (see below) |
| `DSH_SUPERAGENT_GITHUB_REPOSITORY` | GitHub | The repository the Source watches, `owner/name` |
| `DSH_SUPERAGENT_GITHUB_ACCOUNT`, `DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL` | GitHub | The agent account and its commit email |
| `DSH_SUPERAGENT_GITHUB_NUMBER`, `DSH_SUPERAGENT_GITHUB_PR_HEAD` | GitHub | The Issue or pull request that started the Ticket, and its head ref when it is a pull request |
| `DSH_SUPERAGENT_FEISHU_BOT`, `DSH_SUPERAGENT_FEISHU_CHAT` | Feishu | The bot, and the chat that started the Ticket |

Ticket-specific values come from its directory and originating Trigger. Other values come from the current deployment settings. Only the panel can change execution environment settings; text sent to the main Session cannot change the configured shell command.

Workers reach GitHub through the agent account's `gh` and Feishu through the bot's `lark-cli`. Blocked commands fail when invoked by name.

Blocked commands are declared per task type and snapshotted onto each Ticket. The shim directory enforces the union of the executor's list and every type's declared list, so a command one type blocks fails for every Ticket on every engine (over-block, fail closed); a DSH worker shares the host process's `PATH`, so it cannot be limited per type. Each Ticket's worker prompt and prepare command receive only its own declared list. The shims intercept calls by name only: an absolute path still runs, so this is not a security boundary. `gh`, `git` and `lark-cli` cannot be blocked.

These wrappers and directories establish defaults, not a security boundary. A worker can still execute a program by absolute path.

## Merging

Auto-merge is governed by the **Delivery requirements** prompt. The host has no merge-specific decision logic.

By default, the Executor never enables auto-merge as the agent account: GitHub attributes the merge to whoever enabled it. Delivery requirements must name another account's CLI for merging. Without one, people merge the pull request.

The default instructions allow auto-merge only for a pull request opened for the Ticket, when it is ready, the required approvals cover the head commit, and additions plus deletions total fewer than 200 lines. Before pushing another revision, the Executor withdraws auto-merge.

Reviews without a body, such as approvals, also arrive as Triggers and can wake an Executor waiting for review. These instructions govern the agent, not GitHub's merge rules. To enforce approvals, require them in branch protection and dismiss stale approvals. Omit the merge CLI or remove the auto-merge paragraph to require manual merging.

## How a Ticket ends

- **Ready without a pull request:** a `ready` Report ends the Ticket as completed.
- **Nothing to do:** an Executor that finds no work for a person to act on, such as a request that does not reproduce or is superseded, reports `dropped`. The Ticket ends without a message, unless a matched rule asks for one, and a person's later message on its Threads resumes it.
### Pull requests

A Ticket follows the pull request it started from once its Executor reports it. It also follows each pull request opened from its branch once reported by the Executor or found by the GitHub Source. Reopened pull requests are followed again.

The Ticket is done when none of the pull requests it opened remain open. If it opened none, all pull requests it follows must be closed. It then ends with the outcome of the last relevant close and keeps its Subscriptions, allowing a later human comment to resume it.

A close does not end the Ticket while resumed, retried or recovered work is unfinished. It also waits if the Executor acknowledged or answered a follow-up it owns but has not since made a non-progress Report or ended a turn after reading that message. A later `ready` Report ends the Ticket once the same pull-request completion rule is satisfied.

Chat Channels receive one final notice about the pull-request outcome. GitHub already displays the outcome on the pull request itself. Removing a Ticket's Subscription to a pull request also stops it following that pull request.

"Awaiting review" therefore means a `ready` Report with a pull request.

### Follow-ups and context Threads

The Executor decides human follow-ups on its Ticket's own Threads. It handles in-scope requests and hands back requests beyond its scope or for another Ticket. Once no Executor owns the message, it becomes a candidate for the main Session. The main Session may otherwise act on the follow-up only to stop work at the person's request.

On a `per-thread` Source with continuous conversations (BQA), a later message on the same Thread joins the one host Ticket as an Input instead of opening another Ticket: a `ready` Report still ends the Ticket, and the next message resumes it in the same worker Session. Each such message carries its own facts in `TicketInput.note`, which `inputMessage` renders as the Input's routing note. For BQA the note names that question's retrieval `requestId`, which takes precedence over the `requestId` in the Ticket scope (the first question's). The answer callback is routed to the Channel of the question the Report answers (`reply_to_trigger_id`), else to the newest human BQA Input's Channel, else to the Ticket's first BQA Channel, so each question's answer carries its own `requestId`. Cancelling the current BQA question stops the continuous Ticket, ending that window's conversation; the next question starts a new Ticket and worker Session. Known limit: when BQA restarts, its reconciliation stops the Ticket of a pushed link whose request is no longer active, so a window with a question in flight loses its continuous conversation once; the next question starts a new Ticket and Session. A window is answered one question at a time: a question that arrives before the previous question's Ticket ends joins that Ticket as an unread Input, and if the Ticket ends first, the Input returns to Eval and may open a new Ticket, so BQA's serial question flow is the supported case.

An Input counts as read after the Session takes it into a step and subsequently reports or ends a turn. When a Ticket ends, unread messages that were not acknowledged, answered or handed back return to Eval, as described in [002 Authorization](002-authorization.md). Read messages left without action, such as thanks, do not.

Threads followed only for context still deliver messages, but do not give the Ticket ownership of human follow-ups or resume ended Tickets. Those messages can be assessed independently.

Sources poll subscribed Threads while a live Ticket subscribes, and for two weeks after the later of the last Trigger and the subscribing Tickets' end. Afterwards, messages arrive only through ordinary intake: GitHub notifications or Feishu live events.

## Failure and recovery

### Executor blocked or failed

When an Executor Session reports `blocked` or `failed`, or fails to start or errors, which records `failed`, the Ticket takes no automatic Input.

A passing failure of the model provider or the network, an HTTP 408, 429 or 5xx or a refused, reset or timed-out connection, is tried again first, three times with a growing backoff: a launch runs again, and a worker whose turn failed is told to go on; a failed prepare command is not tried again.

Once failed, CI and bot messages are recorded on it, but they are not delivered and do not wake the Session.

Its tools stay available, so a person can continue in the Session directly.

A launch that failed is not tried again on its own.

A person's message, a later Report that is neither `blocked` nor `failed`, or a retry ends the hold.

It is worked out from the stored Reports and Inputs, so a restart keeps it.
### Retry

Available while an open Ticket is in `person / delivery`, `person / blocked` or `person / failed`: a new Assignment, which starts its worker again and takes the Inputs that wait, is the remedy for each.

Once a person's message reached a blocked or failed Ticket, the Executor has the message, so the Ticket shows as working, or as queued when a failed launch starts again, and offers no retry, unless delivering that message failed.

A retry ends the current Assignment and starts a new one in the same Executor Session, directory, branch and pull request.

The Executor model applies only when a Session is created; an existing Session keeps its model.
### Restart

Running Assignments end with "host restarted" and new ones start with a recovery note that tells the Executor to check its directory, git history and GitHub before repeating any outside action, oldest Ticket first.

Assignments that are waiting, ready, blocked or failed stay as they are, unless an Input reached them after that Report, in which case they start again too.

Sessions, directories, Subscriptions, pending messages and the stored work below survive a restart, and so does the record of which messages each Executor Session took into its history, which a step does once it claimed them and before its model call: a message taken by a turn the restart cut off counts as read once a Report or the end of a turn follows, while one a step claimed but a cancel or error cut off before the history counts as unread.

A retry or a restart gives the new Assignment again the messages delivered to the Assignment it replaces that its Executor Session did not take, which a cancel or a cut-off step may have dropped; a copy still waiting in the Session, kept by a restart or persisted across a crash, is taken out before the new Assignment's first message, so the new delivery is the only copy.
### Stored work

What dsh-superagent does after a decision, such as relaying a candidate, a follow-up or a report to the main Session, launching an Assignment or delivering an Input, is stored first and done afterwards.

A relay or a delivery that fails, such as when its Session cannot be reached, is retried after 2 seconds, then after a delay that doubles up to a minute; a launch that fails fails its Ticket, unless the failure was a passing one, as above.

Each kind of work reports an error among the overview's system problems only after one item failed three times in a row; a failed Input delivery shows on its Ticket instead.

Relays to the main Session keep their order, and so do notices; a failed one holds back the later ones of its kind.
### Source failure

The GitHub Source reads each Issue, pull request and Thread on its own: a failed read keeps its error on its Thread, is read again on the next poll, and counts towards an error of the Source, which it reports after three failed polls in a row by default; any successful poll resets the count.

GitHub answers 404 also when the agent lost access to a private repository, so a 404 is retried.

A notified Issue or pull request whose reads keep failing is dropped a day after its first failed read, and at once when GitHub reports it as deleted; it then no longer fails the poll, its Thread keeps the error, and the Source's state names it.

Its read position stays where it was, so a later notification or a poll of its Thread reads what the failed reads missed.

The Feishu event consumer reports every failure, and polling of subscribed topics keeps each failure on its Thread.

A malformed item in a GitHub list or a Feishu page is skipped, and the Source's state counts it.
### Channel failure

Outgoing messages are stored and sent as stored work, retried with backoff from 5 seconds, doubling up to 300.

A Ticket's messages to one conversation go out in the order they were queued, so its acknowledgement comes before its later answer or result: a message waits while an earlier one of the same Ticket to the same conversation has not gone out, until that one has failed three times in a row and shows as a problem.

Messages of other Tickets, and messages of no Ticket, do not wait for it.

A message with failed attempts is a system problem until it goes out or is withdrawn.

A message is dropped only when its Source no longer listens to the conversation, or when the Source answers that the conversation can never receive it; while its Source is off, it waits.

The Sources answer that for a deleted Issue or a locked conversation on GitHub, and for a recalled message or one Feishu no longer finds on Feishu.

A reply to a review comment that no longer exists goes to the pull request's conversation instead.

A dropped message keeps its record, with when and why it was dropped and the Ticket it was for, so it is never queued again; a dropped acknowledgement reads as dropped, not sent.
### Pause processing

Stops dispatch, new Evals, Eval timeouts, Input delivery and replies; a launch already under way waits until processing resumes.

Sources keep recording Triggers, and a running Executor turn is not interrupted.

A person's message to an ended Ticket waits: the first pass after the pause resumes the Ticket, if its Mandate holds under the Policy then.

An Eval in progress does not expire during a pause; its deadline moves later by the pause's length.
### Invalid configuration

A stored Source configuration that its kind rejects disables that Source instance.
