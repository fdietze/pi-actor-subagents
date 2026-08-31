import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExplicitModelRef, resolveModelRef, unknownModelMessage } from "./resolve-model.ts";

const known = { provider: "anthropic", id: "opus" };
const foreground = { provider: "anthropic", id: "sonnet" };
const find = (provider: string, id: string) =>
	[known, foreground].find((m) => m.provider === provider && m.id === id);

test("an explicit ref resolves to exactly that model", () => {
	assert.deepEqual(resolveModelRef("anthropic/opus", find, foreground), {
		provider: "anthropic",
		id: "opus",
		model: known,
	});
});

test("an explicit ref that does not exist FAILS instead of falling back", () => {
	// The caller turns this into "unknown model '<ref>'; available: ..." — silently running
	// the foreground model would hide the typo and run something nobody asked for.
	assert.equal(resolveModelRef("bogus/model", find, foreground), undefined);
});

test("no ref inherits the foreground model", () => {
	assert.equal(resolveModelRef(undefined, find, foreground)?.id, "sonnet");
});

test("a non-'provider/id' placeholder inherits the foreground model", () => {
	// Restored roster entries store "(foreground)" for agents that inherited their model.
	assert.equal(resolveModelRef("(foreground)", find, foreground)?.id, "sonnet");
});

test("without a foreground model there is nothing to inherit", () => {
	assert.equal(resolveModelRef(undefined, find, undefined), undefined);
});

test("the strict lookup never falls back to the foreground", () => {
	assert.equal(resolveExplicitModelRef("anthropic/opus", find)?.id, "opus");
	assert.equal(resolveExplicitModelRef("opus", find), undefined); // no provider -> no guess
	assert.equal(resolveExplicitModelRef("bogus/model", find), undefined);
});

test("the rejection message lists what the caller could have used", () => {
	assert.equal(
		unknownModelMessage("bogus/model", ["anthropic/opus"]),
		"unknown model 'bogus/model'; available: anthropic/opus",
	);
	assert.equal(unknownModelMessage(undefined, []), "unknown model '(none)'");
});
