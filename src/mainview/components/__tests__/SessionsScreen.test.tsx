import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRateLimitsReport } from "../../../shared/rate-limits";
import type { AgentSessionStats } from "../../../shared/session-stats";
import { I18nProvider } from "../../i18n";
import { setSensitiveProjectIds } from "../../sensitive-projects";
import { setStreamerMode } from "../../streamer-mode";
import SessionsScreen from "../SessionsScreen";
import { NOW, session, warmFor } from "./session-test-fixtures";

vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgentRateLimits: vi.fn(),
			listAgentAccounts: vi.fn(async () => ({
				claude: {
					accounts: [{ id: "acc-1", kind: "claude", label: "work@example.com", identity: null, auth: "oauth", api: null, createdAt: 0 }],
					activeId: null,
					systemConfigDir: "/home/me/.claude",
					systemIdentity: { email: "me@example.com" },
				},
				codex: { accounts: [], activeId: null },
			})),
			listPinnedClaudeLogins: vi.fn(async () => []),
		},
	},
}));
vi.mock("../../hooks/useNarrowViewport", () => ({ useNarrowViewport: () => false }));

import { api } from "../../rpc";
const mockGet = api.request.getAgentRateLimits as unknown as ReturnType<typeof vi.fn>;

const SESSIONS: AgentSessionStats[] = [
	session("a", { taskTitle: "Alpha", taskSeq: 11, costUsd: 1.2, contextPercent: 30 }),
	session("b", { taskTitle: "Beta", taskSeq: 22, costUsd: 4.5, contextPercent: 91 }),
	session("c", { taskTitle: "Gamma", taskSeq: 33, costUsd: 0.3, awaitingUser: true, cache: warmFor(60_000) }),
	session("d", { taskTitle: "Delta", taskSeq: 44, costUsd: 9, projectId: "p2", projectName: "other" }),
];

async function renderScreen(props: Partial<Parameters<typeof SessionsScreen>[0]> = {}) {
	mockGet.mockResolvedValue({ snapshots: [], sessions: SESSIONS, generatedAt: NOW } satisfies AgentRateLimitsReport);
	const onOpenTask = vi.fn();
	render(
		<I18nProvider>
			<SessionsScreen projectId="p1" projectName="dev-3.0" onOpenTask={onOpenTask} {...props} />
		</I18nProvider>,
	);
	await act(async () => {});
	return { onOpenTask };
}

const titles = () =>
	within(screen.getByRole("table"))
		.getAllByRole("row")
		.slice(1)
		.map((row) => row.querySelector("td button")?.textContent ?? "")
		.filter(Boolean);

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
	setStreamerMode(false);
	setSensitiveProjectIds([]);
});

