import { test } from "node:test";
import assert from "node:assert/strict";
import { API_KEY, installApi, restoreToolGuard, type SubagentsApiV1 } from "./api.ts";
import { Engine } from "./engine.ts";

const caps = { maxAgents: 8, maxSpawnDepth: 3 };

/** A private stand-in for globalThis, so tests never share the process-wide slot. */
const fresh = () => ({}) as Record<string, unknown>;

const record = (name: string, over: Record<string, unknown> = {}) => ({
	name,
	model: "test/m",
	handle: { deliver: async () => {}, abort: async () => {} },
	spawnedBy: "main",
	depth: name === "main" ? 0 : 1,
	createdAt: 0,
	turns: 0,
	lastActivity: 0,
	...over,
});

test("installApi puts a version-1 API on the global slot, once", () => {
	const g = fresh();
	const engine = new Engine(caps);
	const api = installApi({ engine, retune: async () => {} }, g);
	assert.equal((g[API_KEY] as SubagentsApiV1).version, 1);
	assert.equal(API_KEY, "__subagentsApi_v1");
	// A /reload installs again: same object (subscribers and the policy survive), new deps.
	const again = installApi({ engine, retune: async () => {} }, g);
	assert.equal(again, api);
});

test("installApi defaults to globalThis.__subagentsApi_v1", () => {
	const g = globalThis as Record<string, unknown>;
	const before = g[API_KEY];
	try {
		delete g[API_KEY];
		installApi({ engine: new Engine(caps), retune: async () => {} });
		assert.equal((g[API_KEY] as SubagentsApiV1).version, 1);
	} finally {
		g[API_KEY] = before;
	}
});

test("registerSpawnPolicy refuses a second policy and its unregister frees the slot", () => {
	const api = installApi({ engine: new Engine(caps), retune: async () => {} }, fresh());
	const policy = () => ({ reject: "no" });
	const unregister = api.registerSpawnPolicy(policy);
	assert.equal(api.spawnPolicy(), policy);
	assert.throws(() => api.registerSpawnPolicy(() => ({ reject: "other" })), /already registered/);
	unregister();
	assert.equal(api.spawnPolicy(), undefined);
	const next = () => ({ reject: "next" });
	api.registerSpawnPolicy(next);
	// A stale unregister must not remove the policy registered after it.
	unregister();
	assert.equal(api.spawnPolicy(), next);
});

test("the policy survives a reinstall with new deps", () => {
	const g = fresh();
	const api = installApi({ engine: new Engine(caps), retune: async () => {} }, g);
	const policy = () => ({ reject: "no" });
	api.registerSpawnPolicy(policy);
	installApi({ engine: new Engine(caps), retune: async () => {} }, g);
	assert.equal(api.spawnPolicy(), policy);
});

test("subscribe delegates to the engine and returns an unsubscribe", () => {
	const engine = new Engine(caps);
	const api = installApi({ engine, retune: async () => {} }, fresh());
	const seen: string[] = [];
	const off = api.subscribe((e) => seen.push(e.type));
	engine.addAgent(record("main"));
	engine.reportError("main", "boom");
	off();
	engine.reportError("main", "again");
	assert.deepEqual(seen, ["spawn", "error"]);
});

test("retune delegates to the shell's retune and surfaces its failure", async () => {
	const calls: unknown[] = [];
	const api = installApi(
		{
			engine: new Engine(caps),
			retune: async (name, t) => {
				calls.push([name, t]);
				if (name === "bad") throw new Error("unknown model");
			},
		},
		fresh(),
	);
	await api.retune("w", { model: "a/b", thinkingLevel: "high" });
	assert.deepEqual(calls, [["w", { model: "a/b", thinkingLevel: "high" }]]);
	await assert.rejects(api.retune("bad", { model: "x/y" }), /unknown model/);
});

test("send routes like send_message, from the sender the caller names", async () => {
	const engine = new Engine(caps);
	const inbox: unknown[] = [];
	engine.addAgent(record("w", { handle: { deliver: async (m: unknown) => void inbox.push(m), abort: async () => {} } }));
	const api = installApi({ engine, retune: async () => {} }, fresh());
	await api.send("w", "continue", "my-router");
	await api.send("w", "hi", "lead");
	assert.deepEqual(inbox, [
		{ parts: [{ from: "my-router", content: "continue" }] },
		{ parts: [{ from: "lead", content: "hi" }] },
	]);
	assert.equal(engine.getMessageMatrix()["my-router"]?.w, 1);
	await assert.rejects(api.send("ghost", "x", "my-router"), /unknown agent 'ghost'/);
	await assert.rejects(api.send("w", "x", " "), /sender name/);
	assert.equal(inbox.length, 2);
});

