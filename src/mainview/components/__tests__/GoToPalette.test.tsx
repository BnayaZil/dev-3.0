import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "../../i18n";
import GoToPalette, { type GoToMode } from "../GoToPalette";
import type { Project, Task } from "../../../shared/types";

const getAllProjectTasks = vi.fn();
vi.mock("../../rpc", () => ({
	api: {
		request: {
			getAgents: vi.fn(() => Promise.resolve([])),
			getSpaces: vi.fn(() => Promise.resolve({ version: 1, spaces: [], order: [] })),
			getAllProjectTasks: (...args: unknown[]) => getAllProjectTasks(...args),
		},
	},
}));

function project(id: string, name: string): Project {
	return { id, name, path: `/tmp/${id}`, setupScript: "", devScript: "", cleanupScript: "", defaultBaseBranch: "main", createdAt: "" };
}

function task(id: string, seq: number, projectId: string, over: Partial<Task> = {}): Task {
	return { id, seq, projectId, title: `Task ${id}`, status: "in-progress", worktreePath: `/tmp/${id}`, ...over } as Task;
}

const PROJECTS: Project[] = [project("p1", "users-service"), project("p2", "auth-gateway"), project("p3", "billing")];
const PROJECT_BY_ID = new Map(PROJECTS.map((p) => [p.id, p]));

interface HarnessProps {
	initialMode?: GoToMode;
	tasks?: Task[];
	onSelectProject?: (id: string) => void;
	onSelectTask?: (t: Task) => void;
	onClose?: () => void;
	shortcutIndexById?: Record<string, number>;
}

function Harness({ initialMode = "project", tasks = [], onSelectProject = vi.fn(), onSelectTask = vi.fn(), onClose = vi.fn(), shortcutIndexById }: HarnessProps) {
	const [mode, setMode] = useState<GoToMode>(initialMode);
	getAllProjectTasks.mockResolvedValue([{ projectId: "p1", tasks: tasks.filter((t) => t.projectId === "p1"), todoCount: 0 }, { projectId: "p2", tasks: tasks.filter((t) => t.projectId === "p2"), todoCount: 0 }]);
	return (
		<I18nProvider>
			<GoToPalette
				mode={mode}
				onModeChange={setMode}
				projects={PROJECTS}
				shortcutIndexById={shortcutIndexById}
				projectById={PROJECT_BY_ID}
				taskPorts={new Map()}
				onSelectProject={onSelectProject}
				onSelectSpace={vi.fn()}
				onSelectTask={onSelectTask}
				onClose={onClose}
			/>
		</I18nProvider>
	);
}

beforeEach(() => {
	document.body.innerHTML = "";
	getAllProjectTasks.mockReset();
	try {
		localStorage.clear();
	} catch {
		/* ignore */
	}
});

describe("GoToPalette — project mode", () => {
	it("lists projects and filters as the user types", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		expect(screen.getByText("users-service")).toBeTruthy();
		expect(screen.getByText("billing")).toBeTruthy();
		await user.type(screen.getByRole("textbox"), "auth");
		const options = screen.getAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0].textContent).toContain("auth-gateway");
	});

	it("selects the top match on Enter and closes on Escape", async () => {
		const user = userEvent.setup();
		const onSelectProject = vi.fn();
		const onClose = vi.fn();
		render(<Harness onSelectProject={onSelectProject} onClose={onClose} />);
		await user.type(screen.getByRole("textbox"), "users");
		await user.keyboard("{Enter}");
		expect(onSelectProject).toHaveBeenCalledWith("p1");
		await user.keyboard("{Escape}");
		expect(onClose).toHaveBeenCalled();
	});

	it("renders the ⌘N badge from the board index", () => {
		render(<Harness shortcutIndexById={{ p1: 0, p2: 1, p3: 2 }} />);
		const options = screen.getAllByRole("option");
		expect(options[0].textContent).toContain("users-service");
		expect(options[0].textContent).toContain("⌘1");
	});
});

