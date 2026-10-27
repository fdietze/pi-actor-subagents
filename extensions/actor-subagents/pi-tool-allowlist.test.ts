import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { childToolOptions } from "./tool-guard.ts";

// Contract with the installed Pi: a spawn policy's tool allowlist and guard, handed to
// createAgentSession and the resource loader through childToolOptions exactly as index.ts
// createSession does. Pi's allowlist filters built-in and custom tools alike, so the orchestration
// tools must be added back; the guard (an inline extension factory) blocks a call through Pi's
// tool_call hook. Offline: the model is never called.
const model: Model<"openai-responses"> = {
	id: "test-model", name: "Test model", api: "openai-responses", provider: "openai",
	baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};

const tool = (name: string) =>
	defineTool({
		name, label: name, description: name, parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	});

test("installed Pi: a policy allowlist keeps exactly its tools plus the orchestration tools", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-allowlist-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({});
	const options = childToolOptions(
		{ tools: ["read"], toolGuard: (name) => (name === "read" ? "read is guarded" : undefined) },
		[tool("send_message"), tool("list_subagents")],
	);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager, noExtensions: true, extensionFactories: options.extensionFactories,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir, agentDir: dir, model, resourceLoader, ...options.session,
		sessionManager: SessionManager.inMemory(dir), settingsManager,
	});
	t.after(() => session.dispose());

	assert.deepEqual(session.getActiveToolNames().sort(), ["list_subagents", "read", "send_message"]);
	const runner = session.extensionRunner;
	assert.ok(runner, "the guard extension is loaded");
	const blocked = await runner.emitToolCall({ type: "tool_call", toolCallId: "c1", toolName: "read", input: { path: "x" } });
	assert.deepEqual(blocked, { block: true, reason: "read is guarded" });
	const allowed = await runner.emitToolCall({ type: "tool_call", toolCallId: "c2", toolName: "send_message", input: {} });
	assert.equal(allowed, undefined);
});
