import "server-only";

/** Request-time clock for server components (keeps impure calls out of render bodies). */
export const nowMs = () => Date.now();
export const daysAgo = (d: number) => nowMs() - d * 86_400_000;
