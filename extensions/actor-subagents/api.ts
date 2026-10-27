/**
 * The stable, versioned surface other extensions (e.g. a task router) drive the swarm through:
 * `globalThis.__subagentsApi_v1`. SDK-free.
 *
 * Installed once per process and kept across /reload: a load with the same engine version
 * (index.ts ENGINE_KEY) rebinds the deps (the live engine and the shell's retune) on the SAME
 * object, so a consumer's reference and a registered spawn policy stay valid. A load whose engine
 * version differs installs a fresh object (new code), carrying the registered policy over;
 * consumers should therefore read the slot again after /reload instead of keeping a reference.
 * Children run in-process and spawn through the same spawner, so one policy registered by the
 * foreground covers every depth of the tree.
 *
 * Trust model: the API is an in-process surface for extensions the human installed, which
 * already run with the process's full authority. It does not authenticate its callers: `retune`
 * acts with 'main's authority, and `send` delivers under whatever sender name the caller gives,
 * including a real agent's name or 'main'.
 */
import type { AgentEvent } from "./agent-event.ts";
import type { AgentRecord } from "./agent-record.ts";
import type { AgentStatus } from "./agent-status.ts";
import type { Engine } from "./engine.ts";
import { isThinkingLevel, type ThinkingLevel } from "./thinking-level.ts";
import type { ToolGuard } from "./tool-guard.ts";

export const API_KEY = "__subagentsApi_v1";

export type SpawnArgs = {
	name: string;
	systemPrompt: string;
	message: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	task?: unknown;
};
export type Caller = {
	name: string;
	sessionId: string;
	model: string;
	/** Undefined only while the foreground has not reported its level yet. */
	thinkingLevel: ThinkingLevel | undefined;
	policyMeta?: unknown;
	cwd: string;
};
/**
 * A policy's acceptance. Every field is optional: an omitted model or effort takes the normal
 * route (the spawn's explicit argument, else the spawner's own), so a policy that only narrows
 * tools or appends to the brief does not have to re-implement inheritance.
 */
export type PolicyAccept = {
	model?: string;
	thinkingLevel?: ThinkingLevel;
	briefAppend?: string;
	/**
	 * Allowlist of the child's regular tools (built-ins and extension tools). The orchestration
	 * tools actor-subagents gives every child (send_message, spawn_subagent, list_subagents, ...)
	 * always stay available, so a restricted child can still report back. Plain names, as for
	 * pi's `tools` session option; `+name`/`-name` entries are not supported. Persisted with the
	 * agent, so a restored child comes back with the same allowlist.
	 */
	tools?: string[];
	/** Opaque data for the policy; must be JSON-serializable, because it is persisted with the agent. */
	meta?: unknown;
	/**
	 * Checked on each of the child's tool calls; a returned reason blocks the call. A function
	 * cannot be persisted: a restored guarded child gets its guard back only from the `restore`
	 * hook, and is restored paused and blocked without one.
	 */
	toolGuard?: ToolGuard;
};
export type PolicyResult = PolicyAccept | { reject: string };
export type SpawnPolicy = (a: SpawnArgs, c: Caller) => PolicyResult | Promise<PolicyResult>;

/** A restored agent that ran with a tool guard, as the `restore` hook sees it. */
export type RestoreInfo = {
	name: string;
	parent: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
	tools?: string[];
	/** The meta the policy gave the agent, as persisted (JSON). */
	meta?: unknown;
};
export type SpawnPolicyOptions = {
	/**
	 * Who registers. A registration under the owner of the current one replaces it (so a policy
	 * extension may simply register again after /reload); any other registration is refused
	 * while one is in place, and an anonymous one is never replaced.
	 */
	owner?: string;
	/**
	 * Re-attaches a tool guard to a guarded agent restored after a restart. Returning no guard,
	 * throwing or not answering in time leaves the agent paused and blocked (fail closed).
	 */
	restore?: (info: RestoreInfo) => ToolGuard | undefined | Promise<ToolGuard | undefined>;
};
export type SpawnPolicyRegistration = SpawnPolicyOptions & { fn: SpawnPolicy };

export type AgentInfo = {
	/** Includes the foreground as `main` (its own parent, depth 0, no session transcript). */
	name: string;
	parent: string;
	/** "" while the agent is still spawning (a reserved name without a session yet). */
	sessionId: string;
	/** "(spawning)" while the agent is still spawning. */
	model: string;
	thinkingLevel: ThinkingLevel | undefined;
	state: "spawning" | "running" | "idle" | "paused";
	idleSinceMs?: number;
	lastRequestAt?: number;
	contextTokens?: number;
	costUsd?: number;
	policyMeta?: unknown;
};

