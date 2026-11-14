# ADR-006: Per-repo tool policy for generated pi and Vibe agents

## Status
Accepted

## Date
2026-11-14

## Context
The security audit before going public found that generated pi agents
(`agents/*.md`) and Vibe TOMLs (`agents-vibe/*.toml`) restricted skills but
not tools: pi grants an un-annotated agent its full builtin set (read, bash,
edit, write), and Vibe's `disabled_tools = ["skill"]` only removes one tool
from the full default set. A compromised upstream `SKILL.md` body would have
been an instruction channel with shell and file-write access. The Claude path
was already strict (`tools: Read, Grep, Glob`, no policy).

A blanket read-only allowlist was considered and rejected: most pinned repos'
skills genuinely edit files and run commands (superpowers' TDD loop,
mattpocock's implement, hallmark's browser-linted page builds). Restricting
those agents would break the product's stated purpose — an agent that behaves
like its repo's author intended.

## Decision
Tool access is a per-repo trust decision, made by the maintainer in the
manifest:

- `repos.json` entries accept an optional `tools` field: `"read-only"`
  (the default) or `"full"`.
- `"read-only"` emits a strict allowlist: pi `tools: read, grep, find, ls`;
  Vibe `enabled_tools = ["read_file", "grep"]` (both verified against the
  runtimes' own docs and builtin profiles).
- `"full"` omits the keys and keeps the runtime default — for personas whose
  skills need write/exec. The flag is the trust decision, visible in a
  reviewed manifest commit.
- The Claude path is always read-only regardless of policy (stricter, never
  weaker). Invalid `tools` values are a manifest load error — the policy
  fails closed.

## Alternatives Considered

### Blanket read-only allowlist
Rejected: functional regression for most pinned repos (see Context).

### Keep the implicit default, document the risk
Rejected: the whole finding was that the default is unsafe; leaving it
implicit keeps trust decisions invisible in diffs.

## Consequences
- New pins get the read-only allowlist automatically; granting full tools is
  an explicit, diff-reviewable act.
- The README Trust model documents the flag; the landing page and
  ARCHITECTURE.md describe the policy.
- Repos marked `"full"` still carry the original upstream-content risk; that
  residual is accepted and documented (see the Trust model section).
