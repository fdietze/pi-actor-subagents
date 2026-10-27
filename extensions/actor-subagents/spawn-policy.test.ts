import { test } from "node:test";
import assert from "node:assert/strict";
import type { RoutedAgentMessage } from "./agent-message.ts";
import type { AgentEvent } from "./agent-event.ts";
import { type Caller, installApi, type PolicyResult, type SpawnArgs, type SpawnPolicy } from "./api.ts";
import { Engine } from "./engine.ts";
import { createSpawner, type SessionLike, type ThinkingLevel } from "./spawner.ts";

/** The smallest session the spawner can wire; records what it was handed. */
function fakeSession(): SessionLike & { delivered: RoutedAgentMessage[] } {
	const delivered: RoutedAgentMessage[] = [];
	const listeners: ((e: { type: string }) => void)[] = [];
	let level: ThinkingLevel = "high";
	return {
		delivered,
		// Picks the message up like a live session, so the spawner's reaction wait ends at once.
		sendAgentMessage: async (m) => {
			delivered.push(m);
			setTimeout(() => {
				for (const l of listeners) l({ type: "turn_start" });
			}, 0);
		},
		sendUserMessage: async () => {},
		abort: async () => {},
		abortBash: () => {},
		shutdown: async () => {},
		dispose: () => {},
		get thinkingLevel() {
			return level;
		},
		setModel: async () => {},
		setThinkingLevel: (l) => {
			level = l;
		},
		subscribe: (l) => {
			listeners.push(l);
			return () => {};
		},
		getToolDefinition: () => undefined,
		messages: [],
		getContextUsage: () => undefined,
	} as Partial<SessionLike> as SessionLike & { delivered: RoutedAgentMessage[] };
}

type CreateSpec = Parameters<Parameters<typeof createSpawner>[0]["createSession"]>[0];

function setup(policy?: SpawnPolicy, extra: Partial<Parameters<typeof createSpawner>[0]> = {}) {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3 });
	engine.addAgent({
		name: "main",
		model: "fg/main",
		thinkingLevel: "xhigh",
		sessionId: "sess-main",
		handle: { deliver: async () => {}, abort: async () => {} },
		spawnedBy: "main",
		depth: 0,
		createdAt: 0,
		turns: 0,
		lastActivity: 0,
	});
	const specs: CreateSpec[] = [];
	const sessions = new Map<string, ReturnType<typeof fakeSession>>();
	const calls: { args: SpawnArgs; caller: Caller }[] = [];
	const spawner = createSpawner({
		engine,
		resolveModel: (ref) => {
			if (!ref) return undefined;
			const [provider, id] = ref.split("/");
			return { provider: provider ?? "", id: id ?? "", model: { ref } };
		},
		createSession: async (spec) => {
			specs.push(spec);
			const s = fakeSession();
			s.setThinkingLevel(spec.thinkingLevel ?? "off");
			sessions.set(spec.name, s);
			return { session: s, sessionFile: `/x/${spec.name}.jsonl`, sessionId: `sess-${spec.name}` };
		},
		spawnPolicy: policy
			? () => async (args, caller) => {
					calls.push({ args, caller });
					return policy(args, caller);
				}
			: undefined,
		cwd: () => "/repo",
		...extra,
	});
	return { engine, spawner, specs, sessions, calls };
}

const textOf = (m: RoutedAgentMessage | undefined) => m?.parts[0]?.content;

test("a policy reject fails the spawn with its reason, flagged as rejected, and frees the name", async () => {
	const { engine, spawner, specs } = setup(() => ({ reject: "card missing acceptance" }));
	const r = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.equal(r.ok, false);
	assert.equal(r.rejected, true);
	assert.match(r.msg, /card missing acceptance/);
	assert.equal(engine.has("w"), false);
	assert.equal(specs.length, 0);
});

