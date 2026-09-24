/**
 * Aborts in flight, per agent. An abort is fire-and-forget for whoever starts it, but a later
 * step may have to wait for it: resume must not set an agent running while its abort can still
 * land and kill the new turn (Inversion). SDK-free and engine-free, so it is testable alone.
 */
export class AbortTracker {
	private readonly inFlight = new Map<string, Promise<void>>();

	/**
	 * Start `abort` for `name` and track it until it settles. A failure goes to `onError` instead
	 * of an unhandled rejection, which would take pi down. A newer abort for the same name replaces
	 * the tracked one; the older one's completion then leaves the newer entry alone.
	 */
	track(name: string, abort: () => Promise<void>, onError: (error: unknown) => void): void {
		const done = (async () => {
			try {
				await abort();
			} catch (error) {
				onError(error);
			}
		})().finally(() => {
			if (this.inFlight.get(name) === done) this.inFlight.delete(name);
		});
		this.inFlight.set(name, done);
	}

	/** The aborts still in flight for the agents `select` picks. */
	pending(select: (name: string) => boolean): Promise<void>[] {
		return [...this.inFlight].flatMap(([name, done]) => (select(name) ? [done] : []));
	}
}
