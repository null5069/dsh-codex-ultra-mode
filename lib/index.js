import z from "@deepseek-ai/schemastery";
import { registerUltraCommand, installUltraGestureBoundary } from "./command.js";
import {
  buildUltraPolicy,
  invokedUltraGoal,
  messageText,
  MUTATING_CHILD_TOOLS,
  resolveConfig,
  ULTRA_SOURCE_KIND
} from "./policy.js";
import { UltraRegistry } from "./state.js";
import { createUltraTools } from "./tools.js";
import { createUserMessage } from "./runtime.js";

export const name = "codex-ultra-mode";
export const inject = ["systemPrompt", "tools", "subagents"];

export const Config = z.object({
  spawnProvider: z.string().default("spawn"),
  forkProvider: z.string().default("fork"),
  maxConcurrentSubagents: z.number().step(1).min(1).max(16).default(3),
  maxDepth: z.number().step(1).min(1).max(8).default(3),
  maxTotalSubagents: z.number().step(1).min(1).max(128).default(12),
  maxWaitMs: z.number().step(1).min(1000).max(60000).default(30000),
  maxBarrierSteps: z.number().step(1).min(1).max(32).default(8),
  barrierDrainMs: z.number().step(1).min(100).max(60000).default(10000),
  eventHistory: z.number().step(1).min(32).max(4096).default(512),
  promptSectionOrder: z.number().step(1).min(1).max(1000).default(118),
  singleWriter: z.boolean().default(true),
  childDenyTools: z.array(z.string()).default([]),
  allowWorkflow: z.boolean().default(false),
  slashCommand: z.boolean().default(true)
});

function parentSessionOf(agent) {
  const value = agent.session?.header?.parentSession;
  return typeof value === "string" ? value : undefined;
}

function stopStatus(stopReason) {
  if (stopReason === "completed") return "ready";
  if (stopReason === "aborted") return "interrupted";
  return "failed";
}

async function settleDrain(start, signal, timeoutMs) {
  if (signal.aborted) return { outcome: { kind: "aborted" }, completion: undefined };
  let timer;
  let onAbort;
  // Start inside an observed promise chain: a synchronous throw or immediate
  // rejection can never escape as an unhandled background failure.
  const operation = Promise.resolve().then(start).then(
    () => ({ kind: "drained" }),
    (error) => ({ kind: "failed", error })
  );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const outcome = await Promise.race([operation, timeout, aborted]);
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
  return { outcome, completion: operation };
}

