/**
 * Mouse reports for the agents panel, decoded exactly like pi's own TUI decodes them.
 *
 * Why the panel decodes at all: in fullscreen mode pi normally routes the wheel itself, but it
 * deliberately steps aside for a FOCUSED overlay — `handleViewportInput` returns without
 * consuming when `shouldDeferViewportInputToOverlay()` holds, i.e. "you took focus, you own the
 * mouse". The panel is such an overlay (that is also the only way it gets wheel bytes at all),
 * so the decoding has to happen here.
 *
 * `parseWheelEvent` is a verbatim port of the private
 * `TuiAltScreen.parseWheelEvent` in @earendil-works/pi-tui (dist/tui-alt-screen.js, pi 0.84.2),
 * so panel scrolling reacts to exactly the same bytes as the main chat. It is copied rather
 * than called because the method is private and pi-tui exports no mouse helper; keep it in sync
 * when pi changes.
 *
 * Chunking is not a concern here: pi-tui's StdinBuffer emits one COMPLETE escape sequence per
 * input event (its own docstring uses an SGR mouse report as the example), which is why pi's
 * anchored patterns — and these — always see a single report.
 */

/** Wheel notch: direction -1 = up, 1 = down; x/y are 0-based cell coordinates. */
export interface WheelEvent {
	direction: -1 | 1;
	x: number;
	y: number;
}

const SGR = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/;

/** Port of TuiAltScreen.parseWheelEvent (SGR 1006 and the legacy X10 encoding). */
export function parseWheelEvent(data: string): WheelEvent | undefined {
	const sgr = SGR.exec(data);
	if (sgr) {
		const button = Number.parseInt(sgr[1] as string, 10);
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return {
			direction: direction === 0 ? -1 : 1,
			x: Number.parseInt(sgr[2] as string, 10) - 1,
			y: Number.parseInt(sgr[3] as string, 10) - 1,
		};
	}
	if (data.length === 6 && data.startsWith("\x1b[M")) {
		const button = data.charCodeAt(3) - 32;
		if ((button & 64) === 0) return undefined;
		const direction = button & 3;
		if (direction !== 0 && direction !== 1) return undefined;
		return {
			direction: direction === 0 ? -1 : 1,
			x: data.charCodeAt(4) - 33,
			y: data.charCodeAt(5) - 33,
		};
	}
	return undefined;
}

/**
 * Any mouse report, wheel or not (press, drag, motion, release).
 * The panel swallows all of them: pi hands a focused overlay the whole mouse stream, and a
 * report that reached the chatbox would be typed into it as a raw escape sequence.
 * Same two encodings pi accepts (SGR 1006 press/release, legacy X10 six-byte form).
 */
export function isMouseReport(data: string): boolean {
	return SGR.test(data) || (data.length === 6 && data.startsWith("\x1b[M"));
}
