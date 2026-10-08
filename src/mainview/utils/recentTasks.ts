// MRU (most-recently-used) cache of task VISITS, backing the "Go to" palette's
// task and combined modes. Unlike the project MRU — which records a jump — a task
// is recorded the moment it is VIEWED (recorded centrally at App's route-change
// effect), so simply opening a task from anywhere (a card, the switcher, a deep
// link, back/forward) floats it to the top of the list, not only picking it here.
// The list is an ordered array of task IDs, most-recent first, persisted in
// localStorage and capped so it never grows unbounded. The in-memory `taskMru`
// (state.ts) still drives the Option+Tab switcher; this is the durable mirror
// that survives an app reload.

import { orderByRecency } from "./recentProjects";

const LS_KEY = "dev3-recent-tasks-v1";
const MAX_ENTRIES = 32;

/** Read the MRU task-id list, most-recent first. Tolerates corrupt storage. */
export function getRecentTaskIds(): string[] {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === "string");
	} catch {
		return [];
	}
}

/** Record a visit to `taskId`, moving it to the front of the MRU list. */
export function recordTaskVisit(taskId: string): void {
	if (!taskId) return;
	const next = [taskId, ...getRecentTaskIds().filter((id) => id !== taskId)].slice(0, MAX_ENTRIES);
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(next));
	} catch {
		/* ignore — recency is best-effort */
	}
}

/**
 * Order `tasks` for the "Go to" palette: most-recently-visited first (in MRU
 * order), then the rest in their given order (callers pass newest-seq first).
 * A recent id that no longer exists in `tasks` (completed/cancelled/deleted) is
 * silently dropped — the list is advisory, never a source of phantom rows. Pure.
 */
export function orderTasksByRecency<T extends { id: string }>(tasks: T[], recentIds: string[]): T[] {
	return orderByRecency(tasks, recentIds);
}
