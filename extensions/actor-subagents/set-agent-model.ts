/**
 * The one policy for retuning a running agent — used by the `set_subagent_model` tool and by the
 * panel's model/thinking keys, so an agent and a human retuning the same child hit identical
 * rules and identical wording (DRY on knowledge, not on code shape).
 *
 * Retuning keeps the agent's transcript: pi's AgentSession can swap model and effort in place,
 * so there is no respawn and no lost work.
 *
 * SDK-free: model resolution is injected, which keeps the policy unit-testable without a live
 * pi session (Functional Core / Imperative Shell).
 */
import type { Engine, ModelChange } from "./engine.ts";
import { formatModelThinking, type ThinkingLevel } from "./thinking-level.ts";

export interface SetAgentModelSpec {
	name: string;
	/** Explicit "provider/id"; omitted leaves the model untouched. */
	model?: string;
	/** Requested effort; omitted leaves the level untouched. The model may clamp it. */
	thinkingLevel?: ThinkingLevel;
}

export interface SetAgentModelDeps {
	engine: Engine;
	/** Strict lookup of an explicit ref (resolve-model.ts); undefined when unknown. */
	resolveModel: (ref: string) => ModelChange | undefined;
	/** Rejection text listing the usable models, shared with the spawn path. */
	unknownModel: (ref: string) => string;
	/** Persist the roster so a restart brings the agent back retuned, not as it was spawned. */
	persistRoster: () => void;
}

/** Build the retune entry point. The result message is meant to be shown verbatim. */
export function createAgentModelSetter(deps: SetAgentModelDeps) {
	return async (spec: SetAgentModelSpec): Promise<{ ok: boolean; msg: string }> => {
		// Nothing to apply is a caller mistake, not a no-op success: saying so beats silently
		// reporting the unchanged tuning as if something had happened.
		if (!spec.model && !spec.thinkingLevel) {
			return { ok: false, msg: "error: nothing to change — pass model, thinkingLevel or both" };
		}
		let model: ModelChange | undefined;
		if (spec.model) {
			model = deps.resolveModel(spec.model);
			if (!model) return { ok: false, msg: `error: ${deps.unknownModel(spec.model)}` };
		}
		const result = await deps.engine.retune(spec.name, { model, thinkingLevel: spec.thinkingLevel });
		if (!result.ok) return { ok: false, msg: `error: ${result.reason}` };
		deps.persistRoster();
		const rec = deps.engine.get(spec.name);
		// Report the record's own state, so the message shows the effective level even when the
		// target model clamped the requested one.
		return { ok: true, msg: `retuned '${spec.name}' to ${formatModelThinking(rec?.model ?? "?", rec?.thinkingLevel)}` };
	};
}

export type AgentModelSetter = ReturnType<typeof createAgentModelSetter>;
