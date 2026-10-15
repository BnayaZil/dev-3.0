import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { AgentAccountsState } from "../../shared/agent-accounts";
import { shortClaudeConfigDir } from "../../shared/agent-accounts";
import {
	CONTEXT_ATTENTION_PERCENT,
	formatDurationMs,
	formatTokenCount,
	isSessionCacheWarm,
	sessionAttention,
	type AgentSessionStats,
} from "../../shared/session-stats";
import { useLocale, useT, type TFunction } from "../i18n";
import { api } from "../rpc";
import { AGENT_ACCOUNTS_CHANGED_EVENT, usePinnedClaudeLogins } from "./AgentAccountIndicator";

/** Context fills earlier than a limit window matters, so it escalates at 60/85, not 80/95. */
export function contextTone(percent: number): string {
	if (percent >= CONTEXT_ATTENTION_PERCENT) return "text-danger";
	if (percent >= 60) return "text-warning-strong";
	return "text-fg-2";
}

function contextFill(percent: number): string {
	if (percent >= CONTEXT_ATTENTION_PERCENT) return "bg-danger";
	if (percent >= 60) return "bg-warning";
	return "bg-accent";
}

export function ContextBar({ percent, wide = false }: { percent: number; wide?: boolean }) {
	const clamped = Math.max(0, Math.min(100, percent));
	return (
		<span
			aria-hidden="true"
			className={`relative inline-block overflow-hidden rounded-full bg-fg/10 align-middle ${wide ? "h-1.5 w-16" : "h-1 w-10"}`}
		>
			<span
				className={`absolute inset-y-0 left-0 rounded-full ${contextFill(percent)}`}
				style={{ width: `${clamped}%`, minWidth: clamped > 0 ? "0.2rem" : undefined }}
			/>
		</span>
	);
}

/** Warm/cold with TTL and expiry; an expiry the user can still save reads as a countdown. */
export function CacheState({ session, now }: { session: AgentSessionStats; now: number }) {
	const t = useT();
	const [locale] = useLocale();
	const cache = session.cache;
	const tone = (cls: string) => cls;
	if (!cache) return <span className={tone("text-fg-muted")}>-</span>;
	if (!isSessionCacheWarm(cache, now)) return <span className={tone("text-fg-muted")}>{t("rateLimits.sessionCacheCold")}</span>;
	if (sessionAttention(session, now) === "cacheExpiring") {
		return (
			<span className={tone("text-warning-strong")}>
				{t("rateLimits.sessionCacheExpiresIn", { time: formatDurationMs(Math.max(0, cache.expiresAt! - now)) })}
			</span>
		);
	}
	if (cache.expiresAt == null) return <span className={tone("text-accent")}>{t("rateLimits.sessionCacheWarm")}</span>;
	const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(cache.expiresAt);
	return (
		<span className={tone("text-accent")}>
			{cache.ttl
				? t("rateLimits.sessionCacheWarmTtlUntil", { ttl: cache.ttl, time })
				: t("rateLimits.sessionCacheWarmUntil", { time })}
		</span>
	);
}

/** Everything the statusLine reports beyond the table's columns, one node per field. */
export function sessionDetailItems(session: AgentSessionStats, t: TFunction): ReactNode[] {
	const items: ReactNode[] = [];
	const push = (key: string, node: ReactNode) => items.push(<span key={key}>{node}</span>);
	if (session.sessionName) push("sessionName", <span className="text-fg-2 streamer-private">{session.sessionName}</span>);
	if (session.totalTokens != null) {
		push("tokens", t("rateLimits.sessionTokens", { tokens: formatTokenCount(session.totalTokens) }));
	}
	if (session.turnInputTokens || session.turnOutputTokens) {
		push(
			"turn",
			t("rateLimits.sessionTurn", {
				input: formatTokenCount(session.turnInputTokens ?? 0),
				output: formatTokenCount(session.turnOutputTokens ?? 0),
			}),
		);
	}
	if (session.cacheReadTokens != null || session.cacheWriteTokens != null) {
		push(
			"cacheTokens",
			t("rateLimits.sessionCacheTokens", {
				read: formatTokenCount(session.cacheReadTokens ?? 0),
				write: formatTokenCount(session.cacheWriteTokens ?? 0),
			}),
		);
	}
	if (session.cache?.hitRatio != null) {
		push("hit", t("rateLimits.sessionCacheHit", { percent: Math.round(session.cache.hitRatio * 100) }));
	}
	if (session.durationMs) {
		push(
			"duration",
			t("rateLimits.sessionDuration", {
				time: formatDurationMs(session.durationMs),
				api: formatDurationMs(session.apiDurationMs ?? 0),
			}),
		);
	}
	if (session.linesAdded || session.linesRemoved) {
		push("lines", t("rateLimits.sessionLines", { added: session.linesAdded ?? 0, removed: session.linesRemoved ?? 0 }));
	}
	if (session.effort) push("effort", t("rateLimits.sessionEffort", { level: session.effort }));
	if (session.thinking) push("thinking", t("rateLimits.sessionThinking"));
	return items;
}

