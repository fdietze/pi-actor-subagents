/** Pi's complete thinking-level domain, kept SDK-free for orchestration and persistence. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** Parse, don't validate: callers retain a typed level only after crossing this guard. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.some((level) => level === value);
}

/** One display rule keeps requested model identity and observed effective effort together. */
export function formatModelThinking(model: string, thinkingLevel: ThinkingLevel | undefined): string {
	return thinkingLevel ? `${model}@${thinkingLevel}` : model;
}
