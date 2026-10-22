import type { AgentFamily } from "./types/coding-agents";
import type { KeepAliveState } from "./types/keep-alive";
import type { AgentRateLimitSnapshot, AgentRateLimitsReport, RateLimitSource } from "./rate-limits";

// Pure logic + tuning constants for the keep-alive (auto-revive) watchdog.
// No side effects, no I/O — unit-tested in isolation. The bun scheduler
// (`task-keep-alive-scheduler.ts`) wires these to real liveness and resume.

/**
 * Give up and escalate to the user after this many consecutive failed revives.
 * With the backoff below this is roughly a 24-hour (one-day) window before giving
 * up — long enough to outlast an overnight outage, a weekend, or a machine that
 * was asleep, short enough that a truly dead task does not sit silently forever.
 * The window is counted in ATTEMPTS, not wall-clock, so a sleeping machine does
 * not burn through it — it simply pauses until the scheduler ticks again.
 */
export const KEEP_ALIVE_MAX_ATTEMPTS = 50;
/** First backoff after a revive attempt; doubles each attempt up to the cap. One
 *  tick (see the scheduler) is the floor anyway, so the base matches it. */
export const KEEP_ALIVE_BACKOFF_BASE_MS = 5 * 60_000;
/** Backoff ceiling so a provider that is down for real is not hammered. */
export const KEEP_ALIVE_BACKOFF_MAX_MS = 30 * 60_000;
/** Wait this long past a known rate-limit reset before trying again. */
export const KEEP_ALIVE_RATE_LIMIT_BUFFER_MS = 60_000;
/**
 * Never silently defer a revive beyond this. A reset further out than this (a
 * weekly limit resetting days away, a stale/garbage timestamp) is not something
 * to wait out in silence — fall through to the ordinary attempt→backoff→give-up
 * path so the user gets a "gave up" badge instead of a multi-day quiet hold.
 * Mirrors Claude Code's own ">24h out → don't wait" rule.
 */
export const KEEP_ALIVE_MAX_RATE_LIMIT_WAIT_MS = 24 * 60 * 60_000;
/** A usage window at/above this percent is treated as blocking (the limit is hit). */
export const KEEP_ALIVE_BLOCKED_PERCENT = 100;

/** The persisted state for toggling keep-alive on a task: a fresh watching state, or null when off. */
export function nextKeepAliveState(enabled: boolean): KeepAliveState | null {
	return enabled
		? { enabled: true, status: "watching", attempts: 0, lastAttemptAt: null, nextAttemptAt: null, lastVerdict: null, gaveUpReason: null }
		: null;
}

/** Exponential backoff (ms) to wait before the attempt AFTER `attemptsMade`, capped. */
export function keepAliveBackoffMs(attemptsMade: number): number {
	const n = Math.max(1, attemptsMade);
	return Math.min(KEEP_ALIVE_BACKOFF_BASE_MS * 2 ** (n - 1), KEEP_ALIVE_BACKOFF_MAX_MS);
}

/** The rate-limit data source for an agent family, or null when it exposes none. */
export function keepAliveRateLimitSource(family: AgentFamily | null | undefined): RateLimitSource | null {
	return family === "claude" || family === "codex" ? family : null;
}

/**
 * Latest reset time (epoch ms) among a snapshot's windows that are blocked (used
 * at/over the threshold) with a reset still in the future — else null.
 */
export function keepAliveSnapshotResetMs(snapshot: AgentRateLimitSnapshot, nowMs: number): number | null {
	let latest: number | null = null;
	for (const w of snapshot.windows) {
		if (w.usedPercent >= KEEP_ALIVE_BLOCKED_PERCENT && w.resetsAt != null && w.resetsAt > nowMs) {
			latest = latest === null ? w.resetsAt : Math.max(latest, w.resetsAt);
		}
	}
	return latest;
}

/**
 * When the login behind `(source, accountId)` is rate-limit-blocked right now,
 * the epoch-ms time to wait until before retrying (reset + buffer); else null.
 * Best-effort: no matching snapshot means "not known to be blocked".
 */
export function keepAliveRateLimitWaitUntil(
	report: AgentRateLimitsReport | null,
	source: RateLimitSource,
	accountId: string | null,
	nowMs: number,
): number | null {
	if (!report) return null;
	let latest: number | null = null;
	for (const s of report.snapshots) {
		if (s.source !== source) continue;
		if ((s.accountId ?? null) !== (accountId ?? null)) continue;
		const reset = keepAliveSnapshotResetMs(s, nowMs);
		if (reset !== null) latest = latest === null ? reset : Math.max(latest, reset);
	}
	if (latest === null) return null;
	const waitUntil = latest + KEEP_ALIVE_RATE_LIMIT_BUFFER_MS;
	// A reset too far out (a weekly limit, a bad timestamp) is not worth a silent
	// multi-day hold — let the caller fall through to attempt → backoff → give up.
	return waitUntil - nowMs > KEEP_ALIVE_MAX_RATE_LIMIT_WAIT_MS ? null : waitUntil;
}
