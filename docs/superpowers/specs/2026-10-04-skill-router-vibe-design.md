# Skill Router — Vibe Output Target Design

Date: 2026-10-04
Status: proposed (revised after four-persona SME review)
Companion to: [2026-07-09-skill-router-design.md](2026-07-09-skill-router-design.md)

## Purpose

Extend skill-router with a second derived output target so the same
manifest (`repos.json`) also drives **Mistral Vibe** subagents — one per
third-party skills repo, each seeing exactly that repo's skills and nothing
else. The clean-room guarantee is the requirement: no bleed from the user's
own Vibe skill catalog, no cross-repo name collisions.

Everything already true for pi stays true: the manifest is the single
source of truth; clones, agent definitions, and settings wiring are derived
and regenerable; generation is idempotent; `git diff` on committed
artifacts shows skill-list churn after `update`.

## Context (what Vibe provides)

- Vibe's skill catalog is **global**: `skill_paths` (config.toml),
  `.vibe/skills/`, `.agents/skills/`, `~/.vibe/skills/`,
  `~/.agents/skills/`. There is no per-agent skill catalog — no
  equivalent of pi's `inheritSkills: false` / `skills:` / `skillPath:`
  frontmatter.
- Custom **subagents** are TOML files discovered from `~/.vibe/agents/`,
  `.vibe/agents/`, and extra dirs via the `agent_paths` config key. A file
  with `agent_type = "subagent"` is offered to the model to spawn (never
  user-selectable). Fields: `description`, `enabled_tools`,
  `disabled_tools`, per-tool `permission`, and a prompt — `instructions`
  (inline) or `system_prompt_id`. `instructions` wins when both are
  present. An agent file that cannot be honored (no description, a
  prompt id that resolves nowhere) is dropped and reported in the
  session's config issues — the manifest's required-fields validation
  makes both drop conditions unreachable for generated files.
- On the **Unified Harness**, subagents run on built-in tools only (no
  MCP/connector/plugin tools). `read_file` is built-in. On the legacy
  harness the tool set may differ; validation covers this.
- **File-tool permission resolution** (denylist → allowlist →
  sensitive_patterns → outside-workdir → default permission) applies to
  `read_file`. This is load-bearing for this design — see Permission
  wiring.
- A subagent's cwd is the parent session's project cwd (undocumented but
  robustly assumed), so relative paths in `instructions` do not resolve
  usefully. All paths in generated artifacts are absolute.
- Subagent invocations inherit the parent's hooks (`pre_tool` matchers on
  `read_file` or `task` can deny the file route).

### pi → Vibe mapping

| pi mechanism | Vibe equivalent |
|---|---|
| `agents/<name>.md` (committed) | `agents-vibe/<name>.toml` (committed) |
| `inheritSkills: false` + explicit `skills:` | `disabled_tools = ["skill"]` + embedded skill table in `instructions` |
| `skillPath: ../skills/<name>` (relative, resolved against agent file) | absolute `SKILL.md` path baked into `instructions` |
| advertised catalog (name + description, load on demand) | skill table (name + description) in `instructions`; agent reads `SKILL.md` via `read_file` |
| `subagents.agentScanDirs` in `~/.pi/agent/settings.json` | `agent_paths` in `~/.vibe/config.toml` (honors `VIBE_HOME`) |
| model launches agent by description | same — `description` is the routing signal |

## Non-goals

- Making the routed skills available to Vibe's global catalog (the
  opposite of the guarantee — see Rejected alternative).
- Vibe plugins per repo. Plugins contribute skills to the session's
  catalog, which is global; same bleed problem, plus plugins cannot point
  at a directory outside their own tree.
- Any change to the pi target's output, the manifest schema, discovery
  rules, or curation. The Vibe target is purely additive.

## Rejected alternative: global `skill_paths`

Adding each clone to Vibe's `skill_paths` would expose every routed skill
to every session. It breaks isolation by construction and collides with
the user's own skills (e.g. `superpowers` clones `brainstorming`,
`writing-plans` etc., which the user already has in `~/.vibe/skills/`).
Rejected.

## The clean-room mechanism

pi isolates mechanically: the child agent's catalog contains exactly the
pinned skills. Vibe has no per-agent catalog, so the design recreates the
guarantee with two moves:

