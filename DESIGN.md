# Design

## Purpose

actor-subagents adds a bounded actor swarm to one foreground pi session. Named background agents have independent model sessions, communicate through explicit messages, and form an ownership tree rooted at `main`. The foreground remains the only agent that talks directly to the human.

## Runtime structure

`index.ts` is the imperative shell around the in-memory `Engine`. It registers pi tools and commands, translates pi lifecycle events into engine state, creates child sessions through the SDK, persists membership, and renders the roster. Pure modules hold routing, ordering, status, formatting, model-resolution, and restoration rules so those rules can be tested without pi or the TUI.

Each child session is created with:

- the main process's model registry, credentials, and global agent instructions;
- its own system prompt and session file;
- orchestration tools supplied directly as pi `customTools`;
- recursive extension discovery disabled;
- the tool-result timestamp hook, registered in process as an inline extension factory; and
- the extension paths granted by the `childExtensions` policy in `settings.json`.

A pi hook only fires in the session that registered it, so the timestamp that lets an agent perceive elapsed time has to be installed into every child separately. It travels the same in-process route as the orchestration tools rather than as a file path, which keeps the granted-paths list an exact picture of the foreign-capability policy. The policy is read on every spawn. Parsing is fail-closed: missing, unreadable, malformed, or structurally invalid input becomes an empty list. actor-subagents itself is not loaded recursively in children because its tools are already injected.

## Actor model

The engine owns agent records, spawn parentage, directed mailboxes, activity, status, and lifecycle transitions. Spawning reserves a unique name and enforces the agent-count and depth caps before asynchronous child creation. The caps come from the same `settings.json` and are fixed for the engine's lifetime, because a swarm's limits cannot meaningfully change under the agents already running against them; unlike the capability policy they default per field rather than failing closed. Who spawns, owns: an agent may pause, resume and kill only its strict descendants, and retune itself or its descendants; `main` is the root and owns every agent, and the human's commands and panel act as `main`. The acting agent is bound into each agent's toolset, never taken from tool arguments. Messaging and inspection are unrestricted. Killing an agent cascades through its descendants.

Pause is one flag per agent, and the paused state is derived: an agent is paused while it or any ancestor carries the flag, so pausing an agent holds its whole subtree, including agents spawned into it later. Pausing aborts the running turns it stops. Pause and resume take effect in call order; an agent whose abort is still landing counts as stopped, so its mail buffers and no turn starts, and a resume releases the mailbox and re-triggers the interrupted work only once that abort is done and the agent is still not paused; delivery to a paused agent buffers without losing ordering. Resuming clears only the named agents' own flags; every agent that thereby runs again gets its mailbox released as one ordered batch and its interrupted turn re-triggered, while a pause set by a lower owner stays in place. Without names, pause and resume act on the caller's direct children. A restored session comes up with `main`'s direct children paused; `main` adopts any restored agent whose parent was not restored, so that holds the whole restored swarm. Aborting an agent cancels its running bash command before stopping its agent loop, so a pause stops work already in flight.

The panel's input box is the human speaking directly to the selected agent: it arrives as a real user turn, and is refused rather than buffered when the agent is paused or still spawning.

Sending reports two orthogonal things back to the sender: the message's fate (delivered, buffered, failed) and the receiver's liveness. Since a just-woken agent has not started its turn at the instant routing returns, `send_message` and a spawn's initial message watch the engine's event log — from a mark taken before delivery, so nothing is missed — for that agent's first turn or error, bounded by a short window and never until the turn finishes. Delivery therefore stays fire-and-forget, while a receiver that took the message and never moved becomes visible as one that did not react; a window that was never watched, or an agent killed meanwhile, is reported as such instead of being guessed at.

A child that fails owes its parent a message it can no longer send, so an agent entering the error state notifies its direct parent instead — once per failed turn, whether the turn threw or the model gave up after retries, and as ordinary peer traffic, so an idle parent is woken and a busy one picks it up at its next turn boundary. Nobody is told when the failing agent is the root of the spawn tree or when either side is already gone, which is what a subtree kill leaves behind.

Messages use one structured custom pi message type. The structure preserves sender and recipient provenance for routing, model context, and TUI rendering. A live foreground sink on `globalThis` prevents a reloaded extension instance from delivering through a stale pi handle.

## Persistence and reload compatibility

For a file-backed main session, state lives at:

```text
<main-session-dir>/subagents/<main-session-id>/
  roster.json
  <agent-name>.jsonl
```

`roster.json` records enough validated membership and session metadata to rebuild the swarm. Child conversations remain native pi JSONL sessions. Malformed roster data is ignored rather than partially trusted.

The engine, foreground sink, foreground state, and restore guard use versioned `__subagents*` keys on `globalThis`. Those key names are runtime compatibility contracts: they keep same-version `/reload` connected to live children and deliberately change only when an incompatible in-memory shape requires a new singleton. A reload that finds an engine of an earlier generation shuts its children down before building the new one, because that generation's records are unreachable from the new code while its sessions would keep running; the roster on disk is what carries the swarm to the next start.

## Interfaces

The agent-facing tools, shared by every agent (`set_status` by background agents only), are `spawn_subagent`, `send_message`, `set_subagent_model`, `list_subagents`, `subagent_history`, `set_status`, `pause_subagents`, `resume_subagents`, and `kill_subagents`. A control tool's name is plural exactly when it takes a `names` list; pause, resume and kill report a per-target outcome plus the agents actually affected. Foreground commands are `/subagents`, `/subagents-pause`, `/subagents-resume`, and `/subagents-kill`. Their names, result/message formats, roster format, domain vocabulary, and persistence layout are compatibility surfaces.

The package has no service or network interface of its own. Model traffic and credentials are handled by pi. The extension inherits pi's process authority, so the explicit `childExtensions` policy in `<pi agent dir>/actor-subagents/settings.json` is the primary capability boundary introduced here.
