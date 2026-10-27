/** The spawn policy's per-child tool guard as an inline child extension (index.ts loads it). */
export type ToolGuard = (toolName: string, input: unknown) => string | undefined;

type PiLike = { on(event: "tool_call", h: (e: { toolName: string; input: unknown }) => unknown): void };

/** No guard, no extension: an unguarded child gets no tool_call handler at all. */
export function toolGuardExtensions(guard: ToolGuard | undefined): { name: string; factory: (pi: PiLike) => void }[] {
	if (!guard) return [];
	const factory = (pi: PiLike) =>
		pi.on("tool_call", (e) => {
			const reason = guard(e.toolName, e.input);
			return reason === undefined ? undefined : { block: true, reason };
		});
	return [{ name: "subagent-tool-guard", factory }];
}

/**
 * The tool allowlist a child session is created with. pi's `tools` option filters every tool,
 * custom ones included, so the policy's list (built-ins + extension tools) is widened by the
 * orchestration tools actor-subagents hands the child; without them it could not report back.
 */
export function childToolAllowlist(policyTools: string[] | undefined, orchestration: { name: string }[]): string[] | undefined {
	return policyTools ? [...new Set([...policyTools, ...orchestration.map((t) => t.name)])] : undefined;
}

/**
 * The policy-dependent part of creating a child session (index.ts createSession): `session` goes
 * to createAgentSession (the orchestration tools as customTools, plus the widened allowlist when
 * the policy restricted the tools), `extensionFactories` to the child's resource loader.
 */
export function childToolOptions<T extends { name: string }>(
	spec: { tools?: string[]; toolGuard?: ToolGuard },
	orchestration: T[],
): { session: { customTools: T[]; tools?: string[] }; extensionFactories: ReturnType<typeof toolGuardExtensions> } {
	const tools = childToolAllowlist(spec.tools, orchestration);
	return {
		session: { customTools: orchestration, ...(tools ? { tools } : {}) },
		extensionFactories: toolGuardExtensions(spec.toolGuard),
	};
}
