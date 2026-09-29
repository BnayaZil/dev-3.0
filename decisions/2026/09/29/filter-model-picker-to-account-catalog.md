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
- **Multi-account.** The probe spawns with the ambient CLI login, not dev3's
  per-account launch env, so a filter can be wrong right after switching accounts.
  Accepted for v1; the fix is to thread the account env into the probe.
- **Launch still possible.** An already-selected unavailable model is flagged, not
  blocked; launching it fails as before. Blocking at launch is a follow-up.

## Alternatives considered
- **Prune presets from `agents.json`** — rejected: destructive migration of shared
  on-disk state, breaks older app versions and offline/logged-out users.
- **Strict slug match for Cursor** — rejected: 2 of 7 dev3 Cursor slugs are missing
  from `--list-models` despite the base model being available (false negatives).
- **Attach availability to `getAgents`/agents.json** — rejected: couples the generic
  agent list to a per-account, codex/cursor-specific probe and would persist
  account-derived state to disk.
