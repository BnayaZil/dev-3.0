# Keep-alive (auto-revive) is a task property, not a column

## Context
Users wanted a "monitoring column" on the board: drop a task in and dev3 keeps its
agent conversation alive, auto-reviving it when a proxy drops, a token/usage limit
is hit, or the provider session dies. The request was literally for a Kanban column.

## Investigation
A `TaskStatus` column is mutually exclusive — a task sits in exactly one. But a
monitored task is simultaneously `in-progress` / awaiting, so "monitored" cannot be a
column without lying about the task's real state or losing the mark the instant a
revive resumes work. The bible already settled this class (§3): `Project.sensitive`
is "in the same class as `Task.draft` / `Task.hibernated` — never a column, a kind,
or an action", and "automations never grow their own board, destination, or task
list". Backend research confirmed `resumeTaskSession` (tmux-pty.ts) is a single-flight
seam that relaunches + resumes, and the rate-limit monitor already exposes
`resetsAt`, while no "agent stalled/errored" detector exists.

## Decision
Modeled it as a cross-cutting property `Task.keepAlive` (`src/shared/types/keep-alive.ts`),
inert on its own, read only by the bun watchdog (`src/bun/task-keep-alive-scheduler.ts`)
for tasks whose agent should be running (`AGENT_TIME_STATUSES`), never for a hibernated
one. Liveness is the **agent process**, not the tmux session: panes keep a shell after
the agent exits (`keepShell`), so `taskTerminalAlive` ("session exists") would never see
a dead agent — the watchdog uses `taskMainAgentAlive` (a live non-shell child of the main
pane's launch script, reusing `scheduled-message-author`'s process-tree logic). On a dead
agent it calls `resumeTaskSession` **without** `refuseLive` (the leftover shell session
would otherwise look "live" and block the revive; `performTaskResume` tears the stale
session down first), with exponential backoff, defers to a known rate-limit `resetsAt`,
caps retries then escalates via `pushCliAttention`/`pushCliToast`. Surfaced as the user's "column" intent without a
column: a passive card marker (accent while watching, danger when it gave up) and an
`is:keepalive` board/sidebar filter. Toggled from the task context menu and the
`setTaskKeepAlive` RPC / `dev3 keep-alive` CLI, both through `updateTaskMetadata`.

## Risks
False revive of an idle-on-purpose agent (mitigated: only `AGENT_TIME_STATUSES`, never
awaiting-user/hibernated); thrashing a down provider (backoff + cap + `resetsAt`);
Codex resume can refuse (treated as a failed attempt, then give up). The MVP trigger is
the agent **process exiting** (a crash, or a provider/proxy/network error that kills it);
a still-running agent that is merely stalled or paused at a usage limit is out of scope —
the process is alive, so there is nothing to revive. The rate-limit `resetsAt` logic only
times the retry after the process has already exited, so a relaunch doesn't hit an
immediate block.

## Alternatives considered
A real status/custom column (rejected — mutual exclusivity, §3 class rule); a new
"Monitoring" destination/screen (rejected — §3 automations, nav budget spent); an
always-visible card button (rejected — card inline-action budget is full, §9). Pure
Automations spawn fresh tasks and lose conversation continuity; `/loop` dies with the
session.
