import assert from "node:assert/strict";
import { test } from "node:test";
import {
	describeExtensionStatuses,
	EXTENSION_STATUS_MAX,
	formatExtensionStatuses,
	sanitizeStatusText,
	withExtensionStatus,
} from "./extension-status.ts";

test("sanitizeStatusText strips ANSI and OSC escapes and folds control characters", () => {
	assert.equal(sanitizeStatusText("\x1b[33m⏳2\x1b[39m"), "⏳2");
	assert.equal(sanitizeStatusText("\x1b]8;;https://x\x07link\x1b]8;;\x1b\\"), "link");
	assert.equal(sanitizeStatusText("  a\r\n\tb  \x07 c "), "a b c");
});

test("sanitizeStatusText caps by code points without splitting an astral glyph", () => {
	const long = "🔥".repeat(EXTENSION_STATUS_MAX + 5);
	const out = sanitizeStatusText(long);
	assert.equal(Array.from(out).length, EXTENSION_STATUS_MAX);
	assert.ok(out.endsWith("🔥…"));
});

test("withExtensionStatus sets, replaces and clears, keeping identity when nothing changed", () => {
	const a = withExtensionStatus({}, "jobs", "⏳");
	assert.deepEqual(a, { jobs: "⏳" });
	assert.equal(withExtensionStatus(a, "jobs", "\x1b[1m⏳\x1b[0m"), a, "same plain text is no change");
	const b = withExtensionStatus(a, "jobs", "⏳2");
	assert.deepEqual(b, { jobs: "⏳2" });
	assert.deepEqual(a, { jobs: "⏳" }, "the previous snapshot is not mutated");
	assert.deepEqual(withExtensionStatus(b, "jobs", undefined), {});
	assert.deepEqual(withExtensionStatus(b, "jobs", " \n "), {}, "blank text clears");
	const empty = {};
	assert.equal(withExtensionStatus(empty, "jobs", undefined), empty, "clearing a missing key is no change");
});

test("withExtensionStatus ignores malformed input from untyped extensions", () => {
	const s = { a: "x" };
	assert.equal(withExtensionStatus(s, 42, "y"), s);
	assert.equal(withExtensionStatus(s, "\x1b[0m", "y"), s, "a key that sanitizes to nothing is ignored");
	assert.deepEqual(withExtensionStatus(s, "a", 7), {}, "a non-string text clears");
	assert.deepEqual(withExtensionStatus(s, "b\nc", "y"), { a: "x", "b c": "y" });
});

test("formatting sorts by key: plain values for the roster, key: value for the LLM", () => {
	const s = withExtensionStatus(withExtensionStatus({}, "zeta", "z"), "bash-async", "⏳2");
	assert.equal(formatExtensionStatuses(s), "⏳2 z");
	assert.equal(describeExtensionStatuses(s), "bash-async: ⏳2, zeta: z");
	assert.equal(formatExtensionStatuses(undefined), "");
	assert.equal(describeExtensionStatuses({}), "");
});

test("withExtensionStatus ignores keys outside allowedKeys", () => {
	const allowed = ["bash-async"];
	const s = withExtensionStatus({}, "bash-async", "⏳1", allowed);
	assert.deepEqual(s, { "bash-async": "⏳1" });
	assert.equal(withExtensionStatus(s, "mcp", "MCP 0/4", allowed), s);
	const empty = {};
	assert.equal(withExtensionStatus(empty, "bash-async", "⏳1", []), empty, "an empty list shows nothing");
	assert.deepEqual(withExtensionStatus(s, "bash-async", undefined, allowed), {});
});

test("with allowedKeys, entries keep the allowlist's order", () => {
	const allowed = ["zeta", "bash-async"];
	const s = withExtensionStatus(withExtensionStatus({}, "bash-async", "⏳2", allowed), "zeta", "z", allowed);
	assert.equal(formatExtensionStatuses(s), "z ⏳2");
	assert.equal(describeExtensionStatuses(withExtensionStatus(s, "bash-async", "⏳3", allowed)), "zeta: z, bash-async: ⏳3");
});
