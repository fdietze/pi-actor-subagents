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

A spawn request is checked by `engine.ts`, resolved by `resolve-model.ts`, constructed by `spawner.ts`, and given the tools from `agent-tools.ts` as pi `customTools`. Child extension discovery is disabled. The entry point reads the explicit XDG policy on every spawn and supplies only those additional paths. Missing or invalid policy is an empty capability set.

Agent and session events update `engine.ts`. The panel and feed project that state through pure formatting modules. Agent-to-agent traffic uses the structured custom message defined by `agent-message.ts`; `index.ts` owns delivery to the current foreground session.

When the main session is file-backed, `persistence.ts` stores `roster.json` and child JSONL sessions under `<main-session-dir>/subagents/<main-session-id>/`. Restore validates the roster through `persistence-logic.ts` and reconnects each child session. These paths and formats are compatibility contracts.

## External interfaces

- Pi package entry: `extensions/actor-subagents/index.ts`
- Agent tools: `spawn_subagent`, `send_message`, `set_agent_model`, `list_agents`, `kill_agent`, `agent_history`, `set_status`, `resume_agents`
- Commands: `/agents`, `/agents-pause`, `/agents-resume`, `/agents-kill-all`, `/agents-feed`
- Custom message type and details shape: `agent-message.ts`
- Child capability policy: `$XDG_CONFIG_HOME/pi/actor-subagents/child-extensions.json`
- Persistence: `<main-session-dir>/subagents/<main-session-id>/`
- Process reload compatibility: every `__subagents*` `globalThis` key in `index.ts`

There are no open ports or separate services. The extension has the same process permissions and model credentials as pi; optional child extensions are therefore an explicit least-capability boundary.

## Source map

- `index.ts`: pi integration, lifecycle, child construction, persistence orchestration, commands and UI wiring
- `engine.ts`: actor registry, spawn tree, scheduling, routing, pause/kill/retune state
- `agent-tools.ts`: orchestration tool definitions shared by foreground and children
- `spawner.ts`: child session lifecycle and event bridge
- `persistence.ts`, `persistence-logic.ts`: durable files and validated restoration
- `agent-message.ts`, `agent-message-renderer.ts`: structured peer messages and TUI rendering
- `panel.ts`, `panel-logic.ts`, `feed.ts`: interactive and textual projections
- focused `*.ts` helpers: pure domain rules; adjacent `*.test.ts` files are their tests

## Change rules

Preserve tool and command names, custom message and roster formats, persistence paths, and `globalThis` keys unless a deliberate compatibility migration is specified. Keep the functional core free of pi/TUI I/O where practical. Prefer direct, narrow changes over speculative abstractions (KISS/YAGNI), and add tests for changed pure behavior.
