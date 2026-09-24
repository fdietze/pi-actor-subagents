# pi-actor-subagents

A [pi](https://pi.dev/) extension for persistent actor-style subagent swarms. It lets a foreground agent delegate work to named background agents, route messages through a spawn tree, inspect their state and history, pause, resume or kill the agents they own, and restore saved agents with their sessions.

## Install

```bash
pi install git:github.com/fdietze/pi-actor-subagents
```

## Interface

Every agent receives `spawn_subagent`, `send_message`, `set_subagent_model`, `list_subagents`, `subagent_history`, `set_status`, `pause_subagents`, `resume_subagents`, and `kill_subagents` (`set_status` is for background agents only). An agent pauses, resumes and kills only the agents it spawned and their descendants, and retunes those or itself; `main` owns them all. Messaging and inspection are open to everyone. Child agents receive the orchestration tools through pi's `customTools`; actor-subagents is not recursively loaded as a child extension.

The interactive UI shows a compact roster and provides:

- `/subagents` — open the swarm panel; its input box messages the selected agent as you
- `/subagents-pause` and `/subagents-resume` — stop or continue agents by name, each with its subtree (no name = `main`'s direct children; a pause another agent set on its own child stays)
- `/subagents-kill` — terminate agents by name, each with its subtree (no name = all)

Saved swarms live beside the main pi session under `subagents/<main-session-id>/` and are restored, paused, when that session returns.

## Settings

Optional, at `~/.pi/agent/actor-subagents/settings.json` (inside pi's agent directory):

```json
{
  "maxAgents": 8,
  "maxSpawnDepth": 3,
  "childExtensions": [
    "/absolute/path/to/an/extension"
  ]
}
```

`maxAgents` and `maxSpawnDepth` are the swarm's limits: background agents alive at once and spawn-tree depth. The values above are the defaults. Each value must be a positive integer; anything else (including `0`) falls back to that key's default on its own, so a partial file is fine. New limits take effect when pi next starts.

`childExtensions` grants child sessions extra pi extensions; loading is explicit and fail-closed. Only non-empty string entries are accepted, and anything else — a missing, unreadable, malformed, or invalid file — grants none. Changes apply to the next spawned agent. Do not list actor-subagents itself: children already receive its orchestration tools directly.

## Development

```bash
nix develop
npm ci
npm run ci
npm pack --dry-run
```

Architecture and compatibility contracts are documented in [DESIGN.md](DESIGN.md).

## License

[MIT](LICENSE)
