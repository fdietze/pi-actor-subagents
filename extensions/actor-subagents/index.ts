/**
 * Subagents pi extension — foreground entry.
 * Holds the engine as a globalThis singleton (survives /reload), registers tools
 * + commands for the 'main' agent and creates background agents via the SDK.
 * Design: ../../../DESIGN.md
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  AGENT_MESSAGE_CUSTOM_TYPE,
  createRoutedAgentMessage,
  toCustomAgentMessage,
  type RoutedAgentMessage,
} from "./agent-message.ts";
import { renderAgentMessage } from "./agent-message-renderer.ts";
import { orderAgents } from "./agent-order.ts";
import { agentStatus } from "./agent-status.ts";
import { agentSystemPrompt } from "./agent-system-prompt.ts";
import { makeAgentTools } from "./agent-tools.ts";
import { parseChildExtensionPolicy } from "./child-extension-policy.ts";
import { Engine, type AgentHandle } from "./engine.ts";
import {
  formatFeedLines,
  formatKillResult,
  formatResumeSummary,
  formatSnapshot,
  type KillOutcome,
  type ResumeSummary,
} from "./feed.ts";
import {
  formatContext,
  formatRoster,
  formatSendTargets,
  panelRows,
  type StatusTone,
  swarmStateLine,
} from "./panel-logic.ts";
import { createSubagentsPanel } from "./panel.ts";
import {
  danglingToolResultIds,
  deriveStatus,
  type RawMessage,
  sessionSpecFromRoster,
} from "./persistence-logic.ts";
import { readRoster, subagentsDir, writeRoster } from "./persistence.ts";
import {
  resolveExplicitModelRef,
  resolveModelRef,
  unknownModelMessage,
} from "./resolve-model.ts";
import { createAgentModelSetter } from "./set-agent-model.ts";
import {
  createSpawner,
  type ResolvedModel,
  type SessionLike,
} from "./spawner.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./thinking-level.ts";

// Caps — Phase 1: module constants (binding them to settings is a trivial later addition).
const CAPS = { maxAgents: 8, maxSpawnDepth: 3, turnBudget: 200 };

/** Read the XDG-managed child capability policy on every spawn; malformed/missing means none. */
function readChildExtensionPolicy(): string[] {
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  const policyFile = path.join(
    configHome,
    "pi",
    "actor-subagents",
    "child-extensions.json",
  );
  try {
    return parseChildExtensionPolicy(fs.readFileSync(policyFile, "utf8"));
  } catch {
    return [];
  }
}

// Fired to each mid-turn-paused agent on resume to re-trigger its work. Fixed text
// (not main-authored) so resume stays a single tool call from main's side.
const RESUME_NUDGE = "[resumed] continue your interrupted work";
// Injected into 'main' when the swarm pauses on the turn budget (not on a manual pause).
const BUDGET_ESCALATION = (total: number) =>
  `turn budget (${total}) exhausted, swarm paused. resume_subagents() to re-arm and continue. ` +
  `If turns ran higher than expected, inspect with list_subagents before resuming.`;

// The Engine is a globalThis singleton so it survives /reload. Consequence: a persisted
// instance keeps the SHAPE (methods) of the code that built it — adding/changing Engine
// methods requires bumping this key, else the old instance lacks them ("x is not a
// function") and throws inside event callbacks.
// v2: 'user' -> 'main' rename. v3: added setActivity (fine-grained status phases).
// v4: halt(reason)+frozenReason, freeze-by-blocking recordTurnStart, halted flag, 200 cap.
// v5: AgentRecord gains systemPrompt+sessionFile (persistence roster), attach() sets them.
// v6: Engine gains setCustomStatus + AgentRecord.customStatus (agent-settable status line).
// v7: Engine gains setStopReason + AgentRecord.stopReason; setStreaming(true) clears it.
// v8: setCustomStatus(name, status, etaTs?) + AgentRecord.etaTs (absolute-time ETA).
// v9: added the paused inbox buffer to AgentRecord.
// v10: asynchronous child runtime close + foreground shutdownAll lifecycle.
// v11: AgentRecord gains the child's observed effective thinkingLevel.
// v12: route and resume return structured delivery/pause outcomes.
// v13: resume releases each paused inbox as one atomic ordered batch.
// v14: setStreaming -> beginTurn/endTurn; AgentRecord.streaming folded into .activity.
// v15: one pause vocabulary — halt/frozen/halted -> pause/paused/pausedMidTurn, PauseReason.
// v16: kill cascades to the subtree (KillResult.killed), resume is a no-op while live,
//      route events carry `buffered`.
// v17: Engine.retune + AgentRecord.reconfigure (live model/effort change).
// v18: route handles structured custom agent messages instead of user-message text.
// v19: per-agent manual pause (pause/resume take name lists, pauseSwarm for budget/restored)
//      + deliverUser (panel input as a real user turn).
// v20: isPaused() is the swarm stop only (+ pausedAgents()); resume re-arms the turn budget
//      only when it lifts that stop.
const ENGINE_KEY = "__subagentsEngine_v20";

