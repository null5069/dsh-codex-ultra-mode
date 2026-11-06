import { randomUUID } from "node:crypto";
import { normalizeTaskName } from "./policy.js";
import { defineUltraTool } from "./runtime.js";

const STATUS_VALUES = ["starting", "running", "idle", "ready", "failed", "interrupted"];
const ACTIVE_STATUS = new Set(["starting", "running", "idle"]);
const WAKE_EVENTS = new Set(["end", "report", "settled", "spawn-failed"]);

function requireAgent(exec, toolName) {
  if (!exec.agent) throw new Error(`${toolName} requires a calling agent`);
  return exec.agent;
}

function inheritedOptions(parent) {
  const options = {};
  if (parent.options.provider !== undefined) options.provider = parent.options.provider;
  if (parent.options.model !== undefined) options.model = parent.options.model;
  if (parent.options.maxTokens !== undefined) options.maxTokens = parent.options.maxTokens;
  return Object.keys(options).length === 0 ? undefined : options;
}

function renderError(error) {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return "unrenderable spawn failure";
  }
}

/**
 * Start one continuable child across the two DSH 0.2.x subagent API shapes.
 * 0.2.0-rc.1/rc.2 and 0.2.1-alpha.1 still expose `startContinuable`;
 * 0.2.1-alpha.2 replaced it with `startActivation({ delivery: "parent" })`.
 * Both return the child id and the accepted initial message id.
 */
function startChild(ctx, spec) {
  if (typeof ctx.subagents.startActivation === "function") {
    return ctx.subagents.startActivation({ ...spec, delivery: "parent" });
  }
  if (typeof ctx.subagents.startContinuable === "function") {
    return ctx.subagents.startContinuable(spec);
  }
  throw new Error("the DSH subagent service exposes neither startActivation nor startContinuable");
}

export function createSpawnAgentTool(ctx, registry, config) {
  return defineUltraTool({
    name: "spawn_agent",
    description: "Create a continuable subagent in the active Ultra tree and assign its initial bounded task. The child starts immediately, works in its own context, may create descendants, and reports to you. Start independent children together. fork_turns=none starts fresh; fork_turns=all seeds completed conversation turns but never the current in-flight turn.",
    parameters: {
      task_name: {
        type: "string",
        required: true,
        description: "Unique lowercase name under this parent (letters, digits, _ and -, max 48 characters)."
      },
      message: {
        type: "string",
        required: true,
        description: "Self-contained task: scope, expected output, evidence, permissions and stopping condition."
      },
      fork_turns: {
        type: "string",
        enum: ["none", "all"],
        description: "Conversation inheritance. Defaults to none."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          agent_id: { type: "string", required: true },
          agent_name: { type: "string", required: true },
          message_id: { type: "string", required: true },
          status: { type: "string", required: true, enum: STATUS_VALUES }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: `spawned ${value.agent_name} (${value.agent_id}) [${value.status}]`
      }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = requireAgent(exec, "spawn_agent");
      const taskName = normalizeTaskName(args.task_name);
      if (typeof args.message !== "string" || args.message.trim() === "") {
        throw new Error("message must be a non-empty task description");
      }
      const childId = randomUUID();
      const node = registry.provisionAgent({
        id: childId,
        parentId: parent.id,
        name: taskName,
        lastTask: args.message.slice(0, 240)
      });
      try {
        const agentOptions = inheritedOptions(parent);
        // DSH 0.2.x removed the per-start toolFilter: child tool composition now
        // belongs to an Agent Preset. singleWriter is still enforced at call time
        // by the plugin's tools.guard, which denies mutating tools at depth > 0.
        const start = await startChild(ctx, {
          provider: args.fork_turns === "all" ? config.forkProvider : config.spawnProvider,
          childId,
          label: taskName,
          request: {
            prompt: [{ type: "text", text: args.message }],
            parent,
            maxDepth: config.maxDepth,
            ...(agentOptions === undefined ? {} : { agentOptions })
          },
          signal: exec.signal
        });
        const committed = registry.commitAgent(childId, registry.node(childId)?.status === "starting" ? "running" : registry.node(childId)?.status);
        return {
          agent_id: start.childId,
          agent_name: committed.path,
          message_id: start.messageId,
          status: committed.status
        };
      } catch (error) {
        registry.rollbackAgent(childId, renderError(error));
        throw error;
      }
    }
  });
}

