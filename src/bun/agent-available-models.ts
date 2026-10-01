/**
 * Probe an agent CLI for the models the signed-in account may actually select,
 * so the launch picker can flag presets the account cannot use (e.g. an
 * enterprise ChatGPT plan that dev3 still offers `gpt-6-sol` for). The list is
 * per-account and drifts over time, so a static list in DEFAULT_AGENTS cannot
 * track it — only the CLI's own catalog can.
 *
 * How to list the models is a pure per-adapter descriptor (`modelListProbe`);
 * this module is the impure half that spawns the command and applies it, mirroring
 * codex-model-catalog.ts. Everything here is best-effort: a missing binary, a
 * logged-out CLI, a timeout or an unreadable dump all resolve to "unknown", which
 * makes the picker filter NOTHING — hiding a model the user can use is worse than
 * the dead entry this feature removes.
 *
 * The probe MUST read the same account the launch would. A Codex launch injects
 * the selected managed account's `CODEX_HOME` (applyCodexAccountEnv →
 * getActiveCodexSessionEnv); the probe resolves it identically so a multi-account
 * user is filtered against the account that will actually run, not whatever login
 * happens to sit in `~/.codex`.
 */

import { getActiveCodexSessionEnv } from "./agent-accounts";
import { agentKey, getAgentAdapter } from "../shared/agent-adapters/registry";
import type { ModelListProbeSpec } from "../shared/agent-adapters/types";
import type { AgentFamily, AgentModelAvailability, CodingAgent } from "../shared/types";
import { spawn } from "./spawn";

/** The probe is a fast local-ish call (~300 ms for Codex), but a picker can open
 *  repeatedly; a short cache spares a spawn per open without going stale for long. */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
	at: number;
	slugs: string[] | null;
}

const cache = new Map<string, CacheEntry>();

/** The account whose catalog the probe must read, resolved exactly as a launch
 *  resolves it. Codex only: an explicit `CODEX_HOME` on the default preset wins
 *  (mirrors applyCodexAccountEnv's guard), otherwise the selected/active managed
 *  account's home. Empty for every non-Codex agent and for the system login. */
async function resolveProbeEnv(
	agent: CodingAgent,
	accountId: string | null | undefined,
): Promise<Record<string, string> | undefined> {
	if (agentKey(agent.baseCommand, agent.agentFamily) !== "codex") return undefined;
	const defaultConfig =
		agent.configurations.find((c) => c.id === agent.defaultConfigId) ?? agent.configurations[0];
	const explicitHome = defaultConfig?.envVars?.CODEX_HOME;
	if (explicitHome) return { CODEX_HOME: explicitHome };
	const accountEnv = await getActiveCodexSessionEnv(accountId);
	return Object.keys(accountEnv).length > 0 ? accountEnv : undefined;
}

async function runProbe(
	baseCommand: string,
	spec: ModelListProbeSpec,
	env: Record<string, string> | undefined,
): Promise<string[] | null> {
	const proc = spawn([baseCommand, ...spec.args], { stdout: "pipe", stderr: "ignore", env });
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Race the read against the timer: kill(9) alone does not unblock
	// `Response(stdout).text()` if a grandchild still holds stdout (an npm-wrapped
	// `codex` is a node process around the native binary), so the read could hang
	// forever. The timeout resolves null and the dangling read is left unreferenced.
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => {
			try {
				proc.kill(9);
			} catch {
				// Already gone; nothing to kill.
			}
			resolve(null);
		}, spec.timeoutMs);
	});
	const read: Promise<string[] | null> = (async () => {
		const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? spec.parse(text) : null;
	})().catch(() => null);
	try {
		return await Promise.race([read, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function availableSlugs(
	baseCommand: string,
	family: AgentFamily | undefined,
	spec: ModelListProbeSpec,
	env: Record<string, string> | undefined,
	refresh: boolean,
): Promise<string[] | null> {
	// Key on the resolved CODEX_HOME too: two accounts have two catalogs, and a
	// shared cache would serve one account's models to the other.
	const key = `${baseCommand}\u0000${family ?? ""}\u0000${env?.CODEX_HOME ?? ""}`;
	const hit = cache.get(key);
	if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.slugs;
	const slugs = await runProbe(baseCommand, spec, env);
	cache.set(key, { at: Date.now(), slugs });
	return slugs;
}

/** For tests: forget every cached probe so a fresh spawn runs next time. */
export function clearAvailableModelsCache(): void {
	cache.clear();
}

/**
 * Which of `agent`'s preset models the account cannot select. Returns `unknown`
 * (→ picker filters nothing) when the agent has no model-list command, the probe
 * fails, or it reports an empty catalog (an empty list is never trusted to mean
 * "you have no models"). Routed presets — bound to model roles or the pxpipe
 * proxy — are exempt: their model legitimately need not appear in the account's
 * native catalog. `accountId` selects the account to probe, matching the picker's
 * per-launch account selector; omitted means the registry's active account.
 */
export async function resolveModelAvailability(
	agent: CodingAgent,
	opts: { accountId?: string | null; refresh?: boolean } = {},
): Promise<AgentModelAvailability> {
	const spec = getAgentAdapter(agent.baseCommand, agent.agentFamily).modelListProbe;
	if (!spec) return { status: "unknown" };

	const env = await resolveProbeEnv(agent, opts.accountId);
	const slugs = await availableSlugs(agent.baseCommand, agent.agentFamily, spec, env, opts.refresh ?? false);
	if (!slugs || slugs.length === 0) return { status: "unknown" };

	const normalize = spec.normalize ?? ((slug: string) => slug);
	const available = new Set(slugs.map(normalize));

	const unavailable: string[] = [];
	const seen = new Set<string>();
	for (const config of agent.configurations) {
		if (!config.model) continue;
		if (config.requiresPxpipeProxy) continue;
		if (config.modelRoles && Object.keys(config.modelRoles).length > 0) continue;
		if (available.has(normalize(config.model))) continue;
		if (seen.has(config.model)) continue;
		seen.add(config.model);
		unavailable.push(config.model);
	}
	return { status: "resolved", unavailable };
}
