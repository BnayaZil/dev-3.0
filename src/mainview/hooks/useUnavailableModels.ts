import { useEffect, useState } from "react";
import type { CodingAgent } from "../../shared/types";
import { api } from "../rpc";

/**
 * The preset model slugs the signed-in account cannot select for `agent`, probed
 * from the agent CLI's own model-list command (Codex/Cursor today). The launch
 * picker flags these presets instead of offering dead entries that fail on launch.
 *
 * Returns null while loading, and whenever availability is `unknown` — no
 * model-list command, a logged-out CLI, or a failed probe. Null MUST mean "filter
 * nothing": hiding a model the user can actually use is worse than the dead entry
 * this removes. Re-probes when the selected agent OR account changes — the account
 * decides which catalog applies, so the two must stay in lockstep.
 */
export function useUnavailableModels(
	agent: CodingAgent | undefined | null,
	accountId?: string | null,
): Set<string> | null {
	const [unavailable, setUnavailable] = useState<Set<string> | null>(null);
	const agentId = agent?.id ?? null;
	useEffect(() => {
		setUnavailable(null);
		if (!agentId) return;
		let cancelled = false;
		// Invoke inside the chain so a synchronous throw (e.g. the RPC absent in a
		// test's partial api mock) becomes a caught rejection → unknown, never a
		// crash of the picker. Filtering nothing is always the safe fallback.
		Promise.resolve()
			.then(() => api.request.getAgentAvailableModels({ agentId, accountId }))
			.then((result) => {
				if (!cancelled) setUnavailable(result?.status === "resolved" ? new Set(result.unavailable) : null);
			})
			.catch(() => {
				if (!cancelled) setUnavailable(null);
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, accountId]);
	return unavailable;
}