test("a throwing policy fails the spawn instead of the tool call", async () => {
	const { engine, spawner } = setup(() => {
		throw new Error("router broke");
	});
	const r = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.equal(r.ok, false);
	assert.equal(r.rejected, true);
	assert.match(r.msg, /spawn policy failed: router broke/);
	assert.equal(engine.has("w"), false);
});

test("the policy sees the spawn args (with task) and the caller", async () => {
	const { spawner, calls } = setup(() => ({ model: "a/b", thinkingLevel: "low" }));
	await spawner.spawnAgent(
		{ name: "w", systemPrompt: "p", message: "go", model: "x/y", thinkingLevel: "max", task: { kind: "scout" } },
		"main",
	);
	assert.deepEqual(calls[0]?.args, {
		name: "w",
		systemPrompt: "p",
		message: "go",
		model: "x/y",
		thinkingLevel: "max",
		task: { kind: "scout" },
	});
	assert.deepEqual(calls[0]?.caller, {
		name: "main",
		sessionId: "sess-main",
		model: "fg/main",
		thinkingLevel: "xhigh",
		policyMeta: undefined,
		cwd: "/repo",
	});
});

test("the policy's model, effort, briefAppend and tools are applied to the child", async () => {
	const { engine, spawner, specs, sessions } = setup(() => ({
		model: "anthropic/sonnet",
		thinkingLevel: "medium",
		briefAppend: "Report in 5 lines.",
		tools: ["read", "send_message"],
	}));
	const r = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "do it", model: "x/y" }, "main");
	assert.equal(r.ok, true);
	assert.equal(engine.get("w")?.model, "anthropic/sonnet");
	assert.equal(engine.get("w")?.thinkingLevel, "medium");
	assert.deepEqual(specs[0]?.model, { ref: "anthropic/sonnet" });
	assert.deepEqual(specs[0]?.tools, ["read", "send_message"]);
	assert.equal(textOf(sessions.get("w")?.delivered[0]), "do it\n\nReport in 5 lines.");
});

test("meta is stored on the child and offered back as caller.policyMeta on a grandchild spawn", async () => {
	let n = 0;
	const policy = (): PolicyResult => ({ model: "a/b", thinkingLevel: "low", meta: { tier: `T${++n}` } });
	const { engine, spawner, calls } = setup(policy);
	await spawner.spawnAgent({ name: "child", systemPrompt: "p", message: "go" }, "main");
	await spawner.spawnAgent({ name: "grand", systemPrompt: "p", message: "go" }, "child");
	assert.deepEqual(engine.get("child")?.policyMeta, { tier: "T1" });
	assert.equal(calls[1]?.caller.name, "child");
	assert.equal(calls[1]?.caller.sessionId, "sess-child");
	assert.deepEqual(calls[1]?.caller.policyMeta, { tier: "T1" });
});

test("without a policy the spawn inherits the spawner's model and effort", async () => {
	const { engine, spawner, specs, sessions } = setup();
	const r = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.equal(r.ok, true);
	assert.equal(r.rejected, undefined);
	assert.equal(engine.get("w")?.model, "fg/main");
	assert.equal(engine.get("w")?.thinkingLevel, "xhigh");
	assert.equal(specs[0]?.tools, undefined);
	assert.equal(textOf(sessions.get("w")?.delivered[0]), "go");
	assert.equal(engine.get("w")?.sessionId, "sess-w");
});

test("api subscribers get one spawn event per child, carrying its session id", async () => {
	const { engine, spawner } = setup();
	const api = installApi({ engine, retune: async () => {} }, {});
	const seen: AgentEvent[] = [];
	api.subscribe((e) => {
		if (e.type === "spawn") seen.push(e);
	});
	await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	engine.addAgent({ ...engine.get("w")!, name: "restored", sessionId: "sess-r" });
	assert.deepEqual(
		seen.map(({ ts: _ts, ...e }) => e),
		[
			{ type: "spawn", name: "w", by: "main", parent: "main", childSessionId: "sess-w" },
			{ type: "spawn", name: "restored", by: "main", parent: "main", childSessionId: "sess-r" },
		],
	);
});

