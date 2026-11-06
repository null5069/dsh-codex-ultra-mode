/** Public, deterministic policy helpers for the Ultra activation boundary. */

export const ULTRA_COMMAND = "ultra";
/**
 * Producer-owned source kind for every message this plugin injects. DSH 0.2.x
 * refuses the retired V3 `{ kind: "plugin", plugin: ... }` wrapper at session
 * admission, so plugin notices carry `plugin:<name>` instead.
 */
export const ULTRA_SOURCE_KIND = "plugin:dsh-codex-ultra-mode";
const ULTRA_GESTURE = /^\/ultra(?=$|[\t\n\r ])/u;
const TASK_NAME = /^[a-z][a-z0-9_-]{0,47}$/u;

export const DEFAULTS = Object.freeze({
  spawnProvider: "spawn",
  forkProvider: "fork",
  maxConcurrentSubagents: 3,
  maxDepth: 3,
  maxTotalSubagents: 12,
  maxWaitMs: 30000,
  maxBarrierSteps: 8,
  barrierDrainMs: 10000,
  eventHistory: 512,
  promptSectionOrder: 118,
  singleWriter: true,
  childDenyTools: Object.freeze([]),
  allowWorkflow: false,
  slashCommand: true
});

export const MUTATING_CHILD_TOOLS = Object.freeze([
  "bash",
  "bash_persistent",
  "pwsh",
  "pwsh_persistent",
  "write",
  "edit",
  "str_replace_editor"
]);

export function resolveConfig(config = {}) {
  const childDenyTools = Object.freeze([...new Set(config.childDenyTools ?? DEFAULTS.childDenyTools)]);
  return Object.freeze({
    ...DEFAULTS,
    ...config,
    spawnProvider: config.spawnProvider ?? DEFAULTS.spawnProvider,
    forkProvider: config.forkProvider ?? DEFAULTS.forkProvider,
    maxConcurrentSubagents: config.maxConcurrentSubagents ?? DEFAULTS.maxConcurrentSubagents,
    maxDepth: config.maxDepth ?? DEFAULTS.maxDepth,
    maxTotalSubagents: config.maxTotalSubagents ?? DEFAULTS.maxTotalSubagents,
    maxWaitMs: config.maxWaitMs ?? DEFAULTS.maxWaitMs,
    maxBarrierSteps: config.maxBarrierSteps ?? DEFAULTS.maxBarrierSteps,
    barrierDrainMs: config.barrierDrainMs ?? DEFAULTS.barrierDrainMs,
    eventHistory: config.eventHistory ?? DEFAULTS.eventHistory,
    promptSectionOrder: config.promptSectionOrder ?? DEFAULTS.promptSectionOrder,
    singleWriter: config.singleWriter ?? DEFAULTS.singleWriter,
    childDenyTools,
    allowWorkflow: config.allowWorkflow ?? DEFAULTS.allowWorkflow,
    slashCommand: config.slashCommand ?? DEFAULTS.slashCommand
  });
}

/** Return the latest leading `/ultra` goal from genuine user messages. */
export function invokedUltraGoal(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.source?.kind !== "user") continue;
    for (const block of message.content ?? []) {
      if (block.type !== "text") continue;
      const text = block.text.trimStart();
      if (!ULTRA_GESTURE.test(text)) continue;
      return text.slice(ULTRA_COMMAND.length + 1).trim();
    }
  }
  return undefined;
}

export function normalizeTaskName(value) {
  if (typeof value !== "string" || !TASK_NAME.test(value)) {
    throw new Error("task_name must start with a lowercase letter and contain only lowercase letters, digits, _ or - (max 48 characters)");
  }
  return value;
}

export function buildActivationDirective(goal) {
  const goalLine = goal === ""
    ? "No goal was supplied. Ask the user for the goal before spawning agents."
    : `Current goal: ${goal}`;
  return [
    "The user activated `/ultra`. Enable the Ultra orchestration policy from your system instructions for this session.",
    goalLine,
    "Dynamically delegate only when independent workstreams materially improve speed or quality; otherwise solve the task directly."
  ].join("\n");
}

export function buildUltraPolicy(node, config) {
  const role = node.depth === 0
    ? "You are `/root`, the primary agent. You alone produce the user-facing final answer."
    : `You are ${node.path}, a subagent reporting to ${node.parentPath}.`;
  const writer = config.singleWriter
    ? "Single-writer safety is enabled: subagents must remain read-only. Standard DSH shell and filesystem mutation tools are blocked for them. Inspect and analyze with read/glob/grep/web tools, report exact evidence and proposed patches, and leave all workspace mutation and test execution to `/root`."
    : "The workspace is shared. Delegate disjoint files only, never overwrite another agent's work, and let the parent integrate and test changes.";
  const workflow = config.allowWorkflow
    ? "Use workflow only for a fixed, high-volume fan-out where no fresh model judgment is needed between stages."
    : "Do not call workflow in Ultra mode; this mode is dynamic, model-directed orchestration rather than a fixed execution graph.";
  const nativeSpawn = "Do not call native subagent or subagent_fork spawn tools; use spawn_agent so every child is named, continuable, and tracked by the Ultra tree.";

  return `Ultra-like dynamic multi-agent orchestration is active for this agent tree.
${role}

Collaboration protocol:
- Proactively spawn subagents when the task splits into at least two concrete, independent, bounded workstreams. Good cases include separate codebase regions, competing failure hypotheses, independent research, implementation review, and adversarial verification.
- Prefer one agent for small tasks, strict sequential reasoning, work dominated by one external operation, or work requiring frequent writes to the same mutable state.
- Use the minimum useful team, normally 2–3 agents. The whole tree may have at most ${config.maxConcurrentSubagents} active subagents at once, depth ${config.maxDepth}, and ${config.maxTotalSubagents} subagents total.
- Use spawn_agent for dynamic continuable children. Start independent children together in one assistant message. Use fork_turns=all only when completed conversation history is genuinely needed; otherwise provide a standalone task with fork_turns=none.
- Every task must state scope, expected output, evidence requirements, permissions, and a stopping condition. A child may spawn its own children when its subtask cleanly divides further.
- Use send_message for additional context and followup_task for a new/resumed turn. DSH queues both at a child turn boundary; neither can redirect a turn already in progress.
- Continue useful parent work while children run. When there is nothing useful left, call wait_agent. Use list_agents for a snapshot, not busy polling. Use interrupt_agent only to stop a genuinely obsolete or stuck turn.
- Before finishing a turn, every continuable child must call report once with a self-contained result. Parents must also inspect lifecycle settlement notices, verify evidence, reconcile conflicts and duplicates, state failed branches, and synthesize rather than concatenate reports.
- Do not give a final answer while descendants are starting or running. The runtime may steer you back to wait_agent if you try.
- Agents are equally capable and may use the same non-mutating tools, but authority and safety boundaries do not expand through delegation.

${writer}
${workflow}
${nativeSpawn}`;
}

export function messageText(message, maxChars = 2000) {
  const text = (message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
