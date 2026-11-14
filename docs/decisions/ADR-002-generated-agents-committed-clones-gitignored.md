# ADR-002: Generated agents are committed; skill clones are gitignored

## Status
Accepted

## Date
2026-11-13

## Context
Every run produces two kinds of files from the same clones: the generated
agent definitions (`agents/`, `agents-vibe/`, `agents-claude/`, plus
`catalog/`), and the shallow clones themselves under `skills/<name>/`. The
clones are large, third-party code under their own licenses (see
ATTRIBUTIONS.md), and are fully rebuildable from `repos.json` with a shallow
`git clone`. The agent files are small, reviewed text that defines what each
agent is allowed to know and say.

## Decision
Commit the generated artifacts (`agents/`, `agents-vibe/`, `agents-claude/`,
`catalog/`); gitignore the clones (`.gitignore` contains only `/skills/`).
Clones are treated as a disposable cache, rebuilt by `./install.sh install`
and refreshed by `git pull --ff-only` on `update`.

## Alternatives Considered

### Commit the clones (vendoring / subtrees)
- Pros: checkout works with no network; exact upstream state in history.
- Cons: repository size balloons; upstream code and licenses enter our git
  history, making attribution and license compliance harder; upstream
  updates become merge work.
- Rejected: `repos.json` plus a shallow clone already pins the state, and
  ATTRIBUTIONS.md carries the license list without vendoring the code.

### Gitignore the generated agents too
- Pros: nothing derived is committed; single source of truth.
- Cons: what an agent will say (persona, skill list) becomes invisible to
  git history and PR review; `status` comparisons and other checkouts lose
  the reviewable diff; regenerating on every checkout adds a network
  dependency to merely reading an agent.
- Rejected: the agent files are the product. Reviewing their diffs is the
  main way to catch an upstream change that alters agent behavior.

## Consequences
- `update` diffs are reviewable: persona edits, new skills, and upstream
  skill changes all show up as agent-file diffs in a PR.
- A fresh checkout must run `./install.sh install` before agents actually
  work — the committed `skillPath: ../skills/<name>` points into a clone
  that does not exist yet.
- Pruning is conservative: stale agent files are deleted only when they
  look generated (pi: `skillPath:` match; Vibe: boilerplate marker; Claude:
  ownership marker), so hand-written files of the same name are left alone.
- Upstream code never enters this repo's history; license obligations stay
  in ATTRIBUTIONS.md.
