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
	assert.match(out, /active replies use send_message/);
	assert.match(
		out,
		/reply using send_message \(a go-ahead plus any corrections\) to unblock its work\./,
	);
});

test("preamble distinguishes readable prose, human turns and batched replies from active delivery", () => {
	const out = agentSystemPrompt("worker", "Be brief.", "main");
	assert.match(out, /Ordinary assistant text is not routed/);
	assert.match(out, /human can see it in the panel/);
	assert.match(out, /human panel input is a real user turn/);
	assert.match(out, /Replies can be batched/);
	assert.match(out, /not receipt, reading or completion/);
	assert.match(out, /END YOUR TURN/);
	assert.doesNotMatch(out, /once per reply|ONLY channel|never receive your|answers anyway|nearly free|probably have not looked hard enough/);
});

test("without a spawn policy the spawn hint is unchanged; with one, model and effort are left to it", () => {
	const plain = agentSystemPrompt("worker", "Be brief.", "main");
	assert.match(plain, /omit model\/thinkingLevel to inherit yours\./);
	assert.doesNotMatch(plain, /spawn policy/);
	const routed = agentSystemPrompt("worker", "Be brief.", "main", true);
	assert.match(routed, /omit model\/thinkingLevel to let the spawn policy decide \(inherit if none\)/);
	assert.doesNotMatch(routed, /inherit yours/);
	assert.equal(routed.replace("let the spawn policy decide (inherit if none)", "inherit yours"), plain);
});
