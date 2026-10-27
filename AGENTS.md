# pi-actor-subagents contributor map

Keep this file, `README.md`, and `DESIGN.md` true to the code whenever architecture, interfaces, paths, or commands change.

## Setup and verification

Nix pins the development tools in `flake.nix`. npm supplies the pinned Pi 1.2.0 SDK and type packages for development and integration tests; the package requires Pi >=1.2.0 for native component mouse events.

```bash
nix develop
npm ci
npm run ci
npm pack --dry-run
```

`npm run ci` checks workflows, types, lint, and `*.test.ts` in `extensions/` and `scripts/`. CI runs the same checks inside `nix develop` and publishes successful main pushes; setup and release policy are in `docs/publishing.md`.

`nix develop -c npm run demo` regenerates `docs/subagents.svg`: `scripts/demo.ts` supplies fixed example data to the real panel, and `scripts/render-demo.sh` captures isolated Pi terminal cells through tmux. `scripts/tokyo-night.json` is the demo-only theme; `scripts/render-demo-svg.ts` passes the capture to freeze with terminal color state preserved by `scripts/normalize-terminal-colors.ts`. No model requests or user sessions are involved. Edit the demo data, not the generated SVG, when the scene changes; CI regenerates it and checks for drift. `PI_DEMO_BIN=/path/to/pi` tests another installed Pi.

## Architecture and data flow

`extensions/actor-subagents/index.ts` is the pi entry point and imperative shell. It registers the foreground tools, commands, renderer, and lifecycle handlers; creates headless child sessions through the pi SDK; and connects them to the pure orchestration core.

A spawn request is checked by `engine.ts`, resolved by `resolve-model.ts`, constructed by `spawner.ts`, and given the tools from `agent-tools.ts` as pi `customTools`. If another extension registered a spawn policy through `api.ts`, `spawner.ts` asks it after the reservation (`api.ts` `decideSpawn`: bounded by `spawnPolicyTimeoutMs`, result validated, any failure a refusal that frees the reservation) for optional model and effort, an optional tool allowlist and tool guard (`tool-guard.ts` `childToolOptions`), or a refusal. Without a policy, the `spawn_subagent` hints and the preamble keep their inherit wording and there is no `task` parameter. Child extension discovery is disabled. The entry point reads `settings.json` on every spawn and supplies the `childExtensions` paths and the `childExtensionStatusKeys` filter. Missing or invalid settings are an empty capability set.

`settings.ts` parses that one file (`parseSettings`, pure). The file is flat — `maxAgents`, `maxSpawnDepth`, `childExtensions`, `childExtensionStatusKeys`, `spawnPolicyTimeoutMs`, `promptCacheTtlMs` at the top level — while the parsed `Settings` groups the two limits as `caps`, which is what the engine is constructed from. The limits fall back per field to `DEFAULT_CAPS` and are read once, when `getEngine()` builds the reload-surviving singleton — changed limits therefore apply at the next pi start. `childExtensions` is fail-closed and re-read per spawn. `childExtensionStatusKeys` is display-only, fail-open (missing or invalid shows every key) and re-read per spawn. `spawnPolicyTimeoutMs` (default 30000, 0 = no bound) is re-read per spawn and per restored guarded agent. `promptCacheTtlMs` is display-only too (invalid means `DEFAULT_PROMPT_CACHE_TTL_MS`) and re-read per `list_subagents` call, whose usage column `feed.ts` builds from `agent-info.ts` `agentInfo`.

Tool results are stamped with their wall-clock finish time and, when a matching `tool_call` start was captured by call id, their start time. A finish-only result does not establish tool duration (`tool-timestamp.ts`). A pi hook only fires in the session that registered it, so `index.ts` registers it twice: directly for the foreground, and as an inline `extensionFactories` entry in every child session. That in-process channel is separate from `additionalExtensionPaths`, which stays exactly the configured `childExtensions` policy. Both registrations apply the pure `tool-timestamp.ts`.

