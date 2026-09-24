/**
 * Aborts in flight, per agent. An abort is fire-and-forget for whoever starts it, but a later
 * step may have to wait for it: resume must not set an agent running while its abort can still
 * land and kill the new turn (Inversion). An agent can have several in flight — pause, resume,
 * pause again — and each one can land late, so every one is tracked until it settles.
 * SDK-free and engine-free, so it is testable alone.
 */
export class AbortTracker {
	private readonly inFlight = new Map<string, Set<Promise<void>>>();

	/**
	 * Start `abort` for `name` and track it until it settles. A failure goes to `onError` instead
	 * of an unhandled rejection, which would take pi down.
	 */
	track(name: string, abort: () => Promise<void>, onError: (error: unknown) => void): void {
		let aborts = this.inFlight.get(name);
		if (!aborts) {
			aborts = new Set();
			this.inFlight.set(name, aborts);
		}
		const tracked = aborts;
		const done: Promise<void> = (async () => {
			try {
				await abort();
			} catch (error) {
				onError(error);
			}
		})().finally(() => {
			tracked.delete(done);
			if (tracked.size === 0 && this.inFlight.get(name) === tracked) this.inFlight.delete(name);
		});
		tracked.add(done);
	}

	/** The aborts still in flight for the agents `select` picks. */
	pending(select: (name: string) => boolean): Promise<void>[] {
		return [...this.inFlight].flatMap(([name, aborts]) => (select(name) ? [...aborts] : []));
	}
}
