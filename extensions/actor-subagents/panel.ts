/**
 * SubagentsPanel — a focused full-width overlay anchored to the BOTTOM of the chat (its familiar,
 * unsurprising home; a top anchor made the roster jump above the conversation and was disorienting).
 * The older chat above the panel stays visible; an overlay never reflows the chat, so the panel
 * covers the tail while it is open.
 * Pattern mirrored from question.ts: the factory returns { render, handleInput, invalidate },
 * editor via new Editor(tui, theme), refresh via tui.requestRender().
 * Overlay, not a dock takeover, for one measured reason: in pi's fullscreen mode only a focused
 * overlay receives raw mouse reports in handleInput — a dock component gets keyboard bytes but
 * never wheel bytes, which the TUI routes to the chat transcript behind the panel instead
 * (see mouse-input.ts). The overlay also knows the terminal height, so the transcript is sized
 * from it rather than fixed. A wheel notch above the panel is treated as a chat gesture and
 * swallowed (the panel cannot scroll the main chat's viewport while it holds focus).
 * Transcript: the real chat components (User/Assistant/ToolExecution), kept alive per agent in a
 * TranscriptDocument so pi's own line caches apply, and scrolled by pi's ScrollView so wheel,
 * page and half-page movement behave exactly like the main chat.
 */
import { Editor, type EditorTheme, Key, matchesKey, ScrollView, truncateToWidth } from "@earendil-works/pi-tui";
import { isMouseReport, parseWheelEvent } from "./mouse-input.ts";
import { nextInCycle } from "./next-in-cycle.ts";
import { THINKING_LEVELS } from "./thinking-level.ts";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { AGENT_MESSAGE_CUSTOM_TYPE } from "./agent-message.ts";
import { renderAgentMessage } from "./agent-message-renderer.ts";
import { orderAgents } from "./agent-order.ts";
import { agentStatus } from "./agent-status.ts";
import type { Engine } from "./engine.ts";
import {
	formatContext,
	formatRoster,
	rosterDepth,
	formatSendTargets,
	type StatusTone,
	moveSelection,
	panelRows,
	swarmStateLine,
	transcriptViewport,
} from "./panel-logic.ts";
import {
	type AssistantComponent,
	type RawMessage,
	type ToolComponent,
	TranscriptDocument,
} from "./transcript-document.ts";

interface PanelDeps {
	engine: Engine;
	cwd: string;
	/** Hide assistant thinking blocks, aligned with the main UI's hideThinkingBlock setting. */
	hideThinking: boolean;
	/** Initial tool-output expansion, seeded from the main UI (ctx.ui.getToolsExpanded). */
	toolsExpanded: boolean;
	/** Push a toolsExpanded toggle back to the main UI so both stay in sync. */
	setToolsExpanded: (expanded: boolean) => void;
	/** Model refs ("provider/id") the model keys cycle through — the session's scoped models. */
	listModels: () => string[];
	/** Retune the selected agent; the returned message is shown on the panel's notice line. */
	setAgentModel: (spec: { name: string; model?: string; thinkingLevel?: string }) => Promise<{ ok: boolean; msg: string }>;
}

// The factory's keybindings arg. We only need action matching, so declare the one
// method we use rather than pi's KeybindingsManager: its inherited matches() is not
// visible through the pi-coding-agent subclass under tsgo bundler resolution (a pi
// .d.ts quirk), and the runtime object always carries it. Callers cast at the boundary.
interface KeybindingsLike {
	matches(data: string, keybinding: string): boolean;
}

interface TuiLike {
	requestRender(): void;
}

interface ThemeLike {
	fg(color: string, s: string): string;
	bg(color: string, s: string): string;
}

// busy = clearly visible background, idle/spawning = subtle.
const styleStatus = (theme: ThemeLike) => (label: string, tone: StatusTone) =>
	tone === "error"
		? theme.bg("toolErrorBg", label)
		: tone === "busy"
			? theme.bg("toolSuccessBg", label)
			: theme.fg("dim", label);

// Movement per gesture, taken from pi's fullscreen transcript so both scroll identically:
// TuiAltScreen uses wheelScrollLines = 1 per notch, a page of viewport minus PAGE_SCROLL_OVERLAP,
// and half a viewport for the half-page actions.
const WHEEL_SCROLL_LINES = 1;
const PAGE_SCROLL_OVERLAP = 4;