test("list reports each agent's identity, state and usage", () => {
	const engine = new Engine(caps);
	const now = 1_000_000;
	const messages = [
		{ role: "user", timestamp: now - 9000 },
		{ role: "assistant", timestamp: now - 8000, usage: { cost: { total: 0.5 } } },
		{ role: "toolResult", timestamp: now - 7000 },
		{ role: "assistant", timestamp: now - 6000, usage: { cost: { total: 1.25 } } },
	];
	const view = (tokens: number | null) => ({
		getMessages: () => messages,
		getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: 1 }),
		subscribe: () => () => {},
	});
	engine.addAgent(record("main", { sessionId: "s0", thinkingLevel: "high" }));
	engine.addAgent(
		record("idle1", { sessionId: "s1", lastActivity: now - 4000, view: view(143_000), policyMeta: { tier: "T1" } }),
	);
	engine.addAgent(record("busy", { sessionId: "s2", spawnedBy: "idle1", activity: "tool", view: view(null) }));
	engine.addAgent(record("held", { sessionId: "s3" }));
	engine.pause("main", ["held"]);
	const api = installApi({ engine, retune: async () => {}, now: () => now }, fresh());
	const byName = Object.fromEntries(api.list().map((a) => [a.name, a]));
	assert.deepEqual(byName.idle1, {
		name: "idle1",
		parent: "main",
		sessionId: "s1",
		model: "test/m",
		thinkingLevel: undefined,
		state: "idle",
		idleSinceMs: 4000,
		lastRequestAt: now - 6000,
		contextTokens: 143_000,
		costUsd: 1.75,
		policyMeta: { tier: "T1" },
	});
	assert.equal(byName.busy?.state, "running");
	assert.equal(byName.busy?.parent, "idle1");
	assert.equal(byName.busy?.idleSinceMs, undefined);
	assert.equal(byName.busy?.contextTokens, undefined);
	assert.equal(byName.held?.state, "paused");
	assert.equal(byName.main?.sessionId, "s0");
	assert.equal(byName.main?.lastRequestAt, undefined);
	assert.equal(byName.main?.costUsd, undefined);
});

test("re-registering under the same owner replaces that owner's policy; another owner is refused", () => {
	const api = installApi({ engine: new Engine(caps), retune: async () => {} }, fresh());
	const first = () => ({ reject: "first" });
	const offFirst = api.registerSpawnPolicy(first, { owner: "router" });
	const second = () => ({ reject: "second" });
	const offSecond = api.registerSpawnPolicy(second, { owner: "router" });
	assert.equal(api.spawnPolicy(), second);
	// The replaced registration's unregister is stale and must not remove its successor.
	offFirst();
	assert.equal(api.spawnPolicy(), second);
	assert.throws(() => api.registerSpawnPolicy(() => ({}), { owner: "other" }), /already registered by 'router'/);
	assert.throws(() => api.registerSpawnPolicy(() => ({})), /already registered by 'router'/);
	offSecond();
	assert.equal(api.spawnPolicy(), undefined);
});

test("an anonymous registration is never replaced: a second one is refused", () => {
	const api = installApi({ engine: new Engine(caps), retune: async () => {} }, fresh());
	api.registerSpawnPolicy(() => ({}));
	assert.throws(() => api.registerSpawnPolicy(() => ({})), /already registered/);
	assert.throws(() => api.registerSpawnPolicy(() => ({}), { owner: "router" }), /already registered/);
});

test("a changed engine key installs a fresh API object that keeps the registered policy", () => {
	const g = fresh();
	const restore = () => undefined;
	const old = installApi({ engine: new Engine(caps), retune: async () => {}, engineKey: "k1" }, g);
	const policy = () => ({});
	old.registerSpawnPolicy(policy, { owner: "router", restore });
	assert.equal(installApi({ engine: new Engine(caps), retune: async () => {}, engineKey: "k1" }, g), old);
	const next = installApi({ engine: new Engine(caps), retune: async () => {}, engineKey: "k2" }, g);
	assert.notEqual(next, old, "new code after an engine version change, so consumers re-fetch the slot");
	assert.equal(g[API_KEY], next);
	assert.equal(next.spawnPolicy(), policy);
	assert.equal(next.spawnPolicyRegistration()?.restore, restore);
	assert.throws(() => next.registerSpawnPolicy(() => ({}), { owner: "other" }), /already registered by 'router'/);
});

test("list marks a pending reservation as spawning", () => {
	const engine = new Engine(caps);
	engine.addAgent(record("main"));
	assert.equal(engine.reserve("new", "main").ok, true);
	const api = installApi({ engine, retune: async () => {} }, fresh());
	const info = api.list().find((a) => a.name === "new");
	assert.equal(info?.state, "spawning");
	assert.equal(info?.sessionId, "");
});

test("restoreToolGuard asks the policy's restore hook and explains every way it can fail", async () => {
	const info = { name: "w", parent: "main", model: "a/b", thinkingLevel: "low" as const, tools: ["read"], meta: { tier: 1 } };
	const guard = () => "blocked";
	const seen: unknown[] = [];
	const reg = (restore?: (i: unknown) => unknown) => ({ fn: () => ({}), restore: restore as never });
	assert.deepEqual(await restoreToolGuard(undefined, info, 0), { reason: "no spawn policy is registered" });
	assert.deepEqual(await restoreToolGuard(reg(), info, 0), { reason: "the spawn policy has no restore hook" });
	assert.deepEqual(await restoreToolGuard(reg(() => undefined), info, 0), {
		reason: "the spawn policy's restore hook returned no tool guard",
	});
	assert.deepEqual(
		await restoreToolGuard(reg(() => {
			throw new Error("boom");
		}), info, 0),
		{ reason: "the spawn policy's restore hook failed: boom" },
	);
	assert.deepEqual(await restoreToolGuard(reg(() => new Promise(() => {})), info, 20), {
		reason: "the spawn policy's restore hook failed: no answer within 20 ms",
	});
	const ok = await restoreToolGuard(reg(async (i) => (seen.push(i), guard)), info, 0);
	assert.deepEqual(ok, { guard });
	assert.deepEqual(seen, [info]);
});
