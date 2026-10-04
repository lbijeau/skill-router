# Skill Router — Design

Date: 2026-07-09
Status: approved — implementation plan: docs/superpowers/plans/2026-10-03-skill-router.md

## Purpose

Give a pi setup a family of subagents — one per popular third-party skills
repo — where each agent's entire skill catalog is exactly that one repo.
Each instance behaves differently (different persona, discipline, or
capability) purely by virtue of which skills it can see.

The project's invariant: **the manifest is the source of truth; everything
else (clones, agent definitions, settings wiring) is derived and regenerable.**

## Context (what pi already provides)

- Pi discovers skills from configured locations and advertises name +
  description in the system prompt; full instructions load on demand.
- pi-subagents agents (markdown + YAML frontmatter) start with a clean
  system prompt and do **not** see the parent's discovered skill catalog by
  default (`inheritSkills: false` is the default).
- Agent frontmatter fields `skillPath:` (extra discovery roots, relative
  paths resolve against the agent definition file) and `skills:` (explicit
  selection by declared skill name) let one agent pin exactly one repo's
  skills. This is a clean-room agent.
- `subagents.agentScanDirs` in a Pi settings file adds extra recursive
  agent scan roots (supports `~` and single-segment globs; missing dirs
  ignored). This makes agents defined in this repo usable from any project
  with one settings key and no copying or symlinking.

## Non-goals

- Dynamic runtime routing (per-task LLM filtering of the catalog). A later
  phase if wanted.
- Pi package / npm distribution.
- Version pinning of upstream repos. We track default branches; `update`
  reports what changed.
- Mixing skills from multiple repos into one agent.

## Repo layout

```
skill-router/
├── repos.json            # Manifest — single source of truth
├── skills/               # Shallow clones of each repo (gitignored)
│   └── <name>/
├── agents/               # GENERATED agent definitions (committed)
├── scripts/
│   ├── generate.mjs      # The generator (zero npm dependencies)
│   └── test.mjs          # Fixture-based tests
├── install.sh            # Thin wrapper: node scripts/generate.mjs "$@"
├── .gitignore            # /skills/
└── docs/superpowers/specs/
```

`agents/*.md` files are generated but **committed**, so the repo documents
what each agent pins and `git diff` shows skill-list churn after `update`.

## Manifest — `repos.json`

```json
{
  "repos": [
    {
      "name": "ponytail",
      "url": "https://github.com/DietrichGebert/ponytail",
      "description": "Blunt, opinionated senior-engineer persona",
      "persona": "You are Ponytail: blunt, opinionated, allergic to cargo-cult engineering. Your skills encode how you work."
    }
  ]
}
```

Fields:

- `name` — agent name and clone dir name. Lowercase letters, digits,
  hyphens; no leading/trailing/consecutive hyphens (agent-name rules).
- `url` — git clone URL (GitHub https).
- `description` — one-liner shown in the agent catalog (advertise text).
- `persona` — full body of the generated agent's system prompt.
- `skillSource` — optional. Subdirectory (relative to the clone) to scan
  instead of the repo root, when a repo ships the same skill in multiple
  tool-specific locations. Example: `".pi/skills"`.
- `pathExclude` — optional. Glob patterns matched against skill-dir paths
  (relative to the clone); matching skills are dropped. Example:
  `"skills/in-progress/**"`. Glob semantics: globstar — `*` matches within
  one path segment, `**` matches across segments. Matching is implemented
  in the generator (no dependency); the full pattern set is `*`, `**`, and
  literal characters, nothing else.

Initial curation decisions (evidence from a 2026-07-09 probe of all 10
repos, see Risks):

- `impeccable`: `skillSource: ".pi/skills"` — the repo ships the one skill
  in ~20 tool-specific bundles and the copies have drifted (different
  checksums); `.pi/skills` is the canonical pi bundle.
- `mattpocock`: `pathExclude: ["skills/in-progress/**"]` — the repo author
  marks 6 skills as in-progress; the agent should pin the stable 31.
- All other repos: no filter needed; the built-in skip rules (hidden dirs,
  `.git`, `node_modules`, `tests/`, `test/`) already select the canonical
  trees (e.g. `ponytail`'s `.openclaw/` mirror, `i-have-adhd`'s `.cursor/`
  mirror are hidden dirs and skipped).

Initial entries (10):

