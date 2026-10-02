# Sleep inhibit: an immediate non-zero exit counts as a failure

## Context
`systemd-inhibit` was launched with `--reason=`, an option it does not have, so it printed `unrecognized option` and exited 1. `startInhibit` only counted a thrown `spawn()` toward `MAX_SPAWN_FAILURES`; a process that started and then died was not a failure, so the 10-second poll respawned it forever. Fixing the flag is not enough on every host: under WSL (no logind seat) polkit answers `Failed to inhibit: Access denied` and the process exits 1 the same way.

## Decision
`--why=` replaces `--reason=`. A spawned inhibit process that exits non-zero within `QUICK_EXIT_MS` (5 s) of starting is recorded through the same counter as a failed spawn; after three in a row the backend is marked unavailable for the process lifetime. The counter resets when a process exits after outliving that window, including one `stopInhibit()` ended on purpose, and never on spawn alone. A quick exit of a process `stopInhibit()` stopped is never counted: the exit handler treats any process that is no longer the current one as stopped on purpose. The window is measured with `performance.now()`, so a wall-clock step cannot turn a refusal into a long-lived process.

## Risks
A host where the lock is refused transiently three times in a row loses sleep prevention until the app restarts. The previous behavior on such a host was an error log every 10 seconds with no inhibition either.

## Alternatives considered
- Probe `systemd-inhibit` once at detection time: a second code path that duplicates what the first real launch already tells us.
- Read stderr for `Access denied`: ties behavior to a localized, version-dependent message.
