/** The stable Pi custom-message identity for peer-to-peer agent traffic. */
export const AGENT_MESSAGE_CUSTOM_TYPE = "agent-message";

export interface RoutedAgentMessagePart {
	from: string;
	content: string;
}

/**
 * Structured mailbox payload retained in Pi's `details` field.
 *
 * The model only receives the text projection because provider protocols have no peer-agent
 * role. Keeping provenance structured here makes the session and UI more accurate than that
 * provider-level map (The Map Is Not the Territory, Make Illegal States Unrepresentable).
 */
export interface RoutedAgentMessage {
	parts: RoutedAgentMessagePart[];
}

export interface CustomAgentMessage {
	customType: typeof AGENT_MESSAGE_CUSTOM_TYPE;
	content: string;
	display: true;
	details: RoutedAgentMessage;
}

export function createRoutedAgentMessage(from: string, content: string): RoutedAgentMessage {
	return { parts: [{ from, content }] };
}

/** Preserve paused mailbox order while releasing it as one race-free turn. */
export function mergeRoutedAgentMessages(messages: RoutedAgentMessage[]): RoutedAgentMessage {
	return { parts: messages.flatMap((message) => message.parts) };
}

/**
 * Pi converts custom messages to provider `user` messages, so sender identity must remain in
 * content as well as structured details. See the official extension API:
 * https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#pisendmessagemessage-options
 */
export function toCustomAgentMessage(message: RoutedAgentMessage): CustomAgentMessage {
	return {
		customType: AGENT_MESSAGE_CUSTOM_TYPE,
		content: message.parts.map((part) => `[message from ${part.from}]: ${part.content}`).join("\n\n"),
		display: true,
		details: message,
	};
}

/** Parse persisted extension details at the display boundary instead of trusting unknown data. */
export function parseRoutedAgentMessage(value: unknown): RoutedAgentMessage | undefined {
	if (!value || typeof value !== "object" || !("parts" in value) || !Array.isArray(value.parts)) return undefined;
	const parts: RoutedAgentMessagePart[] = [];
	for (const part of value.parts) {
		if (
			!part ||
			typeof part !== "object" ||
			!("from" in part) ||
			typeof part.from !== "string" ||
			!("content" in part) ||
			typeof part.content !== "string"
		) {
			return undefined;
		}
		parts.push({ from: part.from, content: part.content });
	}
	return parts.length > 0 ? { parts } : undefined;
}

export function formatAgentMessageDisplay(message: RoutedAgentMessage): { label: string; body: string } {
	const senders = [...new Set(message.parts.map((part) => part.from))];
	if (senders.length === 1) {
		return {
			label: `agent · ${senders[0]}`,
			body: message.parts.map((part) => part.content).join("\n\n"),
		};
	}
	return {
		label: `agents · ${senders.join(", ")}`,
		body: message.parts.map((part) => `[${part.from}]\n${part.content}`).join("\n\n"),
	};
}
