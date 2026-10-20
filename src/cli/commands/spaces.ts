import type { CliResponse, Project, SpacesFile } from "../../shared/types";
import { CLI_EXIT_CODE_SPACE_REF_INVALID } from "../../shared/cli-exit-codes";
import {
	SPACE_REF_INVALID_PREFIX,
	shortSpaceId,
	toCliSpaces,
	type CliProject,
	type CliSpace,
	type ProjectSpacesChangeMode,
	type ProjectSpacesChangeResult,
} from "../../shared/project-registration";
import { sendRequest } from "../socket-client";
import { printTable, exitError, exitUsage } from "../output";
import type { ParsedArgs } from "../args";
import { expandShortProjectId, resolveProjectId, type CliContext } from "../context";
import { rejectUnknownFlags } from "../flag-validation";

const PROJECT_REQUIRED = "--project <id> is required (or run from the project's worktree or checkout)";

/**
 * `parseArgs` gives a bare flag the next word as its value, so `--no-space foo`
 * would swallow `foo`. For flags that never take one, hand that word back.
 */
export function withBooleanFlags(args: ParsedArgs, keys: readonly string[]): ParsedArgs {
	const flags = { ...args.flags };
	const positional = [...args.positional];
	for (const key of keys) {
		const value = flags[key];
		if (value === undefined || value === "true") continue;
		flags[key] = "true";
		positional.push(value);
	}
	return { ...args, flags, positional };
}

/** A value flag's value, or undefined; a bare `--flag` (parsed as "true") is a usage error. */
export function flagValue(args: ParsedArgs, key: string): string | undefined {
	const value = args.flags[key];
	if (value === undefined) return undefined;
	if (value === "true") exitUsage(`--${key} needs a value`);
	return value;
}

/** Every value of a repeatable flag, in order. */
export function flagValues(args: ParsedArgs, key: string): string[] {
	const values = args.repeated?.[key] ?? (args.flags[key] === undefined ? [] : [args.flags[key]]);
	if (values.includes("true")) exitUsage(`--${key} needs a value`);
	return values;
}

/** The app predates the method — it is older than this CLI. */
export function isUnknownMethod(resp: CliResponse): boolean {
	return !resp.ok && (resp.error ?? "").startsWith("Unknown method:");
}

/**
 * Exit for a failed request, with the dedicated code when the app refused a
 * space reference. `hint` is what the caller can do about that refusal.
 */
export function exitRequestFailed(resp: CliResponse, fallback: string, spaceHint?: string): never {
	const error = resp.error || fallback;
	if (error.startsWith(SPACE_REF_INVALID_PREFIX)) {
		exitError(error.slice(SPACE_REF_INVALID_PREFIX.length), spaceHint, CLI_EXIT_CODE_SPACE_REF_INVALID);
	}
	if (isUnknownMethod(resp)) {
		exitError(error, "The running dev3 app is older than this CLI. Update or restart the app, then retry.");
	}
	exitError(error);
}

