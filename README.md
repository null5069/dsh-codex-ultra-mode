<p align="right"><a href="./README.zh-CN.md">简体中文</a></p>

# dsh-codex-ultra-mode

[![npm version](https://img.shields.io/npm/v/dsh-codex-ultra-mode.svg)](https://www.npmjs.com/package/dsh-codex-ultra-mode)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

An Ultra-like dynamic multi-agent mode for DeepSeek Harness. With `/ultra <goal>`, the root agent can create focused, continuable subagents as the task evolves, follow up with them, wait for lifecycle events, reconcile conflicting findings, and deliver one integrated result.

> This is an independent behavioral reimplementation based only on publicly documented OpenAI orchestration semantics. It contains no OpenAI private code and does not claim to reproduce undisclosed Codex prompts, routing algorithms, or model capabilities.

## Why this is not Agent Team 2.0

Agent Team is designed for long-lived named members, task boards, DAGs, and member-to-member communication. Ultra is designed for dynamic decomposition and collection within one complex goal. This plugin does not create team files, mailboxes, or a second scheduler. Instead, it builds directly on the continuable subagent runtime in DSH 0.2.x (`0.2.0-rc.1` or newer).

After `/ultra` activates a task, the plugin adds three scoped tools to that agent tree:

- `spawn_agent`: creates continuable subagents that can recursively delegate; supports `fork_turns=none|all`.
- `followup_task`: reuses an existing subagent's context for another turn.
- `wait_agent`: waits for revision-cursor events without polling, acknowledging, or deleting original DSH messages.

The remaining capabilities come directly from DSH:

- `send_message`
- `interrupt_agent`
- `list_agents`
- The subagent `report` tool

## Current capabilities

- Model-directed dynamic delegation without requiring a static DAG up front.
- Subagents can create their own descendants.
- Tree-wide defaults of three active subagents, depth three, and twelve total subagents.
- One model response can issue multiple `spawn_agent` calls in parallel. Cross-branch creation, native `send_message` wake-ups, and `followup_task` cold wake-ups share atomic concurrency slots.
- `subagent/start/end`, reports, and settlement notices enter a bounded event mirror with monotonic revisions. By default, it retains the latest 512 events and mirrors up to 2,000 characters of message text; original DSH sessions remain the complete source of truth.
- If a root or subagent tries to finish while descendants are still running, it receives completion-barrier steering. Once the configured model-step budget is exhausted, the runtime precisely releases that agent's direct Ultra branches and their descendant forests, then requires a disclosed failure and final synthesis instead of appending model steps forever.
- Single-writer mode is enabled by default: subagents must remain read-only, and the plugin blocks standard DSH shell and file-mutation tools. Third-party or MCP mutation tools must be listed in `childDenyTools`. This is a collaboration guardrail, not a general-purpose security sandbox.
- Native DSH `subagent` and `subagent_fork` creation is disabled inside an Ultra tree so one-shot or detached jobs are not mixed with continuable lifecycles. Use `spawn_agent` for all Ultra work.
- Tools are injected only into an activated agent tree, so ordinary DSH sessions pay no additional tool or system-prompt cost.
- The plugin reuses DSH's native subagent UI and session storage; no additional frontend is required. Ultra topology, revision cursors, and concurrency counters are process-local.

## Installation

DeepSeek Harness `0.2.0-rc.1` or newer (0.2.x) is required. Install from npm:

```bash
dsh plugin --profile web add dsh-codex-ultra-mode@0.2.0
```

If `dsh` is not on `PATH`:

```bash
npx @deepseek-ai/dsh@0.2.1-rc.3 plugin --profile web add dsh-codex-ultra-mode@0.2.0
```

Validate the composed profile and restart DSH Web:

```bash
dsh --profile web --dump-config
dsh web
```

The plugin is host-only and does not require a separate browser bundle build.

For source development:

```bash
git clone https://github.com/null5069/dsh-codex-ultra-mode.git
cd dsh-codex-ultra-mode
npm install --ignore-scripts
npm test
dsh plugin --profile web add link:"$PWD"
```

## Usage

```text
/ultra audit this codebase for authentication flaws, implement the important fixes, and run regression tests
```

`/ultra` authorizes proactive, dynamic delegation; it does not force every task to create subagents. The root agent should handle tasks directly when they are small, strictly sequential, or likely to create severe shared-write conflicts.

Agent Team and Ultra complement each other:

- `/agent-teams`: long-running collaboration with persistent task boards and member-to-member communication.
- `/ultra`: one-command parallel investigation, verification, and synthesis for the current goal.

They can be installed in the same profile, but currently should be used in separate sessions, with one orchestration protocol per session. Ultra does not include Agent Team members in its concurrency budget, event waits, or completion barrier, so do not mix `/ultra` and `/agent-teams` within the same task.

## Configuration

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

`allowWorkflow=false` is intentional. DSH workflows are fixed, scripted foreground fan-outs whose default concurrency depends on CPU count; their semantics differ from Ultra's turn-by-turn model decisions. Enable it only when you truly need tens to thousands of homogeneous jobs, or run the workflow in a non-Ultra session.

`maxBarrierSteps` is the model-step budget for the completion barrier. When it is exhausted, the plugin uses DSH's precise child drain to release unfinished branches instead of merely sending a recoverable interrupt. The hot path waits up to `barrierDrainMs`; a drain that exceeds this limit continues in the background while its branch is marked failed locally and prevented from creating or waking further work. This keeps root cancellation and finalization from hanging. Running `/ultra` again does not clear the closing state until the background drain actually settles; after settlement, `/ultra` can reactivate the tree even if DSH also returned a teardown diagnostic. Only an underlying drain that never settles requires a reload. Setting `slashCommand=false` disables both command registration and activation through a raw `/ultra` gesture.

If third-party tools can mutate the workspace or external systems, add their exact tool names to `childDenyTools`. For example:

```yaml
childDenyTools: [apply_patch, github_create_pull_request]
```

## Known differences from Codex Ultra

- This project reproduces only publicly observable behavior. It cannot copy private routing logic or model training.
- DSH currently queues `send_message` for a subagent's next turn and wakes an idle subagent. This is not identical to the OpenAI API semantic of delivery without wake-up.
- The first release supports only `none` and `all` for `fork_turns`, not an exact number of recent turns.
- DSH follow-ups are limited to a direct parent sending to a direct child; there is no sibling peer-to-peer follow-up.
- `/ultra` activation is process-local. DSH persists subagent sessions, but after a restart the Ultra tree, event mirror, and counters are not rebuilt automatically. Run `/ultra` again in the root session; old child sessions can be handled separately through DSH's native session capabilities.
- Uninstalling or hot-reloading the plugin precisely drains branches created directly by the active Ultra root before withdrawing scoped tools. It does not cancel non-Ultra subagents under the same root. Run `/ultra` again after a reload.
- Precise child drain releases the corresponding activation and descendant forest and discards pending inbox work that branch has not claimed. The underlying DSH session record remains, and DSH can cold-resume it under its own native rules. If the drain settles in the background after `barrierDrainMs`, its late settlement notice may still wake an already-finished root; treat that as a diagnostic from the previous run, not as a new result.
- Single-writer mode can block only standard tools and exact names listed in `childDenyTools`; it cannot automatically infer side effects for arbitrary third-party tools. If you disable it, you must ensure write scopes do not overlap.
- The `wait_agent` revision mirror is a bounded summary, not a complete audit log. If an old cursor overflows, the result includes `truncated=true`; inspect the original DSH sessions or recollect conclusions.
- `wait_agent.agent_ids` controls exact wake-up targets and status snapshots only. Because revisions are global across the whole tree, returned `events` always include every tree event after the cursor, preventing updates from other branches from being skipped when targets change.
- The current implementation targets the DSH 0.2.x prerelease API (`0.2.0-rc.1` and newer are supported; `0.2.0-rc.1`, `0.2.0-rc.2`, and `0.2.1-alpha.1` still use `startContinuable`). Rerun the integration tests when upgrading DSH.

## Development verification

```bash
npm test
npm pack --dry-run
```

The test suite covers first-step activation timing, command boundaries, hierarchical trees, concurrency/depth/total limits, cold-resume failure, startup rollback, completion barriers, message cursors, truncation and cancellation, tool-output schemas, uninstall cleanup, and package structure. The current smoke test uses DSH's real JSON Schema validator with a simulated host lifecycle. Full model-routing quality still needs representative comparisons of single-agent, Agent Team, and Ultra success rate, latency, and token usage.

## Naming

Codex and Ultra are names associated with OpenAI products or features. This is an independent community compatibility plugin and is not affiliated with or endorsed by OpenAI.
