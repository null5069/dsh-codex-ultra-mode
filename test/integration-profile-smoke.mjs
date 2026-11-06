import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

const listeners = new Map();
const sections = [];
const commands = [];
const scopedTools = [];
const starts = [];
const followups = [];
const guards = [];
const effects = [];
const rootToolDisposals = [];
const childToolDisposals = [];
const drains = [];
const pendingDrainRejectors = [];

const ctx = {
  systemPrompt: {
    section(definition) {
      sections.push(definition);
      return () => {};
    }
  },
  tools: {
    get() {
      return undefined;
    },
    guard(callback) {
      guards.push(callback);
      return () => {};
    }
  },
  subagents: {
    async startActivation(spec) {
      starts.push(spec);
      return { childId: spec.childId, messageId: "initial-message" };
    },
    async sendMessage(parent, childId, content, options) {
      followups.push({ parent, childId, content, options });
      return "followup-message";
    },
    async drainChildren(parent, childIds) {
      drains.push({ parent, childIds });
      if (drains.length <= 2) {
        await new Promise((_resolve, reject) => pendingDrainRejectors.push(reject));
      }
    }
  },
  commands: {
    register(definition) {
      commands.push(definition);
      return () => {};
    }
  },
  effect(factory, label) {
    const dispose = factory();
    effects.push({ label, dispose });
    return dispose;
  },
  inject(_names, callback) {
    callback(ctx);
  },
  on(name, callback) {
    const entries = listeners.get(name) ?? [];
    entries.push(callback);
    listeners.set(name, entries);
    return () => {};
  }
};

apply(ctx, { maxBarrierSteps: 1, barrierDrainMs: 5 });
assert.equal(commands.some((command) => command.name === "ultra"), true);

const agent = {
  id: "root-session",
  status: "running",
  options: {},
  session: { header: {} },
  ctx: {
    tools: {
      register(tool) {
        scopedTools.push(tool);
        return () => rootToolDisposals.push(tool.name);
      }
    }
  }
};
const messages = [{
  source: { kind: "user" },
  content: [{ type: "text", text: "/ultra smoke test" }]
}];
for (const listener of listeners.get("agent/inbox/inserted") ?? []) {
  listener({ agent, message: messages[0] });
}
assert.deepEqual(scopedTools.map((tool) => tool.name).sort(), [
  "followup_task",
  "spawn_agent",
  "wait_agent"
]);
const policy = sections.find((section) => section.name === "codex-ultra-mode:policy");
assert.match(policy.text({ agent }), /Ultra-like dynamic multi-agent orchestration is active/u);

const preStep = listeners.get("agent/pre-step")?.at(-1);
assert.equal(typeof preStep, "function");
const decision = await preStep(
  { agent, messages, signal: new AbortController().signal },
  async () => ({ kind: "enter", messages })
);
assert.equal(decision.kind, "enter");
assert.equal(decision.messages.at(-1).source.kind, "plugin:dsh-codex-ultra-mode");
assert.equal(scopedTools.length, 3, "pre-step activation must be idempotent");
assert.deepEqual(scopedTools.map((tool) => tool.name).sort(), [
  "followup_task",
  "spawn_agent",
  "wait_agent"
]);

const spawn = scopedTools.find((tool) => tool.name === "spawn_agent");
const spawned = await spawn.execute(
  { task_name: "research", message: "Inspect the auth boundary and report evidence.", fork_turns: "none" },
  { agent, signal: new AbortController().signal }
);
assert.equal(spawned.agent_name, "/root/research");
assert.equal(spawned.status, "running");
assert.equal(starts.length, 1);
assert.equal(starts[0].provider, "spawn");
assert.equal(starts[0].request.maxDepth, 3);
assert.equal(starts[0].delivery, "parent");

const childScopedTools = [];
const child = {
  id: spawned.agent_id,
  status: "running",
  options: {},
  session: { header: { parentSession: agent.id } },
  ctx: {
    tools: {
      register(tool) {
        childScopedTools.push(tool);
        return () => childToolDisposals.push(tool.name);
      }
    }
  }
};
for (const listener of listeners.get("agent/created") ?? []) listener({ agent: child });
assert.deepEqual(childScopedTools.map((tool) => tool.name).sort(), [
  "followup_task",
  "spawn_agent",
  "wait_agent"
]);
assert.match(guards.at(-1)({ agent: child, name: "bash" }), /read-only/u);
assert.match(guards.at(-1)({ agent, name: "subagent" }), /spawn_agent/u);

const steered = [];
agent.steer = (message) => steered.push(message);
for (const listener of listeners.get("agent/turn-stopping") ?? []) {
  await listener({ agent, turn: 1, signal: new AbortController().signal });
}
assert.equal(steered.length, 1);
assert.equal(steered[0].source.kind, "plugin:dsh-codex-ultra-mode");
assert.equal(steered[0].source.summary, "Ultra completion barrier");
const followup = scopedTools.find((tool) => tool.name === "followup_task");
const followed = await followup.execute(
  { agent_id: spawned.agent_id, message: "Also check token expiry." },
  { agent, signal: new AbortController().signal }
);
assert.equal(followed.message_id, "followup-message");
assert.equal(followups.length, 1);