Children's extensions run unattended (`bind-headless-extensions.ts`): `mode: "print"` and `ctx.hasUI === false` through an override on the child's runner, so they take their headless paths instead of opening dialogs, while a capturing UI context still receives `ctx.ui.setStatus`. Those writes are sanitized by `extension-status.ts`, held per child session in `index.ts` `createSession`, and read through `AgentView.getExtensionStatuses`; every other UI method is Pi's no-op. `pi-bind-headless-extensions.test.ts` is the installed-Pi contract.

Control operations carry their actor (`by`): an agent name, `user` for the human's commands and panel, or `restore` for session restore; the latter two act with `main`'s authority (`authorize.ts`). An agent entering the error state — a thrown exception or a logical run the SDK settled after exhausting retries — emits one `error` event per failed run. `lifecycle-notice.ts` selects recipients and formats scheduler messages. Pause, resume and kill use `Engine.notify` to eligible live direct parents, excluding the acting parent; the handle's `append` adds a silent transcript message, with append failures caught without a reported failure or retry. New terminal child errors instead use ordinary `Engine.route` delivery to the live direct parent, including `main`, with no duplicate silent copy. An idle parent gets a turn request, a busy parent gets steering, and a paused or still-stopping parent buffers the error until resume. Resume notices distinguish released agents from those whose own pause was cleared but who remain held by an ancestor. Notices wait in the engine while the recipient's `busy()` is true and are flushed by `flushNotices` when its run or hand-off settles (`spawner.ts` for children, `agent_settled` in `index.ts` for main). Errors do not override pause, restart children or synthesize error events during restore.

Agent and session events update `engine.ts`. The panel and feed project that state through pure formatting modules. The panel renders a child's transcript with pi's own chat components, so `AgentView` (in `agent-record.ts`, implemented by `spawner.ts`) also exposes the child session's `getToolDefinition`: a tool call is drawn by the tool's own renderer instead of as a bare name. Agent-to-agent traffic uses the structured custom message defined by `agent-message.ts`; `index.ts` owns delivery to the current foreground session.

When the main session is file-backed, `persistence.ts` stores `roster.json` and child JSONL sessions under `<main-session-dir>/subagents/<main-session-id>/`. Restore validates the roster through `persistence-logic.ts` and reconnects each child session without appending synthetic tool results. A spawn policy's allowlist and meta are persisted; a guarded agent gets its guard from the policy's `restore` hook or is restored paused with a `runBlock` that resume refuses (fail closed). The `spawn_subagent` description explains attempted paused restoration in the same file-backed main session and its limits: failed roster writes are not reported, unavailable sessions or models may be skipped, and buffered messages, notices, custom status and ETA are not durable. `deriveStatus` marks interrupted work for an explicit resume nudge that treats missing tool outcomes as unknown. Pi owns outbound provider-message normalization; its SDK/provider contract and recovery limits are documented in `DESIGN.md#interrupted-work`. These paths and formats are compatibility contracts.

## External interfaces

- Pi package entry: `extensions/actor-subagents/index.ts`
- Agent tools (`agent-tools.ts`, shared by every agent; 'main' skips `set_status`): `spawn_subagent`, `send_message`, `set_subagent_model`, `list_subagents`, `subagent_history`, `set_status`, `pause_subagents`, `resume_subagents`, `kill_subagents`
- Commands: `/subagents`, `/subagents-pause`, `/subagents-resume`, `/subagents-kill`
- Custom message type and details shape: `agent-message.ts` (scheduler control notices and routed errors; error parts carry optional `actionable: true`, preserved through parsing and batching for restore)
- Extension API: `globalThis.__subagentsApi_v1` (`api.ts`): `registerSpawnPolicy` (with `owner` and `restore` options), `subscribe`, `list`, `retune`, `send`; replaced with new code when `ENGINE_KEY` changes
- Reserved agent names: `main`, `scheduler`, `user`, `restore` (`engine.ts`)
- Settings (caps, child capability policy, child status filter and spawn policy timeout): `<pi agent dir>/actor-subagents/settings.json`, the agent dir being the SDK's `getAgentDir()` (normally `~/.pi/agent`)
- Persistence: `<main-session-dir>/subagents/<main-session-id>/`
- Process reload compatibility: every `__subagents*` `globalThis` key in `index.ts` and `api.ts`

There are no open ports or separate services. The extension has the same process permissions and model credentials as pi; optional child extensions are therefore an explicit least-capability boundary.

