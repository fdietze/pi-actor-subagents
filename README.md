# pi-actor-subagents

A [pi](https://pi.dev/) extension for persistent actor-style subagent swarms. It lets a foreground agent delegate work to named background agents, route messages through a spawn tree, inspect their state and history, pause or resume the swarm, and restore saved agents with their sessions.

## Install

```bash
pi install git:github.com/fdietze/pi-actor-subagents
```

## Interface

The agent receives `spawn_subagent`, `send_message`, `set_subagent_model`, `list_subagents`, `kill_subagent`, `subagent_history`, `set_status`, and `resume_subagents`. Child agents receive the orchestration tools through pi's `customTools`; actor-subagents is not recursively loaded as a child extension.

The interactive UI shows a compact roster and provides:

- `/subagents` — open the swarm panel; its input box messages the selected agent as you
- `/subagents-pause` and `/subagents-resume` — stop or continue agents by name (no name = all)
- `/subagents-kill` — stop agents by name (no name = all)

Saved swarms live beside the main pi session under `subagents/<main-session-id>/` and are restored when that session returns.

## Optional child extensions

Child extension loading is explicit and fail-closed. Put the policy at `$XDG_CONFIG_HOME/pi/actor-subagents/child-extensions.json` (normally `~/.config/pi/actor-subagents/child-extensions.json`):

```json
{
  "extensions": [
    "/absolute/path/to/an/extension"
  ]
}
```

Only non-empty string entries are accepted. A missing, unreadable, malformed, or invalid policy grants no optional child extensions. Do not list actor-subagents itself: children already receive its orchestration tools directly.

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