function getEngine(): Engine {
  const g = globalThis as Record<string, unknown>;
  if (!g[ENGINE_KEY]) g[ENGINE_KEY] = new Engine(CAPS);
  return g[ENGINE_KEY] as Engine;
}

// Delivery to the 'main' agent runs through this globalThis indirection, NOT through a
// captured `pi`. The engine singleton survives /reload and session replacement, but a
// captured `pi` becomes permanently stale (pi loader: state.staleMessage ??= ..., never
// reset). Each freshly loaded instance overwrites the sink with its own live
// pi.sendMessage, so the stored main handle never calls a dead pi.
const MAIN_SINK_KEY = "__subagentsMainSink_v3";
type MainSink = (message: RoutedAgentMessage) => void;
function setMainSink(sink: MainSink): void {
  (globalThis as Record<string, unknown>)[MAIN_SINK_KEY] = sink;
}
function deliverToMain(message: RoutedAgentMessage): void {
  const sink = (globalThis as Record<string, unknown>)[MAIN_SINK_KEY] as
    | MainSink
    | undefined;
  if (!sink) throw new Error("no live foreground session to deliver to 'main'");
  sink(message);
}

// Live foreground state read by the singleton 'main' record. Same reason as MAIN_SINK_KEY:
// the engine (and thus main's view/handle closures) survive /reload, but each reloaded
// instance has fresh locals. Storing the state on globalThis lets the new instance update
// the SAME object the stored closures read, so main's ctx%/streaming never go stale.
const MAIN_STATE_KEY = "__subagentsMainState_v1";
type MainLiveState = {
  usage:
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
};
function mainState(): MainLiveState {
  const g = globalThis as Record<string, unknown>;
  let s = g[MAIN_STATE_KEY] as MainLiveState | undefined;
  if (!s) {
    s = { usage: undefined };
    g[MAIN_STATE_KEY] = s;
  }
  return s;
}

