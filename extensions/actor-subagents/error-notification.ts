/**
 * Who learns that an agent broke, and what they are told. Pure decision; the shell delivers.
 *
 * The swarm runs on "spawn a child, end your turn, get woken when it messages you". A child that
 * errors may never send that message, so its parent would wait forever (Inversion: the failure
 * mode to remove is a parent parked on a reply that can no longer come). The spawn tree is the
 * ownership structure, so the direct parent is the one agent that can act on it.
 */

export interface ErrorNotification {
	/** The agent to notify: the errored agent's direct parent. */
	to: string;
	/** Body of the peer message delivered to that parent. */
	content: string;
}

/**
 * The notification for one error event, or undefined when nobody should be told.
 *
 * Silent cases, all of them "there is no live reader": the errored agent is the root of the spawn
 * tree ('main' has no parent), or either side is no longer registered — which is exactly what a
 * subtree kill leaves behind, so a dying child cannot spam its equally dying parent.
 */
export function errorNotification(
	error: { name: string; reason: string },
	spawnTree: Record<string, string>,
	liveAgents: ReadonlySet<string>,
): ErrorNotification | undefined {
	const parent = spawnTree[error.name];
	if (!parent) return undefined;
	if (!liveAgents.has(error.name) || !liveAgents.has(parent)) return undefined;
	return {
		to: parent,
		content:
			`subagent \`${error.name}\` entered the error state: ${error.reason}. ` +
			`It will not report back on its own — inspect it with subagent_history and decide how to continue.`,
	};
}