| name | url |
|---|---|
| `ponytail` | `https://github.com/DietrichGebert/ponytail` |
| `mattpocock` | `https://github.com/mattpocock/skills` |
| `i-have-adhd` | `https://github.com/ayghri/i-have-adhd` |
| `security-audit` | `https://github.com/cloudflare/security-audit-skill` |
| `superpowers` | `https://github.com/obra/superpowers` |
| `diagram-design` | `https://github.com/cathrynlavery/diagram-design` |
| `humanizer` | `https://github.com/blader/humanizer` |
| `graphify` | `https://github.com/Graphify-Labs/graphify` |
| `addyosmani` | `https://github.com/addyosmani/agent-skills` |
| `impeccable` | `https://github.com/pbakaus/impeccable` |

`description` and `persona` values for all 10 are drafted in the initial
commit as a starting point; the manifest is where they get tuned.

## Generator — `scripts/generate.mjs`

Single file, node ≥ 18, standard library only. Commands:

### `install`

1. For each manifest entry (in file order):
   - `skills/<name>/` absent → `git clone --depth 1 <url> skills/<name>`.
   - Present and a git repo → reuse (no pull; `install` never mutates
     existing clones). If the clone's working tree has local modifications,
     the summary reports `reused (dirty)` instead of `reused`, so divergence
     from the upstream tip is visible.
   - Present but **not** a git repo → remove, re-clone.
2. Discover skills in each clone (below), generate `agents/<name>.md`.
3. Merge the agent scan dir into user settings (below).
4. Prune orphans (below).
5. Print a per-entry summary: cloned/reused(/dirty), N skills, agent
   written, prune results.

### `update`

Same as `install`, except existing clones get
`git pull --ff-only` (a non-ff state is reported as a per-entry warning and
left alone). The summary additionally reports skill-list deltas per agent
(e.g. `superpowers: +2 -1`) so churn is visible in one glance.

### Prune

`install` and `update` both prune orphans after processing the manifest:
for every `agents/<name>.md` or `skills/<name>/` whose `<name>` is not in
the current manifest, remove it and report `pruned <name>`. This keeps
"everything is derived from the manifest" true across removals and renames
(a rename is a remove plus a re-clone).

The generator resolves all paths relative to the repo root (the parent of
`scripts/`), so any command works from any cwd.

### `status`

Read-only table per entry: clone state (`ok` / `missing` / `not-a-repo` /
`dirty`), skill count, agent file state (`in-sync` / `stale` /
`missing`). Exit 0 unless any entry is not `ok`+`in-sync`.

Expected absence: an entry with zero discoverable skills has no agent file
by design. Its agent state is `in-sync` when no `agents/<name>.md` exists,
and `stale` when one does (a leftover that regeneration removes). A zero-skill
entry therefore never forces a non-zero exit on its own.

### Skill discovery

- Recursive walk starting at `skillSource` (default: repo root) for
  directories containing `SKILL.md`, skipping `.git`, `node_modules`,
  `tests/`, `test/`, and hidden dirs (dot-dirs).
- Skills whose relative dir path matches any `pathExclude` pattern are
  dropped before name resolution.
- Skill name = frontmatter `name:` field; falls back to the directory name
  only if the field is absent or empty.
- Deterministic: walk paths are sorted lexicographically; on an in-repo name
  collision the first (in sorted order) wins — mirroring pi's own
  first-discovered-wins semantics. Every dropped duplicate is reported in
  the install/update/status output as `name: kept <path>, dropped <path>`
  so curation can respond with `skillSource`/`pathExclude`.
- A repo with zero discoverable skills is not an error: it is reported and
  no agent file is generated for it (see Failure handling).

### Generated agent file

```markdown
---
name: ponytail
description: Blunt, opinionated senior-engineer persona
inheritSkills: false
skills: ponytail-core, ponytail-review
skillPath: ../skills/ponytail
---
You are Ponytail: blunt, opinionated, allergic to cargo-cult engineering.
Your skills encode how you work.
```

- No `tools:` restriction — personas are full-capability; they only differ
  in what they can see.
- No "generated" marker in the file: a comment before the frontmatter risks
  breaking frontmatter parsing. Drift detection is purely content-based.
- `skillPath:` is relative, resolving against the agent file's real
  location in this repo (the scan-dir setting points at `agents/`, so the
  relative path lands in `skills/<name>/` regardless of where pi resolves
  the scan root).
- Drift detection: `status` regenerates each agent file into memory and
  byte-compares it against the committed file instead of trusting the file.
- Re-running generation is idempotent: identical inputs produce identical
  bytes, so `install`/`update` create no spurious diffs.

## Failure handling

