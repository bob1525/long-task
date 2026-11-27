/** Non-tail calls stop at this depth. Tail calls replace the current frame and do not grow it. */
export const MAX_CALL_STACK = 512;

/**
 * Step budget for `execute`. It does not store a snapshot per step, so a long
 * tail recursion such as `(sum 100000 0)` still fits.
 */
export const DEFAULT_MAX_STEPS = 5_000_000;

/**
 * Step budget for the visualizer. `fib(10)` is about 4300 steps, and a
 * non-tail blow-up reaches `MAX_CALL_STACK` at about 14000 steps. An infinite
 * tail call stops here instead.
 */
export const MAX_TRACE_STEPS = 20_000;

/**
 * Snapshots kept for rewind. Older steps are dropped and the UI says so.
 * The bundled examples fit: the longest, `fib(10)`, is about 4300 steps.
 */
export const MAX_HISTORY = 6_000;
