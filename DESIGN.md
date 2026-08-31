# Design

## Purpose

actor-subagents adds a bounded actor swarm to one foreground pi session. Named background agents have independent model sessions, communicate through explicit messages, and form an ownership tree rooted at `main`. The foreground remains the only agent that talks directly to the human.

## Runtime structure

`index.ts` is the imperative shell around the in-memory `Engine`. It registers pi tools and commands, translates pi lifecycle events into engine state, creates child sessions through the SDK, persists membership, and renders the roster. Pure modules hold routing, ordering, status, formatting, model-resolution, and restoration rules so those rules can be tested without pi or the TUI.

Each child session is created with:

- the main process's model registry, credentials, and global agent instructions;
- its own system prompt and session file;
- orchestration tools supplied directly as pi `customTools`;
- recursive extension discovery disabled; and
- only extension paths granted by the XDG child policy.

The policy is read on every spawn. Parsing is fail-closed: missing, unreadable, malformed, or structurally invalid input becomes an empty list. actor-subagents itself is not loaded recursively in children because its tools are already injected.

## Actor model

The engine owns agent records, spawn parentage, directed mailboxes, activity, status, turn budget, and lifecycle transitions. Spawning reserves a unique name and enforces the agent-count and depth caps before asynchronous child creation. Killing an agent cascades through its descendants. Pausing buffers delivery without losing ordering; resuming releases each mailbox as one ordered batch.

Messages use one structured custom pi message type. The structure preserves sender and recipient provenance for routing, model context, and TUI rendering. A live foreground sink on `globalThis` prevents a reloaded extension instance from delivering through a stale pi handle.

## Persistence and reload compatibility

For a file-backed main session, state lives at:

```text
<main-session-dir>/subagents/<main-session-id>/
  roster.json
  <agent-name>.jsonl
```

`roster.json` records enough validated membership and session metadata to rebuild the swarm. Child conversations remain native pi JSONL sessions. Malformed roster data is ignored rather than partially trusted.

The engine, foreground sink, foreground state, and restore guard use versioned `__subagents*` keys on `globalThis`. Those key names are runtime compatibility contracts: they keep same-version `/reload` connected to live children and deliberately change only when an incompatible in-memory shape requires a new singleton.

## Interfaces

The agent-facing tools are `spawn_agent`, `send_message`, `set_agent_model`, `list_agents`, `kill_agent`, `agent_history`, `set_status`, and `resume_agents`. Foreground commands are `/agents`, `/agents-pause`, `/agents-resume`, `/agents-kill-all`, and `/agents-feed`. Their names, result/message formats, roster format, domain vocabulary, and persistence layout are compatibility surfaces.

The package has no service or network interface of its own. Model traffic and credentials are handled by pi. The extension inherits pi's process authority, so the explicit child-extension policy is the primary capability boundary introduced here.
