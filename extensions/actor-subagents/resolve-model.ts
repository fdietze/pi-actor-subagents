/**
 * Turn a model reference into a concrete model, or nothing.
 *
 * Two distinct inputs, two distinct meanings — this is the whole point of the module:
 *   - an explicit "provider/id" ref is a claim that must hold. If the registry does not
 *     know it, resolution FAILS so the caller can report the available models. Falling
 *     back here would silently run a different model than the one asked for
 *     (The Map Is Not the Territory).
 *   - no ref (inheritance) or a non-"provider/id" placeholder like "(foreground)" means
 *     "whatever the foreground runs" and resolves to that.
 *
 * Pure (functional core): the registry lookup and the foreground model are injected, so
 * the policy is testable without a live pi session.
 */

/** Minimal shape of a pi model needed here; `model` is passed back to the SDK untouched. */
export interface ModelLike {
	provider: string;
	id: string;
}

export interface ResolvedModelRef<M extends ModelLike> {
	provider: string;
	id: string;
	model: M;
}

/**
 * Strict lookup of an explicit "provider/id" — no foreground fallback at all.
 * Retuning a running agent has no inheritance concept: the caller names a model or nothing
 * happens, so a ref that is not "provider/id" (or is unknown) must fail rather than quietly
 * become the foreground model.
 */
export function resolveExplicitModelRef<M extends ModelLike>(
	ref: string,
	find: (provider: string, id: string) => M | undefined,
): ResolvedModelRef<M> | undefined {
	if (!ref.includes("/")) return undefined;
	const slash = ref.indexOf("/");
	const model = find(ref.slice(0, slash), ref.slice(slash + 1));
	return model ? { provider: model.provider, id: model.id, model } : undefined;
}

/** "unknown model 'x'; available: a, b" — one phrasing for every rejected model reference. */
export function unknownModelMessage(ref: string | undefined, available: string[]): string {
	const hint = available.length ? `; available: ${available.join(", ")}` : "";
	return `unknown model '${ref ?? "(none)"}'${hint}`;
}

export function resolveModelRef<M extends ModelLike>(
	ref: string | undefined,
	find: (provider: string, id: string) => M | undefined,
	foreground: { provider: string; id: string } | undefined,
): ResolvedModelRef<M> | undefined {
	if (ref?.includes("/")) return resolveExplicitModelRef(ref, find);
	if (!foreground) return undefined;
	const model = find(foreground.provider, foreground.id);
	return model ? { provider: foreground.provider, id: foreground.id, model } : undefined;
}