1. **Seal the tool route.** The generated TOML sets
   `disabled_tools = ["skill"]`. The subagent cannot load anything from
   the parent's skill catalog through the skill tool.
2. **Grant the file route.** `instructions` embeds a table of the repo's
   skills (name + description + absolute `SKILL.md` path). The agent
   reads the matching `SKILL.md` with `read_file` on demand — the same
  advertise-then-load pattern pi provides, re-homed in the prompt.

**Stated precisely** (the guarantee is three routes, not one):

- The **tool route** is sealed mechanically by `disabled_tools` —
  load-bearing, documented, but not yet exercised; assumption 2.
- The **advertisement route** (system-prompt skill advertisement that
  Vibe composes when `include_prompt_detail = true`) is *validated, not
  enforced*: assumption 4 asks the child what skills it was told about,
  not merely which it can load.
- The **file-read route** into the user's own skill dirs is constrained
  by Vibe's permission model and by nothing this repo controls; it is
  out of scope and noted as residual risk.

If assumption 2 fails, the fallback is prompt-level isolation only
(materially weaker) or dropping the Vibe target until Vibe gains
per-agent skill scoping; the decision gets recorded here, not papered
over.

## Generated artifact

`agents-vibe/<name>.toml` — one per manifest entry with ≥1 discoverable
skill; committed; byte-identical on re-run.

```toml
agent_type = "subagent"
description = "Blunt, opinionated senior-engineer persona"
disabled_tools = ["skill"]
instructions = """
You are Ponytail: a blunt, opinionated senior engineer ... (manifest persona, unchanged)

You have no skill tool; if one is offered anyway, do not use it. Your
skills are files. When a task matches one, read its SKILL.md with
read_file and follow it. If a skill's instructions tell you to use or
load another skill, read that skill's SKILL.md the same way and follow
it. If a read comes back truncated, say so.

- ponytail-core: <normalized description> — /Users/<user>/repositories/skill-router/skills/ponytail/core/SKILL.md
- ponytail-review: <normalized description> — /Users/<user>/repositories/skill-router/skills/ponytail/review/SKILL.md
"""
```

Rules:

- `description` reuses the manifest field verbatim (it is the model's
  spawn signal) with TOML basic-string escaping.
- `instructions` reuses the manifest `persona` verbatim — shared with
  the pi target, so persona tuning stays one-place — followed by the
  generated boilerplate above and the skill table. The boilerplate's
  wording is deliberately state-describing ("You have no skill tool"),
  not prohibition of a tool the child cannot see. The persona's closing
  "when a task matches one, read it and follow it" sentence mildly
  duplicates the boilerplate; accepted cost of the shared-persona
  tradeoff.
- **Table rows are single-line**: `- <name>: <description> — <absolute
  SKILL.md path>`. Full absolute path per row (never a clone-root +
  relative-path join the child must execute) — deletes a known
  subagent failure mode (resolving relative-looking paths against its
  own cwd).
- The fixed boilerplate sentences are machine-independent constants;
  the first one doubles as the prune marker (below).
- Skills excluded by `skillSource`/`pathExclude` or dropped as
  duplicates never appear — the Vibe target consumes the same
  `discoverSkills` result as pi (one discovery per entry per run,
  shared by both renderers and the report).
- Zero discoverable skills → no TOML file, and any leftover from an
  earlier run is removed — same rule as the pi target (`graphify`
  currently produces no agent on either target).
- Drift detection is content-based, same as pi: `status` re-renders into
  memory and byte-compares. No "generated" marker inside the file.
- Committed TOMLs are machine-specific (absolute paths); a new machine
  regenerates rather than copies. Accepted: the repo already wires into
  the user's home.

## Description normalization

Skill descriptions come from `SKILL.md` frontmatter and need more than
the single-line read the pi target required (real repos — ponytail,
humanizer — ship folded/literal block scalars; 7 of 82 roster skills;
name-only fallback would gut exactly the sibling-heavy repos where
disambiguation matters).

`parseSkillFrontmatter` (a second pass, separate from the existing
`name:` loop):

- `description: <text>` → the trimmed single-line value, surrounding
  quotes stripped.
