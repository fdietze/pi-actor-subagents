import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { agentSystemPrompt } from "./agent-system-prompt.ts";
import { childPromptOptions } from "./child-prompt.ts";

// Contract with the installed Pi: a child's loader options (child-prompt.ts, used in index.ts
// createSession) keep Pi's own system prompt, including the promptGuidelines of a granted
// extension's tool and a discovered APPEND_SYSTEM.md, and add the agent preamble after them.
// Offline: the model is never called.
const model: Model<"openai-responses"> = {
	id: "test-model", name: "Test model", api: "openai-responses", provider: "openai",
	baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000,
};

test("installed Pi: a child keeps Pi's prompt and extension guidelines, preamble appended", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-child-prompt-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	writeFileSync(join(dir, "APPEND_SYSTEM.md"), "FROM APPEND_SYSTEM.md");
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
		extensionFactories: [{
			name: "guideline-probe",
			factory: (pi) => {
				pi.registerTool({
					name: "probe",
					label: "Probe",
					description: "Probe tool",
					promptGuidelines: ["Use probe before guessing."],
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
		}],
		...childPromptOptions("worker", "Be brief.", "lead", "append"),
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir, agentDir: dir, model, resourceLoader,
		sessionManager: SessionManager.inMemory(dir), settingsManager,
	});
	t.after(() => session.dispose());

	const prompt = session.systemPrompt;
	const preamble = agentSystemPrompt("worker", "Be brief.", "lead");
	assert.ok(prompt.includes("Use probe before guessing."), "extension promptGuidelines survive");
	assert.ok(prompt.includes("Be concise in your responses"), "Pi's own rules survive");
	assert.ok(prompt.includes(preamble), "agent preamble is present verbatim");
	const append = prompt.indexOf("FROM APPEND_SYSTEM.md");
	assert.ok(append >= 0 && append < prompt.indexOf(preamble), "discovered append prompt comes first");
});

test("installed Pi: replace mode gives the child only the agent preamble, as on main", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-child-prompt-replace-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({});
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
		extensionFactories: [{
			name: "guideline-probe",
			factory: (pi) => {
				pi.registerTool({
					name: "probe",
					label: "Probe",
					description: "Probe tool",
					promptGuidelines: ["Use probe before guessing."],
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				});
			},
		}],
		...childPromptOptions("worker", "Be brief.", "lead", "replace"),
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir, agentDir: dir, model, resourceLoader,
		sessionManager: SessionManager.inMemory(dir), settingsManager,
	});
	t.after(() => session.dispose());

	// Pi still appends its skills section after the override, as on main; the rest is dropped.
	const prompt = session.systemPrompt;
	assert.ok(prompt.startsWith(agentSystemPrompt("worker", "Be brief.", "lead")), "the preamble is the prompt");
	assert.ok(!prompt.includes("Use probe before guessing."), "extension promptGuidelines are dropped");
	assert.ok(!prompt.includes("Be concise in your responses"), "Pi's own rules are dropped");
});
