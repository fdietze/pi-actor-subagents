/**
 * Subagents pi extension — foreground entry.
 * Holds the engine as a globalThis singleton (survives /reload), registers tools
 * + commands for the 'main' agent and creates background agents via the SDK.
 * Design: ../../../DESIGN.md
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionUIContext,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  AGENT_MESSAGE_CUSTOM_TYPE,
  toCustomAgentMessage,
  type RoutedAgentMessage,
} from "./agent-message.ts";
import { renderAgentMessage } from "./agent-message-renderer.ts";
import { orderAgents } from "./agent-order.ts";
import { agentSystemPrompt } from "./agent-system-prompt.ts";
import { makeAgentTools } from "./agent-tools.ts";
import { installApi, restoreToolGuard } from "./api.ts";
import type { AgentHandle } from "./agent-record.ts";
import type { EngineResumeResult } from "./control-result.ts";
import { authorityOf } from "./authorize.ts";
import { Engine } from "./engine.ts";
import {
  formatControlResult,
  formatResumeResult,
} from "./feed.ts";
import {
  formatRoster,
  type StatusTone,
  type StatusWidth,
  swarmStateLine,
} from "./panel-logic.ts";
import { rosterEntries } from "./roster-entries.ts";
import { type ExtensionStatuses, withExtensionStatus } from "./extension-status.ts";
import { bindHeadlessExtensions } from "./bind-headless-extensions.ts";
import { createSubagentsPanel } from "./panel.ts";
import { createRosterWidget } from "./roster-widget.ts";
import {
  deriveStatus,
  type RawMessage,
  restoredPlacement,
  sessionSpecFromRoster,
} from "./persistence-logic.ts";
import { readRoster, subagentsDir, writeRoster } from "./persistence.ts";
import {
  resolveExplicitModelRef,
  resolveModelRef,
  unknownModelMessage,
} from "./resolve-model.ts";
import { createAgentModelSetter } from "./set-agent-model.ts";
import { parseSettings, type Settings } from "./settings.ts";
import {
  createSpawner,
  type ResolvedModel,
  type SessionLike,
} from "./spawner.ts";
import type { ThinkingLevel } from "./thinking-level.ts";
import { timestampToolResult } from "./tool-timestamp.ts";
import { childToolOptions, type ToolGuard } from "./tool-guard.ts";

/**
 * Gives one session a sense of elapsed time by stamping the wall-clock start and finish times
 * onto every tool result — the basis for a set_status ETA that is measured instead of guessed,
 * and the only way an agent can read a single tool's own duration.
 * A pi hook only fires in the session that registered it, so this runs twice: directly for
 * the foreground, and as an inline extension factory inside every child session.
 *
 * The start time is captured at tool_call (fired before execution) and consumed at tool_result,
 * paired by tool call id. An aborted tool may fire tool_call without a tool_result, leaving one
 * stale entry; that is a bounded, negligible leak, so no separate cleanup path is warranted.
 */
function registerToolTimestamps(pi: ExtensionAPI): void {
  const startedAt = new Map<string, number>();
  pi.on("tool_call", (event) => {
    startedAt.set(event.toolCallId, Date.now());
  });
  pi.on("tool_result", (event) => {
    const start = startedAt.get(event.toolCallId);
    startedAt.delete(event.toolCallId);
    return { content: timestampToolResult(event.content, start, Date.now()) };
  });
}

/**
 * Read this extension's settings, next to pi's own agent config (getAgentDir() honors pi's
 * agent-dir override, so a test or alternate profile stays self-contained).
 * A missing or unreadable file is the same as an empty one: parseSettings decides what that
 * means per field (defaults for caps, nothing for childExtensions).
 */
function readSettings(): Settings {
  const file = path.join(getAgentDir(), "actor-subagents", "settings.json");
  try {
    return parseSettings(fs.readFileSync(file, "utf8"));
  } catch {
    return parseSettings("");
  }
}

