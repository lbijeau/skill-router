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
- A live probe (2026-11-14, mistral-vibe 3.0.3, headless) confirmed the
  decisive inference — and only that one: a mode TOML received a working
  spawn tool and successfully spawned the `ponytail` subagent. The probe's
  other two items were *disconfirmed headless* and resolved by artifact
  analysis, not live re-test: `write_file` is denied by the headless
  approval callback (interactive sessions prompt instead), and
  `ask_user_question` exists as the UI-layer `ui.ask_user_question`,
  absent in `-p` mode by design. An interactive smoke test (2026-11-14,
  mistral-vibe 3.0.3, `design-review` run end-to-end in a live session)
  then **verified all three inferences live**: the write-relay loop worked
  (the orchestrator wrote `docs/design.md` from the spawned agent's reply,
  26 KB, verified non-empty), `ask_user_question` produced a real
  Continue/Stop checkpoint between steps, the resume rule skipped both
  steps on re-run (no agents spawned, no files touched), and a bogus
  agent name failed with `subagent_type_not_found` — stopped and reported,
  no substitute guessed.
- Probe correction: the `AgentType` enum values are `agent` and
  `subagent` (`vibe/agents.py`); a mode is `agent_type = "agent"`, not
  `"mode"`.

## Decision

skill-router generates `agents-vibe/workflow-orchestrator.toml` — a mode
(`agent_type = "agent"`), written whenever a valid `workflows.json` exists
and removed when it does not (the same prune philosophy as the installed
manifest). The mode:

- keeps `disabled_tools = ["skill"]` and reads no manifest at runtime —
  the workflow list (names, step agents, tasks, outputs) is **baked in
  at generation time**, the same established pattern as per-repo skill
  rows. (It does read step output files at runtime, to enforce the resume
  rule's exists-and-non-empty check.)
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
to any runner's behavior is a change to all three, landed as one commit
covering all three runner artifacts plus the README; reviews must check
them together. **Known divergence:** the pi/Claude runners read
`workflows.json` at runtime, the Vibe mode is baked at generation — a
workflow edit between installs means Vibe runs the old contract until
the next install/update. Accepted as a drift window, stated here rather
than papered over.

## Consequences

- **Trust surface and residual risk.** The orchestrator runs as the root
  session with `write_file` and no path allowlist — more tool surface than
  any other generated agent. This is justified because its prompt is
  skill-router-authored, which is precisely what ADR-006's clean room does
  *not* defend against (its concern is upstream SKILL.md bodies as an
  instruction channel). The residual risk to name: step-agent replies are
  text derived from third-party skill content, so a malicious reply could
  steer a root-level writer (a prompt-injection channel). Contained by
  interactive write approvals and the step agents' mediated scaffolds,
  but real — accepted knowingly.
- The mode may name an agent whose `agents-vibe/<name>.toml` was pruned
  (repo removed since generation); dispatch then fails at runtime. The
  validator only guarantees names are in `repos.json` at generation time.
  Accepted: the mode's instructions say stop-and-report on spawn failure.
- Modes and subagents share the `agents-vibe/` directory via `agent_paths`;
  the smoke test verified the mode does **not** appear in its own spawn
  list ("that's me, and I don't appear as a spawnable config") — benign,
  as predicted.
- Vibe users select the mode explicitly (`--agent workflow-orchestrator`)
  — the same explicit-invocation UX as the skills, not a loss.
- Writes by the orchestrator prompt for approval in interactive
  sessions; headless mode auto-denies them, so workflows are an
  interactive-only feature on Vibe. That is consistent: checkpoints need
  a human anyway.
- The mode is regenerated on install/update, so workflow edits flow
  with the existing update path; no runtime manifest discovery exists to
  go stale.
- Version fragility: the spawn tool name, depth-one cap, UI tool spelling,
  and the `task` tool's config default (`allowlist = ["explore"]`, ASK
  permission — observed not to bind the root at 3.0.3, but a fragile
  default) are Unified Harness behaviours; re-probe after Vibe upgrades
  (the README already carries this warning).
