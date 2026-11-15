# skill-router

One clean-room agent per third-party skills repo, for pi,
Mistral Vibe and Claude Code. Each generated agent is restricted to
exactly one repo's skills instead of your normal skill catalog, so the agent
behaves like that repo's author intended, and the skill content itself never
reaches your main session. How complete that isolation is differs per tool;
the Claude Code limits are listed under
[Claude Code isolation](#claude-code-isolation).

The pinned upstream projects and their licenses are listed in
[ATTRIBUTIONS.md](ATTRIBUTIONS.md). This README is the source of truth; the
landing page at <https://lbijeau.github.io/skill-router/> is a friendly
overview of the same material.

## Why a clean room

Skills are files on disk, and the spawned agent is the one that reads them —
that's what keeps the bodies out of your main session. The router works the
same way: it reads the catalog and hands back a recommendation (name, path,
digest), not the catalog's bulk.

Default tool restrictions back this up: pi agents get
`inheritSkills: false`, Vibe agents get `disabled_tools = ["skill"]`, and
Claude Code agents are capped to three read tools. The actual allowlists are
a separate per-repo policy — see [Trust model](#trust-model) and
[ADR-006](docs/decisions/ADR-006-per-repo-tool-policy-for-generated-agents.md).

## Quickstart

```sh
./install.sh install   # clone repos, generate agents, wire pi + Vibe settings
./install.sh update    # git pull each clone, regenerate, report deltas
./install.sh status    # read-only health table
./install.sh pin [name]  # print the current upstream HEAD SHA, for moving a pin
```

Then:

- **Claude Code**: the installer copies the agents into `~/.claude/agents/`.
  If that directory did not exist, restart Claude Code once; after that,
  updates load live. Claude Code can then launch any agent (for example
  `humanizer` or `superpowers`) from any project. It also installs a
  `route-skill` skill into `~/.claude/skills/` (run `/reload-skills` if
  that directory is new). Needs Claude Code 2.1.271 or later. Pass
  `--no-claude` to skip all Claude Code changes.
- **pi**: run `/reload` (or restart it) so the new agents are discovered;
  launch one from any project with the `subagent` tool, e.g. agent
  `humanizer` or agent `superpowers`.
- **Vibe**: run `/reload` (or restart it) so the config and agent TOMLs
  are re-read; the model can then spawn the subagents from any project
  (their `description` is the routing signal). If the generator printed
  a manual remedy for your `~/.vibe/config.toml`, apply that line once —
  it means your config's formatting is one the safe-bail envelope refuses
  to edit.

## How it works

- `repos.json` is the manifest — the single source of truth: one entry per
  repo with `name`, `url`, `description`, `persona`, and optional
  `skillSource` / `pathExclude` / `tools` curation.
- The `description` and `persona` text in `repos.json` comes from the
  upstream repo and is shown verbatim to the agents (in the generated agent
  files and the catalog) — only pin repos you trust.
- An optional `repos.local.json` next to it (gitignored, same `{ repos: [...] }`
  shape) overlays machine-local entries — e.g. a `file://` clone that only
  exists on this disk — without ever touching the committed manifest. Local
  entries get a clone and a generated agent like any other, but they are left
  out of the committed `catalog/skill-catalog.md`, so they are not routable
  through the catalog-driven router; invoke their agent by name instead. A
  local entry whose `name` collides with a committed one is a load error.
  Their generated agent files do land in `agents/`, `agents-vibe/` and
  `agents-claude/` (pi discovers them there) — those files are machine-local:
  never commit them, and `install`/`update` print a reminder whenever a local
  entry generates one.
- Each repo is cloned into `skills/<name>/` (gitignored, never committed):
  pinned entries clone full history and check out the pinned commit;
  unpinned entries shallow-clone and `update` pulls `--ff-only`.
- See the generation fan-out diagram in
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#pipeline) for how one
  manifest entry becomes three isolated agents (pi, Vibe, Claude Code).
- One agent definition is generated into `agents/<name>.md` (committed)
  with `inheritSkills: false`, an explicit `skills:` list of everything
  discovered in the clone, and `skillPath: ../skills/<name>`. Unless the
  manifest entry sets `"tools": "full"`, it also gets `tools: read, grep,
  find, ls` — a strict pi allowlist with no shell exec and no file write
  (pi's closest equivalent to the Claude path's `Read, Grep, Glob`; pi has
  no separate glob tool, so `find` stands in).
- `install`/`update` idempotently add
  `subagents.agentScanDirs: ["~/repositories/skill-router/agents"]` to
  `~/.pi/agent/settings.json`, making the agents discoverable everywhere.
- The same run also generates **Vibe** subagents into `agents-vibe/`
  (committed): one TOML per repo with `agent_type = "subagent"`,
  `disabled_tools = ["skill"]` (the subagent cannot load the parent's
  skill catalog — that is the clean-room), and an `instructions` skill
  table listing each skill's name, description, and home-anchored
  (`~`-relative) `SKILL.md` path — Vibe's file tools expanduser() every
  path at runtime, so the committed TOMLs carry no machine-specific
  usernames (checkouts outside the home dir fall back to absolute paths).
  Unless the manifest entry sets `"tools": "full"`, it also gets
  `enabled_tools = ["read_file", "grep"]` — Vibe's own allowlist key,
  verified against the installed `mistral_vibe` package's `explore` builtin
  subagent profile; Vibe has no separate glob/find tool, so `read_file` +
  `grep` is its closest equivalent to the Claude path's `Read, Grep, Glob`.
- Vibe wiring goes into `~/.vibe/config.toml` (or `$VIBE_HOME/config.toml`):
  `agent_paths` gains the `agents-vibe/` directory, and
  `[tools.read_file]` gains depth-pattern allowlist entries
  (`skills/*` … `skills/*`×8) that auto-approve clone reads from sessions
  in other projects — Vibe's default outside-workdir rule would
  otherwise prompt on every read. (The patterns are one-per-depth
  because Vibe matches absolute allowlist patterns with
  component-strict pathlib rules: a single `skills/**` matches nothing.)
  Config edits are line-wise with a `.bak` backup; forms the generator
  cannot merge safely (multi-line arrays, multi-line strings,
  unrecognized table variants) are skipped with the exact manual remedy
  printed. Run `/reload` (or restart Vibe) after installing; note that
  `enabled_agents` / `disabled_agents` config filters override discovery.
- The same run generates **Claude Code** agents into `agents-claude/`
  (committed): one markdown file per repo with frontmatter `name`,
  `description`, `tools: Read, Grep, Glob` and `omitClaudeMd: true`, a body
  made of the persona and a skill table (name, description, home-anchored
  `SKILL.md` path), and a last line `<!-- generated by skill-router: <this
  checkout's path> -->` that marks the file as owned by this checkout (an
  older file with no path after `skill-router` is still recognized, and
  counts as this checkout's). The installer copies validated files into
  the Claude config dir (`$CLAUDE_CONFIG_DIR`, absolute path required, or
  `~/.claude`) and only if that directory already exists. It never writes,
  overwrites or deletes a file that lacks the marker, is a symlink, or whose
  `name` does not match its filename; those are reported and left alone. A
  source file missing its `tools:` line is refused, because an agent without
  it would inherit every tool.
  A manifest entry named like a built-in agent (`general-purpose`, `explore`,
  `plan`) or the router (`skill-router`), or with a blank description, gets no
  Claude agent and a warning.
- Removing or renaming a manifest entry prunes its agent file and clone on
  the next run.

## Workflows

Workflows no longer live here: the module was extracted to the
**skill-workflows** repository per
[ADR-011](docs/decisions/ADR-011-extract-workflows-to-skill-workflows.md) —
install that repo for the `run-workflow` skills (pi and Claude Code) and the
Vibe `workflow-orchestrator` mode. Users who never install skill-workflows
should delete the old installed `run-workflow` skills — and the first
post-extraction `install`/`update` of skill-router does exactly that.
While skill-workflows is installed, its installer writes the Vibe
`workflow-orchestrator.toml` into this repo's `agents-vibe/` with its own
marker: skill-router's prune never touches a foreign-marked file, and
removing the skill-workflows checkout orphans that TOML — delete it
manually. The first post-extraction `install`/`update` of skill-router
prunes the old copies (only the ones carrying skill-router's marker;
skill-workflows-owned installs are never touched).

## Trust model

- `repos.json` entries can pin a commit (`"pin": "<sha>"`, hex, 7-40
  characters): `install`/`update` then clone/fetch and check out exactly
  that commit, never upstream HEAD, so a pinned clone cannot move without a
  reviewed `repos.json` commit. Drift between a pin and the current
  upstream HEAD is reported as a status line, never acted on.
  `./install.sh pin [name]` prints the current upstream HEAD SHA so moving
  a pin stays a hand-edited, reviewed commit — see
  [ADR-007](docs/decisions/ADR-007-sha-pinning-over-dry-run.md).
- An entry without `pin` keeps the original model: `update` runs
  `git pull --ff-only` on that clone — whatever upstream pushed is live in
  the next regenerated agent and catalog, with no review step in between.
  Skill bodies, descriptions and personas are re-pulled on every update and
  shown verbatim to the agents that load them (see the manifest note
  above) — only pin repos you trust, and add a commit `pin` when you want
  `update` to stop tracking upstream on its own.
- Every generated target defaults a repo's agent to a read-only tool
  allowlist: pi gets `tools: read, grep, find, ls`, Vibe gets
  `enabled_tools = ["read_file", "grep"]`, and Claude Code gets
  `tools: Read, Grep, Glob` (see
  [Claude Code isolation](#claude-code-isolation)) — no shell exec, no file
  write, for any target, by default. A manifest entry can set `"tools":
  "full"` to opt a repo's pi and Vibe agents out of that allowlist back to
  the host's normal full tool set, for personas whose skills genuinely edit
  files or run commands (see `repos.json` for which repos are marked
  `full`). Setting it is a maintainer decision made by reading the repo's
  actual `SKILL.md` bodies in a reviewed commit; the generator never infers
  it automatically. Claude Code agents have no `full` opt-out; they stay
  `Read`, `Grep`, `Glob` regardless of the manifest.

## Code layout

`scripts/generate.mjs` is the entry point and still re-exports everything, so
`scripts/test.mjs` and `install.sh` use it unchanged. The code behind it is split
so that imports only point down this list (each file imports from the ones
above it, never from below), which keeps the graph acyclic:

- `scripts/common.mjs`: shared helpers (paths, text normalising, atomic writes,
  status constants, the router body).
- `scripts/discover.mjs`: finding and parsing the skills in a clone.
- `scripts/claude.mjs`: everything for the Claude Code target (rendering,
  ownership, installer, permissions merge, skills sync, install status).
- `scripts/generate.mjs`: the manifest, the pi and Vibe targets, catalog, prune,
  status, install flow and CLI.

## route-skill

`route-skill` is a global pi skill (synced to `~/.pi/agent/skills/route-skill/`)
that routes a described situation to the best skill across **every** repo
pinned in `repos.json`. It spawns the `skill-router` subagent, which reads the
generated `catalog/skill-catalog.md` (one bullet per skill, rebuilt on every
`install`/`update`), opens the winning `SKILL.md`, and returns the skill name,
its path, why it fits, and a short digest. The catalog's bulk never enters the
calling session's context; only the recommendation comes back. The caller then
reads the recommended SKILL.md in-session and follows it.

The catalog and the `skill-router` agent are derived artifacts, regenerated on
every run — `./install.sh status` reports both (`CATALOG` and `ROUTER`
columns). The global skill is boilerplate and is overwritten on update; put
standing behavior in your own `AGENTS.md` or say it in the invocation.

Vibe gets a `skill-router` agent too (`agents-vibe/skill-router.toml`, same
persona, same `enabled_tools = ["read_file", "grep"]` allowlist as every
other generated Vibe subagent), but no `route-skill` invocation skill — Vibe
has no skill-loading tool for the host model to call. Vibe discovers
`skill-router` the same way it discovers every per-repo subagent: by its
`description`, through the `agent_paths` entry already wired into
`~/.vibe/config.toml`. The mechanics are probe-verified (a live headless
Vibe session discovered and spawned a generated subagent from its
description — recorded in
[ADR-012](docs/decisions/ADR-012-vibe-router-and-harness-facts.md), which
cites the ADR-010 probe); whether the model reaches for the router
specifically, unprompted, has not been tested the way
[Claude Code isolation](#claude-code-isolation) was — treat that as
plausible, not guaranteed, and re-check after Vibe upgrades.

## Claude Code isolation

Each Claude Code agent is limited to `Read`, `Grep` and `Glob` (no `Skill`
tool, no MCP tools, no `Bash`) and omits your `CLAUDE.md` files. It reads its
skills as plain files from this checkout. This was checked with a probe on
2026-11-09 with Claude Code 2.1.321, in default permission mode, from a project
other than this one; it is not a guarantee and may change with Claude Code
versions, so re-run the probe after upgrades.

What the probe showed:

- The agent reported only `Read`, `Grep`, `Glob` (plus an unnamed deferred
  tool group, and no `Skill` tool), no other skills, and no `CLAUDE.md` or
  memory text.
- `Read`, `Grep` and `Glob` inside `skills/` did not prompt for permission;
  a read of another file in this repo did, and so did a symlink inside a
  clone that points outside the allowed folders.
- `route-skill` ran from another project; the router read the catalog without
  a prompt.

What still reaches the agent, and what the isolation does not cover:

- A git-status snapshot of the project you launch it from, the clone's own
  `AGENTS.md` after the first read, and instruction text for MCP servers you
  have connected (their tools are not available to it).
- Hooks from your own settings and plugins can still run inside a subagent;
  Claude Code has no per-agent switch for that.
- Isolation protects the subagent's context, not the calling session from
  what the subagent returns. A skill file is third-party text the agent is
  told to follow.
- A project-level `.claude/agents/<same-name>.md` outranks the user-level
  file and can shadow it.
- `omitClaudeMd` needs Claude Code 2.1.271+; older versions ignore unknown
  fields without any error.

What the installer writes under the Claude config dir, and nothing else:
`agents/*.md` (marked), `skills/route-skill/SKILL.md`, and two
`permissions.allow` rules in `settings.json` (with a `.bak` copy, mode 0600):
`Read` on this checkout's `skills/**` and `catalog/**`. Those rules apply to
every session and agent, not only these. If you move the checkout, remove the
old rules. The ownership marker on each generated agent file carries this
checkout's real path, so two checkouts installing into the same config dir
only ever prune their own stale agents — a file left behind by a different
or since-removed checkout is reported (in the install report and in
`status`'s warnings), never deleted. `status` after `install --no-claude`
reports the Claude install as stale unless you pass `--no-claude` to `status`
too.

## Tuning

Edit `repos.json` and rerun `./install.sh update`:

- `description` — the one-liner shown in pi's agent catalog and the
  spawn-routing signal for the Vibe subagent.
- `persona` — the generated agent's system prompt body.
- `skillSource` — scan a subdirectory instead of the repo root, for repos
  that ship the same skill in many tool-specific bundles (e.g.
  `impeccable` → `.pi/skills`).
- `pathExclude` — globstar patterns (`*` within one segment, `**` across
  segments) dropping skill dirs by clone-relative path, e.g. `mattpocock`
  → `["skills/in-progress/**"]`.
- `tools` — `"read-only"` (the default when omitted) or `"full"`. Sets the
  pi `tools:` and Vibe `enabled_tools` allowlist on the generated agent:
  `"read-only"` gets `read, grep, find, ls` (pi) and `["read_file",
  "grep"]` (Vibe); `"full"` omits the allowlist, so the agent keeps the
  host's normal full tool set, shell exec and file write included. Mark a
  repo `"full"` only when its skills genuinely need to edit files or run
  commands to do their job — check the actual `SKILL.md` bodies, not just
  the one-line persona, before marking a new pin `"full"`.
- `pin` — an optional commit SHA (hex, 7-40 characters). With a `pin`,
  `install`/`update` clone and check out exactly that commit and never move
  past it on their own; without one, an entry keeps the old behavior of
  tracking upstream HEAD via `pull --ff-only`. `./install.sh pin [name]`
  prints the current upstream HEAD SHA for one repo or every repo, to copy
  into `repos.json` by hand — see [Trust model](#trust-model) and
  [ADR-007](docs/decisions/ADR-007-sha-pinning-over-dry-run.md).

## Safety

- Claude Code: this tool only writes agent and skill files and the two
  `permissions.allow` rules described above. It never reads, stores or
  transmits credentials and makes no calls to Anthropic. The agents run only
  when you launch them in your own Claude Code session under your own
  account, in-session only; do not script or automate the client with them.
  Each spawned agent uses your subscription quota like any subagent. See
  Anthropic's Consumer Terms, Usage Policy and the Claude Code legal page for
  what applies to you; this README is not legal advice and the terms change.
- Secret hygiene: `hooks/pre-commit` runs `gitleaks protect --staged` on
  every commit and fails closed (no gitleaks → no commit). One-time setup
  after cloning: `brew install gitleaks && git config core.hooksPath hooks`.
  GitHub push protection is the remote-side backstop.
- `~/.pi/agent/settings.json` is backed up to `settings.json.bak` before
  any write; an unparseable settings file is never touched.
- Skill discovery is read-only: clones are only mutated by `git clone`,
  `git pull --ff-only` (unpinned entries) or `git fetch` + `git checkout`
  to the manifest's `pin` (pinned entries); a failed pull, fetch or
  checkout leaves the clone as-is.
- Repos with zero discoverable skills produce no agent (the manifest entry
  is kept — `update` picks them up if the repo gains skills later).
- `./install.sh status` is read-only and exits non-zero when anything is
  out of sync.

## Uninstall

```sh
rm -rf agents agents-vibe skills      # generated artifacts + clones
# remove the "~/repositories/skill-router/agents" entry from
# ~/.pi/agent/settings.json -> subagents.agentScanDirs
# and, from ~/.vibe/config.toml: the agents-vibe entry in agent_paths
# and the skills depth-pattern entries (skills/* .. skills/*x8) in
# [tools.read_file] -> allowlist
git config --unset core.hooksPath     # optional: disables the pre-commit hook
```

Claude Code: delete the marked files in `~/.claude/agents/` (the ones ending in
a `<!-- generated by skill-router -->` line, with or without a path after
`skill-router`), remove the two `Read(...)` entries for this checkout from
`permissions.allow` in `~/.claude/settings.json`, and delete
`~/.claude/skills/route-skill`.

## Follow-ups

The review-leftover issues from the Claude Code target (#14-#18) are all
closed. Still deferred by design, untracked: an uninstall helper, a clone
symlink sweep, `--no-claude` stickiness, and the single `.bak` generation
per merge.

## Tests

```sh
node scripts/test.mjs   # offline, fixture-based; no network needed
```

## License

skill-router is licensed under the [MIT License](LICENSE). The pinned
upstream repos it clones keep their own licenses, as listed in
[ATTRIBUTIONS.md](ATTRIBUTIONS.md).
