# Filter the model picker to the account's real catalog

## Context
dev3's Codex picker offered 7 model slugs across 59 presets, but a signed-in
account can only select a subset — on an enterprise ChatGPT plan `gpt-6-sol` and
`gpt-6-luna` (20 of the 59 presets) were absent from the account's catalog and
failed on launch. The offered set is static in `DEFAULT_AGENTS`; the account's
selectable set is per-account and drifts, so only the CLI's own catalog can track
it. Cursor has the same gap (`cursor-agent --list-models` is account-scoped).

## Investigation
`codex debug models` returns JSON with `slug` / `visibility` / `supported_in_api`;
`visibility === "list" && supported_in_api === true` is the selectable set, and it
is fresher than `~/.codex/models_cache.json`. `cursor-agent --list-models` prints
`slug - name` rows. The other five harnesses have no account-scoped model-list
command (Claude/Gemini/Copilot expose only an interactive `/model`; OpenCode's
`opencode models` lists configured providers, not the account's license; omp pins
no model). dev3 already spawns `codex debug models` in `codex-model-catalog.ts`
for metadata synthesis, so the probe plumbing existed.

## Decision
A per-adapter `modelListProbe` descriptor (`src/shared/agent-adapters/types.ts`:
`args` + pure `parse` + optional `normalize`) declares how to list an account's
models; Codex and Cursor set it, others omit it. The impure half,
`resolveModelAvailability` in `src/bun/agent-available-models.ts`, spawns it
(cached ~60s), normalizes both sides, and returns the raw preset slugs the account
cannot use — exempting routed presets (`modelRoles` / `requiresPxpipeProxy`). The
RPC `getAgentAvailableModels` (`src/bun/rpc-handlers/settings-config.ts`) serves it;
`useUnavailableModels` feeds `buildPickerGroups`, which marks a group `unavailable`
when every preset in it pins an unavailable model; `AgentConfigPicker` renders those
Model rows disabled with an "unavailable" caption, reusing the pxpipe disabled-click
seam. The filter is **UI-only** — `agents.json` is never mutated (AGENTS.md § on-disk
data layout bans destructive migrations of `~/.dev3.0/`). Codex matches on the exact
slug (effort is a separate `-c` arg); Cursor matches on the base model family,
because it bakes effort into the slug (`gpt-5.6-sol-xhigh`) while `--list-models`
enumerates only some tiers — a strict match wrongly hid usable models.

## Risks
- **False negatives.** A wrong probe could hide a usable model. Mitigated: unknown
  and empty results filter nothing; Cursor uses base-family matching; routed presets
  are exempt. Hiding is a disabled+captioned flag, not deletion, and the preset stays
  in `agents.json`.
- **Multi-account** (resolved in review). The probe now resolves the same account the
  launch would: `resolveModelAvailability` takes the picker's `accountId`, resolves
  `CODEX_HOME` via `getActiveCodexSessionEnv` (honoring an explicit `CODEX_HOME` on the
  default preset, like `applyCodexAccountEnv`), spawns the probe with it, and keys the
  cache on it. `useUnavailableModels` passes the picker's account and re-probes on any
  account change. So a user whose active/selected account differs from `~/.codex` is
  filtered against the right catalog.
- **Launch still possible.** An already-selected unavailable model is flagged, not
  blocked; launching it fails as before. Blocking at launch is a follow-up.
- **Per-preset `CODEX_HOME`.** The agent-level probe honors only the default preset's
  explicit `CODEX_HOME`; a non-default preset pinning a different home is not modeled
  (rare, and it falls back to filtering against the default preset's account).
- **Logged-out Codex** (resolved in review follow-up). A logged-out `codex debug
  models` exits 0 and prints its bundled catalog, which would wrongly flag models.
  `resolveModelAvailability` now asks `codexHomeSignedIn` (`harness-readiness.ts`, the
  same rule the first-run readiness gate uses: a non-empty `auth.json`, since an
  emptied `{}` store is logged out) or finds an `OPENAI_API_KEY` before trusting the
  dump — an unauthenticated home resolves to `unknown`. A Codex login kept in the OS
  keyring leaves no `auth.json`, so for those users the filter stays off (the safe
  direction: nothing is greyed).
- **Binary override** (resolved in review follow-up). The probe now resolves the same
  binary a launch would: `applyBinaryPathOverride` (the custom-binary setting) plus the
  default preset's `baseCommandOverride`, so a user who points dev3 at a custom `codex`
  probes the binary that will actually run. A non-default preset whose own
  `baseCommandOverride` resolves to a different binary is skipped rather than judged
  against the probed binary's catalog.

## Alternatives considered
- **Prune presets from `agents.json`** — rejected: destructive migration of shared
  on-disk state, breaks older app versions and offline/logged-out users.
- **Strict slug match for Cursor** — rejected: 2 of 7 dev3 Cursor slugs are missing
  from `--list-models` despite the base model being available (false negatives).
- **Attach availability to `getAgents`/agents.json** — rejected: couples the generic
  agent list to a per-account, codex/cursor-specific probe and would persist
  account-derived state to disk.