export function spaceNames(project: CliProject): string {
	return project.spaces.length > 0 ? project.spaces.map((s) => s.name).join(", ") : "(none)";
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function listSpaces(args: ParsedArgs, socketPath: string): Promise<void> {
	rejectUnknownFlags(args, ["json"]);
	const spacesResp = await sendRequest(socketPath, "spaces.list");
	if (!spacesResp.ok) exitRequestFailed(spacesResp, "Failed to list spaces");
	const projectsResp = await sendRequest(socketPath, "projects.list");
	if (!projectsResp.ok) exitRequestFailed(projectsResp, "Failed to list projects");

	const spaces = toCliSpaces(spacesResp.data as SpacesFile, projectsResp.data as Project[]);
	if ("json" in args.flags) return printJson(spaces);
	if (spaces.length === 0) {
		process.stdout.write('No spaces. Create one with: dev3 spaces create "name" --project <id>\n');
		return;
	}
	printTable(
		["ID", "NAME", "PROJECTS"],
		spaces.map((s) => [
			shortSpaceId(s.id),
			s.name,
			s.projects.length > 0 ? s.projects.map((p) => `${p.name} (${p.id.slice(0, 8)})`).join(", ") : "-",
		]),
	);
}

async function createSpace(args: ParsedArgs, socketPath: string, context: CliContext | null): Promise<void> {
	rejectUnknownFlags(args, ["project", "name", "json"]);
	const name = (flagValue(args, "name") ?? args.positional[0] ?? "").trim();
	if (!name || args.positional.length > 1) {
		exitUsage('Usage: dev3 spaces create "name" [--project <id>]...  (quote a name with spaces)');
	}
	const named = flagValues(args, "project");
	const projectIds = named.length > 0
		? named.map((id) => expandShortProjectId(id, context))
		: [resolveProjectId(undefined, context)].filter((id): id is string => Boolean(id));
	if (projectIds.length === 0) exitUsage(`A space is never empty: ${PROJECT_REQUIRED}`);

	const resp = await sendRequest(socketPath, "spaces.create", { name, projectIds });
	if (!resp.ok) exitRequestFailed(resp, "Failed to create space", "Add a project to the existing space with: dev3 spaces add <space> --project <id>");

	const space = resp.data as CliSpace;
	if ("json" in args.flags) return printJson(space);
	process.stdout.write(
		`Created space ${shortSpaceId(space.id)} "${space.name}" with ${space.projects.map((p) => `${p.name} (${p.id.slice(0, 8)})`).join(", ")}\n`,
	);
}

const CHANGE_USAGE: Record<ProjectSpacesChangeMode, string> = {
	set: "Usage: dev3 spaces set <space> [<space>...] [--project <id>]  (REPLACES all of the project's spaces)\n" +
		'Use "dev3 spaces add" to keep the existing ones, "dev3 spaces set --no-space" to leave every space.',
	add: "Usage: dev3 spaces add <space> [<space>...] [--project <id>]",
	remove: "Usage: dev3 spaces remove <space> [<space>...] [--project <id>]",
};

/**
 * `spaces set` REPLACES the project's whole membership; `spaces add` /
 * `spaces remove` change only the named spaces — the same split as `label`.
 */
async function changeSpaces(
	mode: ProjectSpacesChangeMode,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	rejectUnknownFlags(args, mode === "set" ? ["project", "json", "no-space"] : ["project", "json"]);
	const projectId = resolveProjectId(flagValue(args, "project"), context);
	if (!projectId) exitUsage(PROJECT_REQUIRED);

	const refs = args.positional;
	const noSpace = "no-space" in args.flags;
	if (noSpace && refs.length > 0) exitUsage("--no-space cannot be combined with a space");
	if (!noSpace && refs.length === 0) exitUsage(CHANGE_USAGE[mode]);

	const resp = await sendRequest(socketPath, "spaces.change", { projectId, mode, spaces: refs });
	if (!resp.ok) exitRequestFailed(resp, `Failed to ${mode} spaces`, 'See every space with: dev3 spaces list. A new one: dev3 spaces create "name" --project <id>');

	const result = resp.data as ProjectSpacesChangeResult;
	if ("json" in args.flags) return printJson(result);
	const { project } = result;
	process.stdout.write(
		project.spaces.length > 0
			? `Project ${project.id.slice(0, 8)} "${project.name}" is now in: ${spaceNames(project)}\n`
			: `Project ${project.id.slice(0, 8)} "${project.name}" is now in no space\n`,
	);
	for (const space of result.deletedSpaces) {
		process.stdout.write(`Space "${space.name}" had no projects left and was deleted.\n`);
	}
}

export async function handleSpaces(
	subcommand: string | undefined,
	args: ParsedArgs,
	socketPath: string,
	context: CliContext | null,
): Promise<void> {
	args = withBooleanFlags(args, ["json", "no-space"]);
	switch (subcommand) {
		case undefined:
		case "list":
			return listSpaces(args, socketPath);
		case "create":
			return createSpace(args, socketPath, context);
		case "set":
		case "add":
		case "remove":
			return changeSpaces(subcommand, args, socketPath, context);
		default:
			exitUsage(`Unknown subcommand: spaces ${subcommand}\nAvailable: spaces list, spaces create, spaces set, spaces add, spaces remove`);
	}
}
