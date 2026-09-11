import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, type AgentHandle } from "./engine.ts";
import { makeAgentTools } from "./agent-tools.ts";

const handle = (): AgentHandle => ({ deliver: async () => {}, abort: async () => {} });

const record = (name: string) => ({
	name,
	model: "test/m",
	handle: handle(),
	spawnedBy: "main",
	depth: name === "main" ? 0 : 1,
	createdAt: 0,
	turns: 0,
	lastActivity: 0,
});

/** The send_message tool acting as `self`, with the surrounding shell stubbed out. */
function sendMessageTool(engine: Engine, self: string) {
	const tools = makeAgentTools(self, {
		engine,
		spawnAgent: async () => ({ ok: true, msg: "" }),
		setAgentModel: async () => ({ ok: true, msg: "" }),
		persistRoster: () => {},
		updateStatus: () => {},
		getHideThinking: async () => false,
	});
	const tool = tools.find((t) => t.name === "send_message");
	assert.ok(tool, "send_message tool must exist");
	return tool;
}

/** Fails loudly instead of hanging when a call that must not block does block. */
async function withoutWaiting<T>(what: string, work: Promise<T>): Promise<T> {
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	const guard = new Promise<never>((_, reject) => {
		watchdog = setTimeout(() => reject(new Error(`${what} waited instead of returning`)), 2000);
	});
	try {
		return await Promise.race([work, guard]);
	} finally {
		if (watchdog) clearTimeout(watchdog);
	}
}

test("send_message reports every target's message fate next to the receiver's state", async () => {
	const engine = new Engine({ maxAgents: 8, maxSpawnDepth: 3 });
	engine.addAgent(record("main"));
	engine.addAgent(record("worker"));
	engine.addAgent(record("resting"));
	engine.setActivity("worker", "thinking"); // mid-turn: alive, observed without waiting
	engine.pause(["resting"]);
	const tool = sendMessageTool(engine, "critic");

	// None of these targets can be waited on: two are demonstrably alive or unreachable, and
	// 'main' emits no turn events at all. The watchdog is what proves the tool did not block.
	const result = await withoutWaiting(
		"send_message",
		// The trailing SDK arguments (signal, onUpdate, extension context) are unused by this tool.
		tool.execute("call-1", { to: ["worker", "main", "resting", "ghost"], content: "status?" }, undefined, undefined, undefined as never),
	);

	assert.equal(
		(result.content[0] as { text?: string } | undefined)?.text,
		"sent to worker (thinking), main (idle) · buffered for resting (paused) · failed: ghost: unknown agent 'ghost'",
	);
});
