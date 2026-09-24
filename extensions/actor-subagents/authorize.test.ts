import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRecord } from "./agent-record.ts";
import { authorize } from "./authorize.ts";

const rec = (name: string, spawnedBy: string): AgentRecord => ({
	name,
	model: "test/m",
	handle: { deliver: async () => {}, abort: async () => {} },
	spawnedBy,
	depth: 0,
	createdAt: 0,
	turns: 0,
	lastActivity: 0,
});

// main -> lead -> helper, main -> peer
const agents = new Map([rec("main", "main"), rec("lead", "main"), rec("helper", "lead"), rec("peer", "main")].map((r) => [r.name, r]));
const refused = (name: string) => ({ ok: false, reason: `'${name}' is not in your subtree` });

test("authorize admits strict descendants and refuses everything else with one reason", () => {
	assert.deepEqual(authorize(agents, "lead", "helper"), { ok: true });
	assert.deepEqual(authorize(agents, "main", "helper"), { ok: true });
	assert.deepEqual(authorize(agents, "lead", "peer"), refused("peer"));
	assert.deepEqual(authorize(agents, "helper", "lead"), refused("lead"));
	assert.deepEqual(authorize(agents, "lead", "lead"), refused("lead"));
	assert.deepEqual(authorize(agents, "main", "main"), refused("main"));
});

test("authorize reports unknown agents first and admits self only when asked", () => {
	assert.deepEqual(authorize(agents, "lead", "ghost"), { ok: false, reason: "unknown agent 'ghost'" });
	assert.deepEqual(authorize(agents, "lead", "lead", "self"), { ok: true });
	assert.deepEqual(authorize(agents, "lead", "peer", "self"), refused("peer"));
});
