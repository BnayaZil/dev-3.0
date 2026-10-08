// Unified most-recently-visited list that interleaves PROJECTS and TASKS on one
// timeline, backing the "Go to" palette's Combined ("All") mode. The per-type
// lists (recentProjects / recentTasks) each order one kind; this one records both
// in visit order so Combined can show, e.g., Project1 · Task4 · Project3 mixed by
// when each was last opened. Keys are the palette's own row ids — `p:<projectId>`
// for a project board, `t:<taskId>` for a task — so ordering matches rows directly.
// Recorded centrally at App's route-change effect (covers every entry point plus
// back/forward). Persisted in localStorage, newest-first, capped.

import { orderByRecency } from "./recentProjects";

const LS_KEY = "dev3-recent-nav-v1";
const MAX_ENTRIES = 48;

/** A unified nav key: `p:<projectId>` (board) or `t:<taskId>` (task). */
export function navKey(kind: "project" | "task", id: string): string {
	return `${kind === "project" ? "p" : "t"}:${id}`;
}

/** Read the unified MRU key list, most-recent first. Tolerates corrupt storage. */
export function getRecentNavKeys(): string[] {
	try {
		const raw = localStorage.getItem(LS_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((k): k is string => typeof k === "string");
	} catch {
		return [];
	}
}

/** Record a visit to a unified key, moving it to the front of the list. */
export function recordNavVisit(key: string): void {
	if (!key) return;
	const next = [key, ...getRecentNavKeys().filter((k) => k !== key)].slice(0, MAX_ENTRIES);
	try {
		localStorage.setItem(LS_KEY, JSON.stringify(next));
	} catch {
		/* ignore — recency is best-effort */
	}
}

/**
 * Order rows (projects, spaces, tasks) by the unified visit timeline: items
 * whose `id` is a recent nav key come first in MRU order (projects and tasks
 * interleaved), then the rest in their given order. Rows with no nav key (spaces)
 * simply fall to the tail. Pure.
 */
export function orderByNavRecency<T extends { id: string }>(items: T[]): T[] {
	return orderByRecency(items, getRecentNavKeys());
}
