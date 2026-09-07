/**
 * The agent-facing toolset: the six tools every agent (foreground 'main' and every background
 * agent) drives the swarm with, plus the tool-call preview renderer they share.
 *
 * `selfName` is bound at construction, so a tool call always acts as the agent that owns the
 * tool — an agent cannot spoof another sender. index.ts registers these for 'main' and passes
 * them to each child session as customTools.
 *
 * The protocol rules in the spawn_subagent/send_message descriptions restate, in condensed form,
 * what agent-system-prompt.ts states at boot time. Change them together.
 */
import {
  defineTool,
  keyHint,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { orderAgents } from "./agent-order.ts";
import type { Engine } from "./engine.ts";
import {
  formatKillResult,
  formatMulticastResult,
  formatSnapshot,
  type MulticastRouteOutcome,
  normalizeTargets,
} from "./feed.ts";
import { CUSTOM_STATUS_MAX, formatHistory } from "./panel-logic.ts";
import type { AgentModelSetter } from "./set-agent-model.ts";
import type { Spawner } from "./spawner.ts";
import { collapseBlock, toolPreviewParts } from "./tool-preview.ts";
import { THINKING_LEVELS } from "./thinking-level.ts";

// Tool-call preview that shows the FULL parameter content. Without a custom renderCall,
// pi's fallback for registered tools shows only the tool name (see ToolExecutionComponent
// createCallFallback) — long fields like systemPrompt would be missing entirely.
// No indents (they only waste width): scalar args sit inline on the title line for density,
// multiline string fields (e.g. systemPrompt) follow as unindented blocks.
// Collapsed-preview budget per block field: at most this many lines / characters are shown
// when the tool call is NOT expanded. spawn_subagent.systemPrompt + .message and send_message
// .content are the long fields this bounds; expanding (app.tools.expand) shows them in full.
const BLOCK_COLLAPSE_LINES = 2;
const BLOCK_COLLAPSE_CHARS = 200;
type RenderTheme = {
  fg(color: string, s: string): string;
  bold(s: string): string;
};
function renderToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  theme: RenderTheme,
  expanded: boolean,
): Text {
  const { scalars, blocks } = toolPreviewParts(args ?? {});
  let title =
    theme.fg("toolTitle", theme.bold(toolName)) +
    (scalars.length ? ` ${theme.fg("dim", scalars.join("  "))}` : "");
  const body: string[] = [];
  let anyTruncated = false;
  for (const { key, value } of blocks) {
    body.push(theme.fg("dim", `${key}:`));
    // Expanded: full value. Collapsed: each block truncated separately (lines + chars).
    const { shown, hiddenLines, truncated } = expanded
      ? { shown: value, hiddenLines: 0, truncated: false }
      : collapseBlock(value, BLOCK_COLLAPSE_LINES, BLOCK_COLLAPSE_CHARS);
    for (const l of shown.split("\n")) body.push(theme.fg("toolOutput", l));
    if (truncated) {
      anyTruncated = true;
      if (hiddenLines > 0)
        body.push(
          theme.fg(
            "dim",
            `  … +${hiddenLines} line${hiddenLines === 1 ? "" : "s"}`,
          ),
        );
    }
  }
  // One expand hint on the title line when anything was cut (keybinding-aware).
  if (anyTruncated)
    title += ` ${theme.fg("dim", `(${keyHint("app.tools.expand", "expand")})`)}`;
  return new Text([title, ...body].join("\n"), 0, 0);
}

/** Everything the tools reach outside themselves, injected so this file stays SDK-shell-free. */
export interface AgentToolsDeps {
  engine: Engine;
  spawnAgent: Spawner["spawnAgent"];
  /** Change a running agent's model/effort (set-agent-model.ts owns the rules). */
  setAgentModel: AgentModelSetter;
  /** Persist the membership roster after a spawn or kill. */
  persistRoster: () => void;
  /** Refresh the status widget after a change an agent made. */
  updateStatus: () => void;
  /** The main UI's hideThinkingBlock setting, so subagent_history matches what the human sees. */
  getHideThinking: () => Promise<boolean>;
}

