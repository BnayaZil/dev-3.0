# Peek drops an agent's faint ghost autosuggestion

## Context
A coordinator drives its children with `dev3 message` and checks them with `dev3 peek`. Coordinators kept reporting a child's go as "typed but not sent, press Enter" (users-fed-monorepo Seq 72 re Seq 74/81, three times over hours) for messages that had actually been delivered.

## Investigation
Reproduced live on a scratch target: Claude Code renders a **dimmed (SGR 2 "faint") ghost autosuggestion** of a prior message in the *empty* input box. `dev3 peek` captured the pane without colour (`capturePane` with no `-e`) and `stripTerminalEscapes` removed the dim marker, so the ghost reached the coordinator as plain `❯ push it and open the PR` — indistinguishable from real unsent input. Every actual delivery in ~10 single + one 5-message-burst trials executed (filesystem-marker oracle); the "unsent" text was always the ghost, never a failed submit. Confirmed the dim run with `tmux -L dev3 capture-pane -e` showing `\e[2m`.

## Decision
`dev3 peek` now captures WITH colour (`escapes: true`, `src/bun/task-peek.ts` tmux path) and runs `dropFaintText` (`src/shared/task-peek.ts`) before `stripTerminalEscapes`, dropping any faint (SGR 2) run so the ghost never reads as input. `dropFaintText` tracks SGR intensity across sequences and skips extended-colour introducers (`38;2;r;g;b` etc.) so a truecolour value is not misread as faint. Newlines/tabs always survive. It is applied to the native path too (a no-op today: native capture is already a plain-text projection with no colour).

## Risks
Any *legitimate* faint text on screen is dropped from a peek tail as well; in practice agent TUIs use 256-colour greys (not SGR 2) for real dim UI, and the risk is confined to peek output (logs and the live terminal are untouched). Native-backend peek cannot yet drop the ghost because colour is discarded upstream in its plain-text projection — a separate follow-up if it ever surfaces there.

## Alternatives considered
**Label the ghost** instead of dropping it (render `❯ [dim suggestion: …]`) — safer against false positives but noisier; kept an easy one-line flip in `dropFaintText` and called out in the PR so the maintainer can choose. **Fix at delivery** (make submit more robust) — rejected: the message *was* delivered; nothing was wrong with the submit, only with how peek represented the box.
