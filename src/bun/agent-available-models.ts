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
 */

import { getAgentAdapter } from "../shared/agent-adapters/registry";
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

function cacheKey(baseCommand: string, family: AgentFamily | undefined): string {
	return `${baseCommand}\u0000${family ?? ""}`;
}

async function runProbe(baseCommand: string, spec: ModelListProbeSpec): Promise<string[] | null> {
	const proc = spawn([baseCommand, ...spec.args], { stdout: "pipe", stderr: "ignore" });
	const timer = setTimeout(() => {
		try {
			proc.kill(9);
		} catch {
			// Already gone; nothing to kill.
		}
	}, spec.timeoutMs);
	try {
		const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) return null;
		return spec.parse(text);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

async function availableSlugs(
	baseCommand: string,
	family: AgentFamily | undefined,
	spec: ModelListProbeSpec,
	refresh: boolean,
): Promise<string[] | null> {
	const key = cacheKey(baseCommand, family);
	const hit = cache.get(key);
	if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.slugs;
	const slugs = await runProbe(baseCommand, spec);
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
 * native catalog.
 */
export async function resolveModelAvailability(agent: CodingAgent, refresh = false): Promise<AgentModelAvailability> {
	const spec = getAgentAdapter(agent.baseCommand, agent.agentFamily).modelListProbe;
	if (!spec) return { status: "unknown" };

	const slugs = await availableSlugs(agent.baseCommand, agent.agentFamily, spec, refresh);
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