// Fired to each mid-turn-paused agent on resume to re-trigger its work. Fixed text
// (not main-authored) so resume stays a single tool call from main's side.
// It carries the current local date and time because a resumed transcript can be days old:
// the tool-result stamps in it are date-free, so yesterday's [finished 23:10:04] reads like
// today's. This is the agent's only anchor at the point where its transcript jumps in time.
// It names the actor that resumed it, since the sender is the authority agent ('main' for the
// human and restore), not necessarily who acted.
const RESUME_NUDGE = (now: Date, by: string) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `[resume nudge ${stamp} by ${by}] Continue your interrupted work. A missing tool result means the action outcome is UNKNOWN, not that it failed or had no effect. Inspect actual external state before retrying side-effecting actions.`;
};
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
// v21: Engine gains awaitReaction + statusOf + pauseCauseOf (send/spawn report the receiver's
//      state); route's buffered reason widens from "paused" to PauseReason.
// v22: Engine gains the maxAgents getter (panel header) and takes its caps from settings.json.
// v23: setStopReason(name, reason, detail?) owns the single edge-triggered `error` emit (one per
//      failed turn, both the thrown-exception and the retries-exhausted path); reportError no
//      longer emits itself. A v22 instance would miss the retries-exhausted notification and
//      double-report the exception one, so it must not survive into this code.
// v24: the turn budget is gone — no global turn accounting, no budget pause, no `budget` getter;
//      pauseSwarm(reason) becomes pauseRestored(). A v23 instance would still stop the swarm on
//      its own budget and expose methods this code no longer calls.
// v25: child lifecycle wiring finalizes a logical run on agent_settled, not each retry's agent_end.
//      Existing sessions retain their subscribed closure across /reload, so a v24 engine must be
//      shut down rather than keep emitting duplicate retry notifications.
// v26: one kind of pause — restoredPause, pauseRestored(), isPaused() and PauseReason are gone;
//      a restore pauses main's direct children with the ordinary per-agent flag. The pause is
//      derived (own flag or an ancestor's), resume returns the released/interrupted agents,
//      Engine.status(rec) is the displayed status, and getSpawnTree() is derived from live
//      records. pause/resume/kill/retune take the acting agent first; pause/resume/kill take a
//      names list and return per-target outcomes; pause aborts the stopped turns itself and
//      resume is async, waiting for those aborts. A v25 instance would keep a swarm-wide pause this code can no longer lift.
// v27: provenance and lifecycle notices — AgentRecord.paused holds the actor (a string), events
//      carry `by`, "user"/"restore" act with main's authority, killAll(by), errorReason, statuses
//      carry their cause, and the engine queues silent notices (notify/settled; handles gain
//      append/busy). A v26 instance would treat a string flag as foreign and lack these methods.
// v28: terminal errors route actionable scheduler messages instead of silent notices; v27
//      would retain the old announce/route methods after /reload and never wake a parent.
// v29: records carry sessionId and the spawn policy's state (policyMeta, policyTools,
//      policyGuarded, runBlock; api.ts); attach() stores them and emits an `attach` event,
//      addAgent's spawn event carries the record's sessionId, and resume refuses a blocked
//      (runBlock) agent. A v28 instance would lack all of it, so api.ts would never report a
//      child's session id and a blocked restored agent could be resumed.
const ENGINE_KEY = "__subagentsEngine_v29";

function getEngine(): Engine {
  const g = globalThis as Record<string, unknown>;
  // Caps are read once, when this singleton is created: the swarm's limits stay fixed for as
  // long as its agents live, so editing settings.json applies at the next pi start (or /reload,
  // which only rebuilds the engine when ENGINE_KEY changed).
  if (!g[ENGINE_KEY]) {
    // A key bump means a /reload met an engine of an earlier generation. This code cannot see its
    // agents, but their child sessions keep running and can still deliver into the foreground
    // through the global sink, so the previous generation is taken down before this one is built
    // (Second-Order Thinking: an upgrade must not leave untracked runtimes behind). Membership
    // stays on disk in roster.json, so the next pi start restores the swarm.
    // Fire-and-forget: nothing here can await, and a faulty old runtime must not block the new
    // engine — shutdownAll already isolates per-child failures.
    for (const key of Object.keys(g)) {
      if (key === ENGINE_KEY || !key.startsWith("__subagentsEngine_v")) continue;
      const previous = g[key] as { shutdownAll?: () => Promise<void> };
      delete g[key];
      void previous?.shutdownAll?.().catch(() => {});
    }
    g[ENGINE_KEY] = new Engine(readSettings().caps);
  }
  return g[ENGINE_KEY] as Engine;
}

