# Historical designs & plans

These `plans/` and `specs/` (and related research notes under `docs/research/`)
are **implementation archaeology** — useful for “why did we try X?”, not for
“what ships today?”.

**Authoritative current architecture:** repo-root `AGENTS.md` and `graph/AGENTS.md`.

Do **not** implement from these files without reading live code. Later plans
supersede earlier ones; some architectures were abandoned (e.g.
`CommitWorkbenchViewProvider`, native `SnipcodeScmManager`). Prefer the live
stack: `ChangesWorkbench` + `CommitBoxViewProvider` + `DiffPanel` + host
`src/blame/`.
