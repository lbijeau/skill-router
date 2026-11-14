# ADR-008: --anchor flag for committed-file generation

## Status
Accepted

## Date
2026-11-14

## Context
The committed generated files (`agents-vibe/*.toml`, `agents-claude/*.md`,
`catalog/skill-catalog.md`, and the router agents `agents/skill-router.md` /
`agents-claude/skill-router.md`) embed `~`-anchored paths to skill files and
to the catalog, computed by `tildePath`/`skillRows`/`routerBodyLines` from
the home directory at generation time (`os.homedir()` by default). `install`
and `update` regenerate these files on every run as a side effect of keeping
them current.

`tildePath` only produces a `~/...` path when the path being anchored is
under the resolving home directory; otherwise it falls back to the real
absolute path. So running `install`/`update` from a checkout root other than
the one the committed files were last generated against — whether or not the
new root is under `$HOME` — produces a different path string than what is
committed, and the generated files come out modified in the working tree
even though nothing meaningful changed. `CONTRIBUTING.md` already told
contributors to clone to `~/repositories/skill-router`, but did not say why;
nothing enforced it, and nothing in CI caught a stale commit.

Two independent gaps needed closing: contributors need to know *why* the
clone location matters (so they don't fight the symptom instead of avoiding
it), and CI needs a way to regenerate against the canonical location
regardless of the actual runner's home directory or checkout path, so it can
diff the result against what's committed.

## Decision
**Workaround first, documented with its reasoning** (`CONTRIBUTING.md`):
clone to `~/repositories/skill-router`. This costs nothing beyond the
explanation — the convention already existed — and is the default path for
every contributor who doesn't need to deviate from it.

**A `--anchor <path>` flag on `install`/`update`** (`runCli` in
`scripts/generate.mjs`) pins the home directory used *only* for anchoring
paths in the committed generated files, independent of the real checkout
root or real home directory:

- `--anchor` must be an absolute path; a missing or relative value is a CLI
  error.
- It threads into the existing `home` parameter already accepted by
  `skillRows`, `routerBodyLines`, and the writers that call them
  (`writeVibeAgentFiles`, `writeClaudeAgentFiles`, `writeSkillCatalog`,
  `writeRouterAgent`, `writeClaudeRouterAgent`) — no parallel mechanism, no
  new rendering path.
- **It never reaches `mergeSettings` or `mergeVibeConfig`.** Those write
  local, uncommitted machine config (the pi `agentScanDirs` entry, the Vibe
  `agent_paths`/allowlist entries) and must always resolve the real
  `os.homedir()` and the real `root`, because that config has to work on the
  machine it is installed on. Same for the Claude install path
  (`runClaudeInstall`'s allow-rules and agent installs): those also target
  the real, running machine, not a canonical path that may not even exist on
  it. `--anchor` is scoped to the five writers above only — nothing else in
  `runFlow` receives it.
- A checkout already located at the anchor path is a no-op: `tildePath`'s
  existing equality/prefix check against `home` already produces the same
  `~/...` string whether `home` came from `os.homedir()` or from `--anchor`
  pointing at the same directory. No special-casing needed or added.

**CI** (`.github/workflows/ci.yml`) clones to the canonical path, runs
`node scripts/test.mjs`, then runs `install --anchor
~/repositories/skill-router` (redundant with the clone path by construction,
but explicit so the check does not silently depend on the runner's `$HOME`
matching the clone path) and fails the build on `git diff --exit-code` if
the committed generated files came out different.

## Alternatives Considered

### Git clean/smudge filter (rewrite paths transparently per clone)
Deferred, not rejected outright: would make any checkout location
transparent, but adds a per-clone Git configuration step and a filter
script to maintain for a problem the workaround + CI check already catches
before merge. Revisit only if contributors keep hitting this after both
land.

### Location-independent paths (relative paths, or a different anchor scheme)
Rejected: at least one downstream target (Vibe's file tools) only expands
`~`-style home-relative paths, so an absolute, home-anchored scheme is a
hard requirement, not a style choice.

### Removing committed generated files from version control
Rejected: contradicts the existing rationale for committing them (reviewable
diffs across every repo's agent/persona/catalog content) — see ADR-002.

## Consequences
- Contributors who clone to the canonical path never need `--anchor`;
  install/update regenerate correctly by default, as before.
- Contributors who can't use the canonical path have an explicit workaround
  (`--anchor ~/repositories/skill-router`) instead of a confusing dirty
  working tree with no explanation.
- CI, not convention alone, now enforces that the committed generated files
  match what the generator produces from the canonical location.
- `mergeSettings`, `mergeVibeConfig`, and the Claude install path are
  unaffected by `--anchor` in every case — this is deliberate and is not
  expected to change; a future attempt to thread `--anchor` into those
  should be read as reopening this decision, not extending it.
