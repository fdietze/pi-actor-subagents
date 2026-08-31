import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type RawMessage,
	TranscriptDocument,
	type TranscriptComponentFactory,
} from "./transcript-document.ts";

/** Test doubles that record how often they were BUILT — the point of the document is reuse. */
function recordingFactory() {
	const built: string[] = [];
	const updates: string[] = [];
	const factory: TranscriptComponentFactory = {
		system: (prompt) => {
			built.push(`system:${prompt}`);
			return { render: () => [`system:${prompt}`] };
		},
		user: (text) => {
			built.push(`user:${text}`);
			return { render: () => [`user:${text}`] };
		},
		custom: (message) => {
			const text = typeof message.content === "string" ? message.content : "";
			built.push(`custom:${message.customType}:${text}`);
			return { render: () => [`custom:${message.customType}:${text}`] };
		},
		assistant: (message, isStreaming) => {
			built.push(`assistant:${isStreaming ? "streaming" : "final"}`);
			let label = "assistant";
			return {
				render: () => [label],
				updateContent: (m: never, streaming?: boolean) => {
					label = `assistant:${(m as RawMessage & { tag?: string }).tag ?? ""}:${streaming ? "streaming" : "final"}`;
					updates.push(label);
				},
			};
		},
		tool: (call) => {
			built.push(`tool:${call.name}`);
			let label = `tool:${call.name}`;
			return {
				render: () => [label],
				updateResult: () => {
					label = `tool:${call.name}:done`;
					updates.push(label);
				},
				setExpanded: (expanded: boolean) => updates.push(`expand:${call.name}:${expanded}`),
			};
		},
	};
	return { factory, built, updates };
}

const assistantWithCall = (tag: string): RawMessage => ({
	role: "assistant",
	tag,
	content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }],
} as RawMessage);

test("components are built once and reused across syncs", () => {
	const { factory, built } = recordingFactory();
	const doc = new TranscriptDocument(factory);
	const messages: RawMessage[] = [{ role: "user", content: "hi" }];
	doc.sync({ systemPrompt: "be nice", messages });
	doc.sync({ systemPrompt: "be nice", messages });
	doc.sync({ systemPrompt: "be nice", messages });
	assert.deepEqual(built, ["system:be nice", "user:hi"]); // three syncs, one construction each
	assert.deepEqual(doc.render(80), ["system:be nice", "user:hi"]);
});

test("a custom agent message is distinct from a human user message", () => {
	const { factory, built } = recordingFactory();
	const doc = new TranscriptDocument(factory);
	doc.sync({
		messages: [
			{ role: "user", content: "human" },
			{ role: "custom", customType: "agent-message", content: "peer", display: true },
		],
	});

	assert.deepEqual(built, ["user:human", "custom:agent-message:peer"]);
	assert.deepEqual(doc.render(80), ["user:human", "custom:agent-message:peer"]);
});

test("a tool result attaches to the call component instead of adding a line", () => {
	const { factory } = recordingFactory();
	const doc = new TranscriptDocument(factory);
	const messages: RawMessage[] = [assistantWithCall("a")];
	doc.sync({ messages });
	assert.deepEqual(doc.render(80), ["assistant:a:final", "tool:bash"]);
	messages.push({ role: "toolResult", toolCallId: "c1", content: "ok" });
	doc.sync({ messages });
	assert.deepEqual(doc.render(80), ["assistant:a:final", "tool:bash:done"]);
});

test("the streaming message renders live and is adopted when it finalizes", () => {
	const { factory, built } = recordingFactory();
	const doc = new TranscriptDocument(factory);
	const streaming: RawMessage = { role: "assistant", tag: "s", content: [] } as RawMessage;
	const messages: RawMessage[] = [];
	doc.sync({ messages, streamingMessage: streaming });
	assert.deepEqual(doc.render(80), ["assistant:s:streaming"]);
	// Faithful to pi: the committed message is a DISTINCT object (a copy is streamed, the raw final
	// is committed) and the streaming message is cleared at message_end. Adoption must reuse the live
	// component by POSITION, not identity — so no second component is built and there is no re-parse.
	const final: RawMessage = { role: "assistant", tag: "s", content: [] } as RawMessage;
	messages.push(final);
	doc.sync({ messages, streamingMessage: undefined });
	assert.deepEqual(built, ["assistant:streaming"]);
	assert.deepEqual(doc.render(80), ["assistant:s:final"]);
});

