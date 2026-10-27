import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSystemPrompt } from "./agent-system-prompt.ts";
import { childPromptOptions } from "./child-prompt.ts";

test("childPromptOptions in append mode never replaces pi's system prompt", () => {
	// A systemPromptOverride makes pi drop its default tools and rules sections, and the rules
	// are where extensions' promptGuidelines land (e.g. infinite-context's fold guidance).
	const options = childPromptOptions("worker", "Be brief.", "main", "append");
	assert.deepEqual(Object.keys(options), ["appendSystemPromptOverride"]);
});

test("childPromptOptions in replace mode is the main-branch systemPromptOverride", () => {
	const options = childPromptOptions("worker", "Be brief.", "lead", "replace");
	assert.deepEqual(Object.keys(options), ["systemPromptOverride"]);
	assert.equal(options.systemPromptOverride?.(), agentSystemPrompt("worker", "Be brief.", "lead"));
});

test("childPromptOptions defaults to replace when no mode is given", () => {
	const options = childPromptOptions("worker", "Be brief.", "lead");
	assert.deepEqual(Object.keys(options), ["systemPromptOverride"]);
});

test("childPromptOptions in append mode keeps discovered append prompts and adds the agent preamble last", () => {
	const { appendSystemPromptOverride } = childPromptOptions("worker", "Be brief.", "lead", "append");
	assert.ok(appendSystemPromptOverride);
	assert.deepEqual(appendSystemPromptOverride(["FROM APPEND_SYSTEM.md"]), [
		"FROM APPEND_SYSTEM.md",
		agentSystemPrompt("worker", "Be brief.", "lead"),
	]);
	assert.deepEqual(appendSystemPromptOverride([]), [
		agentSystemPrompt("worker", "Be brief.", "lead"),
	]);
});
