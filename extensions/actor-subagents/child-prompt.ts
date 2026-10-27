/**
 * How a child's system prompt reaches pi's resource loader.
 *
 * Two modes, chosen by the `childSystemPrompt` setting:
 * - "replace" (default): the agent preamble IS the child's system prompt (systemPromptOverride).
 *   The child gets no pi tools/rules sections, so a minimal, fully controlled prompt.
 * - "append": the agent preamble is APPENDED to pi's own prompt. A systemPromptOverride makes pi
 *   drop its default preamble together with the tools and rules sections, and the rules section is
 *   where extensions' promptGuidelines land: a child would get a policy-granted extension's tools
 *   without the guidance on when to use them. Append keeps those, and a discovered APPEND_SYSTEM.md.
 */
import type { ChildSystemPrompt } from "./settings.ts";
import { agentSystemPrompt } from "./agent-system-prompt.ts";

export interface ChildPromptOptions {
	systemPromptOverride?: () => string;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export function childPromptOptions(
	name: string,
	systemPrompt: string,
	spawnedBy: string,
	mode: ChildSystemPrompt = "replace",
): ChildPromptOptions {
	if (mode === "append") {
		return {
			appendSystemPromptOverride: (base) => [...base, agentSystemPrompt(name, systemPrompt, spawnedBy)],
		};
	}
	return {
		systemPromptOverride: () => agentSystemPrompt(name, systemPrompt, spawnedBy),
	};
}
