# pi-actor-subagents

Build arbitrary agent hierarchies in [Pi](https://pi.dev/) where every agent can message every other agent. Inspect their conversations and steer them directly. Agents survive Pi restarts.

Pairs well with [pi-infinite-context](https://github.com/fdietze/pi-infinite-context) for long-running conversations.

## Install

Requires Pi 1.2.0 or newer.

```bash
pi install npm:pi-actor-subagents
```

## Subagents panel

![Subagents panel: an implementer running tests, its reviewer exchanging messages, and a paused researcher](docs/subagents.svg)

Click an agent in the roster to open its conversation. Inside the panel, click another agent or use ↑/↓ to switch. Click **Esc** at the top right, or press Escape, to close.

Mouse controls use Pi's fullscreen mode. `/subagents` and the keyboard controls also work without it. The input box messages the selected agent directly.

## Tools

| Tool | Purpose |
|---|---|
| `spawn_subagent` | Create a named agent with its own system prompt, initial task, model, and session. |
| `send_message` | Send a message to one or more agents, including parents, children, and peers. |
| `list_subagents`, `subagent_history` | Inspect agent state and conversations. |
| `set_subagent_model`, `set_status` | Change model or thinking level; report progress and ETA. |
| `pause_subagents`, `resume_subagents`, `kill_subagents` | Control owned agents and their descendants. |

`/subagents` opens the panel. `/subagents-pause`, `/subagents-resume`, and `/subagents-kill` control named subtrees; omit names to target your direct children.

All tool results in the main session and subagents include start/finish timestamps, giving agents a sense of elapsed time for progress updates and ETA estimates. If a start time is unavailable, only the finish time is shown.

## Configuration

Optional file: `~/.pi/agent/actor-subagents/settings.json` (inside Pi's configured agent directory):

```json
{
  "maxAgents": 8,
  "maxSpawnDepth": 3,
  "childExtensions": [
    "~/.pi/agent/npm/node_modules/pi-infinite-context/extensions/infinite-context/index.ts"
  ],
  "childExtensionStatusKeys": ["bash-async"],
  "promptCacheTtlMs": 300000
}
```

- `maxAgents`: maximum live background agents (default: `8`).
- `maxSpawnDepth`: maximum hierarchy depth (default: `3`). Both limits must be positive integers; missing or invalid values use their defaults. Changes apply after restarting Pi.
- `childExtensions`: extension whitelist for subagents (default: `[]`). List extension files or directories; children do not inherit Pi's discovered extensions. Actor-subagents' orchestration tools are always available and need no whitelist entry. Changes apply to newly spawned agents. The example path assumes `pi install npm:pi-infinite-context` in the default Pi setup. Child extensions run unattended, with `ctx.mode === "print"` and `ctx.hasUI === false`, so they take their headless paths instead of asking. Their `ctx.ui.setStatus` texts still appear in the roster and in `list_subagents` when they set them unconditionally, not only when `ctx.hasUI` is true.
- `childExtensionStatusKeys`: status keys shown in the roster and in `list_subagents` of subagents (default: unset, which shows every key). Statuses with other keys are ignored. An invalid value shows every key. Changes apply to newly spawned agents.
- `spawnPolicyTimeoutMs`: how long a registered spawn policy (see below) may take to answer one spawn, in milliseconds (default: `30000`; `0` waits without a bound). A late answer fails the spawn. Invalid values use the default. Changes apply to the next spawn.
- `promptCacheTtlMs`: your provider's prompt-cache lifetime in milliseconds (default: `300000`, Anthropic's default 5 minutes). `list_subagents` shows each agent's usage after its origin (extension statuses stay last), `cache=warm(1m left) ctx=143k $2.10`: whether its next request would still read the prompt cache (not shown while the agent is running), context tokens and cost so far. The cost is summed over the assistant messages in the agent's current transcript, so it is understated once an extension has folded or compacted older messages away. `0` leaves out `cache=`; an invalid value means the default. Changes apply at the next `list_subagents` call.

## Spawn policy API for extensions

Another extension can decide how subagents are spawned and observe the swarm through `globalThis.__subagentsApi_v1` (types in `extensions/actor-subagents/api.ts`):

```ts
const api = (globalThis as any).__subagentsApi_v1; // undefined until actor-subagents has loaded
const unregister = api.registerSpawnPolicy(
  async (args, caller) => (args.task ? { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "medium" } : { reject: "add a task card" }),
  { owner: "my-router" },
);
```

- `registerSpawnPolicy(fn, { owner?, restore? })`: one policy per process. Registering again under the current registration's `owner` replaces it (so a policy extension can simply register again after `/reload`); any other registration throws while one is in place. The returned function unregisters, and does nothing once its registration was replaced. The policy runs on every `spawn_subagent` call at every depth, after the name, cap and depth checks, with the spawn arguments (including the optional `task` object, otherwise unused) and the caller (`name`, `sessionId`, `model`, `thinkingLevel`, `policyMeta`, `cwd`). It returns `{ reject }`, which fails the tool call with that reason, or an acceptance whose fields are all optional: `model` and `thinkingLevel` (omitted ones follow the normal route: the spawn's own argument, else the spawner's), `briefAppend` (appended to the first message), `tools` (allowlist of plain names of the child's built-in and extension tools; the orchestration tools always stay), `toolGuard` (called on each of the child's tool calls; a returned string blocks the call with that reason) and `meta` (JSON-serializable; stored on the child, offered back as `caller.policyMeta` when it spawns). A policy that throws, returns anything else, or does not answer within `spawnPolicyTimeoutMs` fails the spawn the same way. Without a policy, children inherit the spawner's model and effort, and the `spawn_subagent` tool and agent preamble read exactly as without this API.
- `subscribe(listener)`: engine events; exactly one `spawn` event per agent, sent once its session exists and carrying `childSessionId`.
- `list()`: every agent, `main` (the foreground, its own parent) included, with parent, session id, model, effort, state (`spawning` while a reserved name has no session yet, then `running`, `idle` or `paused`), idle time, last request time, context tokens, cost and `policyMeta`.
- `retune(name, { model?, thinkingLevel? })`: retune with `main`'s authority.
- `send(to, text, from)`: deliver like `send_message`; `from` is the sender name the recipient sees and is required.

Trust: the API is an in-process surface for extensions you installed, which already run with Pi's full process authority. It does not authenticate callers: `retune` acts as `main`, and `send` accepts any sender name, including `main` or a real agent's.

Reload: the object survives `/reload` while the engine version (`ENGINE_KEY` in `index.ts`) stays the same. An update that changes the engine version installs a fresh object and carries the registered policy over, so read `globalThis.__subagentsApi_v1` again after a reload (e.g. in `session_start`) rather than keeping a reference.

Restart: an agent's `tools` and `meta` are saved in the roster, so a restored agent keeps its allowlist. A `toolGuard` is a function and cannot be saved: for a guarded agent, restore calls the `restore(info)` hook given at registration (`info`: name, parent, model, effort, tools, meta) and installs the guard it returns. Without a policy, a hook or a guard, the agent is restored paused and blocked (resume refuses it, its tool calls are blocked) and the human is notified; kill and re-spawn it. Restore runs in actor-subagents' own `session_start`, so register the policy as soon as the API exists: at load time, or in `session_start` when your extension loads before actor-subagents.

## Coordination

- **Handshake:** a new child is instructed to send its parent its understanding of the task and clarification questions, then wait for a `send_message` go-ahead before working. This is an agent protocol, not an enforced scheduling barrier.
- **Ownership:** every agent controls the agents it spawns and their descendants; messaging and inspection are open to all. `set_status` is for background agents.
- **Errors:** a new child error sends its live direct parent a scheduler message: it requests a turn when idle, steers a busy parent, and buffers while the parent is paused or still stopping. It does not restart the child. Pause, resume and kill notices stay silent.
- **Persistence:** reopening the same saved main session restores agents paused; resume them explicitly. Buffered messages, progress, and ETA are not saved.
