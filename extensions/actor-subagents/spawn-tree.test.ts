import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRecord } from "./agent-record.ts";
import { childrenOf, isStrictDescendant, nearest, pausedBy, subtreePostOrder } from "./spawn-tree.ts";

const rec = (name: string, spawnedBy: string, paused?: boolean): AgentRecord => ({
	name,
	model: "test/m",
	handle: { deliver: async () => {}, abort: async () => {} },
	spawnedBy,
	depth: 0,
	createdAt: 0,
	turns: 0,
	lastActivity: 0,
	...(paused ? { paused } : {}),
});

/** main -> a -> b -> c, main -> d */
const tree = (flags: Record<string, boolean> = {}) =>
	new Map(
		[rec("main", "main"), rec("a", "main"), rec("b", "a"), rec("c", "b"), rec("d", "main")].map((r) => [
			r.name,
			{ ...r, ...(flags[r.name] ? { paused: true } : {}) },
		]),
	);

test("nearest walks from the record itself up to, but not including, main", () => {
	const agents = tree();
	const names: string[] = [];
	assert.equal(nearest(agents, agents.get("c"), (cur) => (names.push(cur.name), false)), undefined);
	assert.deepEqual(names, ["c", "b", "a"]);
	assert.equal(nearest(agents, agents.get("c"), (cur) => cur.name === "b")?.name, "b");
	assert.equal(nearest(agents, undefined, () => true), undefined);
});

test("pausedBy names the nearest own flag on the agent or an ancestor", () => {
	assert.equal(pausedBy(tree(), tree().get("c")!), undefined);
	const agents = tree({ a: true, b: true });
	assert.equal(pausedBy(agents, agents.get("c")!), "b");
	assert.equal(pausedBy(agents, agents.get("a")!), "a");
	assert.equal(pausedBy(agents, agents.get("d")!), undefined, "a sibling subtree runs");
});

test("isStrictDescendant: ancestors own their subtree, main owns everyone, nobody owns main", () => {
	const agents = tree();
	assert.equal(isStrictDescendant(agents, "c", "a"), true);
	assert.equal(isStrictDescendant(agents, "c", "main"), true);
	assert.equal(isStrictDescendant(agents, "a", "a"), false, "strict: not itself");
	assert.equal(isStrictDescendant(agents, "a", "c"), false, "not upwards");
	assert.equal(isStrictDescendant(agents, "d", "a"), false, "not a sibling subtree");
	assert.equal(isStrictDescendant(agents, "main", "main"), false);
	assert.equal(isStrictDescendant(agents, "ghost", "main"), false);
});

test("childrenOf and subtreePostOrder follow spawnedBy and never include main", () => {
	const agents = tree();
	assert.deepEqual(childrenOf(agents, "main").map((r) => r.name), ["a", "d"]);
	assert.deepEqual(subtreePostOrder(agents, "a").map((r) => r.name), ["c", "b", "a"]);
	assert.deepEqual(subtreePostOrder(agents, "ghost"), []);
});