/**
 * Engine events as API consumers see them: exactly one `spawn` per agent, sent once its session
 * exists so it can carry `childSessionId` (a reservation's early spawn is held back and its
 * `attach` is reported as the spawn instead).
 */
export type ApiEvent =
	| Exclude<AgentEvent, { type: "spawn" } | { type: "attach" }>
	| { type: "spawn"; name: string; by: string; parent: string; childSessionId?: string; ts: number };

export interface SubagentsApiV1 {
	version: 1;
	/**
	 * One policy per process (see SpawnPolicyOptions.owner for replacement). The returned
	 * function unregisters this registration; it does nothing once the registration was replaced.
	 */
	registerSpawnPolicy(fn: SpawnPolicy, opts?: SpawnPolicyOptions): () => void;
	subscribe(l: (e: ApiEvent) => void): () => void;
	/** Retune as 'main' (root authority); rejects with the reason when the retune fails. */
	retune(name: string, t: { model?: string; thinkingLevel?: ThinkingLevel }): Promise<void>;
	/**
	 * Deliver like send_message; rejects when routing fails. `from` is the sender the recipient
	 * sees (`[message from <from>]`), named by the calling extension: there is no default and no
	 * check that the name is the caller's own.
	 */
	send(to: string, text: string, from: string): Promise<void>;
	list(): AgentInfo[];
}

/** What the shell binds on every load. */
export interface ApiDeps {
	engine: Engine;
	retune: SubagentsApiV1["retune"];
	now?: () => number;
	/** The engine version (index.ts ENGINE_KEY): a different one replaces the installed object. */
	engineKey?: string;
}

/** The installed object: the public API plus the hooks this extension itself reads. */
export interface InstalledApi extends SubagentsApiV1 {
	/** The registered policy, read by the spawner on every spawn. */
	spawnPolicy(): SpawnPolicy | undefined;
	/** The registered policy with its owner and restore hook. */
	spawnPolicyRegistration(): SpawnPolicyRegistration | undefined;
	readonly engineKey: string | undefined;
	rebind(deps: ApiDeps): void;
}

type AssistantLike = { role?: string; timestamp?: number; usage?: { cost?: { total?: number } } };

/** One agent as api.list() reports it; usage is read from the live transcript. */
export function agentInfo(rec: AgentRecord, status: AgentStatus, now: number): AgentInfo {
	const state = rec.pending
		? "spawning"
		: status.kind === "paused"
			? "paused"
			: status.kind === "idle"
				? "idle"
				: "running";
	const assistants = ((rec.view?.getMessages?.() ?? []) as AssistantLike[]).filter((m) => m.role === "assistant");
	return {
		name: rec.name,
		parent: rec.spawnedBy,
		sessionId: rec.sessionId ?? "",
		model: rec.model,
		thinkingLevel: rec.thinkingLevel,
		state,
		idleSinceMs: state === "idle" ? now - rec.lastActivity : undefined,
		lastRequestAt: assistants.at(-1)?.timestamp,
		contextTokens: rec.view?.getContextUsage()?.tokens ?? undefined,
		costUsd: assistants.length ? assistants.reduce((sum, m) => sum + (m.usage?.cost?.total ?? 0), 0) : undefined,
		policyMeta: rec.policyMeta,
	};
}

/** Settles like `p`, or rejects with "no answer within <ms> ms" first; `ms` 0 waits forever. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
	if (!(ms > 0)) return p;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
		(timer as { unref?: () => void }).unref?.();
	});
	try {
		return await Promise.race([p, late]);
	} finally {
		clearTimeout(timer);
	}
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why `value` is not a valid policy result, or undefined when it is one. */
function invalidity(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "expected an object";
	const d = value as Record<string, unknown>;
	if ("reject" in d) return typeof d.reject === "string" && d.reject.trim() ? undefined : "reject must be a non-empty string";
	if (d.model !== undefined && (typeof d.model !== "string" || !d.model)) return "model must be a non-empty string";
	if (d.thinkingLevel !== undefined && !isThinkingLevel(d.thinkingLevel)) return `unknown thinkingLevel ${JSON.stringify(d.thinkingLevel)}`;
	if (d.briefAppend !== undefined && typeof d.briefAppend !== "string") return "briefAppend must be a string";
	if (d.tools !== undefined && !(Array.isArray(d.tools) && d.tools.every((t) => typeof t === "string" && t)))
		return "tools must be a list of tool names";
	if (d.toolGuard !== undefined && typeof d.toolGuard !== "function") return "toolGuard must be a function";
	if (d.meta !== undefined) {
		try {
			JSON.stringify(d.meta);
		} catch (e) {
			return `meta must be JSON-serializable (${errorText(e)})`;
		}
	}
	return undefined;
}

