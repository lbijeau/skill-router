# ADR-001: One clean-room agent per third-party skills repo

## Status
Accepted

## Date
2026-11-13

## Context
Each pinned repo (superpowers, humanizer, ponytail, …) is a curated skill set
whose author intends the skills to be followed as a set — superpowers expects
`using-superpowers` to fire first, impeccable expects its polish checklist, and
so on. An agent spawned to work "the superpowers way" must not also see the
user's own skill catalog: the two sets have different vocabularies, sometimes
colliding skill names, and blending them makes the agent's behavior depend on
whatever else the user has installed. The user's catalog also changes over
time, so an agent that inherits it is not reproducible.

The three targets expose different scoping mechanisms, so the isolation has to
be expressed three ways, and its completeness differs per tool.

## Decision
Generate exactly one agent per repo, and restrict it to that repo's skills
only:

- **pi**: `agents/<name>.md` with `inheritSkills: false`, an explicit
  `skills:` list of everything discovered in the clone, and
  `skillPath: ../skills/<name>`.
- **Vibe**: no per-agent skill scoping exists, so `agents-vibe/<name>.toml`
  sets `disabled_tools = ["skill"]` (the subagent cannot load the parent's
  catalog) and its instructions tell it to read `SKILL.md` files as plain
  files instead.
- **Claude Code**: `agents-claude/<name>.md` limits `tools` to
  `Read, Grep, Glob` (no `Skill` tool, no MCP tools, no `Bash`) and sets
  `omitClaudeMd: true`. A source file missing its `tools:` line is refused,
  because an agent without it would inherit every tool.

The per-repo `persona` in `repos.json` is the agent's system prompt body; the
skills define how it works. Repos with zero discoverable skills produce no
agent (the manifest entry is kept, so `update` picks them up if the repo gains
skills later).

## Alternatives Considered

### Let the generated agent inherit the user's skill catalog
- Pros: no per-repo skill list to maintain; smaller agent files.
- Cons: third-party skills and the user's own would fire together; name
  collisions resolve unpredictably; behavior varies with whatever else the
  user has installed, so the agent is not reproducible and does not behave
  as the repo's author intended.
- Rejected: the whole point is to run the repo's workflows, not a blend.

### Install third-party skills into the user's catalog
- Pros: every tool sees the skills natively.
- Cons: pollutes the user's own catalog with dozens of foreign skills,
  invites name collisions, and is hard to unwind on update or uninstall.
- Rejected: the user's catalog should stay theirs.

### One agent covering all pinned repos
- Pros: one agent, one persona.
- Cons: no per-repo persona; routing between conflicting workflows (ponytail
  vs. i-have-adhd) would be arbitrary.
- Rejected: the repos disagree with each other on purpose.

## Consequences
- Each agent behaves like its repo's author intended, independent of the
  user's installed skills.
- Isolation is per-tool and not equally airtight: pi scopes skills natively,
  Vibe and Claude Code read skills as files under a tool restriction. The
  Claude Code limits were verified by a one-off probe (see the README's
  "Claude Code isolation" section) and may change with Claude Code versions.
- The `skills:` list is regenerated from the clone on every run, so new
  upstream skills appear after `update` without manifest edits.
- Duplicate skill names within one repo are deduplicated (first kept, others
  dropped and reported); duplicates across repos are fine because agents
  never share a catalog.
