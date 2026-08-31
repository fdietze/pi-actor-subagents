/**
 * One agent's transcript as a LIVING component tree.
 *
 * The panel used to build a fresh component per message on every frame. pi's own Text and
 * Markdown components cache their rendered lines by (text, width), so throwing them away each
 * frame threw the cache away too and re-parsed the whole transcript at up to 60 fps — which is
 * why panel scrolling felt heavy next to the main chat, which keeps one component per message
 * for the life of the session. This document does the same: components are created once, told
 * about updates, and re-rendered from their caches.
 *
 * SDK-free by construction: the components are built by an injected factory, so the sync rules
 * (what is new, what merely changed, what a tool result attaches to) are testable without a
 * live TUI (Functional Core / Imperative Shell, Design for Testability).
 */
import { messageText, toolCalls } from "./panel-logic.ts";

export interface RawMessage {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	customType?: string;
	details?: unknown;
	display?: boolean;
}

/** Anything the document can render; mirrors pi-tui's Component minus the input parts. */
export interface TranscriptComponent {
	render(width: number): string[];
}

/** A pi AssistantMessageComponent (or a test double): its content is updated in place. */
export interface AssistantComponent extends TranscriptComponent {
	updateContent(message: never, isStreaming?: boolean): void;
}

/** A pi ToolExecutionComponent (or a test double): result and expansion arrive later. */
export interface ToolComponent extends TranscriptComponent {
	updateResult(result: never, isPartial?: boolean): void;
	setExpanded(expanded: boolean): void;
}

export interface TranscriptComponentFactory {
	/** The agent's system prompt block, shown once at the top. */
	system(prompt: string): TranscriptComponent;
	user(text: string): TranscriptComponent;
	/** Extension messages have their own visual identity; they must never impersonate the human. */
	custom(message: RawMessage): TranscriptComponent;
	assistant(message: RawMessage, isStreaming: boolean): AssistantComponent;
	/** Tool call in flight; its result is attached later via updateResult. */
	tool(call: { id: string; name: string; arguments: unknown }): ToolComponent;
}

interface Entry {
	components: TranscriptComponent[];
}

export interface SyncInput {
	systemPrompt?: string;
	messages: RawMessage[];
	/**
	 * The in-progress assistant message, if the agent is mid-turn. Precondition (Design by
	 * Contract): it must NOT also be present in `messages`. Pi upholds this — the Session pushes a
	 * message to `messages` only at message_end, the same moment it clears the streaming message —
	 * so the two are always disjoint. The document renders it as a trailing live block; once
	 * committed it appears in `messages` and this must be undefined, else it renders twice.
	 */
	streamingMessage?: RawMessage;
}

export class TranscriptDocument {
	private readonly factory: TranscriptComponentFactory;
	private header: TranscriptComponent | undefined;
	private entries: Entry[] = [];
	/** Tool components by call id, so a later toolResult message finds the call it belongs to. */
	private readonly tools = new Map<string, ToolComponent>();
	private streaming: { component: AssistantComponent; tools: Map<string, ToolComponent> } | undefined;
	private expanded = false;
	/**
	 * Bumped by every mutation, so the assembled line array can be reused while nothing changes
	 * — i.e. exactly while you scroll. Same idea (and the same keying on its inputs) as pi's own
	 * Text/Markdown line caches, one level up: those make a component cheap, this makes walking
	 * a long transcript cheap. Caveat: a component that changes itself without going through
	 * sync() (a tool component converting images in the background) is served stale until the
	 * next change; the panel disables images, so that path does not occur here.
	 */
	private revision = 0;
	private cache: { width: number; revision: number; lines: string[] } | undefined;

	// No TS parameter properties: Node's strip-only mode (node --test on .ts) rejects them.
	constructor(factory: TranscriptComponentFactory) {
		this.factory = factory;
	}

	/** Bring the document in line with the agent's current messages. Cheap when nothing changed. */
	sync(input: SyncInput): void {
		if (input.systemPrompt !== undefined && !this.header) {
			this.header = this.factory.system(input.systemPrompt);
			this.revision++;
		}
		// A shorter list means the transcript was replaced (e.g. compaction), not appended to;
		// identity-based adoption cannot help there, so start over.
		if (input.messages.length < this.entries.length) this.reset();
		const last = input.messages.length - 1;
		for (let i = this.entries.length; i < input.messages.length; i++) {
			this.append(input.messages[i] as RawMessage, i === last);
			this.revision++;
		}
		this.syncStreaming(input.streamingMessage);
	}

