# ADR-009: Workflows as an internal seam inside skill-router

Date: 2026-11-14

## Status

Accepted. **Closed 2026-11-14 by [ADR-011](ADR-011-extract-workflows-to-skill-workflows.md):**
the split trigger fired (a second agent source — agent-roster — needed to
appear in a workflow), the module was extracted to skill-workflows, and the
seam held: the extraction moved `workflows.json`, the validator, and the
three runners out without touching `repos.json` or generation.

## Context

skill-router generates one clean-room agent per third-party skills repo.
Users increasingly want multi-agent *workflows*: sequenced runs of
generated agents with file-shaped handoffs and human checkpoints between
stages (the pattern proven by agent-roster's SDLC pipeline). We must
decide whether workflows belong in their own repository or inside
skill-router.

We apply the deep-module vocabulary (see the `codebase-design` skill):

- **Adapter test**: one adapter means a hypothetical seam; two adapters
  means a real one. Today the only agent source a workflow would compose
  is skill-router's own generated agents — one adapter. No second source
  (agent-roster stage agents, hand-written agents, other harnesses)
  exists yet.
- **Deletion test**: the orchestration logic — handoff-file contracts,
  checkpoint pauses, resume — is real implementation. Delete it and the
  complexity reappears across every user chaining agents by hand. The
  module earns its keep; the question is only *where the seam lives*.
- **Depth**: a workflow spec is a small interface (name + ordered steps,
  each step naming an agent and its output file) hiding a lot of
  behaviour (sequencing, handoff enforcement, checkpoints, resume). A
  textbook deep module.

## Decision

Workflows are built as a module **inside skill-router**, behind a
deliberately narrow interface: a `workflows.json` manifest alongside
`repos.json`, where each workflow is a name plus an ordered list of
steps, each step naming a generated agent (by repo name) and its output
file. Everything else — sequencing, handoff-file enforcement,
pause-at-human-checkpoint — is implementation behind that interface.

The narrowness of the interface is the point: it makes a future
extraction cheap.

**Split trigger.** Extract workflows into their own repository when a
workflow needs to compose an agent skill-router did not generate — a
second *agent-source* adapter appears (e.g. agent-roster stage agents
or a hand-written agent).

Shipping workflow runners to additional harnesses does **not** fire the
trigger: the harness axis is skill-router's existing business (one
source of truth, N harness emitters — `agents/`, `agents-claude/`,
`agents-vibe/`). The manifest and validator are harness-agnostic; only
the runner artifact varies per harness. The agent interface (workflow
step → generated agent + output file) still has exactly one adapter.

Until the agent-source trigger fires, the seam stays internal.

## Consequences

- One install gets routing and pipelines; skill-router's "one repo, one
  concern" story stays intact for now.
- The workflow engine must not leak skill-router internals through its
  interface, so the eventual extraction is mechanical.
- When the split trigger fires, `workflows.json` and the engine move
  out; `repos.json` and generation stay.
- Per-harness runners stay in lockstep on behaviour (dispatch each
  step's agent, verify the output file, one human checkpoint between
  steps); only the dispatch mechanism and install location differ.

## Considered and rejected

- **Own repo now**: the second adapter does not exist yet; a repo-level
  seam would be premature, and it would cost an extra install and a
  prematurely defined agent interface with no consumer.
- **Docs/recipes only** (no engine): fails the deletion test — handoff
  and checkpoint discipline is real logic, as agent-roster
  demonstrated; prose does not enforce it.