// Delivery to the 'main' agent runs through this globalThis indirection, NOT through a
// captured `pi`. The engine singleton survives /reload and session replacement, but a
// captured `pi` becomes permanently stale (pi loader: state.staleMessage ??= ..., never
// reset). Each freshly loaded instance overwrites the sink with its own live
// pi.sendMessage, so the stored main handle never calls a dead pi.
// `silent` appends without starting a turn (lifecycle notices); otherwise the message wakes main.
const MAIN_SINK_KEY = "__subagentsMainSink_v4";
type MainSink = (message: RoutedAgentMessage, silent: boolean) => void;
function setMainSink(sink: MainSink): void {
  (globalThis as Record<string, unknown>)[MAIN_SINK_KEY] = sink;
}
function deliverToMain(message: RoutedAgentMessage, silent = false): void {
  const sink = (globalThis as Record<string, unknown>)[MAIN_SINK_KEY] as
    | MainSink
    | undefined;
  if (!sink) throw new Error("no live foreground session to deliver to 'main'");
  sink(message, silent);
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
  /**
   * Pi's own idle check (ctx.isIdle: no agent run active) from the latest foreground handler, so
   * main's busy() reads the real run state like a child's isStreaming instead of a flag that a
   * late agent_settled of the previous run could clear under the next one. A waking delivery
   * marks the run active synchronously, so no hand-off gap exists. Calling it after the ctx went
   * stale throws (see mainBusy). Optional: a state object from an older load lacks it.
   */
  isIdle?: () => boolean;
};
/**
 * Is main's run active? Unknown (no or a stale ctx) counts as busy: the notice then waits for the
 * next agent_settled, which recaptures a live ctx and flushes — waiting is safe, appending
 * mid-run is not (Margin of Safety).
 */
function mainBusy(): boolean {
  try {
    const isIdle = mainState().isIdle;
    return isIdle ? !isIdle() : true;
  } catch {
    return true;
  }
}
function mainState(): MainLiveState {
  const g = globalThis as Record<string, unknown>;
  let s = g[MAIN_STATE_KEY] as MainLiveState | undefined;
  if (!s) {
    s = { usage: undefined };
    g[MAIN_STATE_KEY] = s;
  }
  return s;
}

/**
 * Hooks that attach to things OUTLIVING one extension load — the process's stdout and the engine
 * singleton — while this module is evaluated again on every /reload with fresh closures. Exactly
 * one load may own them at a time: each load disposes the previous owner's hooks before
 * installing its own, otherwise every reload adds another subscriber and a single engine event
 * would be handled once per load through
 * closures whose `ui` is already dead.
 *
 * The swap on load is what guarantees this; the shutdown-time disposal below is a courtesy for
 * the case where no further load follows, so nothing depends on session_shutdown firing.
 */
