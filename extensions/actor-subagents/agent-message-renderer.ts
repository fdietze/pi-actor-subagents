import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	formatAgentMessageDisplay,
	parseRoutedAgentMessage,
} from "./agent-message.ts";

function plainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(part && typeof part === "object" && part.type === "text" && typeof part.text === "string"),
		)
		.map((part) => part.text)
		.join("\n");
}

/** Render peer traffic as an agent message rather than reusing Pi's human-message component. */
export const renderAgentMessage: MessageRenderer = (message, options, theme) => {
	const routed = parseRoutedAgentMessage(message.details);
	const display = routed
		? formatAgentMessageDisplay(routed)
		: { label: "agent message", body: plainText(message.content) };
	const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(display.label)), 0, 0));
	box.addChild(new Text(display.body, 0, 0));
	return box;
};
