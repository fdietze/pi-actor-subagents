/**
 * The authority rule, "who spawns, owns": `by` controls exactly its strict descendants, and
 * 'main', the root, therefore every other agent. With "self" `by` may also act on itself. One
 * check for every control operation keeps the rule in one place (DRY); callers take `by` from
 * the acting agent's tool closure, never from tool arguments, so it cannot be spoofed.
 *
 * An unknown name is reported as such first: observation is unrestricted, so this reveals
 * nothing list_subagents would not.
 */
import type { AgentRecord } from "./agent-record.ts";
import type { CheckResult } from "./control-result.ts";
import { isStrictDescendant } from "./spawn-tree.ts";

export function authorize(
	agents: ReadonlyMap<string, AgentRecord>,
	by: string,
	name: string,
	self?: "self",
): CheckResult {
	if (!agents.has(name)) return { ok: false, reason: `unknown agent '${name}'` };
	if (self && name === by) return { ok: true };
	if (isStrictDescendant(agents, name, by)) return { ok: true };
	return { ok: false, reason: `'${name}' is not in your subtree` };
}
