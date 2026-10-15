import {
	attentionSessions,
	formatCostUsd,
	sessionAttention,
	summarizeSessions,
	type AgentSessionStats,
} from "../../shared/session-stats";
import { useNow } from "../hooks/useNow";
import { useT } from "../i18n";
import { useProjectPrivacy } from "../sensitive-projects";
import { CacheState, contextTone } from "./session-stats-ui";

function AttentionRow({ session, now }: { session: AgentSessionStats; now: number }) {
	const t = useT();
	const privacy = useProjectPrivacy();
	const locked = privacy.isLocked(session.projectId);
	const reason = sessionAttention(session, now);
	const percent = Math.round(session.contextPercent ?? 0);
	return (
		<li className="flex items-baseline gap-1.5 rounded-md px-2 py-1 bg-raised/65">
			{session.taskSeq != null && <span className="shrink-0 tabular-nums text-fg-muted">#{session.taskSeq}</span>}
			<span
				className={`min-w-0 flex-1 truncate text-fg-2 ${privacy.maskClass(session.projectId)}`}
				title={locked ? undefined : (session.taskTitle ?? undefined)}
			>
				{session.taskTitle}
			</span>
			<span className="shrink-0 whitespace-nowrap tabular-nums">
				{reason === "cacheExpiring" ? (
					<CacheState session={session} now={now} />
				) : (
					<span className={contextTone(percent)}>{t("rateLimits.sessionContext", { percent })}</span>
				)}
			</span>
		</li>
	);
}

/**
 * The usage panel's bounded Sessions strip: one summary line, at most
 * MAX_ATTENTION_SESSIONS rows that need the user now, and the way into the full
 * Sessions screen. It never grows with the task count. Absent with no sessions.
 * Sticky to the panel's bottom edge: with many accounts the panel scrolls, and a
 * live readout must not hide below the fold.
 */
export default function UsageSessionsStrip({
	sessions,
	onOpenAll,
}: {
	sessions: readonly AgentSessionStats[];
	onOpenAll?: () => void;
}) {
	const t = useT();
	const now = useNow();
	if (sessions.length === 0) return null;
	const summary = summarizeSessions(sessions, now);
	const attention = attentionSessions(sessions, now);
	const parts = [t.plural("rateLimits.sessionsCount", summary.count)];
	if (summary.warm > 0) parts.push(t.plural("rateLimits.sessionsWarm", summary.warm));
	if (summary.costUsd != null) parts.push(formatCostUsd(summary.costUsd));
	return (
		<section
			aria-labelledby="usage-sessions-title"
			className="sticky bottom-0 -mx-1.5 -mb-1.5 space-y-1.5 border-t border-edge bg-overlay px-1.5 pt-2 pb-1.5"
		>
			<div className="flex items-center gap-2 px-2">
				<div className="min-w-0 flex-1">
					<h3 id="usage-sessions-title" className="text-fg-muted text-micro font-semibold uppercase tracking-wider">
						{t("rateLimits.sessionsTitle")}
					</h3>
					<p className="truncate tabular-nums text-fg-2">{parts.join(" · ")}</p>
				</div>
				{onOpenAll && (
					<button
						type="button"
						onClick={onOpenAll}
						className="inline-flex shrink-0 items-center gap-1 rounded-md bg-elevated px-2.5 py-1.5 font-medium text-fg-2 hover:bg-elevated-hover hover:text-fg active:scale-[0.96] transition-[background-color,color,scale]"
					>
						{t("rateLimits.sessionsAll")}
						<span aria-hidden="true">→</span>
					</button>
				)}
			</div>
			{attention.length > 0 && (
				<ul className="space-y-1">
					{attention.map((session) => (
						<AttentionRow key={session.taskId} session={session} now={now} />
					))}
				</ul>
			)}
		</section>
	);
}
