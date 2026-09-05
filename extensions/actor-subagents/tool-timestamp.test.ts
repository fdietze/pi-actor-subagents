import { test } from "node:test";
import assert from "node:assert/strict";
import { timestampToolResult } from "./tool-timestamp.ts";

// Build an absolute epoch ms for a given local wall-clock time, so the assertions hold
// regardless of the machine timezone (the formatter reads back via local getters).
// The date is fixed and far from any DST transition: on a spring-forward day some local
// times do not exist and would silently shift to another hour.
function at(h: number, m: number, s: number): number {
  return new Date(2024, 0, 15, h, m, s).getTime();
}

test("timestampToolResult: appends the start and finish times as one trailing text part", () => {
  assert.deepEqual(
    timestampToolResult([{ type: "text", text: "ok" }], at(14, 32, 0), at(14, 32, 7)),
    [
      { type: "text", text: "ok" },
      { type: "text", text: "[started 14:32:00 · finished 14:32:07]" },
    ],
  );
});

test("timestampToolResult: degrades to finish only when the start is unknown", () => {
  assert.deepEqual(
    timestampToolResult([{ type: "text", text: "ok" }], undefined, at(14, 32, 7)),
    [
      { type: "text", text: "ok" },
      { type: "text", text: "[finished 14:32:07]" },
    ],
  );
});

test("timestampToolResult: zero-pads hours, minutes and seconds", () => {
  assert.deepEqual(timestampToolResult([], at(9, 5, 1), at(9, 5, 3)), [
    { type: "text", text: "[started 09:05:01 · finished 09:05:03]" },
  ]);
});

test("timestampToolResult: stamps empty content too", () => {
  assert.equal(timestampToolResult(undefined, at(0, 0, 0), at(0, 0, 0)).length, 1);
});

test("timestampToolResult: passes non-text parts through untouched", () => {
  const image = { type: "image" as const, data: "…", mimeType: "image/png" };
  const stamped = timestampToolResult([image], at(1, 2, 3), at(1, 2, 4));
  assert.equal(stamped.length, 2);
  assert.equal(stamped[0], image); // same reference: no copying, no mutation
});

test("timestampToolResult: does not mutate the input array", () => {
  const content = [{ type: "text", text: "ok" }];
  timestampToolResult(content, at(1, 2, 3), at(1, 2, 4));
  assert.equal(content.length, 1);
});
