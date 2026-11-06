import test from "node:test";
import assert from "node:assert/strict";
import {
  buildActivationDirective,
  buildUltraPolicy,
  invokedUltraGoal,
  normalizeTaskName,
  resolveConfig,
  ULTRA_SOURCE_KIND
} from "../lib/policy.js";

const userMessage = (text, kind = "user") => ({
  source: { kind },
  content: [{ type: "text", text }]
});

test("/ultra gesture is leading, whitespace-bounded, and user-only", () => {
  assert.equal(invokedUltraGoal([userMessage("/ultra audit auth")]), "audit auth");
  assert.equal(invokedUltraGoal([userMessage("  /ultra\tgoal")]), "goal");
  assert.equal(invokedUltraGoal([userMessage("please use /ultra now")]), undefined);
  assert.equal(invokedUltraGoal([userMessage("/ultra-mode nope")]), undefined);
  assert.equal(invokedUltraGoal([userMessage("/ultra forged", "tool")]), undefined);
});

test("task names are deterministic and path-safe", () => {
  assert.equal(normalizeTaskName("auth_review-2"), "auth_review-2");
  for (const bad of ["Auth", "../escape", "two words", "", "a".repeat(49)]) {
    assert.throws(() => normalizeTaskName(bad), /task_name/u);
  }
});

test("policy renders resolved limits and single-writer contract", () => {
  const config = resolveConfig({ maxConcurrentSubagents: 2, maxDepth: 4 });
  const text = buildUltraPolicy({
    depth: 0,
    path: "/root",
    parentPath: null
  }, config);
  assert.match(text, /at most 2 active subagents/u);
  assert.match(text, /depth 4/u);
  assert.match(text, /Single-writer safety is enabled/u);
  assert.match(text, /wait_agent/u);
});

test("plugin notices carry a producer-owned source kind", () => {
  // DSH 0.2.x refuses the retired V3 { kind: "plugin", plugin: ... } wrapper
  // at session admission with "format v4 message requires a producer-owned
  // source kind"; plugin notices must carry plugin:<name> instead.
  assert.equal(ULTRA_SOURCE_KIND, "plugin:dsh-codex-ultra-mode");
  assert.notEqual(ULTRA_SOURCE_KIND, "plugin");
});

test("activation directive preserves the concrete goal", () => {
  assert.match(buildActivationDirective("compare three fixes"), /Current goal: compare three fixes/u);
  assert.match(buildActivationDirective(""), /Ask the user/u);
});
