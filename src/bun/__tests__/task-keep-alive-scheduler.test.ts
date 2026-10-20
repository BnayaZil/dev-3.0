/**
 * The watchdog's per-task decision: notice a dead agent and relaunch+resume it,
 * back off and wait out a rate limit, and give up + escalate after the cap. The
 * dependencies (liveness, resume, rate-limit report, pushes) are all mocked; this
 * drives `evaluateTask` and asserts what it decided to do.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../shared/types";
import type { KeepAliveState } from "../../shared/types/keep-alive";
import { KEEP_ALIVE_MAX_ATTEMPTS, KEEP_ALIVE_RATE_LIMIT_BUFFER_MS } from "../../shared/keep-alive";

const H = vi.hoisted(() => ({
	task: null as unknown as Task,
	patches: [] as Partial<KeepAliveState>[],
}));

vi.mock("../data", () => ({
	updateTaskWith: vi.fn(async (_p: unknown, _id: unknown, mutator: (t: Task) => { updates: Partial<Task>; result: unknown }) => {
		const { updates } = await mutator(H.task);
		if (updates.keepAlive !== undefined) {
			H.patches.push(updates.keepAlive as KeepAliveState);
			H.task = { ...H.task, keepAlive: updates.keepAlive } as Task;
		}
		return { task: H.task, result: undefined };
	}),
}));
vi.mock("../rpc-handlers/tmux-pty", () => ({
	taskTerminalAlive: vi.fn(async () => false),
	resumeTaskSession: vi.fn(async () => ({ kind: "resumed", url: "ws://x", result: {} })),
	ResumeUnavailableError: class ResumeUnavailableError extends Error {},
}));
vi.mock("../rate-limit-monitor", () => ({ getCachedRateLimitsReport: vi.fn(() => null) }));
vi.mock("../rpc-handlers", () => ({
	getPushMessage: vi.fn(() => vi.fn()),
	pushCliToast: vi.fn(),
	pushCliAttention: vi.fn(),
}));
vi.mock("../logger", () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { taskTerminalAlive, resumeTaskSession, ResumeUnavailableError } from "../rpc-handlers/tmux-pty";
import { getCachedRateLimitsReport } from "../rate-limit-monitor";
import { pushCliAttention, pushCliToast } from "../rpc-handlers";
import { evaluateTask } from "../task-keep-alive-scheduler";

const project = { id: "proj-1", name: "Proj", path: "/x/repo" } as never;
const NOW = 2_000_000;

function makeTask(keepAlive: KeepAliveState, extra: Partial<Task> = {}): Task {
	return {
		id: "tttttttt-tttt-tttt-tttt-tttttttttttt",
		projectId: "proj-1",
		seq: 9,
		title: "Monitor",
		status: "in-progress",
		keepAlive,
		sessionState: { panes: [{ agentCmd: "claude", sessionId: "s1", agentId: "a", configId: null, agentFamily: "claude", accountId: null }] },
		...extra,
	} as unknown as Task;
}

function lastPatch(): Partial<KeepAliveState> {
	return H.patches[H.patches.length - 1];
}

beforeEach(() => {
	vi.clearAllMocks();
	H.patches = [];
	vi.mocked(taskTerminalAlive).mockResolvedValue(false);
	vi.mocked(resumeTaskSession).mockResolvedValue({ kind: "resumed", url: "ws://x", result: {} } as never);
	vi.mocked(getCachedRateLimitsReport).mockReturnValue(null);
});

describe("evaluateTask", () => {
	it("revives a dead task and arms the backoff", async () => {
		const task = makeTask({ enabled: true, status: "watching", attempts: 0 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).toHaveBeenCalledWith(task.id, { refuseLive: true });
		expect(lastPatch()).toMatchObject({ status: "reviving", attempts: 1, lastVerdict: "revived" });
		expect(lastPatch().nextAttemptAt).toBeGreaterThan(NOW);
	});

	it("resets a recovering task to watching once it is alive again, without resuming", async () => {
		vi.mocked(taskTerminalAlive).mockResolvedValue(true);
		const task = makeTask({ enabled: true, status: "reviving", attempts: 3 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(lastPatch()).toMatchObject({ status: "watching", attempts: 0, lastVerdict: "healthy" });
	});

	it("waits for a known rate-limit reset instead of hammering", async () => {
		vi.mocked(getCachedRateLimitsReport).mockReturnValue({
			generatedAt: NOW,
			snapshots: [{ source: "claude", accountId: null, capturedAt: NOW, creditsBalance: null, monthlyCredits: null, planType: null, windows: [{ id: "w", usedPercent: 100, resetsAt: NOW + 10_000, windowMinutes: null }] }],
		});
		const task = makeTask({ enabled: true, status: "watching", attempts: 0 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(lastPatch()).toMatchObject({ status: "reviving", lastVerdict: "rate-limited", nextAttemptAt: NOW + 10_000 + KEEP_ALIVE_RATE_LIMIT_BUFFER_MS });
	});

	it("holds during the backoff window", async () => {
		const task = makeTask({ enabled: true, status: "reviving", attempts: 1, nextAttemptAt: NOW + 50_000 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(H.patches).toHaveLength(0);
	});

	it("gives up and escalates after the retry cap", async () => {
		const task = makeTask({ enabled: true, status: "reviving", attempts: KEEP_ALIVE_MAX_ATTEMPTS });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(lastPatch()).toMatchObject({ status: "gave-up", lastVerdict: "gave-up" });
		expect(pushCliAttention).toHaveBeenCalledTimes(1);
		expect(pushCliToast).toHaveBeenCalledTimes(1);
	});

	it("gives up when the conversation cannot be resumed", async () => {
		vi.mocked(resumeTaskSession).mockRejectedValue(new ResumeUnavailableError("no-saved-session"));
		const task = makeTask({ enabled: true, status: "watching", attempts: 0 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(lastPatch()).toMatchObject({ status: "gave-up", lastVerdict: "unresumable" });
		expect(pushCliAttention).toHaveBeenCalledTimes(1);
	});

	it("does nothing once it has already given up", async () => {
		const task = makeTask({ enabled: true, status: "gave-up", attempts: KEEP_ALIVE_MAX_ATTEMPTS + 1 });
		H.task = task;
		await evaluateTask(project, task, NOW);
		expect(resumeTaskSession).not.toHaveBeenCalled();
		expect(H.patches).toHaveLength(0);
	});
});