test("the policy's toolGuard is handed to the child session, and absent without one", async () => {
	const toolGuard = () => "no";
	const { specs, spawner } = setup(() => ({ model: "a/b", thinkingLevel: "low", toolGuard }));
	await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.equal(specs[0]?.toolGuard, toolGuard);
	const plain = setup(() => ({ model: "a/b", thinkingLevel: "low" }));
	await plain.spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.equal("toolGuard" in (plain.specs[0] ?? {}), false);
});

test("a malformed policy result fails the spawn with a clear error and frees the name and its cap slot", async () => {
	const malformed: unknown[] = [
		undefined,
		null,
		"anthropic/x",
		42,
		{ reject: 7 },
		{ reject: "" },
		{ model: 5 },
		{ thinkingLevel: "turbo" },
		{ tools: "read" },
		{ tools: ["read", 1] },
		{ briefAppend: {} },
		{ toolGuard: "no" },
		{ meta: { big: 1n } },
	];
	for (const result of malformed) {
		const { engine, spawner, specs } = setup((() => result) as never, {});
		const r = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
		assert.equal(r.ok, false, JSON.stringify(String(result)));
		assert.equal(r.rejected, true);
		assert.match(r.msg, /^error: spawn policy returned an invalid result: /);
		assert.equal(engine.has("w"), false);
		assert.equal(specs.length, 0);
		assert.equal(engine.list().length, 1, "only main is left: the cap slot is free again");
	}
});

test("a synchronously throwing or rejecting policy frees the name like a refusal", async () => {
	const engine = new Engine({ maxAgents: 1, maxSpawnDepth: 3 });
	engine.addAgent({
		name: "main", model: "fg/main", handle: { deliver: async () => {}, abort: async () => {} },
		spawnedBy: "main", depth: 0, createdAt: 0, turns: 0, lastActivity: 0,
	});
	let mode: "throw" | "reject" | "accept" = "throw";
	const spawner = createSpawner({
		engine,
		resolveModel: (ref) => (ref ? { provider: "a", id: "b", model: { ref } } : undefined),
		createSession: async () => ({ session: fakeSession() }),
		spawnPolicy: () => (() => {
			if (mode === "throw") throw new Error("sync boom");
			if (mode === "reject") return Promise.reject(new Error("async boom"));
			return {};
		}) as SpawnPolicy,
	});
	const thrown = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.match(thrown.msg, /spawn policy failed: sync boom/);
	mode = "reject";
	const rejected = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.match(rejected.msg, /spawn policy failed: async boom/);
	// maxAgents is 1: the slot was freed both times, so an accepted spawn still fits.
	mode = "accept";
	const ok = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.equal(ok.ok, true, ok.msg);
});

test("a policy that does not answer within spawnPolicyTimeoutMs fails the spawn and frees the name", async () => {
	const { engine, spawner, specs } = setup(() => new Promise<PolicyResult>(() => {}), { spawnPolicyTimeoutMs: () => 20 });
	const r = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.equal(r.ok, false);
	assert.equal(r.rejected, true);
	assert.match(r.msg, /^error: spawn policy failed: no answer within 20 ms/);
	assert.equal(engine.has("w"), false);
	assert.equal(specs.length, 0);
});

test("spawnPolicyTimeoutMs 0 waits for the policy without a bound", async () => {
	const { spawner } = setup(
		() => new Promise<PolicyResult>((resolve) => setTimeout(() => resolve({ model: "a/b" }), 30)),
		{ spawnPolicyTimeoutMs: () => 0 },
	);
	const r = await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.equal(r.ok, true, r.msg);
});

