import { buildActivationDirective, invokedUltraGoal, ULTRA_COMMAND, ULTRA_SOURCE_KIND } from "./policy.js";
import { createUserMessage } from "./runtime.js";

export function registerUltraCommand(ctx) {
  ctx.effect(() => ctx.commands.register({
    name: ULTRA_COMMAND,
    description: "activate dynamic Ultra-like multi-agent orchestration for a goal",
    input: { hint: "<goal — what should Ultra accomplish?>" },
    handler(invocation) {
      const goal = invocation.rawInput.trim();
      if (goal === "") {
        return { kind: "error", text: `Usage: /${ULTRA_COMMAND} <goal>` };
      }
      invocation.agent.followup(createUserMessage({
        content: [{ type: "text", text: `/${ULTRA_COMMAND}${invocation.rawInput}` }],
        source: { kind: "user" }
      }));
      return { kind: "success", text: `Ultra mode activated for this session: ${goal}` };
    }
  }), "dsh-codex-ultra-mode: slash command");
}

export function installUltraGestureBoundary(ctx, activate) {
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    const goal = invokedUltraGoal(messages);
    if (goal === undefined) return decision;
    signal.throwIfAborted();
    activate(agent);
    const activation = createUserMessage({
      content: [{ type: "text", text: buildActivationDirective(goal) }],
      source: {
        kind: ULTRA_SOURCE_KIND,
        form: "notice",
        summary: "Ultra mode activated"
      }
    });
    return { kind: "enter", messages: [...decision.messages, activation] };
  });
}
