# skill-router

One clean-room agent per third-party skills repo, for both **pi** and
**Mistral Vibe**. Each generated agent sees exactly one repo's skills —
no bleed from your normal skill catalog — so the agent behaves like that
repo's author intended.

The pinned upstream projects and their licenses are listed in
[ATTRIBUTIONS.md](ATTRIBUTIONS.md).

## Quickstart

```sh
./install.sh install   # clone repos, generate agents, wire pi + Vibe settings
./install.sh update    # git pull each clone, regenerate, report deltas
./install.sh status    # read-only health table
```

Then:

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
  `skillSource` / `pathExclude` curation.
- Each repo is shallow-cloned into `skills/<name>/` (gitignored, never
  committed).
- One agent definition is generated into `agents/<name>.md` (committed)
  with `inheritSkills: false`, an explicit `skills:` list of everything
  discovered in the clone, and `skillPath: ../skills/<name>`.
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
- Removing or renaming a manifest entry prunes its agent file and clone on
  the next run.

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

## Safety

- Secret hygiene: `hooks/pre-commit` runs `gitleaks protect --staged` on
  every commit and fails closed (no gitleaks → no commit). One-time setup
  after cloning: `brew install gitleaks && git config core.hooksPath hooks`.
  GitHub push protection is the remote-side backstop.
- `~/.pi/agent/settings.json` is backed up to `settings.json.bak` before
  any write; an unparseable settings file is never touched.
- Skill discovery is read-only: clones are only mutated by `git clone` /
  `git pull --ff-only`; a failed pull leaves the clone as-is.
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

## Tests

```sh
node scripts/test.mjs   # offline, fixture-based; no network needed
```