- `description: >` / `|` (any `spec`/`strip` indicator suffix) → consume
  the indented block that follows, join lines with a single space,
  collapse all whitespace to single spaces.
- Normalize: strip control characters (tab → space); if the result is
  empty or unrepresentable, fall back to name-only.
- **Deterministic truncation** (byte-stable output): if the normalized
  description exceeds 240 characters, truncate at the first sentence
  boundary (`. `, `! `, `? `) within 240; if none, cut at the last word
  boundary within 240 and append `…`.

**The pi-bytes-unchanged constraint, pinned:** the existing `name:`
resolution loop stays byte-identical — description parsing is a
separate pass over the captured frontmatter lines, never emits new
warnings, never alters name resolution, `dropped`, or warning output.
A folded description block containing a `name:` line inside it must
not change the resolved name (fixture-pinned). CRLF handling: the
value is `trimEnd()`-stripped so no `\r` leaks into a TOML string.

## Generator changes — `scripts/generate.mjs`

No new dependencies; node ≥ 18 standard library only.

- **`renderVibeAgentTOML(entry, skills, repoRoot)`** + a
  `writeVibeAgentFiles` pass mirroring `writeAgentFiles`, honoring the
  same `failed` skip set (a clone that failed this run leaves its
  pre-existing TOML untouched), including stale-file removal for
  zero-skill entries. Both writers consume one `discoverSkills` result
  per entry so the targets can never disagree.
- **`mergeVibeConfig(configPath, repoRoot)`** — idempotent merge into
  `~/.vibe/config.toml` (`VIBE_HOME` honored when set). See Scan grammar
  and Permission wiring.
- **`prune`** also covers `agents-vibe/`: a `agents-vibe/<name>.toml`
  whose `<name>` left the manifest is removed only when it carries the
  fixed machine-independent boilerplate marker (the first generated
  boilerplate sentence, verbatim) — the same principle as pi's
  `skillPath:` marker check, not a content byte-compare (impossible:
  the departed entry has no manifest data to render against). A
  user-authored TOML without the marker survives. Report line:
  `pruned <name> (vibe agent)`.
- **`status`** gains a VIBE column: `in-sync` / `stale` / `missing`,
  and `—` only for zero-skill entries **with no TOML on disk**; a
  zero-skill entry with a leftover TOML shows `stale` (exit non-zero) —
  the same expected-absence rule as pi. Non-zero exit when anything
  pi- or Vibe-side is out of sync; exit stays 0 when only the Vibe
  config merge bailed (report-only, pi parity). A fresh checkout on a
  new machine shows every VIBE column `stale` until the first
  `install` regenerates absolute paths — expected, not a bug.
- **`install` / `update`** drive both targets in one run — no new
  commands, no flags. The report distinguishes targets per entry, e.g.
  `ponytail: reused, 6 skills, agent written (pi, vibe)`. Update skill
  deltas are computed once from the pi agent file (both targets share
  the same skill set) and reported once. The report ends with two
  reminders: run `/reload` (or restart Vibe) to pick up new agents, and
  `enabled_agents` / `disabled_agents` config filters override
  discovery — check neither hides the generated names.

### Scan grammar (line-wise TOML, no parser)

The merge operates on a **top-level region** defined precisely:

- Region = all lines before the first line matching `^\s*\[` — both
  `[table]` and `[[array-of-tables]]` headers, indented or not.
- `agent_paths` is recognized **only inside the region**. An
  `agent_paths` line after any header belongs to that table; it is
  invisible to the merge — never edited, never merged into (silently
  corrupting a sub-table is the failure this rule exists to prevent).
- The insert-when-absent position is immediately before the first
  header's **contiguous comment block** (comments directly above the
  header), not between a table's docs and its header. No headers →
  append at EOF. Insert after any BOM; ensure the previous line ends
  with a newline before appending.
- Accepted existing form (single-line, top-level) — strict grammar:
  `^\s*agent_paths\s*=\s*\[\s*(elements)\s*\]\s*$`, elements being
  basic or literal strings separated by commas with optional whitespace
  and a trailing comma. Re-rendered canonically. Anything else —
  trailing inline comment, non-array value, duplicate top-level
  `agent_paths` lines, multi-line array — → **safe-bail**.
