import { test } from "node:test";
import assert from "node:assert/strict";
import { AbortTracker } from "./abort-tracker.ts";

/** An abort that settles only when the test says so. */
function gate() {
	let open: () => void = () => {};
	let fail: (error: Error) => void = () => {};
	const abort = () =>
		new Promise<void>((resolve, reject) => {
			open = resolve;
			fail = reject;
		});
	return { abort, open: () => open(), fail: (error: Error) => fail(error) };
}

test("an abort is pending until it settles, and only for the selected agents", async () => {
	const tracker = new AbortTracker();
	const a = gate();
	const b = gate();
	tracker.track("a", a.abort, () => {});
	tracker.track("b", b.abort, () => {});
	assert.equal(tracker.pending((name) => name === "a").length, 1);
	a.open();
	await Promise.all(tracker.pending((name) => name === "a"));
	assert.equal(tracker.pending((name) => name === "a").length, 0);
	assert.equal(tracker.pending(() => true).length, 1, "b is still in flight");
});

test("a failing abort goes to onError and still settles", async () => {
	const tracker = new AbortTracker();
	const a = gate();
	const errors: unknown[] = [];
	tracker.track("a", a.abort, (error) => errors.push(error));
	const boom = new Error("boom");
	a.fail(boom);
	await Promise.all(tracker.pending(() => true));
	assert.deepEqual(errors, [boom]);
	assert.equal(tracker.pending(() => true).length, 0);
});

test("every abort of an agent stays pending until it settles, in any order", async () => {
	const tracker = new AbortTracker();
	const first = gate();
	const second = gate();
	tracker.track("a", first.abort, () => {});
	tracker.track("a", second.abort, () => {});
	assert.equal(tracker.pending(() => true).length, 2);
	second.open(); // the newer one settles first
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(tracker.pending(() => true).length, 1, "the older abort can still land");
	first.open();
	await Promise.all(tracker.pending(() => true));
	assert.equal(tracker.pending(() => true).length, 0);
});
