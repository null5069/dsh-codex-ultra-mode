import test from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { resolveConfig } from "../lib/policy.js";
import { UltraRegistry } from "../lib/state.js";
import {
  createFollowupTaskTool,
  createSpawnAgentTool,
  createWaitAgentTool
} from "../lib/tools.js";

function setup(overrides = {}) {
  const config = resolveConfig({
    maxConcurrentSubagents: 3,
    maxDepth: 3,
    maxTotalSubagents: 12,
    maxWaitMs: 1000,
    ...overrides
  });
  const registry = new UltraRegistry(config);
  registry.activateRoot("root");
  return { config, registry };
}

const parent = {
  id: "root",
  options: {},
  status: "running",
  session: { header: {} }
};

test("spawn rolls back a path when the provider fails after publication", async () => {
  const { config, registry } = setup();
  let fail = true;
  const ctx = {
    tools: { get: () => undefined },
    subagents: {
      async startActivation(spec) {
        registry.addAgent({ id: spec.childId, parentId: "root", status: "idle" });
        if (fail) throw new Error("admission failed after publication");
        return { childId: spec.childId, messageId: "message-1" };
      }
    }
  };
  const tool = createSpawnAgentTool(ctx, registry, config);
  await assert.rejects(
    tool.execute(
      { task_name: "worker", message: "Inspect the boundary." },
      { agent: parent, signal: new AbortController().signal }
    ),
    /admission failed/u
  );
  assert.equal(registry.descendantsOf("root").length, 0);

  fail = false;
  const value = await tool.execute(
    { task_name: "worker", message: "Retry the boundary." },
    { agent: parent, signal: new AbortController().signal }
  );
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), []);
  assert.equal(value.agent_name, "/root/worker");
});

test("spawn falls back to the 0.2.0 startContinuable API", async () => {
  const { config, registry } = setup();
  let captured;
  const ctx = {
    subagents: {
      async startContinuable(spec) {
        captured = spec;
        return { childId: spec.childId, messageId: "legacy-message" };
      }
    }
  };
  const tool = createSpawnAgentTool(ctx, registry, config);
  const value = await tool.execute(
    { task_name: "legacy", message: "Run on the 0.2.0 subagent service." },
    { agent: parent, signal: new AbortController().signal }
  );
  assert.equal(captured.delivery, undefined);
  assert.equal(captured.request.maxDepth, 3);
  assert.equal(value.message_id, "legacy-message");
  assert.equal(value.status, "running");
});

test("local tool definitions reject malformed model arguments before execution", async () => {
  const { config, registry } = setup();
  const spawn = createSpawnAgentTool({
    tools: { get: () => undefined },
    subagents: {
      async startActivation() {
        throw new Error("must not dispatch malformed arguments");
      }
    }
  }, registry, config);
  await assert.rejects(
    spawn.execute(
      { task_name: "worker", message: "work", fork_turns: "bogus" },
      { agent: parent, signal: new AbortController().signal }
    ),
    (error) => error?.code === "INVALID_ARGS" && /fork_turns/u.test(error.message)
  );
  await assert.rejects(
    spawn.execute(
      { task_name: "worker", message: "work", unexpected: true },
      { agent: parent, signal: new AbortController().signal }
    ),
    (error) => error?.code === "INVALID_ARGS" && /unexpected/u.test(error.message)
  );

  const wait = createWaitAgentTool(registry, config);
  await assert.rejects(
    wait.execute(
      { agent_ids: "not-an-array", timeout_ms: 1 },
      { agent: parent, signal: new AbortController().signal }
    ),
    (error) => error?.code === "INVALID_ARGS" && /agent_ids/u.test(error.message)
  );
});

test("followup reserves a cold wake, updates task metadata, and validates output", async () => {
  const { registry } = setup({ maxConcurrentSubagents: 1 });
  registry.addAgent({ id: "child", parentId: "root", status: "ready", name: "child", lastTask: "old" });
  const tool = createFollowupTaskTool({
    subagents: {
      async sendMessage() {
        assert.equal(registry.reservationsForRoot("root"), 1);
        return "followup-1";
      }
    }
  }, registry);
  const value = await tool.execute(
    { agent_id: "child", message: "Review the revised expiry logic." },
    { agent: parent, token: Symbol("followup"), signal: new AbortController().signal }
  );
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), []);
  assert.equal(registry.node("child").lastTask, "Review the revised expiry logic.");
  assert.equal(registry.node("child").status, "running");
  assert.equal(registry.reservationsForRoot("root"), 0);
});

test("wait returns an old truncated cursor immediately and validates output", async () => {
  const { config, registry } = setup({ eventHistory: 2 });
  registry.addAgent({ id: "child", parentId: "root", status: "running", name: "child" });
  registry.record("root", { type: "diagnostic", agentId: "root" });
  registry.record("root", { type: "diagnostic", agentId: "root" });
  const tool = createWaitAgentTool(registry, config);
  const value = await tool.execute(
    { agent_ids: ["child"], after_revision: 0, timeout_ms: 1000 },
    { agent: parent, signal: new AbortController().signal }
  );
  assert.equal(value.reason, "updated");
  assert.equal(value.truncated, true);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), []);
});

test("a targeted wait returns the global event slice before advancing its cursor", async () => {
  const { config, registry } = setup();
  registry.addAgent({ id: "a", parentId: "root", status: "running", name: "a" });
  registry.addAgent({ id: "b", parentId: "root", status: "running", name: "b" });
  const cursor = registry.currentRevision("root");
  registry.recordMessage("root", "b", "report", "b first");
  registry.recordMessage("root", "a", "report", "a second");
  const tool = createWaitAgentTool(registry, config);
  const value = await tool.execute(
    { agent_ids: ["a"], after_revision: cursor, timeout_ms: 10 },
    { agent: parent, signal: new AbortController().signal }
  );
  assert.equal(value.reason, "updated");
  assert.deepEqual(value.agents.map((entry) => entry.id), ["a"]);
  assert.deepEqual(value.events.filter((event) => event.type === "report").map((event) => event.agentId), ["b", "a"]);
  assert.equal(value.revision, registry.currentRevision("root"));
});
