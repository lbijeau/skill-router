# skill-workflows Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the workflows module from skill-router into a new `skill-workflows` repo with an agent-agnostic registry, per ADR-011, and integrate agent-roster's six stage agents as the second agent source.

**Architecture:** `skill-workflows` owns: the manifest format + validator (ported from skill-router's `scripts/workflows.mjs`), an `agents.json` registry (name + optional per-harness paths), the three runners (pi skill, Claude Code skill, Vibe mode generation), and its installer. Steps reference registry names; runners dispatch by name per harness. skill-router loses the runners and workflow wiring; agent-roster contributes registry entries plus an SDLC workflow.

**Tech Stack:** Node.js ≥ 18 ESM, no dependencies — the same stack and test pattern (`test()` self-registering, `node scripts/test.mjs`) as skill-router, ported.

**Spec:** skill-router `docs/decisions/ADR-011-extract-workflows-to-skill-workflows.md`

## Global Constraints

- No new npm dependencies; Node ≥ 18 built-ins only.
- The workflow spec is unchanged: name, description, steps of (agent, task, output). No typed handoffs, preconditions, or gate semantics in v1.
- Registry entries: `name` (NAME_RE), optional `pi`/`claude`/`vibe` path strings (tilde-anchored at emission, resolved at use). A workflow step's agent must exist in the registry; the validator rejects unknown names with workflow + agent in the message.
- Dispatch is by name on every harness (pi subagent, Claude Task, Vibe spawn config_name). Registry paths are install-time existence checks and docs only.
- Runners keep the ADR-009/010 contract verbatim: dispatch in order, verify output exists and non-empty, one human checkpoint between steps, resume skips completed outputs, stop-and-report on failure, never guess a substitute agent.
- Nothing in skill-workflows reads skill bodies or catalogs; it names agents and files.
- skill-router's suite must stay green after de-extraction; agent-roster's build must stay green after integration.

## Review Focus

- Registry/workflow cross-validation: a step naming an agent registered for zero harnesses is valid at generation but fails everywhere at dispatch — accept (stop-and-report covers it), but the README says so. Registry paths are provenance docs, not user-side verification (agent-roster agents are hand-copied into projects); a missing path is a status line, never an error.
- The cross-repo Vibe write: skill-router's prune must skip foreign markers (tested in Task 5); skill-workflows owns removing its TOML on update/uninstall; a missing skill-router checkout is skip-with-message.
- Orphaned runners: skill-router's de-extraction prunes the installed run-workflow skills it still owns (marker check) one last time.
- Registry drift: agents.json names duplicate agent-roster's frontmatter with no sync — hand-maintained contract, breakage surfaces at dispatch; the README says so.
- Port fidelity: the validator's rejection classes (unknown agent, empty steps, missing fields, bad names, dup names, escaping/dup outputs) must all survive the port — diff against skill-router's test list during review.
- skill-router de-extraction must remove the runners, the mode generation, and the workflows wiring without breaking install/update/status for users who never had workflows (the absent-manifest path was the default a week ago).
- Users with the old skill-router-installed `run-workflow` skills: skill-workflows' installer overwrites them (same paths, same names) — no stale double-install.
- agent-roster agents have no Vibe TOMLs: its SDLC workflow is pi + Claude Code only; the registry marks vibe absent; the Vibe runner's stop-and-report handles it.

---

### Task 1: Bootstrap skill-workflows — module port

**Files (new repo, `~/repositories/skill-workflows`):**
- Create: `scripts/workflows.mjs` (port: `loadWorkflows`, `manifestState`, plus registry-aware agent validation), `scripts/common.mjs` (port the helpers used: `NAME_RE`, `normalizeText`, `atomicWrite`, `tomlEscape`), `scripts/test.mjs` (port the harness), `workflows.json` (the three example workflows, unchanged), `agents.json` (registry: skill-router's five workflow agents), `README.md` (stub — full docs in Task 5), `AGENTS.md`, `.gitignore`, initial git repo.

**Interfaces:**
- Produces: `loadWorkflows(root)` (same signature/semantics as skill-router's, but agent names validated against `agents.json` instead of `repos.json`), `manifestState(root)`, `loadRegistry(root)` → `{ agents: [{ name, description?, pi?, claude?, vibe? }] }` with NAME_RE + unique-name validation.

- [ ] **Step 1: Write the failing tests** — port skill-router's loader tests (all rejection classes) + registry tests (valid, unknown agent in workflow rejected, dup registry names rejected, bad names rejected).
- [ ] **Step 2: Run to verify RED.**
- [ ] **Step 3: Implement the port** — copy `workflows.mjs`/`common.mjs` from skill-router, change the agent-name source from `repos.json` to `agents.json` (one function), port the test harness.
- [ ] **Step 4: Run to verify GREEN** — full suite.
- [ ] **Step 5: Commit** (initial commit: `feat: workflows module ported with agent registry`).

### Task 2: Runner skills + registry resolution

**Files:**
- Create: `global-skills/run-workflow/SKILL.md`, `global-skills-claude/run-workflow/SKILL.md` (ported from skill-router; the sibling-manifest install story is replaced by: install bakes the registry + workflows into the skill dir as JSON copies beside the SKILL.md, same overwrite contract)
- Create: `scripts/sync.mjs` — `syncGlobalSkills(root, skillsHome, wfState)` / `syncClaudeSkills(root, skillsHome, wfState)` ports (marker/ownership guards, stale prune, manifest + registry copies)
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: Task 1's `manifestState`, `loadRegistry`.
- Produces: installed `run-workflow` skills for pi and Claude Code with sibling `workflows.json` + `agents.json`; same return shapes as skill-router's sync functions (`{ written, refused, ... }`).

- [ ] **Step 1: Failing tests** — port skill-router's sync tests (install, byte-identical copies, absent-manifest skip, malformed skip, stale prune, user-authored never touched/clobbered) + new: registry copy lands beside the manifest.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement** — port both sync functions; the copy step now writes `workflows.json` and `agents.json` into the installed dir; skill bodies ported verbatim except the manifest-read step also reads the sibling `agents.json` to resolve names (dispatch remains by name; the registry copy is for install-time checks and transparency).
- [ ] **Step 4: GREEN.**
- [ ] **Step 5: Commit.**

### Task 3: Vibe mode generation

**Files:**
- Create: `scripts/generate.mjs` — `renderVibeOrchestratorTOML(workflows)` + `writeVibeOrchestrator(root, wfState)` ports (marker guard, stale prune, user-authored never clobbered — all as merged in skill-router PR #26)
- Test: `scripts/test.mjs`

- [ ] **Step 1: Failing tests** — port the render + write/prune/ownership tests from skill-router.
- [ ] **Step 2: RED → Step 3: port the implementation (no changes beyond import paths). → Step 4: GREEN. → Step 5: Commit.**

### Task 4: Installer + real-install verification

**Files:**
- Create: `install.sh` (Node ≥ 18 check + `node scripts/install.mjs`), `scripts/install.mjs` — CLI: `install` (sync skills to `~/.pi/agent/skills` + `~/.claude/skills`, write the Vibe mode into **skill-router's** `agents-vibe/` — ruling below), `update`, `status` (workflows count, registry count, runner presence)
- Modify: `README.md` (full docs: what/why, quickstart, the registry format, the three runners, lockstep duty restated as this repo's ADR-001 content, the zero-harness-agent caveat)
- Create: `docs/decisions/ADR-001-three-runner-lockstep.md` (the contract restated from ADR-009/010, INCLUDING ADR-010's known divergence: pi/Claude read the manifest at runtime, the Vibe mode is baked at generation — a workflow edit between installs drifts; status surfaces it)

**Ruling baked in (council-amended):** the Vibe mode TOML lands in skill-router's `agents-vibe/` directory (the only `agent_paths` entry the user's Vibe config has), written with skill-workflows' own marker. The cross-repo contract, stated in BOTH READMEs: skill-router's prune skips foreign markers (Task 5 adds the test); skill-workflows' `update`/`uninstall` removes its TOML (owned by marker); a missing skill-router checkout is a clear skip-with-message, never a hard error. Accepted cost: skill-router's working tree shows the foreign file while skill-workflows is installed. The Vibe step also skips with a message when skill-router's dir is absent — no dependency inversion failure.

- [ ] **Step 1: Failing tests** for install.mjs's flow (tmp-root fixture pattern).
- [ ] **Step 2: RED → Step 3: implement → Step 4: GREEN.**
- [ ] **Step 5: Real install** — run `./install.sh install`; verify `~/.pi/agent/skills/run-workflow/` (SKILL.md + workflows.json + agents.json), `~/.claude/skills/run-workflow/` same, and skill-router's `agents-vibe/workflow-orchestrator.toml` regenerated with the skill-workflows marker.
- [ ] **Step 6: Commit.**

### Task 5: skill-router de-extraction

**Files (skill-router repo):**
- Remove: `global-skills/run-workflow/`, `global-skills-claude/run-workflow/`, `scripts/workflows.mjs`, the `writeVibeOrchestrator`/`renderVibeOrchestratorTOML` wiring and their tests, the `workflows.json` status wiring (statusOf field, printStatus line), repo-root `workflows.json`
- Modify: `README.md` (Workflows section → pointer: workflows now live in skill-workflows; one paragraph, including: users who never install skill-workflows should delete the old installed run-workflow skills — the de-extraction prunes them once), `docs/decisions/ADR-009` (closing note: trigger fired via ADR-011; module extracted; seam held)
- **Prune-skip-foreign-marker (council amendment):** skill-router's `agents-vibe/` stale-prune must skip a file carrying a foreign marker — add the test here (fixture: a workflow-orchestrator.toml with skill-workflows' marker survives a full install/update).
- **Orphan prune (council amendment):** the de-extraction prunes the installed `run-workflow` skills skill-router still owns (they carry skill-router's marker) — one last `syncGlobalSkills`-family pass that removes them; test with a fixture home.
- Keep: everything else; the suite must stay green with the workflows tests removed.

- [x] **Step 1: Remove the module + tests; run the suite** — GREEN.
- [x] **Step 2: README + ADR-009 closing note.**
- [x] **Step 3: Real update** — run skill-router's `./install.sh update`; verify the old runner skills are **not** re-shipped and (with skill-workflows installed) the Vibe mode still exists with skill-workflows' marker.
- [ ] **Step 4: Commit.**

### Task 6: agent-roster integration

**Files (skill-workflows repo):**
- Modify: `agents.json` — add the six agent-roster stage agents (`triage-issues`, `requirements`, `sprint-planning`, `test-authorship`, `code-generation`, `investigate`) with `pi` and `claude` paths into agent-roster's `.pi/agents/` and `.claude/agents/` (tilde-anchored), no `vibe`
- Modify: `workflows.json` — add `feature-line`, the SDLC workflow: **requirements → sprint-planning** (council amendment: agent-roster's own contract says requirements consumes a brainstorm outcome, NOT triage's bd-queue output — triage is standalone or omitted; do not chain it). Outputs under `knowledge/` per agent-roster's stage contract (task text carries the file-shape discipline; the spec stays minimal). The per-ticket test-authorship/code-generation loop is deliberately out of scope for a linear spec — say so in the README so nobody later "fixes" it by bloating the spec.

- [ ] **Step 1: Failing tests** — the new workflow validates; its agents exist in the registry; the generated Vibe mode and skill copies include it (run the suite).
- [ ] **Step 2: RED → Step 3: add entries → Step 4: GREEN.**
- [ ] **Step 5: Real install + smoke** — reinstall; confirm the pi skill dir's workflows.json lists `feature-line`; dispatch one step live in a scratch project (requirements on a dummy brainstorm outcome, with the agent-roster agents copied into that project per its install model) to prove cross-repo dispatch works — the under-specified part the council named: verify the agents are actually present in the dispatch project, since that is the real failure mode.
- [ ] **Step 6: Commit.**