## Source map

Extension paths below are relative to `extensions/actor-subagents/`.

- `index.ts`: pi integration, lifecycle, child construction, persistence orchestration, commands and UI wiring
- `engine.ts`: stateful actor registry and orchestration: spawn/attach, scheduling, routing, pause/resume, kill/retune
- `spawn-tree.ts`: pure spawn-tree rules (ancestry, children, kill order, derived pause `pauseHolder`)
- `authorize.ts`: the subtree authority rule, "who spawns, owns", and the non-agent actors `user`/`restore`
- `abort-tracker.ts`: per-agent aborts in flight, which resume waits for
- `agent-record.ts`, `agent-event.ts`, `control-result.ts`: the engine's record, event and control-result types
- `api.ts`: the versioned API for other extensions (spawn policy with validation and timeout, restore hook, events, list, retune, send), installed once per process, rebound on a same-engine-version reload
- `agent-info.ts`: pure `AgentInfo` projection of a record (state, usage from the live transcript), shared by `api.ts` `list()` and the `list_subagents` usage column in `feed.ts`
- `tool-guard.ts`: a spawn policy's tool allowlist widening and per-call tool guard as an inline child extension, combined for createSession by `childToolOptions`
- `spawn-policy.test.ts`: the spawner's policy step (refusal, malformed result, throw, timeout, kill during the call, applied and partial decisions, meta chaining, spawn events, restored policy state and blocked restore)
- `pi-tool-allowlist.test.ts`: installed Pi contract that a policy allowlist filters custom tools too (hence the widening) and that a tool guard blocks through `tool_call`
- `settings.ts`: pure parser for `settings.json` (caps + child extension policy + child status filter) and the default caps
- `agent-tools.ts`: orchestration tool definitions shared by foreground and children
- `spawner.ts`: child session lifecycle and event bridge
- `persistence.ts`, `persistence-logic.ts`: durable files and validated restoration
- `pi-resume-compatibility.test.ts`: installed Pi session reopening and outbound normalization contract tests
- `agent-message.ts`, `agent-message-renderer.ts`: structured peer messages and TUI rendering
- `lifecycle-notice.ts`: pure rule for who is told about a pause, resume, kill or error, and what
- `pi-silent-append.test.ts`: installed Pi contract that a `triggerTurn: false` custom message on an idle session appends without a turn
- `tool-timestamp.ts`: pure tool-result stamper (wall-clock start + finish times)
- `roster-widget.ts`: native mouse routing from persistent roster rows to the shared panel lifecycle in `index.ts`
- `roster-entries.ts`: one roster row per agent, shared by the persistent roster and the panel
- `bind-headless-extensions.ts`, `extension-status.ts`: unattended child extension binding with status capture, and the pure status sanitizer/formatters
- `pi-bind-headless-extensions.test.ts`: installed Pi contract for captured `setStatus`, `hasUI` false, `print` mode and cancelled dialogs
- `panel.ts`, `panel-logic.ts`, `feed.ts`: interactive and textual projections; the panel keeps selection by agent identity, resolves row clicks against the last frame, and closes through the top-right `Esc` label or Escape key
- `panel.test.ts`: selection, close hit targets, and installed Pi fullscreen mouse-dispatch contracts
- focused `*.ts` helpers: pure domain rules; adjacent `*.test.ts` files are their tests

Repository-level paths:

- `README.md`: purpose, installation, demo, tools, configuration, and coordination
- `docs/subagents.svg`: editable terminal capture generated from the real panel
- `docs/publishing.md`, `.github/workflows/ci.yml`: npm Trusted Publishing setup and release workflow
- `scripts/publish.ts`, `scripts/*.test.ts`: release policy, real package-content checks, and demo invariants
- `package.json` → `files`, `extensions/actor-subagents/.npmignore`: published files; tests and `.corral` stay private

## Change rules

Preserve tool and command names, custom message and roster formats, persistence paths, and `globalThis` keys unless a deliberate compatibility migration is specified. Keep the functional core free of pi/TUI I/O where practical. Prefer direct, narrow changes over speculative abstractions (KISS/YAGNI), and add tests for changed pure behavior.
