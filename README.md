# skill-router

One clean-room pi agent per third-party skills repo. Each generated agent
sees exactly one repo's skills — no bleed from your normal skill catalog —
so the agent behaves like that repo's author intended.

The pinned upstream projects and their licenses are listed in
[ATTRIBUTIONS.md](ATTRIBUTIONS.md).

## Quickstart

```sh
./install.sh install   # clone repos, generate agents, wire pi settings
./install.sh update    # git pull each clone, regenerate, report deltas
./install.sh status    # read-only health table
```

Then run `/reload` in pi (or restart it) so the new agents are discovered.
Launch one from any project with the `subagent` tool, e.g. agent
`humanizer` or agent `superpowers`.

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
- Removing or renaming a manifest entry prunes its agent file and clone on
  the next run.

## Tuning

Edit `repos.json` and rerun `./install.sh update`:

- `description` — the one-liner shown in pi's agent catalog.
- `persona` — the generated agent's system prompt body.
- `skillSource` — scan a subdirectory instead of the repo root, for repos
  that ship the same skill in many tool-specific bundles (e.g.
  `impeccable` → `.pi/skills`).
- `pathExclude` — globstar patterns (`*` within one segment, `**` across
  segments) dropping skill dirs by clone-relative path, e.g. `mattpocock`
  → `["skills/in-progress/**"]`.

## Safety

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
rm -rf agents skills                      # generated artifacts + clones
# remove the "~/repositories/skill-router/agents" entry from
# ~/.pi/agent/settings.json -> subagents.agentScanDirs
```

## Tests

```sh
node scripts/test.mjs   # offline, fixture-based; no network needed
```