- **Multi-line-string blindness**: if the file contains `"""` or `'''`
  anywhere, safe-bail outright (a multi-line string can contain a fake
  header or fake `agent_paths` line; conservative refusal is
  predictable). The insert path runs the same scan, not just the merge
  path.
- Byte discipline: preserve the file's dominant line-ending convention
  on rewritten/appended lines; a `\r` must not defeat the key grammar.
- **The written entry is an absolute path** (`os.homedir()`-expanded) —
  tilde expansion inside `agent_paths` values is undocumented in Vibe;
  an unexpanded `~` is a silent total no-op of the target.
- Safe-bail is **actionable, not a dead end**: the warning prints the
  exact manual remedy — the literal element to add, and for the
  multi-line case the exact line to insert before the closing bracket.
  Bail is report-only, exit 0.
- Backup/atomicity parity with `mergeSettings`: `.bak` replaced (never
  written through — pre-existing `.bak` symlinks cannot redirect) only
  immediately before the first modifying write; no `.bak` on
  no-change/bail runs; parent dirs created (`recursive: true`) for the
  fresh-file case; all writes temp + rename.

### Permission wiring (the outside-workdir wall)

Reading `~/repositories/skill-router/skills/...` from a parent session
in **any other project** is outside-workdir by construction — Vibe's
default resolution requires approval (or denies at
`permission = "never"`), and on the Unified Harness a subagent's own
tool config cannot loosen this. The file route is the design's spine,
so the mitigation is designed in, not hoped away:

- `mergeVibeConfig` **also** ensures a top-level table in config.toml:

  ```toml
  [tools.read_file]
  allowlist = ["/Users/<user>/repositories/skill-router/skills/**"]
  ```

  The allowlist is checked **before** the outside-workdir rule, so this
  auto-approves clone reads. Envelope: `[tools.read_file]` absent →
  append the whole table at EOF (appending a new table after
  everything is always valid TOML — the one structurally safe
  insertion); present with a single-line `allowlist` → merge with the
  same real-path dedup; present in any other form → safe-bail with the
  exact manual remedy.
- Validation (assumption 3) probes the **unmitigated** behavior first —
  whether default Vibe auto-approves, prompts, or denies clone reads —
  so the spec records whether the allowlist is necessary or merely
  belt-and-suspenders.

## Settings wiring (Vibe side)

`~/.vibe/config.toml` (or `$VIBE_HOME/config.toml`) gains:

```toml
agent_paths = ["/Users/<user>/repositories/skill-router/agents-vibe"]
```

Absolute entry; same real-path comparison semantics as the pi
`subagents.agentScanDirs` merge (added only if not already present,
symlinked equivalents deduped).

## Failure handling

