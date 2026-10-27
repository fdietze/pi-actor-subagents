/** The engine's event log entries, which the feed, panel and reaction waits observe. */
export type AgentEvent =
	// `childSessionId` is known for a registered (restored) agent; a reservation learns it at
	// `attach`, once its session exists.
	| { type: "spawn"; name: string; by: string; childSessionId?: string; ts: number }
	| { type: "attach"; name: string; by: string; childSessionId?: string; ts: number }
	// `buffered` distinguishes a message parked in a paused inbox from one handed to the
	// target session: the feed must not claim delivery for something that has not moved yet.
	| { type: "route"; from: string; to: string; preview: string; buffered: boolean; ts: number }
	| { type: "turn"; name: string; ts: number }
	// `names` lists exactly the agents whose own pause flag changed, so the feed never claims a
	// stop that did not happen (The Map Is Not the Territory).
	// `by` is the actor: an agent name, "user" (the human) or "restore" (session restore).
	| { type: "pause"; names: string[]; by: string; ts: number }
	| { type: "resume"; names: string[]; by: string; ts: number }
	| { type: "kill"; name: string; by: string; ts: number }
	| { type: "error"; name: string; reason: string; ts: number };
