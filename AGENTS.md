# pi-actor-subagents contributor map

Keep this file, `README.md`, and `DESIGN.md` true to the code whenever architecture, interfaces, paths, or commands change.

## Setup and verification

Nix is the source of truth for Node.js 24, TypeScript Go, and oxlint. npm supplies only pinned development type libraries.

```bash
nix develop
npm ci
npm run ci
npm pack --dry-run
```

`npm run ci` runs strict type-checking, linting, and every `*.test.ts` through Node's test runner. CI runs the same commands inside `nix develop`.

## Architecture and data flow

`extensions/actor-subagents/index.ts` is the pi entry point and imperative shell. It registers the foreground tools, commands, renderer, and lifecycle handlers; creates headless child sessions through the pi SDK; and connects them to the pure orchestration core.

A spawn request is checked by `engine.ts`, resolved by `resolve-model.ts`, constructed by `spawner.ts`, and given the tools from `agent-tools.ts` as pi `customTools`. Child extension discovery is disabled. The entry point reads `settings.json` on every spawn and supplies only the `childExtensions` paths. Missing or invalid settings are an empty capability set.

`settings.ts` parses that one file (`parseSettings`, pure). The file is flat — `maxAgents`, `maxSpawnDepth`, `childExtensions` at the top level — while the parsed `Settings` groups the two limits as `caps`, which is what the engine is constructed from. The limits fall back per field to `DEFAULT_CAPS` and are read once, when `getEngine()` builds the reload-surviving singleton — changed limits therefore apply at the next pi start. `childExtensions` is fail-closed and re-read per spawn.

Every tool result carries the wall-clock times it started and finished, so agents can measure elapsed time and a tool's own duration (which is what `set_status`'s `etaMinutes` needs). The start time is captured at `tool_call` and paired to the result by call id. A pi hook only fires in the session that registered it, so `index.ts` registers it twice: directly for the foreground, and as an inline `extensionFactories` entry in every child session. That in-process channel is separate from `additionalExtensionPaths`, which stays exactly the configured `childExtensions` policy. Both registrations apply the pure `tool-timestamp.ts`.

An agent entering the error state — a thrown exception or a turn the SDK stopped retrying — emits one `error` event per failed turn, and `index.ts` delivers a notification to that agent's direct parent as ordinary peer traffic, so a parent parked on a reply that can no longer come is woken. `error-notification.ts` decides who is told.

Agent and session events update `engine.ts`. The panel and feed project that state through pure formatting modules. The panel renders a child's transcript with pi's own chat components, so `AgentView` (in `engine.ts`, implemented by `spawner.ts`) also exposes the child session's `getToolDefinition`: a tool call is drawn by the tool's own renderer instead of as a bare name. Agent-to-agent traffic uses the structured custom message defined by `agent-message.ts`; `index.ts` owns delivery to the current foreground session.

When the main session is file-backed, `persistence.ts` stores `roster.json` and child JSONL sessions under `<main-session-dir>/subagents/<main-session-id>/`. Restore validates the roster through `persistence-logic.ts` and reconnects each child session. These paths and formats are compatibility contracts.

## External interfaces

- Pi package entry: `extensions/actor-subagents/index.ts`
- Agent tools: `spawn_subagent`, `send_message`, `set_subagent_model`, `list_subagents`, `kill_subagent`, `subagent_history`, `set_status`, `resume_subagents`
- Commands: `/subagents`, `/subagents-pause`, `/subagents-resume`, `/subagents-kill`
- Custom message type and details shape: `agent-message.ts`
- Settings (caps and child capability policy): `<pi agent dir>/actor-subagents/settings.json`, the agent dir being the SDK's `getAgentDir()` (normally `~/.pi/agent`)
- Persistence: `<main-session-dir>/subagents/<main-session-id>/`
- Process reload compatibility: every `__subagents*` `globalThis` key in `index.ts`

There are no open ports or separate services. The extension has the same process permissions and model credentials as pi; optional child extensions are therefore an explicit least-capability boundary.

## Source map

- `index.ts`: pi integration, lifecycle, child construction, persistence orchestration, commands and UI wiring
- `engine.ts`: actor registry, spawn tree, scheduling, routing, per-agent and swarm-wide pause, kill/retune state
- `settings.ts`: pure parser for `settings.json` (caps + child extension policy) and the default caps
- `agent-tools.ts`: orchestration tool definitions shared by foreground and children
- `spawner.ts`: child session lifecycle and event bridge
- `persistence.ts`, `persistence-logic.ts`: durable files and validated restoration
- `agent-message.ts`, `agent-message-renderer.ts`: structured peer messages and TUI rendering
- `error-notification.ts`: pure rule for who is notified when an agent enters the error state
- `tool-timestamp.ts`: pure tool-result stamper (wall-clock start + finish times)
- `panel.ts`, `panel-logic.ts`, `feed.ts`: interactive and textual projections
- focused `*.ts` helpers: pure domain rules; adjacent `*.test.ts` files are their tests

## Change rules

Preserve tool and command names, custom message and roster formats, persistence paths, and `globalThis` keys unless a deliberate compatibility migration is specified. Keep the functional core free of pi/TUI I/O where practical. Prefer direct, narrow changes over speculative abstractions (KISS/YAGNI), and add tests for changed pure behavior.
