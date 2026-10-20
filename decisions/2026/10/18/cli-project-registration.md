# Projects and spaces from the CLI reuse the Add Project handlers

## Context

An agent that created a repo could not put it on the board: `dev3 projects` only had `list`, and nothing in the CLI touched spaces. The app's Add Project dialog is the reference flow, and it already has back-end handlers for each of its tabs (`addProject`, `initAndAddProject`, `cloneAndAddProject` in `src/bun/rpc-handlers/app-handlers.ts`) plus the spaces handlers.

## Decision

`src/bun/project-registration.ts` backs `projects.add`, `projects.clone` and `spaces.*` on the CLI socket by calling those same handlers. The socket server loads it lazily, because its imports reach `rpc-handlers/shared` and so Electrobun (`cli-socket-server-imports.test.ts`). Every space ref is resolved before anything is written, so a bad `--space` never leaves a half-registered project, and resolved again right before the memberships are applied, because a clone can run for minutes while someone deletes the target space or creates a same-named one (a failure there says the project was added and exits 1, not 34). A project removed earlier and added again keeps its old memberships unless `--no-space` is passed, as in the app. `--space` never creates a space (a typo would silently make one); `--new-space` does, and refuses a name already in use, since name refs would become ambiguous. An already-registered folder changes nothing and exits 33 (idempotent scripts); a space ref that cannot be used exits 34. The CLI mirrors `label set|add|remove`: `spaces set` replaces a project's memberships, `add`/`remove` change only the named ones, and a space left empty is deleted exactly as in the app. A new `projectAdded` push (also broadcast to other instances) makes a CLI-added project appear in open windows, which previously only re-read projects when returning to the dashboard.

## Risks

`projects add` compares paths with symlinks resolved, while `data.addProject` compares raw strings; a project registered elsewhere under a different spelling of a symlinked path is reported as existing by the CLI but would be added twice through the app. The second space check narrows the race to the moment between it and the write; `spaces-data.createSpace` still does not enforce unique names, because the app's New Space dialog allows duplicates. A clone runs inside one socket request with a 30-minute client timeout; past that the CLI gives up while the app finishes the clone and registers it.

## Alternatives considered

A separate CLI-only registration path was rejected: it would drift from what the dialog writes (default branch detection, resolved config, clone paths). Letting `--space` create missing spaces was rejected for the typo reason above. A project-centric `projects set-spaces` command was rejected in favour of the `label`-style verbs agents already know.