/** A row's disclosure; renders nothing when the session has no extra fields. */
export function SessionDetails({ session }: { session: AgentSessionStats }) {
	const t = useT();
	const items = sessionDetailItems(session, t);
	if (items.length === 0) return null;
	return <div className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums text-fg-3">{items}</div>;
}

/**
 * Names the login a session bills, from the dump envelope: a managed account by its
 * label, a project-pinned config dir by its email, else the default login.
 */
export function useSessionAccountLabel(): (session: AgentSessionStats) => string {
	const t = useT();
	const [accounts, setAccounts] = useState<AgentAccountsState | null>(null);
	const pinnedLogins = usePinnedClaudeLogins();
	useEffect(() => {
		let cancelled = false;
		function reload() {
			Promise.resolve()
				.then(() => api.request.listAgentAccounts())
				.then((next) => {
					if (!cancelled && next) setAccounts(next);
				})
				.catch(() => {});
		}
		reload();
		window.addEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, reload);
		return () => {
			cancelled = true;
			window.removeEventListener(AGENT_ACCOUNTS_CHANGED_EVENT, reload);
		};
	}, []);
	return useCallback(
		(session: AgentSessionStats) => {
			if (session.configDir) {
				const pinned = pinnedLogins.find((login) => login.configDir === session.configDir);
				return pinned?.identity?.email ?? shortClaudeConfigDir(session.configDir);
			}
			if (session.accountId) {
				const account = accounts?.claude.accounts.find((a) => a.id === session.accountId);
				return account ? account.label || account.identity?.email || account.id : t("sessions.accountRemoved");
			}
			return accounts?.claude.systemIdentity?.email ?? t("sessions.accountDefault");
		},
		[accounts, pinnedLogins, t],
	);
}

/** The prompt cache as a pill for the Sessions screen: the column header already says
 *  "prompt cache", so the pill says only the state, its expiry and the TTL. */
export function CachePill({ session, now }: { session: AgentSessionStats; now: number }) {
	const t = useT();
	const [locale] = useLocale();
	const cache = session.cache;
	if (!cache) return <span className="text-fg-muted">-</span>;
	const warm = isSessionCacheWarm(cache, now);
	const expiring = warm && sessionAttention(session, now) === "cacheExpiring";
	const label = !warm
		? t("sessions.cache.cold")
		: expiring
			? t("sessions.cache.expiresIn", { time: formatDurationMs(Math.max(0, cache.expiresAt! - now)) })
			: cache.expiresAt != null
				? t("sessions.cache.warmUntil", {
						time: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(cache.expiresAt),
					})
				: t("sessions.cache.warm");
	const pill = !warm ? "bg-fg/5 text-fg-muted" : expiring ? "bg-warning/15 text-warning-strong" : "bg-accent/10 text-accent";
	const dot = !warm ? "bg-fg-muted/60" : expiring ? "bg-warning" : "bg-accent";
	return (
		<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
			<span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${pill}`}>
				<span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />
				{label}
			</span>
			{warm && cache.ttl && <span className="text-xs text-fg-muted">{cache.ttl}</span>}
		</span>
	);
}
