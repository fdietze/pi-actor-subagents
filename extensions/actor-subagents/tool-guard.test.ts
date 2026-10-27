import { test } from "node:test";
import assert from "node:assert/strict";
import { childToolAllowlist, childToolOptions, toolGuardExtensions } from "./tool-guard.ts";

/** Loads the inline extensions into a stand-in pi and returns the tool_call handlers they registered. */
function load(entries: ReturnType<typeof toolGuardExtensions>) {
	const handlers: ((event: { toolName: string; input: unknown }) => unknown)[] = [];
	const pi = { on: (event: string, h: (typeof handlers)[number]) => void (event === "tool_call" && handlers.push(h)) };
	for (const e of entries) e.factory(pi as never);
	return handlers;
}

test("a guard reason blocks the tool call with that reason", () => {
	const seen: unknown[] = [];
	const [handler] = load(
		toolGuardExtensions((name, input) => {
			seen.push([name, input]);
			return name === "write" ? "scouts are read-only" : undefined;
		}),
	);
	assert.deepEqual(handler?.({ toolName: "write", input: { path: "x" } }), { block: true, reason: "scouts are read-only" });
	assert.deepEqual(seen, [["write", { path: "x" }]]);
});

test("a guard that returns undefined lets the call through", () => {
	const [handler] = load(toolGuardExtensions(() => undefined));
	assert.equal(handler?.({ toolName: "read", input: {} }), undefined);
});

test("no guard registers no handler", () => {
	assert.deepEqual(toolGuardExtensions(undefined), []);
	assert.equal(load(toolGuardExtensions(undefined)).length, 0);
});

test("a policy allowlist of ['read'] still leaves the child its orchestration tools", () => {
	const orchestration = [{ name: "spawn_subagent" }, { name: "send_message" }, { name: "list_subagents" }];
	const tools = childToolAllowlist(["read"], orchestration);
	assert.deepEqual(tools, ["read", "spawn_subagent", "send_message", "list_subagents"]);
	assert.ok(tools?.includes("send_message"));
	assert.equal(childToolAllowlist(undefined, orchestration), undefined);
});

test("childToolOptions: no restriction passes only the orchestration tools and loads no guard", () => {
	const orchestration = [{ name: "send_message" }];
	assert.deepEqual(childToolOptions({}, orchestration), { session: { customTools: orchestration }, extensionFactories: [] });
	const guarded = childToolOptions({ tools: ["read"], toolGuard: () => "no" }, orchestration);
	assert.deepEqual(guarded.session, { customTools: orchestration, tools: ["read", "send_message"] });
	assert.equal(guarded.extensionFactories.length, 1);
});
