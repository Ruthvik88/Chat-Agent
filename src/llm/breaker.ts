/**
 * A circuit breaker for saturated models.
 *
 * The Gemini free tier rejects a saturated model with 503 "high demand" and
 * rejects a spent model with 429 "per day limit exceeded". Both are properties
 * of the *model*, not of the request, so retrying is pointless and every retry
 * costs another slow round trip. Once a model trips, it is skipped entirely for
 * a cool-off period and requests go straight to the next model.
 *
 * State is module-level because a provider instance is created per request.
 */

/** How long a tripped model is skipped. */
export const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/** model -> timestamp when the breaker closes again. */
const tripped = new Map<string, number>();

/** Called when the breaker opens or closes, for logging. */
export type BreakerListener = (event: { model: string; state: 'opened' | 'closed'; until?: number }) => void;

let listener: BreakerListener | undefined;

export function onBreakerEvent(fn: BreakerListener): void {
  listener = fn;
}

export function tripBreaker(model: string, now = Date.now()): void {
  const until = now + BREAKER_COOLDOWN_MS;
  tripped.set(model, until);
  listener?.({ model, state: 'opened', until });
}

/** True when the model is currently skipped. Closes the breaker when it expires. */
export function isTripped(model: string, now = Date.now()): boolean {
  const until = tripped.get(model);
  if (until === undefined) return false;
  if (now < until) return true;
  tripped.delete(model);
  listener?.({ model, state: 'closed' });
  return false;
}

/** Test seam: forget every tripped model. */
export function resetBreaker(): void {
  tripped.clear();
}