export function createFollowupTaskTool(ctx, registry) {
  return defineUltraTool({
    name: "followup_task",
    description: "Assign additional work to one of your direct continuable children, preserving that child's context. If it is running, the message is delivered at its next step boundary; if idle or stored, it resumes. This cannot redirect work already underway.",
    parameters: {
      agent_id: {
        type: "string",
        required: true,
        description: "Durable id of your direct child."
      },
      message: {
        type: "string",
        required: true,
        description: "The additional task or revised instruction."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          agent_id: { type: "string", required: true },
          message_id: { type: "string", required: true },
          accepted: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: `follow-up accepted for ${value.agent_id} as ${value.message_id}`
      }]
    },
    async execute(args, exec) {
      const parent = requireAgent(exec, "followup_task");
      if (typeof args.message !== "string" || args.message.trim() === "") {
        throw new Error("message must be non-empty");
      }
      const reservationToken = exec.token ?? Symbol("ultra-followup");
      const check = registry.reserveWake(reservationToken, parent.id, args.agent_id);
      if (!check.ok) throw new Error(`${check.code}: ${check.message}`);
      try {
        const messageId = await ctx.subagents.sendMessage(
          parent,
          args.agent_id,
          [{ type: "text", text: args.message }],
          { signal: exec.signal }
        );
        registry.updateTask(args.agent_id, args.message.slice(0, 240));
        registry.markStatus(args.agent_id, "running", "followup");
        return { agent_id: args.agent_id, message_id: messageId, accepted: true };
      } finally {
        registry.releaseReservation(reservationToken);
      }
    }
  });
}

export function createWaitAgentTool(registry, config) {
  return defineUltraTool({
    name: "wait_agent",
    description: "Wait without polling for a report, settlement, failure, interruption, or idle transition from descendants in the active Ultra tree. agent_ids controls which exact agents wake the wait and appear in the snapshot; events always contains every tree event since the returned global revision cursor so changing targets cannot hide updates. Pass after_revision on later waits. Timeout is a normal empty update and never consumes messages.",
    parameters: {
      agent_ids: {
        type: "array",
        items: { type: "string" },
        description: "Descendant ids to watch. Omit or pass [] to watch every descendant."
      },
      after_revision: {
        type: "integer",
        description: "Last revision already observed. Omit to start from the current revision."
      },
      timeout_ms: {
        type: "integer",
        description: `Maximum wait in milliseconds (1–${config.maxWaitMs}); defaults to ${config.maxWaitMs}.`
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reason: { type: "string", required: true, enum: ["idle", "updated", "timeout"] },
          revision: { type: "integer", required: true },
          truncated: { type: "boolean", required: true },
          agents: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", required: true },
                name: { type: "string", required: true },
                status: { type: "string", required: true, enum: STATUS_VALUES },
                parent: { type: "string" },
                task: { type: "string", required: true }
              }
            }
          },
          events: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: true
            }
          }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: value.events.length === 0
          ? `wait_agent ${value.reason} at revision ${value.revision}`
          : `wait_agent ${value.reason} at revision ${value.revision}\n${value.events.map((event) => JSON.stringify(event)).join("\n")}`
      }]
    },
    timeoutMs: config.maxWaitMs + 2000,
    async execute(args, exec) {
      const caller = requireAgent(exec, "wait_agent");
      const descendants = registry.descendantsOf(caller.id);
      const requested = Array.isArray(args.agent_ids) && args.agent_ids.length > 0
        ? [...new Set(args.agent_ids)]
        : descendants.map((node) => node.id);
      for (const id of requested) {
        if (!registry.isDescendant(id, caller.id)) {
          throw new Error(`INVALID_TARGET: ${id} is not a descendant of this agent`);
        }
      }
      const targets = requested.map((id) => registry.node(id)).filter(Boolean);
      const timeoutMs = args.timeout_ms ?? config.maxWaitMs;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > config.maxWaitMs) {
        throw new Error(`timeout_ms must be an integer between 1 and ${config.maxWaitMs}`);
      }
      const suppliedRevision = args.after_revision;
      if (suppliedRevision !== undefined && (!Number.isSafeInteger(suppliedRevision) || suppliedRevision < 0)) {
        throw new Error("after_revision must be a non-negative integer");
      }
      const afterRevision = suppliedRevision ?? registry.currentRevision(caller.id);
      if (afterRevision > registry.currentRevision(caller.id)) {
        throw new Error("after_revision cannot be newer than the current Ultra revision");
      }
      const targetSet = new Set(requested);
      const isWakeEvent = (event) => {
        if (!targetSet.has(event.agentId)) return false;
        return WAKE_EVENTS.has(event.type) || (event.status !== undefined && !ACTIVE_STATUS.has(event.status));
      };
      // The cursor is tree-global, so its payload must also be tree-global. If
      // events were filtered here, advancing the cursor while watching A could
      // permanently hide an earlier event from B on the next targeted wait.
      const existing = registry.eventsSince(caller.id, afterRevision);
      const hasExistingWake = existing.events.some(isWakeEvent);
      const allIdle = targets.length === 0 || targets.every((node) => !ACTIVE_STATUS.has(node.status));
      let reason = existing.truncated || hasExistingWake ? "updated" : allIdle ? "idle" : undefined;
      if (reason === undefined) {
        reason = await registry.waitForEvent(caller.id, afterRevision, isWakeEvent, {
          signal: exec.signal,
          timeoutMs
        });
      }
      const result = registry.eventsSince(caller.id, afterRevision);
      return {
        reason,
        revision: result.revision,
        truncated: result.truncated,
        agents: registry.snapshot(targets),
        events: result.events
      };
    }
  });
}

export function createUltraTools(ctx, registry, config) {
  return [
    createSpawnAgentTool(ctx, registry, config),
    createFollowupTaskTool(ctx, registry),
    createWaitAgentTool(registry, config)
  ];
}