describe("SessionsScreen", () => {
	it("starts on the project it was opened from, attention first", async () => {
		await renderScreen();
		expect(titles()).toEqual(["#33Gamma", "#22Beta", "#11Alpha"]);
		expect(screen.queryByRole("columnheader", { name: "Project" })).toBeNull();
	});

	it("sorts by a column and flips direction on a second click", async () => {
		await renderScreen();
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "Cost" }));
		expect(titles()).toEqual(["#22Beta", "#11Alpha", "#33Gamma"]);
		await user.click(screen.getByRole("button", { name: /Cost/ }));
		expect(titles()).toEqual(["#33Gamma", "#11Alpha", "#22Beta"]);
		expect(screen.getByRole("columnheader", { name: /Cost/ }).getAttribute("aria-sort")).toBe("ascending");
	});

	it("lists every project, naming each row's project under its title, when opened outside one", async () => {
		await renderScreen({ projectId: null, projectName: null });
		expect(titles()).toHaveLength(4);
		const delta = screen.getByText("Delta").closest("tr")!;
		expect(within(delta).getByText("other")).toBeTruthy();
	});

	it("searches by title and by #number", async () => {
		await renderScreen();
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const search = screen.getByRole("searchbox");
		await user.type(search, "alp");
		expect(titles()).toEqual(["#11Alpha"]);
		await user.clear(search);
		await user.type(search, "#22");
		expect(titles()).toEqual(["#22Beta"]);
		await user.clear(search);
		await user.type(search, "nothing");
		expect(screen.getByText("No sessions match this search.")).toBeTruthy();
	});

	it("opens the task from its row and reveals the statusline details on demand", async () => {
		const { onOpenTask } = await renderScreen();
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "#11 Alpha" }));
		expect(onOpenTask).toHaveBeenCalledWith("a", "p1");
		expect(screen.queryByText(/turn 2 in/)).toBeNull();
		await user.click(screen.getByRole("button", { name: "Details: Alpha" }));
		expect(screen.getByText(/turn 2 in/)).toBeTruthy();
	});

	it("explains how sessions get here when there are none", async () => {
		mockGet.mockResolvedValue({ snapshots: [], generatedAt: NOW });
		render(
			<I18nProvider>
				<SessionsScreen projectId={null} projectName={null} onOpenTask={() => {}} />
			</I18nProvider>,
		);
		await act(async () => {});
		expect(screen.getByText("No agent task sessions in the last 6 hours.")).toBeTruthy();
	});

	it("masks a sensitive project's titles and name in streamer mode", async () => {
		setStreamerMode(true);
		setSensitiveProjectIds(["p2"]);
		await renderScreen({ projectId: null, projectName: null });
		const secret = screen.getByText("Delta");
		expect(secret.className).toContain("streamer-private");
		expect(secret.closest("button")?.getAttribute("title")).toBeNull();
		const projectCell = screen.getByText("other");
		expect(projectCell.className).toContain("streamer-private");
		expect(projectCell.getAttribute("title")).toBeNull();
		expect(screen.getByText("Alpha").className).not.toContain("streamer-private");
		expect(screen.getAllByText("dev-3.0")[0].className).not.toContain("streamer-private");
	});

	it("names a sensitive project only as private in the scope picker", async () => {
		setStreamerMode(true);
		setSensitiveProjectIds(["p2"]);
		await renderScreen({ projectId: null, projectName: null });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("combobox", { name: "Projects" }));
		const options = screen.getAllByRole("option").map((o) => o.textContent);
		expect(options).toContain("Private project");
		expect(options).not.toContain("other");
	});

	it("filters to one project when opened outside one", async () => {
		await renderScreen({ projectId: null, projectName: null });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("combobox", { name: "Projects" }));
		await user.click(screen.getByRole("option", { name: "other" }));
		expect(titles()).toEqual(["#44Delta"]);
	});

	it("offers all projects when the scoped project has no sessions but others do", async () => {
		await renderScreen({ projectId: "p3", projectName: "quiet" });
		expect(screen.getByText("No sessions in this project in the last 6 hours.")).toBeTruthy();
		expect(screen.queryByText("No agent task sessions in the last 6 hours.")).toBeNull();
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("button", { name: "Show all projects" }));
		expect(titles()).toHaveLength(4);
	});

	it("has no details toggle for a session with nothing more to show", async () => {
		const bare = session("e", {
			taskTitle: "Echo",
			effort: null,
			thinking: false,
			totalTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
			turnInputTokens: null,
			turnOutputTokens: null,
			durationMs: null,
			apiDurationMs: null,
			linesAdded: null,
			linesRemoved: null,
		});
		mockGet.mockResolvedValue({ snapshots: [], sessions: [bare, SESSIONS[0]], generatedAt: NOW } satisfies AgentRateLimitsReport);
		render(
			<I18nProvider>
				<SessionsScreen projectId="p1" projectName="dev-3.0" onOpenTask={() => {}} />
			</I18nProvider>,
		);
		await act(async () => {});
		expect(screen.queryByRole("button", { name: "Details: Echo" })).toBeNull();
		expect(screen.getByRole("button", { name: "Details: Alpha" })).toBeTruthy();
	});
	it("names the login each session bills and filters by it", async () => {
		mockGet.mockResolvedValue({
			snapshots: [],
			sessions: [
				session("a", { taskTitle: "Alpha", taskSeq: 11 }),
				session("b", { taskTitle: "Beta", taskSeq: 22, accountId: "acc-1" }),
				session("c", { taskTitle: "Gamma", taskSeq: 33, accountId: "gone" }),
			],
			generatedAt: NOW,
		} satisfies AgentRateLimitsReport);
		render(
			<I18nProvider>
				<SessionsScreen projectId={null} projectName={null} onOpenTask={() => {}} />
			</I18nProvider>,
		);
		await act(async () => {});
		const table = within(screen.getByRole("table"));
		expect(table.getByText("me@example.com")).toBeTruthy();
		expect(table.getByText("work@example.com")).toBeTruthy();
		expect(table.getByText("Removed account")).toBeTruthy();
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("combobox", { name: "Accounts" }));
		await user.click(screen.getByRole("option", { name: "Claude · work@example.com" }));
		expect(titles()).toEqual(["#22Beta"]);
	});

	it("blurs every login email in streamer mode, the account picker included", async () => {
		setStreamerMode(true);
		mockGet.mockResolvedValue({
			snapshots: [],
			sessions: [session("a", { taskTitle: "Alpha", taskSeq: 11 }), session("b", { taskTitle: "Beta", taskSeq: 22, accountId: "acc-1" })],
			generatedAt: NOW,
		} satisfies AgentRateLimitsReport);
		render(
			<I18nProvider>
				<SessionsScreen projectId={null} projectName={null} onOpenTask={() => {}} />
			</I18nProvider>,
		);
		await act(async () => {});
		const cell = within(screen.getByRole("table")).getByText("work@example.com");
		expect(cell.className).toContain("streamer-private");
		expect(cell.getAttribute("title")).toBeNull();
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(screen.getByRole("combobox", { name: "Accounts" }));
		const option = within(screen.getByRole("option", { name: "Claude · work@example.com" })).getByText("work@example.com");
		expect(option.className).toContain("streamer-private");
	});

	it("offers no account filter while every session bills the same login", async () => {
		await renderScreen();
		expect(screen.queryByRole("combobox", { name: "Accounts" })).toBeNull();
	});

	it("counts the sessions that need the user in a summary tile", async () => {
		await renderScreen();
		const tile = screen.getByText("Need you").parentElement!;
		expect(within(tile).getByText("2")).toBeTruthy();
	});
});
