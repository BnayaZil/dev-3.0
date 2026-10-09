import { beforeEach, describe, expect, it } from "vitest";
import { getRecentNavKeys, navKey, orderByNavRecency, recordNavVisit } from "../recentNav";
import { getRecentTaskIds, recordTaskVisit } from "../recentTasks";

beforeEach(() => {
	localStorage.clear();
});

describe("recentTasks", () => {
	it("records visits newest-first without duplicates", () => {
		recordTaskVisit("a");
		recordTaskVisit("b");
		recordTaskVisit("a");
		expect(getRecentTaskIds()).toEqual(["a", "b"]);
	});

	it("caps the list at 32 entries, dropping the oldest", () => {
		for (let i = 0; i < 40; i++) recordTaskVisit(`t${i}`);
		const ids = getRecentTaskIds();
		expect(ids).toHaveLength(32);
		expect(ids[0]).toBe("t39");
		expect(ids).not.toContain("t7");
	});

	it("tolerates corrupt storage", () => {
		localStorage.setItem("dev3-recent-tasks-v1", "{not json");
		expect(getRecentTaskIds()).toEqual([]);
		recordTaskVisit("a");
		expect(getRecentTaskIds()).toEqual(["a"]);
	});
});

describe("recentNav", () => {
	it("prefixes keys by kind so a project and a task with one id never collide", () => {
		expect(navKey("project", "x")).toBe("p:x");
		expect(navKey("task", "x")).toBe("t:x");
	});

	it("interleaves projects and tasks by visit order, unvisited rows keep their order at the tail", () => {
		recordNavVisit("t:b");
		recordNavVisit("p:p2");
		recordNavVisit("t:a");
		const rows = [{ id: "p:p1" }, { id: "p:p2" }, { id: "t:a" }, { id: "t:b" }, { id: "space:s" }];
		expect(orderByNavRecency(rows).map((r) => r.id)).toEqual(["t:a", "p:p2", "t:b", "p:p1", "space:s"]);
	});

	it("caps the timeline at 48 entries", () => {
		for (let i = 0; i < 60; i++) recordNavVisit(`t:${i}`);
		expect(getRecentNavKeys()).toHaveLength(48);
	});
});
