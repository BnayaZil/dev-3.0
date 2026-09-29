import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock spawn before importing the module under test: resolveModelAvailability
// spawns the agent CLI, and the test drives its stdout/exit code.
vi.mock("../spawn", () => ({
	spawn: vi.fn(),
	spawnSync: vi.fn(),
}));

import { resolveModelAvailability, clearAvailableModelsCache } from "../agent-available-models";
import { codexAdapter } from "../../shared/agent-adapters/codex";
import { cursorAdapter } from "../../shared/agent-adapters/cursor";
import { spawn } from "../spawn";
import type { CodingAgent } from "../../shared/types";

const mockSpawn = spawn as unknown as ReturnType<typeof vi.fn>;

/** A fake Bun subprocess whose stdout is a fixed string. */
function fakeProc(stdout: string, exitCode = 0) {
	return { stdout, exited: Promise.resolve(exitCode), kill: vi.fn() };
}

function codexAgent(models: string[]): CodingAgent {
	return {
		id: "builtin-codex",
		name: "Codex",
		baseCommand: "codex",
		configurations: models.map((model, i) => ({ id: `c${i}`, name: model, model })),
	};
}

const CODEX_DUMP = JSON.stringify({
	models: [
		{ slug: "gpt-6-astra", visibility: "list", supported_in_api: true },
		{ slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true },
		{ slug: "gpt-5.4", visibility: "hide", supported_in_api: true },
		{ slug: "gpt-api-only", visibility: "list", supported_in_api: false },
	],
});

beforeEach(() => {
	vi.clearAllMocks();
	clearAvailableModelsCache();
});

describe("codex modelListProbe.parse", () => {
	const parse = codexAdapter.modelListProbe!.parse;

	it("keeps only visibility=list AND supported_in_api slugs", () => {
		expect(parse(CODEX_DUMP)).toEqual(["gpt-6-astra", "gpt-5.6-sol"]);
	});

	it("returns null on non-JSON so a broken dump filters nothing", () => {
		expect(parse("not json")).toBeNull();
	});

	it("returns null when there is no models array", () => {
		expect(parse(JSON.stringify({ foo: 1 }))).toBeNull();
	});

	it("has no normalize — Codex compares on the exact base slug", () => {
		expect(codexAdapter.modelListProbe!.normalize).toBeUndefined();
	});
});

describe("cursor modelListProbe", () => {
	const probe = cursorAdapter.modelListProbe!;

	it("parses `slug - Display Name` rows and skips the header", () => {
		const out = "Available models\n\nauto - Auto (default)\ngpt-5.6-sol-high - GPT-5.6 Sol 1M High\n";
		expect(probe.parse(out)).toEqual(["auto", "gpt-5.6-sol-high"]);
	});

	it("normalize folds effort/speed suffixes to the base family", () => {
		const n = probe.normalize!;
		expect(n("gpt-5.6-sol-xhigh")).toBe("gpt-5.6-sol");
		expect(n("gpt-5.6-sol-high")).toBe("gpt-5.6-sol");
		expect(n("cursor-grok-4.6-high-fast")).toBe("cursor-grok-4.6");
		expect(n("claude-opus-5-thinking-high")).toBe("claude-opus-5");
		// A slug with no effort suffix is left whole.
		expect(n("composer-2.5")).toBe("composer-2.5");
	});
});

describe("resolveModelAvailability", () => {
	it("flags Codex preset models the account cannot select", async () => {
		mockSpawn.mockReturnValue(fakeProc(CODEX_DUMP));
		const agent = codexAgent(["gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol"]);
		const result = await resolveModelAvailability(agent);
		expect(result).toEqual({ status: "resolved", unavailable: ["gpt-6-sol"] });
	});

	it("treats a Cursor xhigh preset as available when the base family is listed", async () => {
		// The account lists gpt-5.6-sol-high (not -xhigh); base-family match keeps the
		// dev3 preset gpt-5.6-sol-xhigh available, and flags an absent family.
		mockSpawn.mockReturnValue(fakeProc("Available models\n\ngpt-5.6-sol-high - GPT-5.6 Sol\n"));
		const agent: CodingAgent = {
			id: "builtin-cursor",
			name: "Cursor",
			baseCommand: "agent",
			configurations: [
				{ id: "a", name: "sol", model: "gpt-5.6-sol-xhigh" },
				{ id: "b", name: "grok", model: "cursor-grok-4.6-high-fast" },
			],
		};
		const result = await resolveModelAvailability(agent);
		expect(result).toEqual({ status: "resolved", unavailable: ["cursor-grok-4.6-high-fast"] });
	});

	it("returns unknown for an empty catalog rather than flagging everything", async () => {
		mockSpawn.mockReturnValue(fakeProc(JSON.stringify({ models: [] })));
		const result = await resolveModelAvailability(codexAgent(["gpt-6-sol"]));
		expect(result).toEqual({ status: "unknown" });
	});

	it("returns unknown on a non-zero exit", async () => {
		mockSpawn.mockReturnValue(fakeProc("", 1));
		const result = await resolveModelAvailability(codexAgent(["gpt-6-sol"]));
		expect(result).toEqual({ status: "unknown" });
	});

	it("returns unknown for an agent whose CLI has no model-list command", async () => {
		const agent: CodingAgent = {
			id: "builtin-gemini",
			name: "Gemini",
			baseCommand: "gemini",
			configurations: [{ id: "g", name: "pro", model: "gemini-3.1-pro-preview" }],
		};
		const result = await resolveModelAvailability(agent);
		expect(result).toEqual({ status: "unknown" });
		expect(mockSpawn).not.toHaveBeenCalled();
	});

	it("exempts routed presets (model roles) from the filter", async () => {
		mockSpawn.mockReturnValue(fakeProc(CODEX_DUMP));
		const agent: CodingAgent = {
			id: "builtin-codex",
			name: "Codex",
			baseCommand: "codex",
			configurations: [
				{ id: "routed", name: "routed", model: "some-routed-model", modelRoles: { main: "x" } },
				{ id: "dead", name: "dead", model: "gpt-6-sol" },
			],
		};
		const result = await resolveModelAvailability(agent);
		expect(result).toEqual({ status: "resolved", unavailable: ["gpt-6-sol"] });
	});
});