/**
 * Ask the policy, bounded by `timeoutMs` (0 = no bound). Never throws: a throw, a timeout or a
 * malformed result becomes a refusal with a reason the spawning agent can read.
 */
export async function decideSpawn(
	policy: SpawnPolicy,
	args: SpawnArgs,
	caller: Caller,
	timeoutMs: number,
): Promise<{ reject: string } | { accept: PolicyAccept }> {
	let value: unknown;
	try {
		value = await within(Promise.resolve().then(() => policy(args, caller)), timeoutMs);
	} catch (e) {
		return { reject: `spawn policy failed: ${errorText(e)}` };
	}
	const invalid = invalidity(value);
	if (invalid) return { reject: `spawn policy returned an invalid result: ${invalid}` };
	return "reject" in (value as object) ? (value as { reject: string }) : { accept: value as PolicyAccept };
}

/**
 * The tool guard of a restored guarded agent, from the policy's `restore` hook (bounded by
 * `timeoutMs`), or the reason it could not be re-attached.
 */
export async function restoreToolGuard(
	registration: SpawnPolicyRegistration | undefined,
	info: RestoreInfo,
	timeoutMs: number,
): Promise<{ guard: ToolGuard } | { reason: string }> {
	if (!registration) return { reason: "no spawn policy is registered" };
	const { restore } = registration;
	if (!restore) return { reason: "the spawn policy has no restore hook" };
	try {
		const guard = await within(Promise.resolve().then(() => restore(info)), timeoutMs);
		return typeof guard === "function" ? { guard } : { reason: "the spawn policy's restore hook returned no tool guard" };
	} catch (e) {
		return { reason: `the spawn policy's restore hook failed: ${errorText(e)}` };
	}
}

function makeApi(initial: ApiDeps, inherited: SpawnPolicyRegistration | undefined): InstalledApi {
	let deps = initial;
	let registration = inherited;
	return {
		version: 1,
		engineKey: initial.engineKey,
		registerSpawnPolicy(fn, opts = {}) {
			if (registration && (registration.owner === undefined || registration.owner !== opts.owner)) {
				const by = registration.owner === undefined ? "" : ` by '${registration.owner}'`;
				throw new Error(`a spawn policy is already registered${by}`);
			}
			const mine: SpawnPolicyRegistration = { ...opts, fn };
			registration = mine;
			return () => {
				if (registration === mine) registration = undefined;
			};
		},
		subscribe: (l) =>
			deps.engine.subscribe((e) => {
				if (e.type === "attach" || e.type === "spawn") {
					if (e.type === "spawn" && deps.engine.get(e.name)?.pending) return;
					l({ type: "spawn", name: e.name, by: e.by, parent: e.by, childSessionId: e.childSessionId, ts: e.ts });
				} else l(e);
			}),
		retune: (name, t) => deps.retune(name, t),
		async send(to, text, from) {
			if (!from?.trim()) throw new Error("api.send needs a sender name");
			const result = await deps.engine.route(from, to, text);
			if (result.outcome === "failed") throw new Error(result.reason);
		},
		list: () => deps.engine.list().map((rec) => agentInfo(rec, deps.engine.status(rec), (deps.now ?? Date.now)())),
		spawnPolicy: () => registration?.fn,
		spawnPolicyRegistration: () => registration,
		rebind(next) {
			deps = next;
		},
	};
}

/**
 * Install the API on `g` (globalThis by default): rebind the one already there when it was built
 * for the same engine version, else install a fresh one that keeps the registered policy.
 */
export function installApi(deps: ApiDeps, g: Record<string, unknown> = globalThis as Record<string, unknown>): InstalledApi {
	const existing = g[API_KEY] as Partial<InstalledApi> | undefined;
	if (existing?.rebind && existing.engineKey === deps.engineKey) {
		existing.rebind(deps);
		return existing as InstalledApi;
	}
	const api = makeApi(deps, existing?.spawnPolicyRegistration?.());
	g[API_KEY] = api;
	return api;
}
