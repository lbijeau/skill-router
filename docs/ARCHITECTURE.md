# Architecture

skill-router turns pinned third-party skill repos into isolated per-repo
agents for pi, Mistral Vibe and Claude Code, plus a catalog-driven
router. Everything is derived from one manifest; nothing is configured twice.

## Pipeline

1. **Manifest** — `repos.json`: one entry per repo with `name`, `url`,
   `description`, `persona`, and optional `skillSource` / `pathExclude`
   curation. Validated by `loadManifest` (names, required fields, URL shape).
   Single source of truth — see ADR-003.
2. **Clone** — `install`/`update` shallow-clone each repo into
   `skills/<name>/` (gitignored, never committed — ADR-002). `update` pulls
   `--ff-only`; a failed pull leaves the clone as-is.
3. **Discover** — `scripts/discover.mjs` walks each clone for directories
   containing `SKILL.md`, parses the frontmatter (`name`, `description`),
   applies `skillSource`/`pathExclude`, and dedupes skills by name (first
   wins, the rest are reported).
4. **Generate** — one agent per repo, restricted to that repo's skills
   (ADR-001):
   - **pi**: `agents/<name>.md` — frontmatter `inheritSkills: false`, an
     explicit `skills:` list, `skillPath: ../skills/<name>`.
   - **Vibe**: `agents-vibe/<name>.toml` — `agent_type = "subagent"`,
     `disabled_tools = ["skill"]`, instructions with a skill table of
     `~`-anchored `SKILL.md` paths (Vibe expanduser()s paths at runtime, so
     no machine-specific usernames are committed).
   - **Claude Code**: `agents-claude/<name>.md` — `tools: Read, Grep, Glob`,
     `omitClaudeMd: true`, persona + skill table, ownership marker.
   All three directories are committed (ADR-002). A repo with zero skills
   gets no agent; reserved or blank-description names get no Claude agent.
5. **Wire settings** — idempotent, never destructive (ADR-004):
   - **pi**: `~/.pi/agent/settings.json` gains
     `subagents.agentScanDirs: ["…/skill-router/agents"]`, making the agents
     discoverable from any project. Temp-dir entries are refused and stale
     ones pruned (ADR-005).
   - **Vibe**: `~/.vibe/config.toml` (or `$VIBE_HOME`) gains the
     `agents-vibe/` dir in `agent_paths` and `[tools.read_file]` allowlist
     patterns — one per depth (`skills/*` … `skills/*`×8), because Vibe's
     component-strict pathlib matching makes a single `skills/**` match
     nothing.
   - **Claude Code**: the installer copies owned agent files into
     `~/.claude/agents/`, installs the `route-skill` skill, and merges two
     `permissions.allow` `Read` rules (this checkout's `skills/**` and
     `catalog/**`) into `~/.claude/settings.json` with a `.bak` copy.
   All writes are atomic with a `.bak` backup; forms the merger cannot
   merge safely are skipped and the exact manual remedy is printed.
6. **Catalog + router** — `catalog/skill-catalog.md` (one bullet per skill,
   rebuilt every run) and the `skill-router` agent, spawned by the global
   `route-skill` pi skill. The router reads the catalog, opens the winning
   `SKILL.md`, and returns the skill name, path, why it fits, and a digest —
   the catalog's bulk never enters the calling session's context. Both are
   derived artifacts, regenerated on every run; `status` reports them.

Renaming or removing a manifest entry prunes its agent files and clone on
the next run; pruning only deletes files that look generated.

## Code layout

`scripts/generate.mjs` is the entry point and re-exports everything, so
`scripts/test.mjs` and `install.sh` (a one-line `exec node` wrapper) use it
unchanged. Imports only point down this list, keeping the graph acyclic:

- `scripts/common.mjs` — shared helpers (paths, text normalising,
  `atomicWrite`, status constants, the router body).
- `scripts/discover.mjs` — finding and parsing skills in a clone.
- `scripts/claude.mjs` — the Claude Code target (rendering, ownership,
  installer, permissions merge, skills sync, install status).
- `scripts/generate.mjs` — manifest, pi and Vibe targets, catalog, prune,
  status, install flow and CLI.

## Commands

```sh
./install.sh install   # clone, generate, wire settings
./install.sh update    # pull clones, regenerate, report skill deltas
./install.sh status     # read-only health table; non-zero when out of sync
node scripts/test.mjs   # offline, fixture-based; no network needed
```

## Decisions

- [ADR-001](decisions/ADR-001-one-clean-room-agent-per-repo.md) — one
  clean-room agent per repo
- [ADR-002](decisions/ADR-002-generated-agents-committed-clones-gitignored.md)
  — generated agents committed, clones gitignored
- [ADR-003](decisions/ADR-003-repos-json-single-source-of-truth.md) —
  `repos.json` as the single source of truth
- [ADR-004](decisions/ADR-004-never-write-user-config-destructively.md) —
  never write user config destructively
- [ADR-005](decisions/ADR-005-refuse-temp-dir-entries-in-persistent-settings.md)
  — refuse temp-dir entries in persistent pi settings
