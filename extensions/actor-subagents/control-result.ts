/** Result shapes of the engine's checks and control operations (pause, resume, kill). */

export type CheckResult = { ok: true } | { ok: false; reason: string };

/**
 * One target's outcome of a control operation (pause, resume, kill). `reason` explains a refusal,
 * or — on success — a state the caller would otherwise misread (e.g. still held by an ancestor).
 */
export interface TargetOutcome {
	target: string;
	ok: boolean;
	reason?: string;
}

/** A control operation's per-target outcomes plus the agents whose state actually changed. */
export interface ControlResult {
	results: TargetOutcome[];
	affected: string[];
}

/**
 * Work released by resume, counted without claiming asynchronous delivery completed. `affected`
 * lists the agents that went from paused to running.
 */
export interface EngineResumeResult extends ControlResult {
	/** The resumed agents that had been paused mid-turn: their work needs re-triggering. */
	interrupted: string[];
	bufferedMessages: number;
}