export function apply(ctx, inputConfig = {}) {
  const config = resolveConfig(inputConfig);
  const registry = new UltraRegistry(config);
  const childDeniedTools = new Set([...MUTATING_CHILD_TOOLS, ...config.childDenyTools]);
  const installed = new WeakMap();
  const liveInstallations = new Set();
  const agentsById = new Map();
  const barrierAttempts = new Map();
  const closingAgents = new Set();
  const reopenableAgents = new Set();
  const closingAttempts = new Map();

  const isClosing = (agentId) => {
    for (const closingId of closingAgents) {
      if (agentId === closingId || registry.isDescendant(agentId, closingId)) return true;
    }
    return false;
  };

  const revokeTools = (agent, errors) => {
    const installation = installed.get(agent);
    if (installation === undefined) return;
    installed.delete(agent);
    liveInstallations.delete(installation);
    for (const dispose of installation.disposers.reverse()) {
      try {
        dispose();
      } catch (error) {
        errors?.push(error);
      }
    }
  };

  const installTools = (agent) => {
    if (installed.has(agent) || !registry.isActive(agent.id)) return;
    agentsById.set(agent.id, agent);
    const installation = { agent, disposers: [] };
    installed.set(agent, installation);
    liveInstallations.add(installation);
    try {
      for (const tool of createUltraTools(ctx, registry, config)) {
        if (ctx.tools.get(tool.name, agent) !== undefined) {
          throw new Error(`ULTRA_TOOL_NAME_CONFLICT: ${tool.name} is already registered for agent ${agent.id}`);
        }
        installation.disposers.push(agent.ctx.tools.register(tool));
      }
    } catch (error) {
      revokeTools(agent);
      throw error;
    }
  };

  const activate = (agent) => {
    registry.activateRoot(agent.id, agent.status);
    installTools(agent);
  };

  const beginRun = (agent) => {
    const relevantClosing = [...closingAgents].filter((id) => (
      id === agent.id || registry.isDescendant(id, agent.id)
    ));
    if (relevantClosing.some((id) => !reopenableAgents.has(id))) {
      registry.record(agent.id, {
        type: "run-blocked",
        agentId: agent.id,
        status: "failed",
        message: "a prior Ultra branch is still draining or failed to drain; reload the plugin if it never settles"
      });
      installTools(agent);
      return;
    }
    const { retiredAgentIds } = registry.beginRun(agent.id, agent.status);
    for (const id of new Set([...retiredAgentIds, ...relevantClosing])) {
      closingAgents.delete(id);
      reopenableAgents.delete(id);
      closingAttempts.delete(id);
    }
    for (const id of retiredAgentIds) {
      const retired = agentsById.get(id);
      if (retired !== undefined) revokeTools(retired);
      agentsById.delete(id);
    }
    installTools(agent);
  };

  // Agent-scoped registrations belong to the Agent fiber that creates them,
  // not automatically to this plugin fiber. Revoke the exact registrations on
  // unload/HMR so a reloaded plugin cannot inherit stale registry closures.
  ctx.effect(() => async () => {
    const errors = [];
    const roots = [...agentsById.values()].filter((agent) => registry.node(agent.id)?.parentId === null);
    try {
      for (const rootAgent of roots) {
        const childIds = registry.descendantsOf(rootAgent.id)
          .filter((node) => node.parentId === rootAgent.id)
          .map((node) => node.id);
        if (childIds.length === 0) continue;
        try {
          await ctx.subagents.drainChildren(rootAgent, childIds);
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      for (const installation of [...liveInstallations]) {
        revokeTools(installation.agent, errors);
      }
      agentsById.clear();
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "failed to drain Ultra descendants or revoke agent tools");
    }
  }, "dsh-codex-ultra-mode: scoped tool ownership");

  ctx.systemPrompt.section({
    name: "codex-ultra-mode:policy",
    order: config.promptSectionOrder,
    text: (context) => {
      const agent = context.agent;
      if (agent === undefined) return "";
      const node = registry.node(agent.id);
      return node === undefined ? "" : buildUltraPolicy(node, config);
    }
  });

  ctx.on("agent/created", ({ agent }) => {
    let node = registry.node(agent.id);
    if (node === undefined) {
      const parentId = parentSessionOf(agent);
      if (parentId !== undefined && registry.isActive(parentId)) {
        node = registry.addAgent({ id: agent.id, parentId, status: agent.status });
      }
    } else registry.markPublished(agent.id, agent.status);
    if (node !== undefined) installTools(agent);
  });

  ctx.on("agent/status", ({ agent, status }) => {
    if (registry.isActive(agent.id)) registry.markStatus(agent.id, status);
  });

  ctx.on("agent/disposed", ({ agent }) => {
    if (registry.isActive(agent.id)) registry.markAgentDisposed(agent.id);
    revokeTools(agent);
    agentsById.delete(agent.id);
    for (const key of barrierAttempts.keys()) {
      if (key.startsWith(`${agent.id}:`)) barrierAttempts.delete(key);
    }
    const closingAttempt = closingAttempts.get(agent.id);
    if (closingAttempt === undefined || closingAttempt.agent === agent) {
      closingAgents.delete(agent.id);
      reopenableAgents.delete(agent.id);
      closingAttempts.delete(agent.id);
    }
  });

  ctx.on("subagent/start", (info) => {
    if (registry.isActive(info.id)) registry.markStatus(info.id, "running", "start", { runId: info.runId });
  });

  ctx.on("subagent/end", (info) => {
    if (!registry.isActive(info.id)) return;
    registry.markStatus(info.id, stopStatus(info.stopReason), "end", {
      runId: info.runId,
      stopReason: info.stopReason,
      ...(info.lastAssistantMessage === undefined ? {} : {
        message: messageText({ content: info.lastAssistantMessage })
      })
    });
  });

  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    // DSH assembles the first request before agent/pre-step. Activating at inbox
    // insertion makes the policy and schemas visible on the very first /ultra
    // model step, for both raw user gestures and slash-command replay.
    if (config.slashCommand && invokedUltraGoal([message]) !== undefined) beginRun(agent);
    if (!registry.isActive(agent.id)) return;
    const source = message.source;
    if (source?.kind !== "subagent-report" && source?.kind !== "subagent-settled") return;
    registry.recordMessage(
      agent.id,
      source.senderSessionId,
      source.kind === "subagent-report" ? "report" : "settled",
      messageText(message)
    );
  });

  // Safe default: Ultra children research and review; only the root mutates.
  ctx.effect(() => ctx.tools.guard((exec) => {
    const agent = exec.agent;
    if (agent === undefined) return undefined;
    const node = registry.node(agent.id);
    if (node === undefined) return undefined;
    if (isClosing(agent.id) && [
      "spawn_agent",
      "followup_task",
      "send_message",
      "subagent",
      "subagent_fork",
      "workflow"
    ].includes(exec.name)) {
      return "Ultra completion is closing this branch; no new or resumed work may be admitted";
    }
    if (!config.allowWorkflow && exec.name === "workflow") {
      return "workflow is disabled inside Ultra mode; use dynamic spawn_agent delegation";
    }
    if (["subagent", "subagent_fork"].includes(exec.name)) {
      return "native spawn tools are disabled inside Ultra mode; use spawn_agent for tracked continuable children";
    }
    if (config.singleWriter && node.depth > 0 && childDeniedTools.has(exec.name)) {
      return "Ultra single-writer mode makes subagents read-only; report evidence and proposed changes to your parent";
    }
    return undefined;
  }), "dsh-codex-ultra-mode: capability guard");

  // Native messaging may cold-resume a child. Reserve its tree-wide slot
  // before parallel dispatch so sibling calls cannot race past the cap.
  ctx.on("tools/pre-execute", async (exec, next) => {
    const decision = await next();
    if (decision.kind !== "allow") return decision;
    if (exec.agent === undefined || !registry.isActive(exec.agent.id)) return decision;
    if (exec.name === "send_message") {
      const target = exec.arguments?.subagent_id;
      if (typeof target !== "string") return decision;
      const wake = registry.reserveWake(exec.token, exec.agent.id, target);
      return wake.ok ? decision : { kind: "deny", reason: `${wake.code}: ${wake.message}` };
    }
    return decision;
  });

  ctx.on("tools/result", (exec) => {
    registry.releaseReservation(exec.token);
  });

  ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
    if (!registry.isActive(agent.id)) return;
    const running = registry.runningDescendants(agent.id);
    const key = `${agent.id}:${turn}`;
    if (running.length === 0) {
      barrierAttempts.delete(key);
      return;
    }
    const attempts = barrierAttempts.get(key) ?? 0;
    if (attempts >= config.maxBarrierSteps) {
      closingAgents.add(agent.id);
      const closingAttempt = {
        agent,
        run: registry.rootForAgent(agent.id)?.run,
        token: Symbol("ultra-barrier-drain")
      };
      closingAttempts.set(agent.id, closingAttempt);
      const directChildIds = registry.descendantsOf(agent.id)
        .filter((node) => node.parentId === agent.id)
        .map((node) => node.id);
      const { outcome, completion } = await settleDrain(
        () => ctx.subagents.drainChildren(agent, directChildIds),
        signal,
        config.barrierDrainMs
      );
      const markBackgroundResult = (result) => {
        const current = closingAttempts.get(agent.id);
        if (
          current?.token !== closingAttempt.token ||
          current.agent !== agent ||
          agentsById.get(agent.id) !== agent ||
          registry.rootForAgent(agent.id)?.run !== closingAttempt.run
        ) return;
        // drainChildren reports errors only after attempting every
        // selected branch and releasing ownership. Either settled outcome is
        // safe to reopen; the failed outcome still remains visible in events.
        reopenableAgents.add(agent.id);
        for (const node of registry.runningDescendants(agent.id)) {
          registry.markStatus(
            node.id,
            result.kind === "drained" ? "interrupted" : "failed",
            result.kind === "drained" ? "barrier-drained" : "barrier-drain-failed",
            {
              message: result.kind === "drained"
                ? "released after completion-barrier budget was exhausted"
                : `completion barrier could not release this descendant: ${String(result.error)}`
            }
          );
        }
      };
      if ((outcome.kind === "timeout" || outcome.kind === "aborted") && completion !== undefined) {
        void completion.then(markBackgroundResult);
      } else if (outcome.kind === "drained" || outcome.kind === "failed") {
        markBackgroundResult(outcome);
      }
      if (outcome.kind === "aborted") {
        barrierAttempts.delete(key);
        if (completion === undefined) {
          closingAgents.delete(agent.id);
          closingAttempts.delete(agent.id);
        }
        return;
      }
      const drainError = outcome.kind === "failed"
        ? outcome.error
        : outcome.kind === "timeout"
          ? new Error(`exact branch release exceeded ${config.barrierDrainMs}ms and continues in the background`)
          : undefined;
      for (const node of registry.runningDescendants(agent.id)) {
        if (drainError === undefined) {
          registry.markStatus(node.id, "interrupted", "barrier-drained", {
            message: "released after completion-barrier budget was exhausted"
          });
        } else {
          registry.markStatus(node.id, "failed", "barrier-drain-failed", {
            message: `completion barrier could not release this descendant: ${String(drainError)}`
          });
        }
      }
      barrierAttempts.delete(key);
      if (signal.aborted) return;
      agent.steer(createUserMessage({
        content: [{
          type: "text",
          text: drainError === undefined
            ? `Ultra completion-barrier budget is exhausted. The runtime released ${directChildIds.length} direct child branch(es), including their descendant forests. Do not spawn replacements. Report the unfinished branches as interrupted, synthesize the available evidence, and finish.`
            : `Ultra completion-barrier budget is exhausted and exact branch release failed: ${String(drainError)}. The remaining branches are marked failed locally. Do not spawn replacements. Disclose the release failure, synthesize only settled evidence, and finish.`
        }],
        source: {
          kind: ULTRA_SOURCE_KIND,
          form: "notice",
          summary: drainError === undefined ? "Ultra branches released" : "Ultra branch release failed"
        }
      }));
      return;
    }
    barrierAttempts.set(key, attempts + 1);
    agent.steer(createUserMessage({
      content: [{
        type: "text",
        text: `Ultra completion barrier: ${running.length} descendant(s) are still active (${running.map((node) => `${node.path}=${node.status}`).join(", ")}). Do not finalize yet. Continue useful work or call wait_agent for these ids: ${running.map((node) => node.id).join(", ")}.`
      }],
      source: {
        kind: ULTRA_SOURCE_KIND,
        form: "notice",
        summary: "Ultra completion barrier"
      }
    }));
  });

  if (config.slashCommand) {
    ctx.inject(["commands"], (commandCtx) => registerUltraCommand(commandCtx));
    installUltraGestureBoundary(ctx, activate);
  }
}