	/** Mirror the main UI's tool-output expansion onto every tool component. */
	setToolsExpanded(expanded: boolean): void {
		if (expanded !== this.expanded) this.revision++;
		this.expanded = expanded;
		for (const tool of this.tools.values()) tool.setExpanded(expanded);
		if (this.streaming) for (const tool of this.streaming.tools.values()) tool.setExpanded(expanded);
	}

	/** The whole transcript, in order. Components serve their own cached lines. */
	render(width: number): string[] {
		const cached = this.cache;
		if (cached && cached.width === width && cached.revision === this.revision) return cached.lines;
		const lines: string[] = [];
		if (this.header) lines.push(...this.renderComponent(this.header, width));
		for (const entry of this.entries) {
			for (const component of entry.components) lines.push(...this.renderComponent(component, width));
		}
		if (this.streaming) {
			lines.push(...this.renderComponent(this.streaming.component, width));
			for (const tool of this.streaming.tools.values()) lines.push(...this.renderComponent(tool, width));
		}
		this.cache = { width, revision: this.revision, lines };
		return lines;
	}

	/** A render failure degrades to a marker line; it must never take the panel down. */
	private renderComponent(component: TranscriptComponent, width: number): string[] {
		try {
			return component.render(width);
		} catch {
			return ["  (unrenderable message)"];
		}
	}

	private reset(): void {
		this.entries = [];
		this.tools.clear();
		this.streaming = undefined;
		this.revision++;
	}

	private append(message: RawMessage, isLast: boolean): void {
		// A tool result has no component of its own: it belongs to the call that is already shown.
		if (message.role === "toolResult") {
			const id = message.toolCallId;
			if (id) this.tools.get(id)?.updateResult(message as never);
			this.entries.push({ components: [] });
			return;
		}
		if (message.role === "user") {
			this.entries.push({ components: [this.factory.user(messageText(message.content))] });
			return;
		}
		if (message.role === "custom") {
			this.entries.push({
				components: message.display === false ? [] : [this.factory.custom(message)],
			});
			return;
		}
		if (message.role === "assistant") {
			// Positional adoption: reuse the live streaming block for the assistant message now being
			// committed, keeping its component and tool components (their line caches survive, so there
			// is no re-parse flash on finalize). Only the LAST new message can be the streaming one — Pi
			// streams one assistant message at a time and commits it at message_end, which pushes it to
			// `messages` and clears the streaming message atomically. Identity can't be used to match:
			// Pi emits a fresh copy per message_update but the raw final object at message_end, so the
			// streamed and committed objects are never reference-equal.
			const adopted = isLast ? this.streaming : undefined;
			const component = adopted ? adopted.component : this.factory.assistant(message, false);
			component.updateContent(message as never, false);
			const components: TranscriptComponent[] = [component];
			for (const call of toolCalls(message)) {
				const tool = adopted?.tools.get(call.id) ?? this.factory.tool(call);
				tool.setExpanded(this.expanded);
				this.tools.set(call.id, tool);
				components.push(tool);
			}
			if (adopted) this.streaming = undefined;
			this.entries.push({ components });
			return;
		}
		this.entries.push({ components: [] });
	}

	private syncStreaming(message: RawMessage | undefined): void {
		if (!message) {
			if (this.streaming) this.revision++;
			this.streaming = undefined;
			return;
		}
		// Build the live component once per streaming block, then mutate it in place on every update
		// (one message re-parsed per frame, exactly what the main chat does). No object identity is
		// needed to separate one assistant message from the next: Pi clears the streaming message at
		// message_end, so syncStreaming(undefined) ends the block and the next message_start opens a
		// fresh one. Per SyncInput's contract the streaming message is never also in `messages`, so it
		// renders exactly once — as this trailing block until committed, then as its adopted entry.
		if (!this.streaming) {
			this.streaming = { component: this.factory.assistant(message, true), tools: new Map() };
		}
		this.revision++;
		this.streaming.component.updateContent(message as never, true);
		for (const call of toolCalls(message)) {
			if (this.streaming.tools.has(call.id)) continue;
			const tool = this.factory.tool(call);
			tool.setExpanded(this.expanded);
			this.streaming.tools.set(call.id, tool);
		}
	}
}