| Condition | Behavior |
|---|---|
| Clone fails for entry X | Vibe writer honors the same `failed` skip set as pi; pre-existing TOML for X untouched |
| Zero `SKILL.md` in a valid clone | No TOML; stale TOML removed; manifest entry kept (same as pi) |
| User-authored TOML at `agents-vibe/<manifest-name>.toml` | Overwritten — `agents-vibe/` is fully generated for manifest names; prune protection applies only to non-manifest names (same as pi's `agents/`) |
| config.toml read-only / `VIBE_HOME` unwritable | Warn-skip like the unparseable case; never crash mid-flow |
| `VIBE_HOME` set, dir doesn't exist | Parent dirs created before creating config |
| TOML write fails mid-`writeVibeAgentFiles` | Reported per target; never reported as "agent written (pi, vibe)" |
| `agent_paths`/`[tools.read_file]` in an unmergeable form | Safe-bail + exact manual remedy; report-only, exit 0 |
| Unparseable config.toml | Never touched; warning |

## Testing — `scripts/test.mjs`

Fixture-based, offline, no network, no deps — same harness as today.

**Rendering:**
- Vibe TOML rendering: frontmatter names + normalized descriptions +
  **absolute per-row paths** in the table; `agent_type`,
  `disabled_tools = ["skill"]`; persona verbatim; boilerplate marker
  sentence verbatim.
- Description normalization: folded (`>`), literal (`|`), `>-`, quoted
  single-line, empty, missing, >240-char truncation (both sentence and
  word-boundary branches), block containing a `name:` line (name
  resolution unchanged), CRLF description (no `\r` in TOML).
- TOML escaping: `"` and `\` in persona/description; `"""` inside the
  persona; persona ending in `"`; control characters normalized or
  name-only fallback.
- Idempotency: byte-identical re-run.
- Zero-skill entry: no TOML; stale TOML removed.

**mergeVibeConfig:**
- Absent key + tables → inserted before the first header's comment
  block; absent + no tables → appended; absent + indented/`[[x]]`
  headers → still before the first; comment containing `[` before the
  first header.
- Single-line array: quoted/literal elements, trailing comma,
  no-space spelling → merged, no duplicate; trailing inline comment /
  non-array value / duplicate keys / multi-line array / any `"""`
  or `'''` in file → safe-bail, file untouched, warning contains the
  manual remedy.
- `agent_paths` under a sub-table → invisible; top-level key inserted;
  the tabled line untouched.
- BOM, CRLF, no-trailing-newline files.
- `.bak` symlink replaced not written through; no `.bak` after
  no-change/bail; `VIBE_HOME`-pointed config path (parent dirs created).
- `[tools.read_file]` absent → table appended at EOF; single-line
  allowlist merged; exotic form → bail.

**Flow / status / prune:**
- Exit 1 when only the VIBE side is stale (pi column `in-sync`).
- Zero-skill + leftover TOML → `stale`, exit non-zero; zero-skill + no
  TOML → `—`, exit 0.
- Prune removes both `agents/<name>.md` and `agents-vibe/<name>.toml`
  for a departed entry; user-authored files (no marker) survive in both
  dirs.
- Clone-failure leaves the pre-existing Vibe TOML untouched.
- Status: persona change flips the VIBE column to `stale`.
- Update deltas reported once, not per target.

## Assumptions to validate on first run

Same discipline as the pi spec's validation section. On a real Vibe
install with `agent_paths` wired and a parent session cwd outside this
repo, in order (each later item presumes the earlier ones):

1. **`agent_paths` discovery (prerequisite)** — a generated subagent
   appears in the spawnable set (subagent status list); neither
   `enabled_agents` nor `disabled_agents` filters the generated names.
2. **`disabled_tools = ["skill"]` honored in subagents (load-bearing)** —
   the child reports no access to the parent's catalog through the
   skill tool.
3. **Permission wall behavior (unmitigated first)** — from the unrelated
   project, `read_file` of a clone `SKILL.md`: auto-approved / prompts /
   denied, recorded for each outcome; then confirm the
   `[tools.read_file]` allowlist entry (if the generator added it)
   auto-approves clone reads. Records whether the allowlist is
   necessary.
4. **Advertisement bleed** — ask the child what skills it was **told
   about** (system-prompt advertisement), not merely which it can
   load; advertisement of the parent's catalog is residual risk, not a
   spec failure.
5. **`read_file` availability + truncation** — the child reads a
   `SKILL.md` via the absolute path; large files report truncation.
6. **Description routing** — the parent model spawns the right agent
   for a matching task from an unrelated project.
7. **Routing fidelity** — spawn a concrete task (e.g. `mattpocock` with
   a TDD task); the child's transcript shows `read_file` of the right
   `SKILL.md` and the output follows it.
8. **Parser acceptance** — the generated TOMLs parse in Vibe's real
   TOML parser (escaping correctness is fixture-tested offline but
   only provable here); changes picked up after `/reload` or restart.

If (2) fails, the fallback is prompt-level isolation (weaker) or
dropping the Vibe target until Vibe gains per-agent skill scoping; the
decision gets recorded here, not papered over.

## Validation results (2026-10-04, live install, unified harness v2.25.8)

Validated against a real Vibe session in an unrelated project
(`planetron`), driven via Herdr pane control; config entries applied
manually per the remedy (the generator correctly refused this
pretty-printed, multi-line-array config — the envelope held on first
contact with a hostile-to-line-grammar file).

| # | Assumption | Result |
|---|---|---|
| 1 | `agent_paths` discovery | **Pass** — all 9 subagents listed with their manifest descriptions; `graphify` correctly absent; empty `enabled_agents`/`disabled_agents` did not filter |
| 2 | `disabled_tools = ["skill"]` honored | **Pass, with nuance** — the skill tool remains *visible* in the child's schema, but an actual load attempt returned `tool_denied`; the seal holds at invocation |
| 3 | Permission wall | **Finding** — the child's clone `SKILL.md` read triggered an outside-workdir approval prompt in the parent UI *despite* `[tools.read_file] permission = "always"` **and** the generated allowlist entry. The unified harness exposes the tool as `file_system.read_file` (namespaced), and the `[tools.read_file]` config keys apparently do not bind to it. The allowlist mitigation as designed does **not** work on the unified harness; "Allow once" permitted the read |
| 4 | Advertisement bleed | **Confirmed** — the child was told about parent-catalog skills in its prompt (in addition to its file-route skill). Pre-classified residual risk; isolation rests on the tool-route seal (which holds) |
| 5 | `read_file` availability + truncation | **Pass** — full 397-line read (`was_truncated: false`), child disclosed byte counts unprompted |
| 6 | Description routing | **Pass** — a natural rewrite task (no agent named) was spontaneously delegated to `humanizer` |
| 7 | Routing fidelity | **Pass** — child read the right `SKILL.md` via its absolute path and its rewrite followed the skill |
| 8 | TOML parser acceptance | **Pass** — `/reload` surfaced no config issues; all 9 TOMLs also parse under Python `tomllib` |

Offline pre-validation: the generator's refusal behavior (bail + exact
manual remedy + no write + no `.bak`) held against the real config; all
generated TOMLs are strict-parser-valid; the folded-description pipeline
renders the ponytail flagship artifact as designed.

**Open decision (assumption 3):** on the unified harness, subagent skill
reads surface a per-read approval prompt in the parent. Options: accept
the prompts (each skill activation needs one Allow), find the config key
that governs the namespaced `file_system.read_file` tool, or launch with
`--add-dir` to pre-trust the clone tree. Until one lands, the allowlist
duty is harmless but inert on the unified harness.

## Risks / unknowns

- **Isolation strength**: the tool route is harness-enforced
  (`disabled_tools`), the advertisement route is validated-not-enforced
  (assumption 4). Explicitly weaker than pi's catalog-level enforcement
  until validated.
- **The permission wall**: outside-workdir reads are the design's
  biggest environmental dependency; the allowlist is the designed
  mitigation, validated in assumption 3. `pre_tool` hooks matching
  `read_file` (inherited by subagents) can still deny the route —
  user-side, out of this repo's control.
- **Absolute paths in committed artifacts**: regenerated per machine;
  cross-machine `git diff` churn; `status` all-`stale` on a new machine
  until first `install`. Accepted (the repo already bakes the user's
  home into pi wiring).
- **Vibe config edits are line-wise**, not a real TOML parser. The
  envelope (strict region grammar, multi-line-string refusal, backup
  first, actionable bail) bounds the blast radius the same way the pi
  JSON merge does.
- **Long skill tables**: `addyosmani` (25) and `mattpocock` (31) embed
  ~30 description lines per spawn. pi eagerly advertises
  name+description in the child's system prompt too and loads bodies on
  demand in both designs — the eager cost is genuinely comparable;
  per-row absolute paths add modest bytes.
- **Dirty clones**: table descriptions freeze at generation time; a
  `reused (dirty)` clone can disagree with its `SKILL.md` until the
  next `update`.
- **Name collisions with user agents**: a user file
  `~/.vibe/agents/<name>.toml` (or a same-named entry in another
  `agent_paths` dir) collides with a generated name; precedence is
  undocumented in Vibe. `status` warns when a manifest name also
  exists in `~/.vibe/agents/`.
- Vibe may change subagent or `agent_paths` semantics across releases;
  `status` drift detection plus the validation checklist are the safety
  net.

## Review provenance

Revised 2026-10-04 after a four-persona SME review (Vibe internals,
config-file safety, prompt/agent design, test/generator integration).
All Critical and Important findings were incorporated; the material
design changes, each traceable to review findings: the permission wall
and its allowlist mitigation, block-scalar description parsing,
top-level-only TOML scan grammar with multi-line-string refusal,
marker-based prune, the zero-skill status rule, absolute paths
everywhere (entries and skill rows), boilerplate rewording, the
chained-skill rule, and the expanded failure/test/assumption tables.