test("a kill during the policy await cancels the spawn without a session and leaves a re-spawn alone", async () => {
	let answer!: (r: PolicyResult) => void;
	const gate = new Promise<PolicyResult>((resolve) => {
		answer = resolve;
	});
	const { engine, spawner, specs } = setup(() => gate);
	const first = spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	await new Promise((r) => setTimeout(r, 0));
	await engine.kill("main", ["w"]);
	// The same name is reserved again by another spawn while the first policy call still runs.
	assert.equal(engine.reserve("w", "main").ok, true);
	const second = engine.get("w");
	answer({ reject: "too late" });
	const r = await first;
	assert.equal(r.ok, false);
	assert.match(r.msg, /spawn of 'w' was cancelled/);
	assert.equal(engine.get("w"), second, "the later reservation is not released");
	assert.equal(specs.length, 0, "no session is created for a cancelled spawn");
});

test("an accept without model or effort keeps the normal route: explicit args, else the spawner's", async () => {
	const { engine, spawner, sessions } = setup(() => ({ briefAppend: "Be brief." }));
	await spawner.spawnAgent({ name: "a", systemPrompt: "p", message: "go" }, "main");
	assert.equal(engine.get("a")?.model, "fg/main");
	assert.equal(engine.get("a")?.thinkingLevel, "xhigh");
	assert.equal(textOf(sessions.get("a")?.delivered[0]), "go\n\nBe brief.");
	await spawner.spawnAgent({ name: "b", systemPrompt: "p", message: "go", model: "x/y", thinkingLevel: "low" }, "main");
	assert.equal(engine.get("b")?.model, "x/y");
	assert.equal(engine.get("b")?.thinkingLevel, "low");
	const effortOnly = setup(() => ({ thinkingLevel: "minimal" }));
	await effortOnly.spawner.spawnAgent({ name: "c", systemPrompt: "p", message: "go" }, "main");
	assert.equal(effortOnly.engine.get("c")?.model, "fg/main");
	assert.equal(effortOnly.engine.get("c")?.thinkingLevel, "minimal");
});

test("the policy's allowlist and the fact of a guard are recorded on the child for persistence", async () => {
	const { engine, spawner } = setup(() => ({ tools: ["read"], toolGuard: () => undefined, meta: { tier: 1 } }));
	await spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.deepEqual(engine.get("w")?.policyTools, ["read"]);
	assert.equal(engine.get("w")?.policyGuarded, true);
	const plain = setup(() => ({}));
	await plain.spawner.spawnAgent({ name: "w", systemPrompt: "p", message: "go" }, "main");
	assert.equal(plain.engine.get("w")?.policyTools, undefined);
	assert.equal(plain.engine.get("w")?.policyGuarded, undefined);
});

test("a restored agent keeps its policy state, and one whose guard is missing stays paused and blocked", async () => {
	const { engine, spawner } = setup();
	const restore = (name: string, runBlock?: string) =>
		spawner.restoreAgent({
			name, spawnedBy: "main", depth: 1, model: "a/b", systemPrompt: "p", sessionFile: `/s/${name}.jsonl`,
			session: fakeSession(), pausedMidTurn: false,
			policyTools: ["read"], policyMeta: { tier: 1 }, policyGuarded: true, ...(runBlock ? { runBlock } : {}),
		});
	restore("guarded");
	restore("blocked", "its tool guard was not restored: no spawn policy is registered");
	assert.deepEqual(engine.get("guarded")?.policyTools, ["read"]);
	assert.deepEqual(engine.get("guarded")?.policyMeta, { tier: 1 });
	assert.equal(engine.get("guarded")?.policyGuarded, true);
	// Restore pauses main's children as usual; the blocked one also holds its own pause.
	engine.pause("restore");
	const all = await engine.resume("main");
	assert.deepEqual(all.affected, ["guarded"]);
	assert.equal(engine.status(engine.get("blocked")!).kind, "paused");
	const named = await engine.resume("main", ["blocked"]);
	assert.deepEqual(named.results, [
		{ target: "blocked", ok: false, reason: "its tool guard was not restored: no spawn policy is registered" },
	]);
	assert.equal(engine.status(engine.get("blocked")!).kind, "paused");
});
