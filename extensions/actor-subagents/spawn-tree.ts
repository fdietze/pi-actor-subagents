/**
 * Pure rules over the spawn tree, read from the live records' `spawnedBy` — the one parent
 * representation. 'main' is the root and its own spawnedBy.
 *
 * Every walk up the tree terminates because every `spawnedBy` names a live agent or 'main' and
 * parents are registered before their children, so the parent links cannot form a cycle.
 */
import type { AgentRecord } from "./agent-record.ts";

type Agents = ReadonlyMap<string, AgentRecord>;

/** The nearest of `rec` and its ancestors (below 'main') that matches. */
export function nearest(
	agents: Agents,
	rec: AgentRecord | undefined,
	match: (cur: AgentRecord) => boolean,
): AgentRecord | undefined {
	for (let cur = rec; cur && cur.name !== "main"; cur = agents.get(cur.spawnedBy)) {
		if (match(cur)) return cur;
	}
	return undefined;
}

/**
 * The single pause decision: the nearest agent — this one or an ancestor — whose own `paused`
 * flag holds `rec`, or undefined when it runs. Deriving the state instead of copying flags down
 * the tree keeps one source of truth: a subtree spawned or restored under a paused agent is held
 * without extra bookkeeping, and a flag set by a lower owner survives an ancestor's resume
 * (Correctness by Construction).
 */
export function pausedBy(agents: Agents, rec: AgentRecord): string | undefined {
	return nearest(agents, rec, (cur) => cur.paused === true)?.name;
}

/** Is `name` a strict descendant of `ancestor`? 'main' is nobody's descendant and everyone else's ancestor. */
export function isStrictDescendant(agents: Agents, name: string, ancestor: string): boolean {
	const rec = agents.get(name);
	if (!rec || name === "main") return false;
	if (ancestor === "main") return true;
	return nearest(agents, agents.get(rec.spawnedBy), (cur) => cur.name === ancestor) !== undefined;
}

/** The agents `parent` spawned. */
export function childrenOf(agents: Agents, parent: string): AgentRecord[] {
	return [...agents.values()].filter((rec) => rec.name !== "main" && rec.spawnedBy === parent);
}

/**
 * `name` and all its descendants in post-order: descendants precede their parent, so a kill
 * in this order never closes a record while a live child could still route into it.
 */
export function subtreePostOrder(agents: Agents, name: string): AgentRecord[] {
	const out: AgentRecord[] = [];
	const collect = (parent: string) => {
		for (const child of childrenOf(agents, parent)) collect(child.name);
		const rec = agents.get(parent);
		if (rec) out.push(rec);
	};
	collect(name);
	return out;
}
