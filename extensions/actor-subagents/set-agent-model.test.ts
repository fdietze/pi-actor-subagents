import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, type AgentHandle } from "./engine.ts";
import { createAgentModelSetter } from "./set-agent-model.ts";

const handle = (): AgentHandle => ({ deliver: async () => {}, abort: async () => {} });
const caps = { maxAgents: 4, maxSpawnDepth: 3 };

/** Engine with one live child whose session accepts every change and clamps nothing. */
function engineWithChild(): { engine: Engine; changes: unknown[] } {
	const engine = new Engine(caps);
	const changes: unknown[] = [];
	engine.addAgent({
		name: "w",
		model: "anthropic/sonnet",
		thinkingLevel: "low",
		handle: handle(),
		spawnedBy: "main",
		depth: 1,
		createdAt: 0,
		turns: 0,
		lastActivity: 0,
		reconfigure: async (change) => {
			changes.push(change);
			return { model: change.model?.display, thinkingLevel: change.thinkingLevel ?? "low" };
		},
	});
	return { engine, changes };
}

function setterFor(engine: Engine, persisted: string[] = []) {
	return createAgentModelSetter({
		engine,
		resolveModel: (ref) => (ref === "anthropic/opus" ? { display: "anthropic/opus", model: {} } : undefined),
		unknownModel: (ref) => `unknown model '${ref}'; available: anthropic/opus`,
		persistRoster: () => persisted.push("persisted"),
	});
}

test("a model change is applied, persisted and reported with the effective level", async () => {
	const { engine, changes } = engineWithChild();
	const persisted: string[] = [];
	const result = await setterFor(engine, persisted)("main", { name: "w", model: "anthropic/opus", thinkingLevel: "high" });
	assert.equal(result.ok, true);
	assert.equal(result.msg, "retuned 'w' to anthropic/opus@high");
	assert.equal(engine.get("w")?.model, "anthropic/opus");
	assert.equal(changes.length, 1);
	assert.deepEqual(persisted, ["persisted"]); // a restart must restore the retuned agent
});

test("thinking level alone leaves the model untouched", async () => {
	const { engine } = engineWithChild();
	const result = await setterFor(engine)("main", { name: "w", thinkingLevel: "xhigh" });
	assert.equal(result.ok, true);
	assert.equal(engine.get("w")?.model, "anthropic/sonnet");
	assert.equal(engine.get("w")?.thinkingLevel, "xhigh");
});

test("an unknown model is refused with the available list, and nothing is applied", async () => {
	const { engine, changes } = engineWithChild();
	const result = await setterFor(engine)("main", { name: "w", model: "bogus/model" });
	assert.equal(result.ok, false);
	assert.match(result.msg, /unknown model 'bogus\/model'; available: anthropic\/opus/);
	assert.equal(changes.length, 0);
	assert.equal(engine.get("w")?.model, "anthropic/sonnet");
});

test("a call that changes nothing is an error, not a silent success", async () => {
	const { engine } = engineWithChild();
	const result = await setterFor(engine)("main", { name: "w" });
	assert.equal(result.ok, false);
	assert.match(result.msg, /nothing to change/);
});

test("engine refusals (unknown agent, main) surface verbatim", async () => {
	const { engine } = engineWithChild();
	const set = setterFor(engine);
	assert.match((await set("main", { name: "ghost", thinkingLevel: "high" })).msg, /unknown agent 'ghost'/);
	assert.match((await set("main", { name: "main", thinkingLevel: "high" })).msg, /cannot retune 'main'/);
});
