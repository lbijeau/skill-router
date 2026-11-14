# ADR-003: repos.json as the single source of truth manifest

## Status
Accepted

## Date
2026-11-13

## Context
Three targets (pi, Vibe, Claude Code) need the same facts about each pinned
repo: where to clone it from, what its agent is called, the one-line
description used for spawn routing, the persona that becomes the agent's
system prompt body, and how to curate discovery (`skillSource` for repos that
ship skills in a subdirectory, `pathExclude` for dropping in-progress or
tool-specific bundles). If those facts lived in three places, the targets
would drift: a repo pinned for pi but forgotten for Vibe, or two different
descriptions for the same agent.

## Decision
`repos.json` is the manifest and the single source of truth: one entry per
repo with `name`, `url`, `description`, `persona`, and optional
`skillSource` / `pathExclude`. Everything else — pi agents, Vibe TOMLs,
Claude agents, the catalog, the router — is derived and regenerated on every
run. `loadManifest` validates the manifest up front: names must match
`NAME_RE` and be unique, required fields must be non-empty strings, `url`
must be an https GitHub URL or `file://` mirror, `skillSource` must be a
relative path inside the clone, `pathExclude` an array of strings.

Adding a repo is one JSON edit plus `./install.sh update`. Removing or
renaming an entry prunes its agent files and clone on the next run.

## Alternatives Considered

### Per-target configuration
- Pros: each target could grow target-only fields naturally.
- Cons: the same repo must be pinned three times; descriptions and personas
  drift between targets; three files to edit for every change.
- Rejected: the targets share one concept — a pinned repo — so they share
  one entry.

### CLI flags or environment variables instead of a file
- Pros: no manifest format to maintain.
- Cons: not versioned, not reviewable, easy to invoke inconsistently.
- Rejected: the pin list is the project's content; it belongs in git.

### Manifest entries inside each clone
- Pros: metadata travels with the code.
- Cons: clones are gitignored and overwritten by `git clone` / `pull`, so
  local edits would be destroyed; upstream repos would have to agree on a
  format.
- Rejected: the manifest must be ours, not upstream's.

## Consequences
- One diff reviews the whole change: pin, persona, description, curation.
- Validation lives in exactly one place (`loadManifest`); every command
  (install, update, status) fails fast on a bad manifest.
- `description` doubles as the Vibe spawn-routing signal and the pi catalog
  line — one field, two consumers, both documented in the README's Tuning
  section.
- Generated files never carry facts the manifest does not; `status` can
  verify every artifact against a re-render from the manifest plus clones.
- The `file://` URL allowance exists for local mirrors (e.g.
  `anatomy-experiments`); it is validated but not portable across machines.