describe("GoToPalette — task mode", () => {
	it("loads cross-project tasks, newest-seq first, and opens one on Enter", async () => {
		const user = userEvent.setup();
		const onSelectTask = vi.fn();
		render(<Harness initialMode="task" tasks={[task("a", 1, "p1", { title: "Fix login" }), task("b", 7, "p2", { title: "Refactor billing" })]} onSelectTask={onSelectTask} />);
		await screen.findByText("Fix login");
		const options = screen.getAllByRole("option");
		// Higher seq (7) first with no recency recorded.
		expect(options[0].textContent).toContain("Refactor billing");
		await user.keyboard("{Enter}");
		expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "b" }));
	});

	it("filters with a token-DSL query (reuses the sidebar engine)", async () => {
		const user = userEvent.setup();
		render(<Harness initialMode="task" tasks={[task("a", 1, "p1", { title: "Visible one", status: "in-progress" }), task("b", 2, "p1", { title: "Hidden one", hidden: true })]} />);
		await screen.findByText("Visible one");
		await user.type(screen.getByRole("textbox"), "is:hidden");
		await waitFor(() => {
			const rows = screen.getAllByRole("option");
			expect(rows).toHaveLength(1);
			expect(rows[0].textContent).toContain("Hidden one");
		});
	});

	it("shows a loading state until the task pool resolves", async () => {
		let resolve: (v: unknown) => void = () => {};
		getAllProjectTasks.mockReturnValue(new Promise((r) => { resolve = r; }));
		render(
			<I18nProvider>
				<GoToPalette mode="task" onModeChange={vi.fn()} projects={PROJECTS} projectById={PROJECT_BY_ID} taskPorts={new Map()} onSelectProject={vi.fn()} onSelectSpace={vi.fn()} onSelectTask={vi.fn()} onClose={vi.fn()} />
			</I18nProvider>,
		);
		expect(screen.getByText("Loading tasks…")).toBeTruthy();
		resolve([{ projectId: "p1", tasks: [task("a", 1, "p1", { title: "Arrived" })], todoCount: 0 }]);
		expect(await screen.findByText("Arrived")).toBeTruthy();
	});
});

describe("GoToPalette — combined mode and switching", () => {
	it("lists both projects and tasks in combined mode", async () => {
		render(<Harness initialMode="combined" tasks={[task("a", 1, "p1", { title: "Combined task" })]} />);
		await screen.findByText("Combined task");
		expect(screen.getByText("users-service")).toBeTruthy();
	});

	it("interleaves projects and tasks by the unified visit timeline in combined mode", async () => {
		// Visit order (newest first): Task A, project p2 (auth-gateway), Task B.
		localStorage.setItem("dev3-recent-nav-v1", JSON.stringify(["t:a", "p:p2", "t:b"]));
		render(<Harness initialMode="combined" tasks={[task("a", 1, "p1", { title: "Task A" }), task("b", 2, "p2", { title: "Task B" })]} />);
		await screen.findByText("Task A");
		const rows = screen.getAllByRole("option").map((r) => r.textContent ?? "");
		// A task, then a project, then a task — mixed, not all-projects-then-all-tasks.
		expect(rows[0]).toContain("Task A");
		expect(rows[1]).toContain("auth-gateway");
		expect(rows[2]).toContain("Task B");
	});

	it("switches mode on a strip click and on Tab", async () => {
		const user = userEvent.setup();
		render(<Harness initialMode="project" tasks={[task("a", 1, "p1", { title: "Switched-to task" })]} />);
		// Start in projects mode: the project rows are there, the task is not.
		expect(screen.getByText("users-service")).toBeTruthy();
		expect(screen.queryByText("Switched-to task")).toBeNull();
		// Click the Tasks tab on the mode strip.
		await user.click(screen.getByTestId("go-to-mode-task"));
		expect(await screen.findByText("Switched-to task")).toBeTruthy();
		// Tab from Tasks cycles to Combined, where projects are listed again.
		await user.keyboard("{Tab}");
		await waitFor(() => expect(screen.getByText("users-service")).toBeTruthy());
	});
});