/** Build the toolset acting as `selfName`. */
export function makeAgentTools(
  selfName: string,
  deps: AgentToolsDeps,
): ToolDefinition[] {
  const {
    engine,
    spawnAgent,
    setAgentModel,
    persistRoster,
    updateStatus,
    getHideThinking,
  } = deps;
  return [
    defineTool({
      name: "spawn_subagent",
      label: "Spawn Subagent",
      renderCall: (args, theme, context) =>
        renderToolArgs(
          "spawn_subagent",
          args as Record<string, unknown>,
          theme as RenderTheme,
          context?.expanded ?? false,
        ),
      description:
        "Create a subagent — a helper that runs inside your current session. Give it a system prompt and its first message (the task). " +
        "It can then be messaged by name. The result briefly confirms that the new agent picked its task up and " +
        "reports its state ('idle (no reaction)' means it received the task but did not start a turn). " +
        "Event-driven & fire-and-forget: after spawning, END YOUR TURN — you are automatically re-woken when an agent " +
        "messages you back. Do NOT poll list_subagents or wait in a loop for completion; it wastes turns. Inspect " +
        "(list_subagents/subagent_history) only if you suspect something went wrong. The new agent's first reply will be " +
        "its understanding of the task plus clarification questions, then it waits — reply using send_message " +
        "(go-ahead + any corrections) to unblock its work." +
        // Only main can reach the human; subagents escalate uncertainty up their own chain instead.
        (selfName === "main"
          ? " If a spawned agent asks something you can't confidently answer yourself, ask the user rather than guessing."
          : ""),
      parameters: Type.Object({
        name: Type.String({ description: "Unique agent name ([a-zA-Z0-9_-])" }),
        systemPrompt: Type.String({
          description: "System prompt defining the agent's behavior",
        }),
        overrideModel: Type.Optional(
          Type.String({
            description:
              "Omit to inherit your current model (the default — almost always correct). Set 'provider/id' " +
              "ONLY when the user explicitly named a specific model; a wrong value returns the available list.",
          }),
        ),
        overrideThinkingLevel: Type.Optional(
          StringEnum(THINKING_LEVELS, {
            description:
              "often described as <model>@<thinking level>. Omit to inherit your current effective thinking level / effort.",
          }),
        ),
        // Required, not optional: an agent that receives no message never gets a turn and
        // would sit idle forever. Requiring the task removes that dead-on-arrival state.
        message: Type.String({
          description:
            "The task, delivered as the new agent's first message right after spawn",
        }),
      }),
      execute: async (_id, args) => {
        // Agent-facing override names map to the SDK-free SpawnSpec fields.
        const res = await spawnAgent(
          {
            name: args.name,
            systemPrompt: args.systemPrompt,
            model: args.overrideModel,
            thinkingLevel: args.overrideThinkingLevel,
            message: args.message,
          },
          selfName,
        );
        persistRoster();
        return { content: [{ type: "text", text: res.msg }], details: {} };
      },
    }),
    defineTool({
      name: "send_message",
      label: "Send Message",
      renderCall: (args, theme, context) =>
        renderToolArgs(
          "send_message",
          args as Record<string, unknown>,
          theme as RenderTheme,
          context?.expanded ?? false,
        ),
      description:
        "Replying to an agent always means calling this tool with that agent as the target. Ordinary assistant text " +
        'does not reach the agent. Fire-and-forget message to a list of agents (e.g. ["main"]). It returns as soon as ' +
        "each receiver has picked the message up (briefly confirmed), never waiting for the reply, and reports every " +
        "receiver's state back: working/thinking means it started on your message, 'idle (no reaction)' means it took " +
        "the message but did not start a turn, and buffered/failed mean it is paused or gone. " +
        "After sending, END YOUR TURN — you are automatically re-woken if a reply arrives. Do NOT poll or wait in a " +
        "loop; inspect only if you suspect a problem.",
      parameters: Type.Object({
        // Array-only, not a Union: weak models drop `to` entirely when the schema is
        // anyOf(string, array). A flat array removes the choice and is type-honest.
        to: Type.Array(Type.String(), {
          description:
            'List of target agent names (multicast). Even for a single target, pass an array, e.g. ["main"].',
        }),
        content: Type.String({ description: "Message content" }),
      }),
      execute: async (_id, args) => {
        const targets = normalizeTargets(args.to);
        // Route first (synchronous ordering, one feed event per target), then confirm reactions.
        const routed: MulticastRouteOutcome[] = [];
        for (const t of targets) {
          const outcome = await engine.route(selfName, t, args.content);
          routed.push({ target: t, ...outcome });
        }
        // The per-target waits run in PARALLEL: serial waits would cost timeout x targets for a
        // multicast, turning one bounded confirmation into a long block.
        const results = await Promise.all(
          routed.map(async (result) => {
            if (result.outcome !== "delivered") return result; // parked or gone: no turn can follow
            const reacted = await engine.awaitReaction(result.target);
            // Gone mid-wait: keep the snapshot taken at delivery rather than inventing a state.
            return reacted ? { ...result, receiverStatus: reacted } : result;
          }),
        );
        return {
          content: [{ type: "text", text: formatMulticastResult(results) }],
          details: {},
        };
      },
    }),
    defineTool({
      name: "set_subagent_model",
      label: "Set Subagent Model",
      renderCall: (args, theme, context) =>
        renderToolArgs(
          "set_subagent_model",
          args as Record<string, unknown>,
          theme as RenderTheme,
          context?.expanded ?? false,
        ),
      description:
        "Change a running agent's model and/or thinking effort, keeping its transcript and its " +
        "place in the swarm — no respawn. Works on any agent INCLUDING YOURSELF, so use it to " +
        "escalate work that turned out harder than expected (stronger model or higher effort) or to " +
        "downshift cheap grinding. Pass at least one of model/thinkingLevel. Takes effect from the " +
        "target's next turn; a turn already running may finish on the old model. 'main' is the " +
        "human's own chat and cannot be retuned.",
      parameters: Type.Object({
        name: Type.String({ description: "Agent to retune" }),
        model: Type.Optional(
          Type.String({
            description:
              "'provider/id' to switch to; omit to keep the current model. A wrong value returns the available list.",
          }),
        ),
        thinkingLevel: Type.Optional(
          StringEnum(THINKING_LEVELS, {
            description:
              "Effort to request; omit to keep the current one. The model may clamp it — the result reports the effective level.",
          }),
        ),
      }),
      execute: async (_id, args) => {
        const res = await setAgentModel({
          name: args.name,
          model: args.model,
          thinkingLevel: args.thinkingLevel,
        });
        return { content: [{ type: "text", text: res.msg }], details: {} };
      },
    }),
    defineTool({
      name: "list_subagents",
      label: "List Subagents",
      renderCall: (args, theme, context) =>
        renderToolArgs(
          "list_subagents",
          args as Record<string, unknown>,
          theme as RenderTheme,
          context?.expanded ?? false,
        ),
      description: "List all agents and their status.",
      parameters: Type.Object({}),
      execute: async () => {
        const { used, total } = engine.budget;
        const ordered = orderAgents(engine.list(), engine.getMessageMatrix());
        return {
          content: [
            {
              type: "text",
              text: formatSnapshot(
                ordered,
                used,
                total,
                selfName,
                engine.isPaused(),
              ),
            },
          ],
          details: {},
        };
      },
    }),
    defineTool({
      name: "kill_subagent",
      label: "Kill Subagent",
      renderCall: (args, theme, context) =>
        renderToolArgs(
          "kill_subagent",
          args as Record<string, unknown>,
          theme as RenderTheme,
          context?.expanded ?? false,
        ),
      description:
        "Terminate agents by name array. Killing an agent also kills the agents it spawned (its whole subtree); the result names every agent taken down. 'main' cannot be killed.",
      parameters: Type.Object({
        name: Type.Array(Type.String(), {
          description: "List of agent names to terminate",
        }),
      }),
      execute: async (_id, args) => {
        const targets = normalizeTargets(args.name);
        const results = [];
        for (const target of targets) {
          const result = await engine.kill(target);
          results.push(
            result.ok
              ? { target, ok: true, killed: result.killed }
              : { target, ok: false, reason: result.reason },
          );
        }
        persistRoster();
        return {
          content: [{ type: "text", text: formatKillResult(results) }],
          details: {},
        };
      },
    }),
    defineTool({
      name: "subagent_history",
      label: "Subagent History",
      renderCall: (args, theme, context) =>
        renderToolArgs(
          "subagent_history",
          args as Record<string, unknown>,
          theme as RenderTheme,
          context?.expanded ?? false,
        ),
      description:
        "Inspect a background agent's message transcript ('main' is the foreground chat and has no " +
        "mirrored transcript). offset: start index (0 = beginning, the default; " +
        "negative = from the end, e.g. -30 = last 30). limit: window size (default 30). The header " +
        "reports the total message count and the shown range so you can page through.",
      parameters: Type.Object({
        name: Type.String({ description: "agent whose history to inspect" }),
        offset: Type.Optional(
          Type.Number({
            description:
              "start index; 0=beginning (default), negative=from end",
          }),
        ),
        limit: Type.Optional(
          // Minimum at the boundary: a window of 0 messages is not a meaningful request, and
          // formatHistory would silently clamp it to 1 (Parse, don't validate).
          Type.Number({
            minimum: 1,
            description: "number of messages to show (default 30)",
          }),
        ),
      }),
      execute: async (_id, args) => {
        const rec = engine.get(args.name);
        if (!rec)
          return {
            content: [{ type: "text", text: `unknown agent '${args.name}'` }],
            details: {},
          };
        // 'main' is the foreground chat; its transcript is not mirrored into the registry,
        // so an empty list here would read as "main said nothing". Say so explicitly.
        if (args.name === "main")
          return {
            content: [
              {
                type: "text",
                text: "agent main · transcript not available here — main is the foreground chat itself, which is not mirrored into the agent registry.",
              },
            ],
            details: {},
          };
        const text = formatHistory({
          name: args.name,
          systemPrompt: rec.view?.getSystemPrompt?.(),
          messages: (rec.view?.getMessages() ?? []) as {
            role?: string;
            content?: unknown;
          }[],
          offset: args.offset,
          limit: args.limit,
          hideThinking: await getHideThinking(),
        });
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
    defineTool({
      name: "set_status",
      label: "Set Status",
      renderCall: (args, theme, context) =>
        renderToolArgs(
          "set_status",
          args as Record<string, unknown>,
          theme as RenderTheme,
          context?.expanded ?? false,
        ),
      description:
        "Set your short status line shown in list_subagents and the agents panel " +
        "(e.g. 'parsing 500 files', 'waiting on review'). Pass empty string to clear. " +
        `Keep it terse — one short phrase, ≤ ${CUSTOM_STATUS_MAX} chars (longer is truncated in the roster). ` +
        "It must describe your CURRENT state, not a past action. " +
        "Every tool result is stamped with the wall-clock time it finished — use those stamps to " +
        "gauge elapsed time and rates. Set etaMinutes (minutes from NOW until you're free) only " +
        "from a concrete basis: a command's timeout, a known duration, or a measured rate; omit it " +
        "when you would be guessing — no ETA beats a wrong one. It is fully respecified each call " +
        "(omit to clear a prior ETA) and rendered as an absolute clock time, so do NOT write an " +
        "ETA into the status text yourself. " +
        "Update status when your phase changes, and before you END A TURN and go idle set it to a " +
        "resting/outcome state (e.g. 'done', 'waiting for critic', 'blocked: needs X') or clear it — " +
        "never leave a stale in-progress phrase like 'sending to editor' once you are idle. " +
        "Do not restate the system status ('idle', 'thinking'): it is already displayed next to " +
        "yours, so 'idle' here just renders as 'idle · idle'. Say WHY or WHAT, or clear it.",
      parameters: Type.Object({
        status: Type.String({
          description: `Short status phrase, ≤ ${CUSTOM_STATUS_MAX} chars; empty clears`,
        }),
        etaMinutes: Type.Optional(
          Type.Number({
            description:
              "Minutes from now until you're free; rendered as absolute clock time. Omit to clear.",
          }),
        ),
      }),
      execute: async (_id, args) => {
        const etaTs =
          args.etaMinutes != null
            ? Date.now() + args.etaMinutes * 60000
            : undefined;
        engine.setCustomStatus(selfName, args.status, etaTs);
        updateStatus();
        return {
          content: [
            {
              type: "text",
              text: args.status
                ? `status set: ${args.status}`
                : "status cleared",
            },
          ],
          details: {},
        };
      },
    }),
  ];
}
