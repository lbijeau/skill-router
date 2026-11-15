# ADR-012: Vibe router agent and the source-verified Vibe harness facts

## Status
Accepted

## Date
2026-11-14

## Context
The catalog router existed on pi and Claude Code only; Vibe routed
harness-natively via agent descriptions (issue #13). Deciding whether a
Vibe router was possible required facts about the Mistral Vibe harness
itself, verified against the installed mistral-vibe 3.0.3 package source:

- The `AgentType` enum accepts exactly `agent` and `subagent` — nothing
  else. A generated roster or router TOML must use one of these.
- `enabled_tools` is an allowlist enforced as a **ceiling, never a
  grant**: a builtin absent from it is denied in the child, and one
  present is resolved against the parent's own mode by taking the
  stricter of the two. The allowlist holds even when the parent runs in
  auto-approve.
- Discovery is `agent_paths` globbing `*.toml` (plus implicit project
  and user dirs); a non-blank `description` is all a subagent type needs
  to be visible to the parent model. Nothing beyond `agent_paths` is
  required for a new subagent to be discoverable.
- A blank description invalidates the agent type entirely, and
  instructions are capped at 64 KiB.

## Decision
Generate a committed `agents-vibe/skill-router.toml` mirroring the pi
and Claude routers: same persona, `enabled_tools = ["read_file",
"grep"]` (the same read-only set as read-only per-repo agents, justified
against Vibe's own `explore` builtin profile), `disabled_tools =
["skill"]`, and the router body instructions.

The router is **exempt from the per-repo tools policy** (ADR-006): the
`tools` field is a trust decision about upstream repos, and the router
is a generated artifact, not a manifest entry. Exemption matches the pi
and Claude routers, which are read-only by construction.

## Alternatives Considered

### Follow the per-repo tools policy
Rejected: not well-defined for a non-entry; there is no manifest entry
to read a policy from.

### No Vibe router (keep description-based routing)
Rejected as the default, retained as the honest caveat: the mechanics
are confirmed, but whether Vibe's model reaches for the router unprompted
has not been probe-verified the way Claude Code isolation was. The
README and landing page carry that caveat; re-check after Vibe upgrades.

## Consequences
- The catalog router is tri-target; the catalog's bulk stays out of the
  calling session on every harness.
- The router survives the agents-vibe prune sweep (explicitly excluded
  from the orphan sweep).
- The harness facts above are the reference for any future Vibe
  emission work in sibling repos; cite this ADR, not conversation.