test("a streamed tool call keeps its component when the message finalizes", () => {
	const { factory, built } = recordingFactory();
	const doc = new TranscriptDocument(factory);
	const streaming = assistantWithCall("t");
	const messages: RawMessage[] = [];
	doc.sync({ messages, streamingMessage: streaming });
	assert.deepEqual(doc.render(80), ["assistant:t:streaming", "tool:bash"]);
	// Distinct committed object (pi streams a copy, commits the raw final); the tool component must
	// carry over from the streaming block by position, so it is built exactly once.
	messages.push(assistantWithCall("t"));
	doc.sync({ messages, streamingMessage: undefined });
	assert.deepEqual(built.filter((b) => b.startsWith("tool:")), ["tool:bash"]); // built once
	assert.deepEqual(doc.render(80), ["assistant:t:final", "tool:bash"]);
});

test("a second streaming message builds a fresh block after the first finalizes (split on the gap)", () => {
	// No object identity separates one assistant message from the next: the streaming message going
	// undefined at message_end ends a block, and the next one opens a fresh component. This is what
	// lets adoption be positional — a committed message can only adopt the block that is still open.
	const { factory, built } = recordingFactory();
	const doc = new TranscriptDocument(factory);
	const messages: RawMessage[] = [];
	doc.sync({ messages, streamingMessage: { role: "assistant", tag: "a", content: [] } as RawMessage });
	messages.push({ role: "assistant", tag: "a", content: [] } as RawMessage); // distinct final object
	doc.sync({ messages, streamingMessage: undefined }); // message_end: block a closes, adopted
	doc.sync({ messages, streamingMessage: { role: "assistant", tag: "b", content: [] } as RawMessage });
	assert.deepEqual(built, ["assistant:streaming", "assistant:streaming"]); // one per block, a adopted
	assert.deepEqual(doc.render(80), ["assistant:a:final", "assistant:b:streaming"]);
});

test("a replaced (shorter) transcript is rebuilt from scratch", () => {
	const { factory, built } = recordingFactory();
	const doc = new TranscriptDocument(factory);
	doc.sync({ messages: [{ role: "user", content: "one" }, { role: "user", content: "two" }] });
	doc.sync({ messages: [{ role: "user", content: "fresh" }] });
	assert.deepEqual(built, ["user:one", "user:two", "user:fresh"]);
	assert.deepEqual(doc.render(80), ["user:fresh"]);
});

test("tool expansion reaches components built before and after the toggle", () => {
	const { factory, updates } = recordingFactory();
	const doc = new TranscriptDocument(factory);
	const messages: RawMessage[] = [assistantWithCall("a")];
	doc.sync({ messages });
	doc.setToolsExpanded(true);
	messages.push({ role: "user", content: "next" }, assistantWithCall("b"));
	doc.sync({ messages });
	assert.ok(updates.includes("expand:bash:true"));
	// The later call is created already expanded, not left at the default.
	assert.equal(updates.filter((u) => u === "expand:bash:true").length >= 2, true);
});

test("a component that throws degrades to a marker instead of taking the panel down", () => {
	const { factory } = recordingFactory();
	const doc = new TranscriptDocument({
		...factory,
		user: () => ({
			render: () => {
				throw new Error("boom");
			},
		}),
	});
	doc.sync({ messages: [{ role: "user", content: "hi" }] });
	assert.deepEqual(doc.render(80), ["  (unrenderable message)"]);
});

test("an unchanged transcript is not re-assembled (what makes scrolling cheap)", () => {
	let renders = 0;
	const doc = new TranscriptDocument({
		system: (prompt) => ({ render: () => [`system:${prompt}`] }),
		user: (text) => ({
			render: () => {
				renders++;
				return [`user:${text}`];
			},
		}),
		custom: () => ({ render: () => ["custom"] }),
		assistant: () => ({ render: () => ["assistant"], updateContent: () => {} }),
		tool: () => ({ render: () => ["tool"], updateResult: () => {}, setExpanded: () => {} }),
	});
	const messages: RawMessage[] = [{ role: "user", content: "hi" }];
	doc.sync({ messages });
	doc.render(80);
	doc.render(80);
	doc.render(80);
	assert.equal(renders, 1); // scrolling re-renders the panel, not the transcript

	doc.render(100); // a resize is a different layout, so it is assembled again
	assert.equal(renders, 2);

	messages.push({ role: "user", content: "more" }); // new content invalidates it
	doc.sync({ messages });
	doc.render(100);
	assert.equal(renders, 4); // both user components re-rendered (their own caches still apply)
});
