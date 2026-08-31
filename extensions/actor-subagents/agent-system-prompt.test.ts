import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSystemPrompt } from "./agent-system-prompt.ts";

test("agentSystemPrompt names the agent and its spawner, and appends the spawn prompt last", () => {
	const out = agentSystemPrompt("critic", "SPAWN PROMPT BODY", "lead");
	assert.match(out, /^You are agent "critic" in a multi-agent system\./);
	assert.match(out, /You were spawned by "lead"\./);
	assert.ok(out.endsWith("SPAWN PROMPT BODY"));
});

test("agentSystemPrompt requires agent replies to use send_message", () => {
	const out = agentSystemPrompt("worker", "Be brief.", "main");

	// KISS: protect the communication contract without duplicating the complete prompt.
	assert.match(out, /The ONLY channel between agents is the send_message tool\./);
	assert.match(
		out,
		/reply using send_message \(a go-ahead plus any corrections\) to unblock its work\./,
	);
});
