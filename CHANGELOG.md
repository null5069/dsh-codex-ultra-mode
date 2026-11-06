# Changelog

## 0.2.0 — 2026-11-06

- Target DeepSeek Harness 0.2.x (peer range `^0.2.0-rc.1`); `0.2.0-rc.1` and newer are supported. 0.1.x remains the DSH `0.1.1-rc.2` line.
- Fix `format v4 message requires a producer-owned source kind`: plugin notices now use the producer-owned `plugin:dsh-codex-ultra-mode` source kind instead of the retired V3 `{ kind: "plugin", plugin: ... }` wrapper. This was the error that aborted every `/ultra` activation on DSH 0.2.x.
- Port `spawn_agent` to `subagents.startActivation({ delivery: "parent" })`, with a runtime fallback to `subagents.startContinuable` on `0.2.0-rc.1`, `0.2.0-rc.2`, and `0.2.1-alpha.1`, which predate `startActivation`.
- Port `followup_task` from `subagents.followup` to `subagents.sendMessage` (delivered at the child's next step boundary).
- Port completion-barrier and unload drain from `subagents.drainContinuableChildren` to `subagents.drainChildren`.
- Drop the per-start `toolFilter`: DSH 0.2.x moved child tool composition to Agent Presets. Single-writer remains enforced at call time by the plugin's `tools.guard`, which denies mutating tools below depth 0.

## 0.1.0 — 2026-08-25

- Add deterministic `/ultra <goal>` activation.
- Add scoped `spawn_agent`, `followup_task`, and cursor-based `wait_agent` tools.
- Reuse DSH-native `send_message`, `interrupt_agent`, `list_agents`, and child `report`.
- Add tree-wide concurrency, depth, and total-agent limits.
- Add a bounded event-driven completion barrier with exact branch-forest drain and a hard closing gate.
- Add first-step activation, run epochs, cold-resume failure handling, exact unload cleanup, and atomic cold-wake reservations.
- Deny native one-shot/detached subagent tools inside Ultra and add configurable third-party mutation-tool denial.
