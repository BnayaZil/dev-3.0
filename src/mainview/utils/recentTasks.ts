// MRU (most-recently-used) cache of task VISITS, backing the "Go to" palette's
// Tasks mode. Unlike the project MRU — which records a jump — a task is recorded
// the moment it is VIEWED (App's route-change effect), so opening a task from
// anywhere (a card, the switcher, a deep link, back/forward) floats it to the top.
// Persisted in localStorage, newest-first, capped. The in-memory `taskMru`
// (state.ts) still drives the Option+Tab switcher; this is the durable mirror
// that survives an app reload. Ordering uses `orderByRecency`, which drops ids
// that are no longer in the pool (completed/cancelled/deleted tasks).

import { pushMruEntry, readMruList } from "./recentProjects";

const LS_KEY = "dev3-recent-tasks-v1";
const MAX_ENTRIES = 32;

/** Read the MRU task-id list, most-recent first. */
export function getRecentTaskIds(): string[] {
	return readMruList(LS_KEY);
}

/** Record a visit to `taskId`, moving it to the front of the MRU list. */
export function recordTaskVisit(taskId: string): void {
	pushMruEntry(LS_KEY, taskId, MAX_ENTRIES);
}