| Condition | Behavior |
|---|---|
| Clone fails (network, 404) | Warn, skip entry, continue; exit non-zero at end |
| Zero `SKILL.md` in a valid clone | Warn, skip agent generation, remove any leftover `agents/<name>.md`; manifest entry kept so `update` retries |
| `skills/<name>` exists, not a git repo | Remove and re-clone |
| `git pull --ff-only` fails on update | Warn for that entry, leave clone as-is, regenerate from current state |
| Malformed frontmatter in a discovered `SKILL.md` | Skip that one skill with a warning; keep the rest |
| Duplicate `name` in manifest | Hard error before doing anything |

## Global activation

`install` (and `update`) idempotently merge into
`~/.pi/agent/settings.json`:

```json
{ "subagents": { "agentScanDirs": ["~/repositories/skill-router/agents"] } }
```

- Read-modify-write of the JSON; the entry is added only if an equivalent
  entry (`~`-expanded, real-path-compared) is not already present in the
  existing array.
- A backup of the previous settings file is written to
  `~/.pi/agent/settings.json.bak` before the write.
- The command prints exactly what it changed (or "already configured").
- If the settings file does not exist, it is created with only this key.

## Testing — `scripts/test.mjs`

Fixture-based, no network, no deps. Builds a temp dir containing:

1. A "normal" fixture repo: `skills/core/SKILL.md` (frontmatter name matches
   the dir) and `skills/renamed/SKILL.md` whose frontmatter name is
   **different** from its dir name.
2. A "nested" fixture repo: skills under a `src/skills/` subtree.
3. An "empty" fixture repo: no `SKILL.md` anywhere.

Assertions:

- Generated `skills:` list uses frontmatter names, not dir names.
- Clean-room frontmatter present (`inheritSkills: false`, correct
  `skillPath`).
- Empty repo produces no agent file, does not fail the run.
- Re-running generation on unchanged inputs produces byte-identical files.
- `status` reports `stale` when the manifest's persona changes.
- A fixture with the same skill name in two non-hidden trees: winner is the
  sorted-first path and the loser is reported as dropped.
- `pathExclude` fixtures: a `**` pattern matches across path segments and
  drops its targets; a `*` pattern within one segment does not cross a
  segment boundary (both directions asserted).
- A `skillSource` fixture: a skill reachable only inside the configured
  subdirectory is discovered; a same-named skill outside it is not.
- A zero-skill entry yields exit 0 from `status` (expected absence).

Run via `node scripts/test.mjs`; exits non-zero on failure.

## Assumptions to validate on first run

The clean-room guarantee rests on pi behaviors that are documented but not
exercised by the offline fixture tests. Validate once on a real pi install
after the first `install`; record the outcome here (with date) when done:

1. An agent discovered via `subagents.agentScanDirs` resolves
   `skillPath: ../skills/<name>` against the agent file's real location in
   this repo, not against the scan-dir entry as written in settings.
2. With `inheritSkills: false` plus an explicit `skills:` list, the child
   sees exactly the listed skills — no bleed from the parent's catalog.
3. A `skills:` entry whose name no longer exists in the `skillPath`
   discovery set (upstream renamed a skill between `update` and launch) is
   ignored or warned, not fatal to the launch.
4. When two skills in the same `skillPath` share a declared name, behavior
   matches first-discovered-wins (pi's documented collision semantics).

## Risks / unknowns

**Verified initial roster**
 (2026-07-09, shallow clones of all 10 repos,
applying this spec's discovery rules + the curation decisions above):

| agent | skills | notes |
|---|---|---|
| `ponytail` | 6 | `.openclaw/` mirror skipped (hidden) |
| `mattpocock` | 31 | 6 in-progress excluded |
| `i-have-adhd` | 1 | `.cursor/` mirror skipped (hidden) |
| `security-audit` | 1 | |
| `superpowers` | 15 | |
| `diagram-design` | 1 | |
| `humanizer` | 1 | `SKILL.md` at repo root |
| `impeccable` | 1 | `skillSource: .pi/skills`; 23 drifted copies ignored |
| `addyosmani` | 25 | |
| `graphify` | 0 | **no agent generated** — repo ships no skills |

Total: 9 agents, 82 skills. `graphify` stays in the manifest as an intent;
`update` will generate its agent if the repo ever gains skills.

- Upstream repos can rename or restructure skills; `update`'s delta report
  and duplicate-dropped report are the safety net.
- `agentScanDirs` is a pi-subagents settings key; if the user runs pi
  without pi-subagents, the agents are simply not discovered (no other
  effect on the pi install).
