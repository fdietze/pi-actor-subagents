import assert from "node:assert/strict";
import { test } from "node:test";
import { isMouseReport, parseWheelEvent } from "./mouse-input.ts";

test("SGR wheel reports decode to direction plus 0-based coordinates", () => {
	// Button 64 = wheel up, 65 = wheel down (bytes captured from a live pi session).
	assert.deepEqual(parseWheelEvent("\x1b[<64;50;15M"), { direction: -1, x: 49, y: 14 });
	assert.deepEqual(parseWheelEvent("\x1b[<65;50;15M"), { direction: 1, x: 49, y: 14 });
});

test("non-wheel buttons and horizontal wheels are not wheel events", () => {
	assert.equal(parseWheelEvent("\x1b[<0;10;5M"), undefined); // press
	assert.equal(parseWheelEvent("\x1b[<0;10;5m"), undefined); // release
	assert.equal(parseWheelEvent("\x1b[<32;10;5M"), undefined); // drag
	assert.equal(parseWheelEvent("\x1b[<66;10;5M"), undefined); // horizontal wheel: pi ignores it
});

test("the legacy X10 encoding decodes the same way", () => {
	const x10 = (button: number, x: number, y: number) =>
		`\x1b[M${String.fromCharCode(button + 32)}${String.fromCharCode(x + 33)}${String.fromCharCode(y + 33)}`;
	assert.deepEqual(parseWheelEvent(x10(64, 3, 7)), { direction: -1, x: 3, y: 7 });
	assert.deepEqual(parseWheelEvent(x10(65, 3, 7)), { direction: 1, x: 3, y: 7 });
	assert.equal(parseWheelEvent(x10(0, 3, 7)), undefined);
});

test("keyboard input is neither a wheel event nor a mouse report", () => {
	for (const key of ["x", "\x1b", "\x1b[A", "\x1b[<64;50;15"]) {
		assert.equal(parseWheelEvent(key), undefined);
		assert.equal(isMouseReport(key), false);
	}
});

test("every mouse report is recognised, so the panel can swallow it", () => {
	assert.equal(isMouseReport("\x1b[<64;50;15M"), true); // wheel
	assert.equal(isMouseReport("\x1b[<0;10;5M"), true); // press
	assert.equal(isMouseReport("\x1b[<0;10;5m"), true); // release
	assert.equal(isMouseReport("\x1b[<35;10;5M"), true); // motion
	assert.equal(isMouseReport("\x1b[M\x20\x21\x21"), true); // X10
});
