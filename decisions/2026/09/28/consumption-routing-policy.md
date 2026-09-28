# Consumption routing: an account policy for launches nobody hand-picked

Design record. No code ships with it; the implementation is a separate task, in phases.

## Context

dev3 holds several accounts per harness (Claude `CLAUDE_CONFIG_DIR` logins and API profiles,
Codex `CODEX_HOME` logins) and reads every account's limit windows, but nothing uses those
readings to decide anything. "Default" is four independent settings: the global preset
(`defaultAgentId`/`defaultConfigId`), the per-project AI-review column preset, one default
account per harness (`activeId`, a preselect only), and the launch profiles designed in
`agent-launch-profiles` but not built.

So every launch nobody hand-picks — an agent-requested launch that approves itself after a
minute, an automation, the AI-review column agent, a "Start in…" launch — lands on the default
account whatever its headroom. When a limit hits mid-task, Claude parks the task
(`stopfailure-parks-the-task`) and waits for a human; Codex shows nothing. Round-robin
distribution was deferred in `per-launch-agent-account-selection` and never built.

## Investigation

- One function already decides "no account chosen → default": `resolveAccountIdOverride`
  (`src/bun/agent-accounts.ts`), behind both `getActiveClaudeSessionEnv` and
  `getActiveCodexSessionEnv`.
- Claude's 5h/7d readings arrive only through the `dev3 statusline` wrapper while a
  dev3-launched Claude session runs on that account (`src/bun/rate-limit-monitor.ts`), so an idle
  account's numbers age. Codex windows come from rollout tails plus `codex app-server` every
  5 minutes.
- Paths that ignore the task's account today: the AI-review column agent
  (`resolveCommandForAgent` in `src/bun/rpc-handlers/tmux-pty.ts` gets no account) and automations
  (`src/bun/automations-data.ts` stores none). `getAgentUsage`
  (`src/bun/rpc-handlers/agent-usage.ts`) scans only `~/.codex/sessions`, so managed Codex
  accounts are missing from the usage dashboard.
- Claude transcripts are shared across account dirs (`claude-config-dir-share-by-default`), so a
  Claude conversation can in principle resume under another account — read in code, not run.
  Codex conversations are pinned to their `CODEX_HOME` (`locate-codex-resume-home-by-session-id`).

## Decision

1. **The account axis first.** A *consumption policy* chooses the account for any launch where no
   human chose one. An explicit pick always wins; retry and resume keep their recorded account.
2. **Three policies, all in phase 1**, one global setting:
   - **Pinned** — the default account, always. Today's behaviour and the default setting, so
     nothing changes until the user opts in.
   - **Waterfall** — the first eligible account in the user's order.
   - **Smart** — if an eligible account's 5h window resets within 90 minutes and still has room,
     it goes first, because that room is lost at reset anyway. Otherwise the account furthest
     behind its weekly pace (share of the window elapsed minus share used). Nothing eligible →
     point 5.
3. **Per-account settings:** `autoUse` (may an unpicked launch use it — on for subscription logins,
   off for API profiles), `reserve` (weekly % kept for the human), and an order (the Waterfall
   position).
4. **Reading rules.** A window whose reset time has passed is known empty. Otherwise the recorded
   percentage is a floor: usage outside dev3 only adds to it. An account with no reading is
   unknown — Smart ranks it last, Waterfall takes it in turn. A herd guard adds an estimated load
   for each agent already running on the account, so a burst of launches does not pile onto one.
   Eligible = `autoUse` on, 5h below 90% including the herd estimate, weekly below 100 − reserve.
5. **Nothing eligible → defer, never launch into a limit.** An unattended launch becomes a
   "Start in…" launch (`Task.scheduledLaunch`) at the earliest known reset, with an attention
   badge naming the account. The launch dialog shows the same and lets the user override.
6. **Limit hit mid-task.** Under **Pinned: wait** — the task still parks with its badge, and a
   "continue" message is queued for the reset time (`dev3 message --at`). Under **Waterfall and
   Smart: switch** — the same Claude conversation resumes on the next eligible account, falling
   back to wait when none is eligible. Codex always waits, since its conversation cannot move
   accounts, and first needs limit detection, which does not exist yet.
7. **Where it lives.** The pick happens once, in `launchTaskPty`
   (`src/bun/rpc-handlers/tmux-pty.ts`), and is persisted on `task.accountId`, so trust setup,
   resume and rate-limit attribution agree. A new optional `accountPickReason` on the task feeds a
   line in the launch dialog. The AI-review column agent and automations go through the same pick.
   New fields are optional additions to existing file content: no path, no rename, no migration.
8. **Harness level, phase 3.** A launch profile becomes a *route*: an ordered list of legs, each
   leg = harness + preset + account pool, and a used-up leg hands over to the next. Only legs the
   user added, keeping the "never sideways" rule of `agent-launch-profiles`. Harnesses with no
   readings (Gemini, Cursor, Copilot, OMP, OpenCode) are legs taken strictly in order. When this
   ships, `agent-launch-profiles` gets a supersede note: its profile stops being one pointer.
9. **Phases.** 0 — the gaps in Investigation plus Codex limit detection. 1 — points 1–5 and 7.
   2 — point 6. 3 — point 8, plus pay-per-token budgets if the open question below allows them.

## Open question for review

**May a pay-per-token account (a Claude API profile, a catalog provider) ever serve a launch nobody
hand-picked?** Proposed: only after an explicit approval by the user, per launch, through the same
approval dialog agent launches already use — never silently, because it spends real money where a
subscription does not. Left open for the maintainer: whether an opt-in daily budget (dev3 already
prices tokens locally, `src/shared/agent-pricing.ts`) may stand in for that approval.

## Risks

- Stale Claude readings on idle accounts are bounded by the reading rules, not removed. Usage
  outside dev3 (claude.ai chats, the user's own terminal) stays invisible.
- dev3 sees only the 5h and 7d windows (plus Codex credits); any other cap a plan has is invisible.
- Switching accounts loses the prompt cache: the first turn on the new account re-reads the whole
  conversation at full price.
- Claude cross-account resume is read from code, not run. If it fails, switching becomes a fresh
  session plus a handoff.
- Provider terms: routing between separate payers (work seat, personal plan, team) is the intended
  case. Several personal subscriptions rotated purely around limits may breach a provider's terms,
  so the feature must never be described as limit evasion.
- The herd estimate is a guess until it is measured per preset.

## Alternatives considered

- **Round-robin** (the deferred idea) — reads no limits, so it routes into exhausted accounts.
- **Launch profiles alone** — pick a model, still bill the default account, know nothing of windows.
- **Warnings only at ≥ 95%** — do nothing for launches nobody watches, which is the problem.
- **Switch under every policy, Pinned included** — rejected: Pinned promises "this account only".
- **Codex switch via a fresh conversation plus handoff** — deferred: a new conversation silently
  drops context the user may not expect to lose.