export default function subagents(pi: ExtensionAPI) {
  const engine = getEngine();

  // The toolset acting as `selfName`. Deps are collected per call, so this stays independent
  // of the order in which spawnAgent/updateStatus below are defined.
  const toolsFor = (selfName: string) =>
    makeAgentTools(selfName, {
      engine,
      spawnAgent,
      setAgentModel,
      persistRoster,
      updateStatus,
      getHideThinking,
    });

  // One fixed custom type gives every peer message a distinct, stable visual identity. The
  // structured details drive the renderer; the content projection still carries provenance
  // because Pi converts custom messages to provider-level user messages (SoC, DRY).
  pi.registerMessageRenderer(AGENT_MESSAGE_CUSTOM_TYPE, renderAgentMessage);

  // This (freshly loaded) instance now owns the main delivery with its live pi —
  // replacing a possibly stale sink from a previous instance.
  // deliverAs "steer": deliver agent->main messages at main's next turn boundary instead
  // of only when main fully stops. Critical for the common "poll list_subagents until done"
  // loop: with "followUp" the replies queue while main streams and main never observes
  // them mid-loop (polls forever). "steer" injects them before main's next LLM call so it
  // sees the replies. triggerTurn preserves immediate delivery while main is idle.
  setMainSink((message) =>
    pi.sendMessage(toCustomAgentMessage(message), {
      triggerTurn: true,
      deliverAs: "steer",
    }),
  );

  // Process-global model services built once (same creds as the foreground).
  // pi 0.80.10 SDK: AuthStorage was removed and ModelRegistry now wraps an async
  // ModelRuntime. ModelRuntime.create() with no args reads getAgentDir()/auth.json
  // + models.json — the SAME credentials and models the foreground uses. subagents()
  // is synchronous, so build asynchronously and expose the runtime via a promise;
  // find()/getAvailable() below read the registry synchronously once refresh() lands
  // (well before the first spawn), and guard against the brief pre-ready window.
  let modelRegistry: ModelRegistry | undefined;
  const modelRuntimeReady = ModelRuntime.create().then(async (runtime) => {
    modelRegistry = new ModelRegistry(runtime);
    await modelRegistry.refresh();
    return runtime;
  });

  // Background agents share main's real agentDir so they inherit the SAME global AGENTS.md
  // and global skills. Recursive discovery stays disabled; only the explicit XDG policy is
  // loaded, so interactive or orchestration extensions cannot enter a headless child by
  // accident (least capability, without embedding personal extension names in this code).
  const realAgentDir = path.join(os.homedir(), ".pi/agent");

  // Where this main session's background agent files + roster live. Set at session_start
  // from the main session; undefined until then (and for an in-memory main session) -> new
  // agents fall back to in-memory (no persistence).
  let subDir: string | undefined;

  // Read the live hideThinkingBlock setting (the static config AND the ctrl+t runtime toggle
  // both persist to it). reload() picks up runtime toggles; we read fresh per panel-open and
  // per subagent_history call so subagent thinking display stays aligned with the main UI.
  let settingsMgr: SettingsManager | undefined;
  const getHideThinking = async (): Promise<boolean> => {
    try {
      if (!settingsMgr) settingsMgr = SettingsManager.create(cwd, realAgentDir);
      await settingsMgr.reload();
      return settingsMgr.getHideThinkingBlock();
    } catch {
      return false;
    }
  };

  // The UI is only available via ctx.ui (ExtensionUIContext), not on `pi`.
  // We cache the reference from session_start so we can update the footer from
  // engine events too (outside a handler ctx).
  type UI = {
    setStatus(key: string, text: string | undefined): void;
    setWidget(
      key: string,
      content: string[] | undefined,
      opts?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
    theme: {
      fg(color: string, s: string): string;
      bg(color: string, s: string): string;
    };
  };
  let ui: UI | undefined;
  // Cache the main context as a VALUE — never hold the ctx itself (it goes stale after a
  // turn/reload; calling a cached ctx crashes pi with "stale ctx").
  const captureMainContext = (c: {
    getContextUsage(): MainLiveState["usage"];
  }) => {
    try {
      mainState().usage = c.getContextUsage();
    } catch {
      /* ctx stale -> ignore, refreshed on the next handler */
    }
  };
  type ModelLike = { provider: string; id: string };
  let cwd = process.cwd();
  let foregroundModel: ModelLike | undefined; // current foreground model (for inheritance to agents)
  let foregroundThinkingLevel: ThinkingLevel | undefined;
  // "provider/id" of the models this session is scoped to (empty = no scoping configured).
  let scopedModels: string[] = [];
  // While the /subagents panel is open, hide the persistent roster (otherwise doubled).
  let panelOpen = false;

  // Capture the model from every foreground handler ctx (more reliable than model_select alone).
  const captureForegroundModel = (m: ModelLike | undefined) => {
    if (!m) return;
    foregroundModel = { provider: m.provider, id: m.id };
    const u = engine.get("main");
    if (u) u.model = `${m.provider}/${m.id}`;
  };
  const captureForegroundThinkingLevel = (level: ThinkingLevel | undefined) => {
    if (!level) return;
    foregroundThinkingLevel = level;
    const u = engine.get("main");
    if (u) u.thinkingLevel = level;
  };

  const updateStatus = () => {
    if (!ui) return;
    try {
      const agents = orderAgents(engine.list(), engine.getMessageMatrix());
      // No footer status — count/running/budget live in the /subagents panel header.
      // Permanent roster display above the editor (plan-mode pattern, no overlay).
      // Only show when at least one background agent exists (just 'main' alone is
      // redundant) and the /subagents panel is not already open.
      // Only show background agents ('main' = the chat itself, redundant).
      const background = agents.filter((a) => a.name !== "main");
      const theme = ui.theme;
      const styler = (label: string, tone: StatusTone) =>
        tone === "error"
          ? theme.bg("toolErrorBg", label)
          : tone === "busy"
            ? theme.bg("toolSuccessBg", label)
            : theme.fg("dim", label);
      const matrix = engine.getMessageMatrix();
      // EVERY widget line must fit the live terminal width or pi's renderer throws
      // ("Rendered line N exceeds terminal width"). pi checks against this.terminal.columns,
      // so truncate each composed line to process.stdout.columns (NOT a hardcoded width —
      // that crashed on narrower terminals). truncateToWidth is ANSI/unicode aware.
      const width = process.stdout.columns ?? 80;
      const rosterLines = formatRoster(
        background.map((a) => ({
          name: a.name,
          model: a.model,
          thinkingLevel: a.thinkingLevel,
          context: formatContext(a.view?.getContextUsage()),
          status: agentStatus(a),
          customStatus: a.customStatus,
          etaTs: a.etaTs,
          targets: formatSendTargets(matrix, a.name),
        })),
        width,
        { styleStatus: styler },
      ).map((line) => truncateToWidth(line, width));
      const running = background.filter(
        (a) => agentStatus(a).kind === "working",
      ).length;
      const stateLine = swarmStateLine(
        engine.isPaused(),
        running,
        engine.pausedAgents().length,
      );
      const pauseLine = engine.isPaused()
        ? theme.bg(
            "toolPendingBg",
            truncateToWidth(stateLine.padEnd(width), width),
          )
        : theme.bg("selectedBg", truncateToWidth(stateLine, width));
      // Same header the /subagents panel shows, so the turn budget is always visible at a
      // glance (matters for the budget-pause escalation) — not only inside the panel.
      const { used, total } = engine.budget;
      const header = theme.fg(
        "accent",
        truncateToWidth(
          `─ subagents · ${background.length} agents · ${running} running · budget ${used}/${total} `,
          width,
        ),
      );
      ui.setWidget(
        "agents-roster",
        panelOpen || background.length === 0
          ? undefined
          : [header, ...rosterLines, pauseLine],
      );
    } catch {
      /* ui from a stale ctx -> skip this tick, refreshes on the next handler */
    }
  };

  // Update the status on every engine event; escalate budget-pauses to 'main' exactly once
  // (the pause event fires once — the paused guard in recordTurnStart prevents re-entry).
  // A manual /subagents-pause and a restored swarm do NOT escalate (nobody ran out of budget).
  engine.subscribe((e) => {
    if (e.type === "pause" && e.reason === "budget") {
      try {
        deliverToMain(
          createRoutedAgentMessage(
            "scheduler",
            BUDGET_ESCALATION(engine.budget.total),
          ),
        );
      } catch {
        /* no live foreground session — escalation surfaces in /subagents-feed + panel instead */
      }
    }
    updateStatus();
  });

  // Policy lives in resolve-model.ts (pure); this only binds it to the live registry.
  const resolveModel = (ref: string | undefined): ResolvedModel | undefined =>
    resolveModelRef(
      ref,
      (provider, id) => modelRegistry?.find(provider, id) ?? undefined,
      foregroundModel,
    );

  // Tools for a specific agent (name bound fixed) — used for the foreground 'main'
  // via pi.registerTool and for background agents via customTools.

  // Repair a crash-truncated transcript before the LLM sees it: a kill between persisting an
  // assistant tool_use and its tool_result leaves a dangling tool_use, which providers reject.
  // pi does NOT reconcile on load (verified: convertToLlm + buildSessionContext pass messages
  // verbatim), so synthesize the missing tool_result here. appendMessage also rewrites the file.
  const reconcileDangling = (sm: SessionManager): void => {
    const msgs = sm.buildSessionContext().messages as RawMessage[];
    for (const { id, name } of danglingToolResultIds(msgs)) {
      sm.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: "Interrupted — not completed" }],
        isError: true,
        timestamp: Date.now(),
      } as never);
    }
  };

  // SDK adapter: creates an isolated background agent session. With existingFile it reopens a
  // persisted session (restart resume); otherwise it starts a fresh persisted session under
  // subDir (or in-memory when no main-session dir is available).
  const createSession = async (
    spec: {
      name: string;
      systemPrompt: string;
      spawnedBy: string;
      model: unknown;
      thinkingLevel?: ThinkingLevel;
    },
    existingFile?: string,
  ): Promise<{ session: SessionLike; sessionFile?: string }> => {
    // Children get the human's settings as VALUES, through a manager whose writes go nowhere.
    // pi's session.setModel()/setThinkingLevel() persist the new default into settings.json, so
    // a file-backed child manager would let a retuned subagent silently change what the next
    // foreground session starts with. Inversion: remove that failure mode structurally instead
    // of relying on nobody ever calling a persisting setter. Same reasoning as the steeringMode
    // override below, which for the same reason is applied in memory rather than via a setter.
    const realSettings = SettingsManager.create(cwd, realAgentDir);
    const childSettings = SettingsManager.inMemory(
      realSettings.getGlobalSettings(),
    );
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: realAgentDir,
      settingsManager: childSettings,
      // noExtensions disables discovery; explicit additional paths are still loaded.
      noExtensions: true,
      additionalExtensionPaths: readChildExtensionPolicy(),
      systemPromptOverride: () =>
        agentSystemPrompt(spec.name, spec.systemPrompt, spec.spawnedBy),
    });
    await loader.reload();
    // Project settings ride along as overrides (the in-memory manager only seeds the global
    // scope), plus mailbox semantics for children.
    childSettings.applyOverrides({
      ...realSettings.getProjectSettings(),
      steeringMode: "all",
    });

    let sm: SessionManager;
    if (existingFile) {
      sm = SessionManager.open(existingFile);
      reconcileDangling(sm);
    } else if (subDir) {
      fs.mkdirSync(subDir, { recursive: true });
      sm = SessionManager.create(cwd, subDir);
      try {
        (sm as { setSessionName?: (n: string) => void }).setSessionName?.(
          spec.name,
        );
      } catch {
        /* display name is cosmetic; ignore if unsupported */
      }
    } else {
      sm = SessionManager.inMemory(cwd);
    }

    // Leave the built-in tool allowlist unset so the agent inherits the full default
    // foreground toolset, plus the custom agent tools via customTools.
    const modelRuntime = await modelRuntimeReady;
    const { session } = await createAgentSession({
      cwd,
      model: spec.model as NonNullable<
        Parameters<typeof createAgentSession>[0]
      >["model"],
      thinkingLevel: spec.thinkingLevel,
      modelRuntime,
      customTools: toolsFor(spec.name),
      resourceLoader: loader,
      sessionManager: sm,
      settingsManager: childSettings,
    });
    // SDK sessions do not start extension lifecycles until the host explicitly binds them.
    await session.bindExtensions({ mode: "print" });
    const managedSession: SessionLike = {
      sendAgentMessage: (message, options) =>
        session.sendCustomMessage(toCustomAgentMessage(message), {
          triggerTurn: true,
          deliverAs: options?.deliverAs,
        }),
      // Same steer semantics as peer traffic: a busy agent picks the human's text up at its next
      // turn boundary rather than only after it fully stops.
      sendUserMessage: (text) =>
        session.sendUserMessage(text, { deliverAs: "steer" }),
      abort: () => session.abort(),
      abortBash: () => session.abortBash(),
      shutdown: async () => {
        const runner = session.extensionRunner;
        if (runner.hasHandlers("session_shutdown")) {
          await runner.emit({ type: "session_shutdown", reason: "quit" });
        }
      },
      dispose: () => session.dispose(),
      get thinkingLevel() {
        return session.thinkingLevel;
      },
      setModel: (model) =>
        session.setModel(model as Parameters<typeof session.setModel>[0]),
      setThinkingLevel: (level) => session.setThinkingLevel(level),
      subscribe: (listener) =>
        session.subscribe(listener as Parameters<typeof session.subscribe>[0]),
      get messages() {
        return session.messages;
      },
      getContextUsage: () => session.getContextUsage(),
    };
    return { session: managedSession, sessionFile: sm.getSessionFile() };
  };

  // Models offered for retuning and named in "unknown model" errors: the session's scoped
  // models when the human scoped them (settings `enabledModels` / --models), else the whole
  // authenticated catalogue. Mirrors what pi's own model cycling offers in the main chat.
  const listModels = (): string[] =>
    scopedModels.length > 0
      ? scopedModels
      : (modelRegistry?.getAvailable() ?? []).map((m) => `${m.provider}/${m.id}`);

  const { spawnAgent, restoreAgent } = createSpawner({
    engine,
    resolveModel,
    createSession,
    onActivity: updateStatus,
    listAvailableModels: listModels,
  });

  // Retuning a running agent (the set_subagent_model tool and the panel's model/effort keys).
  // The strict resolver is deliberate: retuning has no inheritance, so an unresolvable ref must
  // fail loudly instead of quietly switching the agent to the foreground model.
  const setAgentModel = createAgentModelSetter({
    engine,
    resolveModel: (ref) => {
      const resolved = resolveExplicitModelRef(
        ref,
        (provider, id) => modelRegistry?.find(provider, id) ?? undefined,
      );
      return resolved
        ? { display: `${resolved.provider}/${resolved.id}`, model: resolved.model }
        : undefined;
    },
    unknownModel: (ref) => unknownModelMessage(ref, listModels()),
    persistRoster: () => persistRoster(),
  });

  // Overwrite roster.json with current background membership (called after spawn/kill).
  // Best-effort: persistence must never break the swarm.
  const persistRoster = (): void => {
    if (!subDir) return;
    try {
      writeRoster(subDir, engine.list());
    } catch {
      /* best-effort */
    }
  };

  // Restore-once guard keyed by subDir; on globalThis so it survives /reload (which must NOT
  // re-restore — the singleton still holds the live agents).
  const restoredSet = (): Set<string> => {
    const g = globalThis as Record<string, unknown>;
    let s = g.__subagentsRestored_v1 as Set<string> | undefined;
    if (!s) {
      s = new Set();
      g.__subagentsRestored_v1 = s;
    }
    return s;
  };

  // Cold-start rebuild of a persisted swarm AS PAUSED: reopen each agent file, reconcile any
  // crash damage, derive idle-vs-mid-turn from the transcript tail, register paused. The
  // existing resume_subagents()/`/subagents-resume` then re-triggers exactly the interrupted agents.
  const restoreSwarm = async (): Promise<void> => {
    if (!subDir) return;
    // Skip if the swarm is already populated (/reload) or already restored this session.
    if (engine.list().some((a) => a.name !== "main")) return;
    const done = restoredSet();
    if (done.has(subDir)) return;
    done.add(subDir);
    const roster = readRoster(subDir);
    if (!roster.length) return;
    let restored = 0;
    for (const entry of roster) {
      if (!fs.existsSync(entry.sessionFile)) continue; // file gone -> skip
      const resolved = resolveModel(entry.model);
      if (!resolved) continue; // model no longer available -> skip
      try {
        const { session, sessionFile } = await createSession(
          sessionSpecFromRoster(entry, resolved.model),
          entry.sessionFile,
        );
        restoreAgent({
          name: entry.name,
          spawnedBy: entry.spawnedBy,
          depth: entry.depth,
          model: `${resolved.provider}/${resolved.id}`,
          systemPrompt: entry.systemPrompt,
          sessionFile: sessionFile ?? entry.sessionFile,
          session,
          pausedMidTurn:
            deriveStatus(session.messages as RawMessage[]) === "pausedMidTurn",
        });
        restored++;
      } catch {
        /* skip an unrestorable agent */
      }
    }
    // Present the restored swarm as paused: one resume_subagents()/`/subagents-resume` reactivates it.
    // "restored" is its own reason so it never escalates to main like a budget pause.
    if (restored > 0) engine.pauseSwarm("restored");
  };

  // Shared by /subagents-resume and the resume_subagents tool: unpause the named agents (all of them
  // when no names are given, which also re-arms the budget), release their buffered messages and
  // re-trigger only the interrupted ones. Nothing is re-triggered when the resume did not happen
  // (already live, or a named resume held back by the swarm-wide budget pause).
  const resumeAgents = (names?: string[]): ResumeSummary => {
    const wanted = names && names.length > 0 ? new Set(names) : undefined;
    const interrupted = engine
      .list()
      .filter(
        (a) => a.name !== "main" && a.pausedMidTurn && (!wanted || wanted.has(a.name)),
      )
      .map((a) => a.name);
    const resumed = engine.resume(names);
    if (!resumed.wasPaused) {
      updateStatus();
      return { ...resumed, retriggered: 0 };
    }
    for (const name of interrupted) void engine.route("main", name, RESUME_NUDGE);
    updateStatus();
    return { ...resumed, retriggered: interrupted.length };
  };

  // Swarm control commands take an optional agent-name list; empty means "all of them".
  const parseNames = (args: string): string[] =>
    args.split(/[\s,]+/).filter((name) => name.length > 0);

  // Names the human asked for that no agent answers to. Reported by every control command, so a
  // typo never reads as "nothing to do".
  const unknownNames = (names: string[]): string[] =>
    names.filter((name) => !engine.has(name));

  // Aborting is fire-and-forget, but a rejected promise with no handler would take pi down.
  const abortAgent = async (name: string): Promise<void> => {
    try {
      await engine.get(name)?.handle.abort();
    } catch (error) {
      engine.reportError(
        name,
        `abort failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  // Capture the foreground model (for inheritance to spawned agents).
  pi.on("model_select", (event) => {
    captureForegroundModel(event.model);
  });
  pi.on("thinking_level_select", (event) => {
    captureForegroundThinkingLevel(event.level);
  });

  // Capture the foreground streaming flag for the status display + the model.
  pi.on("agent_start", (_event, ctx) => {
    ui = ctx.ui;
    captureForegroundModel(ctx.model);
    captureForegroundThinkingLevel(ctx.thinkingLevel);
    captureMainContext(ctx);
    engine.beginTurn("main");
    updateStatus();
  });
  // Mirror the background phase tracking for 'main' so its status reads consistently.
  pi.on("message_update", (event) => {
    const sub = (event as { assistantMessageEvent?: { type?: string } })
      .assistantMessageEvent?.type;
    if (sub === "thinking_start") engine.setActivity("main", "thinking");
    else if (sub === "text_start" || sub === "toolcall_start")
      engine.setActivity("main", "writing");
    else return;
    updateStatus();
  });
  pi.on("tool_execution_start", (event) => {
    engine.setActivity(
      "main",
      "tool",
      (event as { toolName?: string }).toolName,
    );
    updateStatus();
  });
  pi.on("agent_end", (event, ctx) => {
    ui = ctx.ui;
    captureMainContext(ctx);
    captureForegroundThinkingLevel(ctx.thinkingLevel);
    engine.endTurn("main");
    // Reflect main's terminal outcome too (error/truncated), consistent with background agents.
    const msgs =
      (event as { messages?: { role?: string; stopReason?: string }[] })
        .messages ?? [];
    const lastAssistant = [...msgs]
      .reverse()
      .find((m) => m.role === "assistant");
    engine.setStopReason("main", lastAssistant?.stopReason as never);
    updateStatus();
  });

  // Register the 'main' agent (foreground). Delivery uses a Pi custom message, never a human role.
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    ui = ctx.ui;
    ctx.ui.setStatus("agents", undefined); // footer status no longer used (info lives in the panel)
    captureMainContext(ctx);
    captureForegroundModel(ctx.model);
    captureForegroundThinkingLevel(ctx.thinkingLevel);
    // Resolved once at session start (from --models / the enabledModels setting), exactly like
    // pi resolves it for its own model cycling.
    scopedModels = (ctx.scopedModels ?? []).map(
      (s) => `${s.model.provider}/${s.model.id}`,
    );
    // Locate this main session's subagents dir (persistence + restore are keyed by it).
    try {
      const id = ctx.sessionManager.getSessionId();
      const dir = ctx.sessionManager.getSessionDir();
      subDir = id && dir ? subagentsDir(dir, id) : undefined;
    } catch {
      subDir = undefined;
    }
    if (!engine.has("main")) {
      const mainHandle: AgentHandle = {
        // via the globalThis indirection so the singleton handle never uses a stale pi.
        deliver: async (message) => {
          deliverToMain(message);
        },
        abort: async () => {}, // do not abort the human's turn
      };
      engine.addAgent({
        name: "main",
        model: foregroundModel
          ? `${foregroundModel.provider}/${foregroundModel.id}`
          : "(foreground)",
        thinkingLevel: foregroundThinkingLevel,
        handle: mainHandle,
        spawnedBy: "main",
        depth: 0,
        createdAt: Date.now(),
        turns: 0,
        lastActivity: Date.now(),
        view: {
          getMessages: () => [], // main transcript = the main chat (not mirrored)
          getContextUsage: () => mainState().usage, // globalThis-backed, survives /reload
          subscribe: () => () => {},
        },
      });
    }
    await restoreSwarm();
    updateStatus();
  });

  pi.on("session_shutdown", async (event) => {
    // A same-version /reload must retain the singleton's live children. Real foreground
    // replacement/quit closes their runtimes but deliberately leaves roster.json intact.
    if (event.reason === "reload") return;
    const previousSubDir = subDir;
    subDir = undefined;
    await engine.shutdownAll();
    if (previousSubDir) restoredSet().delete(previousSubDir);
    updateStatus();
  });

  // Register the foreground tools for 'main'. set_status is background-only: main has
  // ctx.ui.setStatus() + the human watches the chat directly, so a second status channel
  // would only confuse.
  for (const tool of toolsFor("main")) {
    if (tool.name === "set_status") continue;
    pi.registerTool(tool);
  }

  // Main-only: deciding whether the paused group continues is main's call. NOT added to
  // the shared toolset (background agents must not self-resume the swarm).
  pi.registerTool({
    name: "resume_subagents",
    label: "Resume Subagents",
    description:
      "Resume PAUSED agents: release their buffered messages and retrigger their interrupted work. " +
      "Without names it resumes every agent, and re-arms the turn budget if the swarm stopped on " +
      "it; with names it only lifts those agents' manual pause and cannot buy extra budget. Does " +
      "nothing for agents that are already live. Call it after the swarm pauses on the turn budget " +
      "to let the group continue.",
    parameters: Type.Object({
      names: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Agents to resume; omit or pass an empty list to resume everything.",
        }),
      ),
    }),
    execute: async (_id, args) => {
      const summary = resumeAgents(args.names);
      return {
        content: [{ type: "text", text: formatResumeSummary(summary) }],
        details: summary,
      };
    },
  });

  // pi's fuzzy autocomplete preserves registration order when match scores tie. Register the
  // primary command first so partial input such as /subag selects the panel, not /subagents-pause.
  // /subagents opens a focused overlay across the BOTTOM half, its familiar home. Focus — not
  // full-screen size — makes mouse-wheel scrolling possible: pi's fullscreen TUI consumes wheel
  // reports for the main chat unless a focused overlay claims them (mouse-input.ts).
  pi.registerCommand("subagents", {
    description: "Open the subagents panel (Esc to close)",
    handler: async (_args, ctx) => {
      ui = ctx.ui;
      panelOpen = true;
      updateStatus(); // hide the redundant persistent roster
      const hideThinking = await getHideThinking(); // align panel thinking with the main UI
      // Seed tool-output expansion from the main UI so ctrl+o state is inherited (and synced back).
      const toolsExpanded = ctx.ui.getToolsExpanded?.() ?? false;
      try {
        await ctx.ui.custom<void>((tui, theme, kb, done) =>
          createSubagentsPanel(
            {
              engine,
              cwd,
              hideThinking,
              toolsExpanded,
              setToolsExpanded: (v) => ctx.ui.setToolsExpanded?.(v),
              listModels,
              setAgentModel: (spec) =>
                setAgentModel(spec as Parameters<typeof setAgentModel>[0]),
            },
            tui,
            theme,
            // kb.matches() is inherited from pi-tui's KeybindingsManager but not
            // visible on the pi-coding-agent subclass under tsgo bundler resolution;
            // the runtime object carries it, so narrow to the KeybindingsLike shape
            // the panel actually uses.
            kb as unknown as {
              matches(data: string, keybinding: string): boolean;
            },
            done,
          ),
          {
            overlay: true,
            // Bottom half: the panel covers the chat tail while open, but the older chat above stays
            // visible. A top anchor kept the tail visible but was disorienting (the roster jumped
            // above the conversation), so we accept covering the tail for the unsurprising position.
            overlayOptions: {
              anchor: "bottom-center",
              width: "100%",
              maxHeight: panelRows(process.stdout.rows ?? 30),
            },
            // Without focus the overlay renders but the editor keeps the input — and the wheel.
            onHandle: (handle: { focus(): void }) => handle.focus(),
          } as never,
        );
      } finally {
        panelOpen = false;
        updateStatus(); // show the persistent roster again
      }
    },
  });

  // Every swarm control command shares the /subagents- prefix, so typing it lists the whole
  // control surface and none collides with a pi built-in (/resume continues a chat session).
  pi.registerCommand("subagents-pause", {
    description:
      "Pause agents by name (empty = all); their turns stop and new messages buffer until resumed.",
    handler: async (args, ctx) => {
      const requested = parseNames(args);
      const unknown = unknownNames(requested);
      const paused = engine.pause(requested);
      // Abort AFTER the pause is recorded, so a turn cut here cannot start a successor.
      for (const name of paused) void abortAgent(name);
      const notice = [
        paused.length
          ? `PAUSED ${paused.join(", ")}; new messages will buffer. Use /subagents-resume to continue.`
          : "No agents to pause.",
        ...(unknown.length ? [`unknown: ${unknown.join(", ")}`] : []),
      ].join(" · ");
      ctx.ui.notify(notice, "warning");
      updateStatus();
    },
  });

  pi.registerCommand("subagents-resume", {
    description:
      "Resume agents by name (empty = all; re-arms the turn budget if the swarm stopped on it): " +
      "release buffered messages and retrigger interrupted work. No effect on agents that are " +
      "already live.",
    handler: async (args, ctx) => {
      const requested = parseNames(args);
      const unknown = unknownNames(requested);
      const summary = formatResumeSummary(resumeAgents(requested));
      ctx.ui.notify(
        unknown.length ? `${summary} · unknown: ${unknown.join(", ")}` : summary,
        "info",
      );
    },
  });

  pi.registerCommand("subagents-kill", {
    description: "Terminate agents by name (empty = all except 'main').",
    handler: async (args, ctx) => {
      const names = parseNames(args);
      // Named kills report per target (each cascades to its subtree); without names the whole
      // swarm goes down and killAll already returns the flat list of what it took.
      const results: KillOutcome[] = names.length
        ? await Promise.all(
            names.map(async (target) => ({ target, ...(await engine.kill(target)) })),
          )
        : (await engine.killAll()).map((name) => ({ target: name, ok: true }));
      persistRoster();
      ctx.ui.notify(
        results.length ? formatKillResult(results) : "No agents to kill.",
        "info",
      );
      updateStatus();
    },
  });

  // The textual counterpart of the panel: the same roster the list_subagents tool prints, so the
  // human can read the swarm state without opening (and closing) an overlay.
  pi.registerCommand("subagents-list", {
    description: "Show the subagent roster as text.",
    handler: async (_args, ctx) => {
      const { used, total } = engine.budget;
      const ordered = orderAgents(engine.list(), engine.getMessageMatrix());
      ctx.ui.notify(
        formatSnapshot(ordered, used, total, "main", engine.isPaused()),
        "info",
      );
    },
  });

  pi.registerCommand("subagents-feed", {
    description: "Show the agent activity log (last 40 events).",
    handler: async (_args, ctx) => {
      const lines = formatFeedLines(engine.events).slice(-40);
      ctx.ui.notify(
        lines.length ? lines.join("\n") : "(no activity yet)",
        "info",
      );
    },
  });
}