for (const listener of listeners.get("agent/turn-stopping") ?? []) {
  await listener({ agent, turn: 1, signal: new AbortController().signal });
}
assert.deepEqual(drains.map((entry) => entry.childIds), [[spawned.agent_id]]);
assert.equal(steered[1].source.summary, "Ultra branch release failed");
assert.match(guards.at(-1)({ agent, name: "followup_task" }), /closing/u);
const retryUltra = {
  source: { kind: "user" },
  content: [{ type: "text", text: "/ultra do not reopen a pending drain" }]
};
for (const listener of listeners.get("agent/inbox/inserted") ?? []) {
  listener({ agent, message: retryUltra });
}
assert.match(guards.at(-1)({ agent, name: "spawn_agent" }), /closing/u);

for (const listener of listeners.get("subagent/end") ?? []) {
  listener({
    id: spawned.agent_id,
    runId: "run-1",
    provider: "spawn",
    local: true,
    stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "Auth finding." }]
  });
}
const wait = scopedTools.find((tool) => tool.name === "wait_agent");
const waited = await wait.execute(
  { agent_ids: [spawned.agent_id], timeout_ms: 10 },
  { agent, signal: new AbortController().signal }
);
assert.equal(waited.reason, "idle");
assert.equal(waited.agents[0].status, "ready");
assert.equal(waited.agents[0].task, "Also check token expiry.");

for (const listener of listeners.get("agent/disposed") ?? []) listener({ agent: child });
assert.deepEqual(childToolDisposals.sort(), ["followup_task", "spawn_agent", "wait_agent"]);

const coldChildScopedTools = [];
const coldChild = {
  ...child,
  status: "idle",
  ctx: {
    tools: {
      register(tool) {
        coldChildScopedTools.push(tool);
        return () => childToolDisposals.push(tool.name);
      }
    }
  }
};
for (const listener of listeners.get("agent/created") ?? []) listener({ agent: coldChild });
assert.equal(coldChildScopedTools.length, 3);
for (const listener of listeners.get("agent/disposed") ?? []) listener({ agent: coldChild });
const coldFailure = await wait.execute(
  { agent_ids: [spawned.agent_id], after_revision: waited.revision, timeout_ms: 10 },
  { agent, signal: new AbortController().signal }
);
assert.equal(coldFailure.reason, "updated");
assert.equal(coldFailure.agents[0].status, "failed");
assert.equal(coldFailure.events.some((event) => event.type === "start-failed"), true);

pendingDrainRejectors[0](new Error("released with teardown diagnostics"));
await new Promise((resolve) => setImmediate(resolve));
const reopenUltra = {
  source: { kind: "user" },
  content: [{ type: "text", text: "/ultra reopen after the prior drain settled" }]
};
for (const listener of listeners.get("agent/inbox/inserted") ?? []) {
  listener({ agent, message: reopenUltra });
}
assert.equal(guards.at(-1)({ agent, name: "spawn_agent" }), undefined);

const oldGeneration = await spawn.execute(
  { task_name: "old_generation", message: "Create an old-generation branch for the ABA regression." },
  { agent, signal: new AbortController().signal }
);
for (const listener of listeners.get("agent/turn-stopping") ?? []) {
  await listener({ agent, turn: 2, signal: new AbortController().signal });
  await listener({ agent, turn: 2, signal: new AbortController().signal });
}
assert.deepEqual(drains.at(-1).childIds, [oldGeneration.agent_id]);
assert.match(guards.at(-1)({ agent, name: "spawn_agent" }), /closing/u);

for (const listener of listeners.get("agent/disposed") ?? []) listener({ agent });
assert.deepEqual(rootToolDisposals.sort(), ["followup_task", "spawn_agent", "wait_agent"]);

const resumedTools = [];
const resumedToolDisposals = [];
const resumedAgent = {
  ...agent,
  status: "running",
  ctx: {
    tools: {
      register(tool) {
        resumedTools.push(tool);
        return () => resumedToolDisposals.push(tool.name);
      }
    }
  }
};
for (const listener of listeners.get("agent/created") ?? []) listener({ agent: resumedAgent });
for (const listener of listeners.get("agent/inbox/inserted") ?? []) {
  listener({ agent: resumedAgent, message: {
    source: { kind: "user" },
    content: [{ type: "text", text: "/ultra resumed root generation" }]
  } });
}
const resumedSpawn = resumedTools.find((tool) => tool.name === "spawn_agent");
const newGeneration = await resumedSpawn.execute(
  { task_name: "new_generation", message: "Remain active while the stale drain settles." },
  { agent: resumedAgent, signal: new AbortController().signal }
);
pendingDrainRejectors[1](new Error("stale old-generation drain diagnostic"));
await new Promise((resolve) => setImmediate(resolve));
const resumedWait = resumedTools.find((tool) => tool.name === "wait_agent");
const newSnapshot = await resumedWait.execute(
  { agent_ids: [newGeneration.agent_id], timeout_ms: 5 },
  { agent: resumedAgent, signal: new AbortController().signal }
);
assert.equal(newSnapshot.reason, "timeout");
assert.equal(newSnapshot.agents[0].status, "running");
assert.equal(guards.at(-1)({ agent: resumedAgent, name: "spawn_agent" }), undefined);

const ownership = effects.find((effect) => effect.label === "dsh-codex-ultra-mode: scoped tool ownership");
assert.equal(typeof ownership?.dispose, "function");
await ownership.dispose();
assert.deepEqual(drains.map((entry) => entry.childIds), [
  [spawned.agent_id],
  [oldGeneration.agent_id],
  [newGeneration.agent_id]
]);
assert.deepEqual(resumedToolDisposals.sort(), ["followup_task", "spawn_agent", "wait_agent"]);

console.log("integration profile smoke: PASS");
