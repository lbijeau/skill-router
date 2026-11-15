# ADR-010: The Vibe workflow runner is a generated mode TOML

Date: 2026-11-14

## Status

Accepted. Extends ADR-009.

## Context

ADR-009 shipped workflows with runners for pi and Claude Code (installed
skills) and a docs-only manual procedure for Vibe, because Vibe agents get
`disabled_tools = ["skill"]` — a skill cannot be the runner there. The
parked question was whether Vibe could get a real runner.

A `research-to-verdict` workflow run (research → architecture review →
verdict, artifacts in the session's workflow outputs) established:

- Vibe's Unified Harness caps subagents at depth one — a subagent cannot
  spawn other subagents, so an orchestrator subagent is impossible.
- Anything with `agent_type = "agent"` is a **mode**: user-selectable
  (`--agent NAME`, Shift+Tab), runs at the root, and is exactly the thing
  that can call `agents.spawn`.
- A live probe (2026-11-14, mistral-vibe 3.0.3) confirmed the decisive
  inference: a mode TOML received a working spawn tool and successfully
  spawned the `ponytail` subagent. The probe's other two negatives were
  headless-mode artifacts: `write_file` is denied by the headless approval
  callback (interactive sessions prompt), and `ask_user_question` exists
  as the UI-layer `ui.ask_user_question`, absent in `-p` mode by design.
- Probe correction: the `AgentType` enum values are `agent` and
  `subagent` (`vibe/agents.py`); a mode is `agent_type = "agent"`, not
  `"mode"`.

## Decision

skill-router generates `agents-vibe/workflow-orchestrator.toml` — a mode
(`agent_type = "agent"`), written whenever a valid `workflows.json` exists
and removed when it does not (the same prune philosophy as the installed
manifest). The mode:

- keeps `disabled_tools = ["skill"]` and reads nothing at runtime that is
  not baked into its instructions — the workflow list (names, step
  agents, tasks, outputs) is **baked in at generation time**, the same
  established pattern as per-repo skill rows.
- dispatches each step's agent via the spawn tool with the step's task
  text, waits for the reply, and **writes the output file itself** from
  the subagent's returned text. Step agents keep their ADR-006 read-only
  allowlists; the orchestrator is the single writer. (The verdict's F4:
  a prompt clause cannot mechanically verify non-stub replies — accepted
  as a known limit rather than papered over.)
- checkpoints between every step via `ask_user_question`, honoring the
  ADR-009 contract on the third harness, and skips steps whose output
  file already exists and is non-empty (the shared resume rule).
- needs no `config.toml` change: `agent_paths` already loads
  `agents-vibe/` (ADR-004 respected by omission).

**Lockstep duty:** the three runners (pi skill, Claude Code skill, Vibe
mode) implement one contract — dispatch in order, verify output,
checkpoint between steps, resume by skipping completed outputs. A change
to any runner's behavior is a change to all three; reviews must check
them together.

## Consequences

- Vibe users select the mode explicitly (`--agent workflow-orchestrator`)
  — the same explicit-invocation UX as the skills, not a loss.
- Writes by the orchestrator prompt for approval in interactive
  sessions; headless mode auto-denies them, so workflows are an
  interactive-only feature on Vibe. That is consistent: checkpoints need
  a human anyway.
- The mode is regenerated on install/update, so workflow edits flow
  with the existing update path; no runtime manifest discovery exists to
  go stale.
- Version fragility: the spawn tool name, depth-one cap, and UI tool
  spelling are Unified Harness behaviours; re-probe after Vibe upgrades
  (the README already carries this warning).