const PROCESS_HOOKS_KEY = "__subagentsProcessHooks_v1";
function installProcessHooks(dispose: () => void): void {
  const g = globalThis as Record<string, unknown>;
  (g[PROCESS_HOOKS_KEY] as (() => void) | undefined)?.();
  g[PROCESS_HOOKS_KEY] = dispose;
}
function disposeProcessHooks(dispose: () => void): void {
  const g = globalThis as Record<string, unknown>;
  // Only the owner disposes: a newer load may already have taken over, and disposing then would
  // tear down the LIVE hooks instead of these.
  if (g[PROCESS_HOOKS_KEY] !== dispose) return;
  dispose();
  g[PROCESS_HOOKS_KEY] = undefined;
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
      resumeAgents,
      persistRoster,
      updateStatus,
      spawnPolicyActive: () => api.spawnPolicy() !== undefined,
      // Re-read per call like the other display settings, so an edit applies at the next listing.
      promptCacheTtlMs: () => readSettings().promptCacheTtlMs,
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
  // silent: triggerTurn false appends without a turn, which the engine only does while main is
  // not busy (mid-run Pi would push it into the running turn's history).
  setMainSink((message, silent) =>
    pi.sendMessage(
      toCustomAgentMessage(message),
      silent
        ? { triggerTurn: false }
        : { triggerTurn: true, deliverAs: "steer" },
    ),
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
  // and global skills. Recursive discovery stays disabled; only the extensions listed in
  // settings.json are loaded, so interactive or orchestration extensions cannot enter a
  // headless child by accident (least capability, without embedding personal extension
  // names in this code).
  const realAgentDir = getAgentDir();

  // Where this main session's background agent files + roster live. Set at session_start
  // from the main session; undefined until then (and for an in-memory main session) -> new
  // agents fall back to in-memory (no persistence).
  let subDir: string | undefined;

  // Read the live hideThinkingBlock setting (the static config AND the ctrl+t runtime toggle
  // both persist to it). reload() picks up runtime toggles; we read fresh per panel-open so
  // the panel's thinking display stays aligned with the main UI.
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
  let ui: ExtensionUIContext | undefined;
  // Cache the main context as a VALUE — never hold the ctx itself (it goes stale after a
  // turn/reload; calling a cached ctx crashes pi with "stale ctx").
  const captureMainContext = (c: {
    getContextUsage(): MainLiveState["usage"];
    isIdle(): boolean;
  }) => {
    // The function, not the ctx: it is only ever called guarded (mainBusy).
    mainState().isIdle = () => c.isIdle();
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
  // One status column width for the persistent roster and the panel (panel-logic.ts StatusWidth):
  // the footer widget is rebuilt on every refresh, so its state must live here.
  const rosterStatusWidth: StatusWidth = { width: 0 };

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
      // No footer status — count and running live in the /subagents panel header.
      // Permanent roster display above the editor (plan-mode pattern, no overlay).
      // Only show when at least one background agent exists (just 'main' alone is
      // redundant) and the /subagents panel is not already open.
      // Only show background agents ('main' = the chat itself, redundant); the spawn-tree depth
      // of each entry becomes the row indent, with main's children as the visible roots.
      const background = agents.filter((o) => o.agent.name !== "main");
      if (panelOpen || background.length === 0) {
        ui.setWidget("agents-roster", undefined);
        return;
      }
      const widgetUi = ui;
      ui.setWidget("agents-roster", (_tui, theme) => createRosterWidget(
        background.map(({ agent }) => agent.name),
        (width) => {
          const styler = (label: string, tone: StatusTone) =>
            tone === "error"
              ? theme.bg("toolErrorBg", label)
              : tone === "busy"
                ? theme.bg("toolSuccessBg", label)
                : theme.fg("dim", label);
          // Render at Pi's supplied width: resizing and other widgets can change the available space.
          const rosterLines = formatRoster(
            rosterEntries(engine, background),
            width,
            { styleStatus: styler, statusWidth: rosterStatusWidth },
          ).map((line) => truncateToWidth(line, width));
          const running = background.filter(
            (o) => engine.status(o.agent).kind === "working",
          ).length;
          const stateLine = swarmStateLine(running, engine.pausedAgents().length);
          const pauseLine = theme.bg("selectedBg", truncateToWidth(stateLine, width));
          // Same header the /subagents panel shows, so the swarm's size and activity stay visible at
          // a glance — not only inside the panel.
          const header = theme.fg(
            "accent",
            truncateToWidth(
              `─ subagents · ${background.length} agents · ${running} running `,
              width,
            ),
          );
          return [header, ...rosterLines, pauseLine];
        },
        (name) => {
          void openPanel(widgetUi, name).catch((error) => widgetUi.notify(String(error), "error"));
        },
      ));
    } catch {
      /* ui from a stale ctx -> skip this tick, refreshes on the next handler */
    }
  };

  // Update the status on every engine event.
  const unsubscribeEngine = engine.subscribe(() => updateStatus());
  installProcessHooks(unsubscribeEngine);

  // Policy lives in resolve-model.ts (pure); this only binds it to the live registry.
  const resolveModel = (ref: string | undefined): ResolvedModel | undefined =>
    resolveModelRef(
      ref,
      (provider, id) => modelRegistry?.find(provider, id) ?? undefined,
      foregroundModel,
    );

  // Tools for a specific agent (name bound fixed) — used for the foreground 'main'
  // via pi.registerTool and for background agents via customTools.

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
      tools?: string[];
      toolGuard?: ToolGuard;
    },
    existingFile?: string,
  ): Promise<{ session: SessionLike; sessionFile?: string; sessionId?: string }> => {
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
    const settings = readSettings();
    // The spawn policy's allowlist and guard (tool-guard.ts): without them the agent inherits the
    // full default foreground toolset, plus the custom agent tools via customTools; with an
    // allowlist the orchestration tools always stay (childToolAllowlist).
    const toolOptions = childToolOptions(spec, toolsFor(spec.name));
    // Read once with the tools, so the preamble and spawn_subagent word the spawn hint alike.
    const spawnPolicyActive = api.spawnPolicy() !== undefined;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: realAgentDir,
      settingsManager: childSettings,
      // noExtensions disables discovery; explicit additional paths are still loaded.
      // additionalExtensionPaths stays exactly the configured policy, so that array remains a
      // faithful picture of the FOREIGN capability boundary. Our own always-on hook rides
      // the separate in-process factory channel (like the orchestration customTools), which
      // cannot fail to resolve and, loading after the path extensions, appends the stamp
      // last — a policy-granted extension cannot clobber it.
      // Re-read per spawn (unlike the caps), so revoking a capability takes effect on the
      // next child rather than at the next pi start.
      noExtensions: true,
      additionalExtensionPaths: settings.childExtensions,
      extensionFactories: [
        { name: "subagent-timestamps", factory: registerToolTimestamps },
        ...toolOptions.extensionFactories,
      ],
      systemPromptOverride: () =>
        agentSystemPrompt(spec.name, spec.systemPrompt, spec.spawnedBy, spawnPolicyActive),
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
      // Separation of Concerns: Pi normalizes outbound requests; restoration keeps
      // observed history intact because a missing result cannot prove an action failed.
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

    const modelRuntime = await modelRuntimeReady;
    const { session } = await createAgentSession({
      ...toolOptions.session,
      cwd,
      model: spec.model as NonNullable<
        Parameters<typeof createAgentSession>[0]
      >["model"],
      thinkingLevel: spec.thinkingLevel,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: sm,
      settingsManager: childSettings,
    });
    // SDK sessions do not start extension lifecycles until the host explicitly binds them.
    // Children's extensions run unattended, with their footer statuses captured
    // (bind-headless-extensions.ts).
    // The statuses are owned by this session (read via the view, like context usage), so a late
    // write from a killed child can never reach a re-spawned agent of the same name.
    let extensionStatuses: ExtensionStatuses = {};
    await bindHeadlessExtensions(session, (key, text) => {
      const next = withExtensionStatus(extensionStatuses, key, text, settings.childExtensionStatusKeys);
      if (next === extensionStatuses) return;
      extensionStatuses = next;
      // Writes arrive outside any tool call (job timers, session_start), so redraw here.
      updateStatus();
    });
    const managedSession: SessionLike = {
      sendAgentMessage: (message, options) =>
        session.sendCustomMessage(toCustomAgentMessage(message), {
          triggerTurn: true,
          deliverAs: options?.deliverAs,
        }),
      // Same steer semantics as peer traffic: a busy agent picks the human's text up at its next
      // turn boundary rather than only after it fully stops.
      // triggerTurn false on an idle session appends without a turn (pi-silent-append.test.ts);
      // the engine only calls this while the session is not busy.
      appendAgentMessage: (message) =>
        session.sendCustomMessage(toCustomAgentMessage(message), {
          triggerTurn: false,
        }),
      get isStreaming() {
        return session.isStreaming;
      },
      sendUserMessage: (text) =>
        session.sendUserMessage(text, { deliverAs: "steer" }),
      abort: () => session.abort(),
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
      getToolDefinition: (name) => session.getToolDefinition(name),
      get messages() {
        return session.messages;
      },
      getContextUsage: () => session.getContextUsage(),
      getExtensionStatuses: () => extensionStatuses,
    };
    return {
      session: managedSession,
      sessionFile: sm.getSessionFile(),
      sessionId: sm.getSessionId(),
    };
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
    spawnPolicy: () => api.spawnPolicy(),
    cwd: () => cwd,
    // Re-read per spawn, like childExtensions.
    spawnPolicyTimeoutMs: () => readSettings().spawnPolicyTimeoutMs,
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

  // globalThis.__subagentsApi_v1 for other extensions; a /reload rebinds the same object, unless
  // the engine version changed (then a fresh object with this load's code replaces it).
  const api = installApi({
    engine,
    engineKey: ENGINE_KEY,
    retune: async (name, t) => {
      const result = await setAgentModel("main", { name, ...t });
      if (!result.ok) throw new Error(result.msg);
    },
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

  // Cold-start rebuild of a persisted swarm AS PAUSED: reopen each agent file without inventing
  // outcomes, derive idle-vs-mid-turn from the transcript tail, register, then pause main's
  // direct children. The existing resume_subagents()/`/subagents-resume` then re-triggers exactly
  // the interrupted agents.
  const restoreSwarm = async (): Promise<void> => {
    if (!subDir) return;
    // Skip if the swarm is already populated (/reload) or already restored this session.
    if (engine.list().some((a) => a.name !== "main")) return;
    const done = restoredSet();
    if (done.has(subDir)) return;
    done.add(subDir);
    const roster = readRoster(subDir);
    if (!roster.length) return;
    const blocked: string[] = [];
    for (const entry of roster) {
      if (!fs.existsSync(entry.sessionFile)) continue; // file gone -> skip
      const resolved = resolveModel(entry.model);
      if (!resolved) continue; // model no longer available -> skip
      // Placed before the session is built, so its preamble names the adopting parent too.
      const placement = restoredPlacement(entry.spawnedBy, engine.get(entry.spawnedBy)?.depth);
      // Fail closed: the allowlist comes back from the roster (sessionSpecFromRoster); a guard is
      // a function, so only the policy's restore hook can give it back. Without it the agent is
      // restored paused and blocked, with a deny-all guard as a second line.
      let toolGuard: ToolGuard | undefined;
      let runBlock: string | undefined;
      if (entry.guarded) {
        const restored = await restoreToolGuard(
          api.spawnPolicyRegistration(),
          {
            name: entry.name,
            parent: placement.spawnedBy,
            model: `${resolved.provider}/${resolved.id}`,
            thinkingLevel: entry.thinkingLevel,
            tools: entry.tools,
            meta: entry.meta,
          },
          readSettings().spawnPolicyTimeoutMs,
        );
        if ("guard" in restored) toolGuard = restored.guard;
        else {
          const reason = `its spawn-policy tool guard was not restored (${restored.reason}); kill and re-spawn it`;
          runBlock = reason;
          toolGuard = () => reason;
        }
      }
      try {
        const { session, sessionFile, sessionId } = await createSession(
          {
            ...sessionSpecFromRoster({ ...entry, ...placement }, resolved.model),
            ...(toolGuard ? { toolGuard } : {}),
          },
          entry.sessionFile,
        );
        restoreAgent({
          name: entry.name,
          ...placement,
          model: `${resolved.provider}/${resolved.id}`,
          systemPrompt: entry.systemPrompt,
          sessionFile: sessionFile ?? entry.sessionFile,
          sessionId,
          session,
          pausedMidTurn:
            deriveStatus(session.messages as RawMessage[]) === "pausedMidTurn",
          policyTools: entry.tools,
          policyMeta: entry.meta,
          policyGuarded: entry.guarded,
          runBlock,
        });
        if (runBlock) blocked.push(entry.name);
      } catch {
        /* skip an unrestorable agent */
      }
    }
    if (blocked.length > 0) {
      ui?.notify(
        `subagents: ${blocked.join(", ")} restored paused and blocked: the spawn policy did not re-attach ` +
          "their tool guard, so they cannot be resumed (kill and re-spawn them)",
        "warning",
      );
    }
    // Present the restored swarm as paused: pausing main's direct children holds every restored
    // agent (main adopted the orphans), and one resume_subagents()/`/subagents-resume` reactivates it.
    engine.pause("restore");
  };

  // Shared by /subagents-resume and the resume_subagents tool, acting as `by`: the engine clears
  // the targets' own pause and releases the buffered messages of every agent that runs again;
  // the interrupted ones among those are re-triggered in the name of `by`'s authority agent
  // ('main' for the human), so their reply goes to an agent that can read it.
  const resumeAgents = async (by: string, names?: string[]): Promise<EngineResumeResult> => {
    const result = await engine.resume(by, names);
    const nudge = RESUME_NUDGE(new Date(), by);
    for (const name of result.interrupted) void engine.route(authorityOf(by), name, nudge);
    updateStatus();
    return result;
  };

  // Swarm control commands take an optional agent-name list; empty means all of main's children.
  const parseNames = (args: string): string[] =>
    args.split(/[\s,]+/).filter((name) => name.length > 0);

  // Capture the foreground model (for inheritance to spawned agents).
  pi.on("model_select", (event) => {
    captureForegroundModel(event.model);
  });
  pi.on("thinking_level_select", (event) => {
    captureForegroundThinkingLevel(event.level);
  });

  // main's run ended: append the lifecycle notices that waited for it (Engine.notify). If another
  // run already started meanwhile, mainBusy() still reads true and they keep waiting for its end.
  pi.on("agent_settled", (_event, ctx) => {
    captureMainContext(ctx);
    engine.flushNotices("main");
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
  registerToolTimestamps(pi);
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
    let sessionId: string | undefined;
    try {
      const id = ctx.sessionManager.getSessionId();
      sessionId = id;
      const dir = ctx.sessionManager.getSessionDir();
      subDir = id && dir ? subagentsDir(dir, id) : undefined;
    } catch {
      subDir = undefined;
    }
    // The singleton 'main' record outlives a session switch, so its id is refreshed here.
    const mainRecord = engine.get("main");
    if (mainRecord) mainRecord.sessionId = sessionId;
    if (!engine.has("main")) {
      const mainHandle: AgentHandle = {
        // via the globalThis indirection so the singleton handle never uses a stale pi.
        deliver: async (message) => {
          deliverToMain(message);
        },
        abort: async () => {}, // do not abort the human's turn
        append: (message) => deliverToMain(message, true),
        busy: mainBusy,
      };
      engine.addAgent({
        name: "main",
        model: foregroundModel
          ? `${foregroundModel.provider}/${foregroundModel.id}`
          : "(foreground)",
        thinkingLevel: foregroundThinkingLevel,
        sessionId,
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
    registerMainTools();
    await restoreSwarm();
    // A live ctx is captured again only now: notices queued while it was stale (after a reload)
    // would otherwise wait for main's next run to settle.
    engine.flushNotices("main");
    updateStatus();
  });

  pi.on("session_shutdown", async (event) => {
    // A same-version /reload must retain the singleton's live children. Real foreground
    // replacement/quit closes their runtimes but deliberately leaves roster.json intact.
    if (event.reason === "reload") return;
    disposeProcessHooks(unsubscribeEngine);
    const previousSubDir = subDir;
    subDir = undefined;
    await engine.shutdownAll();
    if (previousSubDir) restoredSet().delete(previousSubDir);
    updateStatus();
  });

  // Register the foreground tools for 'main'. set_status is background-only: main has
  // ctx.ui.setStatus() + the human watches the chat directly, so a second status channel
  // would only confuse.
  // The spawn hint depends on whether a spawn policy is registered, which a policy extension
  // loaded after this one only does later (at its load or session_start): session_start
  // registers them again when that changed.
  let mainToolsPolicy: boolean | undefined;
  const registerMainTools = (): void => {
    const active = api.spawnPolicy() !== undefined;
    if (active === mainToolsPolicy) return;
    mainToolsPolicy = active;
    for (const tool of toolsFor("main")) {
      if (tool.name === "set_status") continue;
      pi.registerTool(tool);
    }
  };
  registerMainTools();

  // KISS: the command and roster clicks share one panel lifecycle; the guard also covers loading.
  const openPanel = async (panelUi: ExtensionUIContext, initialAgent?: string) => {
    if (panelOpen) return;
    ui = panelUi;
    panelOpen = true;
    updateStatus(); // hide the redundant persistent roster
    try {
      const hideThinking = await getHideThinking();
      const toolsExpanded = panelUi.getToolsExpanded?.() ?? false;
      await panelUi.custom<void>((tui, theme, kb, done) =>
        createSubagentsPanel(
          {
            engine,
            cwd,
            initialAgent,
            hideThinking,
            toolsExpanded,
            setToolsExpanded: (v) => panelUi.setToolsExpanded?.(v),
            listModels,
            statusWidth: rosterStatusWidth,
            setAgentModel: (spec) =>
              setAgentModel("user", spec as Parameters<typeof setAgentModel>[1]),
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
          // A percentage, not a number: pi re-resolves it against the live terminal height on
          // every render, while a number computed at open time would freeze the container at the
          // old height across a resize. "50%" is exactly what panelRows() gives the transcript
          // inside, so container and content stay in sync.
          overlayOptions: {
            anchor: "bottom-center",
            width: "100%",
            maxHeight: "50%",
          },
          // Keep keyboard input in the panel instead of the foreground editor.
          onHandle: (handle: { focus(): void }) => handle.focus(),
        } as never,
      );
    } finally {
      panelOpen = false;
      updateStatus(); // show the persistent roster again
    }
  };

  // Register the primary command first so fuzzy autocomplete prefers it to the controls.
  pi.registerCommand("subagents", {
    description: "Open the subagents panel (Esc to close)",
    handler: async (_args, ctx) => openPanel(ctx.ui),
  });

  // Every swarm control command shares the /subagents- prefix, so typing it lists the whole
  // control surface and none collides with a pi built-in (/resume continues a chat session).
  // The human's commands act as "user", which carries main's authority (authorize.ts) and is
  // recorded as the actor, so status and notices can tell the human's actions from main's.
  pi.registerCommand("subagents-pause", {
    description:
      "Pause agents by name (empty = all of main's children; subtrees follow): request turn aborts; in-flight effects may still settle " +
      "and new messages buffer until resumed.",
    handler: async (args, ctx) => {
      ctx.ui.notify(formatControlResult("pause", engine.pause("user", parseNames(args))), "warning");
      updateStatus();
    },
  });

  pi.registerCommand("subagents-resume", {
    description:
      "Resume agents by name (empty = all of main's children; subtrees follow): release buffered " +
      "messages and request nudges for interrupted work.",
    handler: async (args, ctx) => {
      ctx.ui.notify(formatResumeResult(await resumeAgents("user", parseNames(args))), "info");
    },
  });

  pi.registerCommand("subagents-kill", {
    description: "Terminate agents by name, each with its subtree (empty = all except 'main').",
    handler: async (args, ctx) => {
      const names = parseNames(args);
      const result = names.length ? await engine.kill("user", names) : await engine.killAll("user");
      persistRoster();
      ctx.ui.notify(formatControlResult("kill", result), "info");
      updateStatus();
    },
  });


}
