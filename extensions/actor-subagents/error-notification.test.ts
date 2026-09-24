import assert from "node:assert/strict";
import { test } from "node:test";
import { errorNotification } from "./error-notification.ts";

const live = (...names: string[]) => new Set(names);

test("an errored child notifies its direct parent, naming the agent and the reason", () => {
	const n = errorNotification(
		{ name: "worker", reason: "boom" },
		{ worker: "lead", lead: "main" },
		live("main", "lead", "worker"),
	);
	assert.equal(n?.to, "lead");
	assert.match(n?.content ?? "", /`worker`/);
	assert.match(n?.content ?? "", /boom/);
});

test("'main' is notified like any other parent", () => {
	const n = errorNotification({ name: "worker", reason: "boom" }, { worker: "main" }, live("main", "worker"));
	assert.equal(n?.to, "main");
});

test("the root of the spawn tree has no parent to notify", () => {
	// 'main' errors: nobody above it, so the event is only a feed entry.
	assert.equal(errorNotification({ name: "main", reason: "boom" }, { worker: "main" }, live("main")), undefined);
});

test("a killed agent does not notify, and nobody notifies a killed parent", () => {
	// Both halves of a subtree kill: the records are gone by the time the errors land.
	const tree = { worker: "lead", lead: "main" };
	assert.equal(errorNotification({ name: "worker", reason: "gone" }, tree, live("main", "lead")), undefined);
	assert.equal(errorNotification({ name: "worker", reason: "gone" }, tree, live("main", "worker")), undefined);
});

test("a reason that ends in a period is not given a second one", () => {
	const n = errorNotification({ name: "worker", reason: "The operation was aborted." }, { worker: "main" }, live("main", "worker"));
	assert.doesNotMatch(n?.content ?? "", /\.\./);
	assert.match(n?.content ?? "", /The operation was aborted\. It will not/);
});