export function createSubagentsPanel(deps: PanelDeps, tui: TuiLike, theme: ThemeLike, kb: KeybindingsLike, done: () => void) {
	let selectedIndex = 0;
	// Tool-output expansion, seeded from main (ctrl+o). Toggled in-panel and pushed back to main.
	let toolsExpanded = deps.toolsExpanded;
	let hasAbove = false;
	let hasBelow = false;
	// Viewport of the last render; the scroll keys need it to move by pages like pi does.
	let lastViewport = 1;
	// Top screen row of the last rendered frame. The panel is bottom-anchored (flush to the terminal
	// bottom), so it spans rows panelTopRow..bottom; a wheel notch ABOVE panelTopRow is aimed at the
	// main chat still visible above the panel.
	let panelTopRow = 0;
	let unsubView: (() => void) | undefined;

	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const editor = new Editor(tui as never, editorTheme);

	// 'main' is not listed in the panel (= the main chat you are already in).
	// Spawn-tree order (parent followed by its subtree; siblings by parent traffic), then drop
	// main. Recomputed per access so it tracks live spawns/messages.
	// Ordered entries carry the spawn-tree depth the rows indent by; main is dropped, so its
	// children (depth 1) are the visible roots and render at indent 0.
	const ordered = () =>
		orderAgents(deps.engine.list(), deps.engine.getMessageMatrix()).filter((o) => o.agent.name !== "main");
	const agents = () => ordered().map((o) => o.agent);
	const refresh = () => tui.requestRender();
	const selectedName = () => agents()[selectedIndex]?.name;

	// Subscribe to the selected agent's view so streaming updates live. The transcript itself is
	// read from the view at render time, so the listener only has to ask for a frame.
	const rebindView = () => {
		unsubView?.();
		unsubView = agents()[selectedIndex]?.view?.subscribe(() => refresh());
	};
	rebindView();

	// One document + scroll position per agent, keyed by the agent's view so a killed agent's
	// document is collected with it and a re-spawn under the same name starts clean.
	// Keeping the components alive is the whole point: pi's Text/Markdown cache their rendered
	// lines by (text, width), so an unchanged transcript costs a slice instead of a re-parse.
	type AgentView = NonNullable<ReturnType<typeof agents>[number]["view"]>;
	const documents = new WeakMap<AgentView, { doc: TranscriptDocument; scroll: ScrollView }>();
	const documentFor = (view: AgentView) => {
		const existing = documents.get(view);
		if (existing) return existing;
		const doc = new TranscriptDocument({
			system: (prompt) => ({
				render: (width) => [
					theme.fg("dim", truncateToWidth("─ system ─", width)),
					...prompt.split("\n").map((line) => theme.fg("dim", truncateToWidth(`  ${line}`, width))),
					"",
				],
			}),
			user: (text) => new UserMessageComponent(text, undefined as never),
			custom: (message) =>
				new CustomMessageComponent(
					message as never,
					message.customType === AGENT_MESSAGE_CUSTOM_TYPE ? renderAgentMessage : undefined,
				) as never,
			assistant: (message) =>
				new AssistantMessageComponent(message as never, deps.hideThinking, undefined as never) as AssistantComponent,
			tool: (call) => {
				// The agent's own definition of the tool, so its renderCall draws the pending call with
				// its argument preview exactly as the main chat does. A tool the session cannot name a
				// definition for keeps the previous behaviour: an empty definition still takes the
				// renderer path (call = just the tool name, result = the preview), whereas undefined
				// would fall back to formatToolExecution() and dump the whole args JSON.
				const definition = view.getToolDefinition?.(call.name) ?? {};
				const component = new ToolExecutionComponent(
					call.name,
					call.id,
					call.arguments,
					{ showImages: false },
					definition as never,
					tui as never,
					deps.cwd,
				);
				// The args are complete: the panel builds a component from a recorded call, never from
				// a partially streamed one.
				component.setArgsComplete();
				return component as ToolComponent;
			},
		});
		doc.setToolsExpanded(toolsExpanded);
		// follow "end" reproduces the main chat: new output sticks to the bottom until you scroll up.
		const scroll = new ScrollView({ render: (width: number) => doc.render(width), invalidate: () => {} } as never, {
			follow: "end",
		});
		const created = { doc, scroll };
		documents.set(view, created);
		return created;
	};

	/** Scroll the selected agent's transcript, in pi's units (positive = towards the newest). */
	const scrollBy = (lines: number) => {
		const view = agents()[selectedIndex]?.view;
		if (!view) return;
		documentFor(view).scroll.scrollBy(lines);
		refresh();
	};

	// Text typed here is a MESSAGE to the selected agent, not a command line. Slash input is
	// almost always a pi command aimed at the main chat, and sending it as a task wastes an
	// agent turn on "/subagents" (observed). Refuse it and say where commands belong.
	let notice: string | undefined;
	editor.onSubmit = (value: string) => {
		const to = selectedName();
		const text = value.trim();
		if (text.startsWith("/")) {
			notice = "commands run in the main chat (Esc first) — this box messages the selected agent";
			refresh();
			return;
		}
		notice = undefined;
		if (!to || !text) return;
		// The chatbox types AS THE HUMAN: the agent receives a real user turn, not peer traffic
		// labelled "message from main". A refusal (paused, still spawning) keeps the text in the
		// editor so nothing the human wrote is lost.
		const result = deps.engine.deliverUser(to, text);
		if (result.outcome === "refused") notice = result.reason;
		else editor.setText("");
		refresh();
	};

	// Retune the selected agent. Fire-and-forget: the retune awaits the child session, and
	// blocking input on it would freeze the panel; the notice line reports the outcome when it
	// lands (the roster row shows the new model@level either way).
	const retune = (spec: { model?: string; thinkingLevel?: string }) => {
		const rec = agents()[selectedIndex];
		if (!rec) return;
		void deps.setAgentModel({ name: rec.name, ...spec }).then((result) => {
			notice = result.msg;
			refresh();
		});
	};

	const cycleModel = (direction: 1 | -1) => {
		const rec = agents()[selectedIndex];
		if (!rec) return;
		const next = nextInCycle(deps.listModels(), rec.model, direction);
		if (!next) {
			notice = "no models available to cycle through";
			refresh();
			return;
		}
		retune({ model: next });
	};

	const cycleThinking = () => {
		const rec = agents()[selectedIndex];
		if (!rec) return;
		retune({ thinkingLevel: nextInCycle(THINKING_LEVELS, rec.thinkingLevel, 1) });
	};

	// The selected agent's transcript, kept in its document and cut to the viewport the way pi
	// cuts the main chat: ScrollView owns the position (clamping, follow-end), the caller slices.
	const transcriptLines = (width: number, viewport: number): string[] => {
		// pi exposes maxHeight rather than a fixed overlay height. Filling only the transcript's
		// unused rows makes the panel exactly half-height while keeping its chatbox at the bottom
		// (KISS: no second layout system, just honor the viewport contract).
		const fillViewport = (lines: string[]) => [
			...lines,
			...Array.from({ length: Math.max(0, viewport - lines.length) }, () => ""),
		];
		const rec = agents()[selectedIndex];
		if (!rec?.view) {
			hasAbove = false;
			hasBelow = false;
			return fillViewport([theme.fg("muted", "  (no agents — create one with spawn_subagent)")]);
		}
		const { doc, scroll } = documentFor(rec.view);
		doc.sync({
			systemPrompt: rec.view.getSystemPrompt?.(),
			messages: (rec.view.getMessages() ?? []) as RawMessage[],
			// Read live rather than tracked from events, so switching to a slow-thinking agent shows
			// its in-progress message immediately instead of at its next delta.
			streamingMessage: rec.view.getStreamingMessage?.() as RawMessage | undefined,
		});
		const lines = scroll.render(width);
		if (lines.length === 0) {
			hasAbove = false;
			hasBelow = false;
			return fillViewport([theme.fg("muted", "  (no messages yet)")]);
		}
		scroll.updateLayout(lines.length, viewport, refresh);
		const top = scroll.scrollTop;
		hasAbove = top > 0;
		hasBelow = top + viewport < lines.length;
		return fillViewport(lines.slice(top, top + viewport).map((line) => truncateToWidth(line, width)));
	};

	const close = () => {
		unsubView?.();
		unsubView = undefined;
		done();
	};

	return {
		handleInput(data: string): void {
			// Mouse first, and every report is consumed here: as a focused overlay the panel gets
			// press/drag/motion reports too, and letting one reach the editor would type the raw
			// escape sequence into the chatbox. Only the wheel does anything (scroll the transcript),
			// with the same movement per notch as pi's own transcript.
			if (isMouseReport(data)) {
				const wheel = parseWheelEvent(data);
				// Only scroll the agent transcript for a notch OVER the panel. A notch above it is over
				// the main chat still visible above the bottom-anchored panel — swallow it (still consumed,
				// so it never reaches the chatbox), but do not scroll: the panel cannot drive the main
				// chat's viewport, and scrolling agents for a chat-aimed gesture was the surprising bug.
				if (wheel && wheel.y >= panelTopRow) scrollBy(wheel.direction * WHEEL_SCROLL_LINES);
				return;
			}
			if (matchesKey(data, Key.escape)) {
				close();
				return;
			}
			if (matchesKey(data, Key.up)) {
				selectedIndex = moveSelection(selectedIndex, -1, agents().length);
				notice = undefined;
				rebindView();
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				selectedIndex = moveSelection(selectedIndex, 1, agents().length);
				notice = undefined;
				rebindView();
				refresh();
				return;
			}
			// The keys that retune YOUR model in the main chat retune the SELECTED AGENT here.
			// Same ids, so a rebind carries over and there is no panel-only vocabulary to learn.
			if (kb.matches(data, "app.model.cycleForward")) {
				cycleModel(1);
				return;
			}
			if (kb.matches(data, "app.model.cycleBackward")) {
				cycleModel(-1);
				return;
			}
			if (kb.matches(data, "app.thinking.cycle")) {
				cycleThinking();
				return;
			}
			// A page keeps PAGE_SCROLL_OVERLAP lines of context, exactly like pi's transcript paging;
			// Ctrl+U/D move half a page (pi's halfPage actions, unbound by default there).
			const page = Math.max(1, lastViewport - PAGE_SCROLL_OVERLAP);
			const halfPage = Math.max(1, Math.floor(lastViewport / 2));
			// Several bindings per direction, since tmux/terminals may swallow PgUp/PgDn.
			if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.shift("up"))) {
				scrollBy(-page);
				return;
			}
			if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.shift("down"))) {
				scrollBy(page);
				return;
			}
			if (matchesKey(data, Key.ctrl("u"))) {
				scrollBy(-halfPage);
				return;
			}
			if (matchesKey(data, Key.ctrl("d"))) {
				scrollBy(halfPage);
				return;
			}
			// ctrl+o: toggle tool-output expansion (matches the main UI; respects user rebinds).
			if (kb.matches(data, "app.tools.expand")) {
				toolsExpanded = !toolsExpanded;
				deps.setToolsExpanded(toolsExpanded); // keep main in sync
				const view = agents()[selectedIndex]?.view;
				if (view) documentFor(view).doc.setToolsExpanded(toolsExpanded);
				refresh();
				return;
			}
			editor.handleInput(data);
			refresh();
		},
		render(width: number): string[] {
			const lines: string[] = [];
			const running = deps.engine.list().filter((a) => agentStatus(a).kind === "working").length;
			const header = `─ subagents · ${agents().length}/${deps.engine.maxAgents} agents · ${running} running `;
			lines.push(theme.fg("accent", truncateToWidth(header.padEnd(width, "─"), width)));
			const styler = styleStatus(theme);
			const matrix = deps.engine.getMessageMatrix();
			// The matrix is historical; only live names may appear in the targets column.
			const live = deps.engine.liveNames();
			for (const line of formatRoster(
				ordered().map(({ agent: a, depth }) => ({
					name: a.name,
					depth: rosterDepth(depth),
					model: a.model,
					thinkingLevel: a.thinkingLevel,
					context: formatContext(a.view?.getContextUsage()),
					status: agentStatus(a),
					customStatus: a.customStatus,
					etaTs: a.etaTs,
					targets: formatSendTargets(matrix, a.name, live),
				})),
				width,
				{
					styleStatus: styler,
					selectedIndex,
					// Selection is a full-row highlight instead of a cursor glyph, so the roster starts
					// flush left and no width is spent on an indent column.
					styleSelected: (line) => theme.bg("selectedBg", line.padEnd(width)),
				},
			)) {
				lines.push(truncateToWidth(line, width));
			}
			// Global swarm mode (paused/live) below the list — one source of truth in panel-logic.
			const stateLine = swarmStateLine(deps.engine.isPaused(), running, deps.engine.pausedAgents().length);
			lines.push(
				deps.engine.isPaused()
					? theme.bg("toolPendingBg", truncateToWidth(stateLine.padEnd(width), width))
					: theme.bg("selectedBg", stateLine),
			);
			lines.push(theme.fg("dim", truncateToWidth("─".repeat(width), width)));
			// Chatbox and hint are composed BEFORE the transcript so the transcript can claim exactly
			// the rows they leave inside the panel's budget (the editor's height varies with input).
			const chatbox: string[] = [];
			if (!selectedName()) chatbox.push(theme.fg("muted", truncateToWidth(" (no agent selected)", width)));
			chatbox.push(...editor.render(width));
			const viewport = transcriptViewport(panelRows(process.stdout.rows ?? 30), lines.length + chatbox.length + 1);
			lastViewport = viewport;
			const transcript = transcriptLines(width, viewport);
			const scrollHint = `${hasAbove ? "▲" : ""}${hasBelow ? "▼" : ""}`;
			const out = [
				...lines,
				...transcript,
				...chatbox,
				notice
					? theme.fg("warning", truncateToWidth(` ${notice} `, width))
					: theme.fg(
							"dim",
							truncateToWidth(
								` ↑/↓ agent · wheel/Ctrl+U/D scroll ${scrollHint} · Ctrl+P model · Shift+Tab effort · Enter send · Esc close `,
								width,
							),
						),
			];
			// Feed the wheel router the panel's top screen row (bottom-anchored: terminal rows minus
			// height). A notch above it is over the main chat still visible above the panel.
			panelTopRow = (process.stdout.rows ?? 30) - out.length;
			return out;
		},
		invalidate(): void {
			(editor as { invalidate?: () => void }).invalidate?.();
		},
	};
}
