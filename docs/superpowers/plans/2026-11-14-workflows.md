# Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-agent workflows — sequenced runs of generated agents with file-shaped handoffs and human checkpoints — as an internal module inside skill-router, per ADR-009.

**Architecture:** A `workflows.json` manifest beside `repos.json` defines workflows as an ordered list of steps, each naming a generated agent (by repo name) and an output file. A validator in `scripts/workflows.mjs` enforces the manifest against `repos.json`. `run-workflow` runner skills for pi (`global-skills/`) and Claude Code (`global-skills-claude/`) instruct the main session to dispatch each step's agent, verify the output file, and pause for a human between stages; Vibe gets a docs-first manual procedure (skills are disabled for Vibe agents). The engine is deliberately narrow: spec in, orchestrated run out, so the eventual repo extraction (ADR-009 split trigger) is mechanical.

**Tech Stack:** Node.js ≥ 18 ESM, no new dependencies. Existing patterns: `scripts/common.mjs`, `scripts/test.mjs` (self-registering `test()` functions run by `node scripts/test.mjs`).

**Spec:** `docs/decisions/ADR-009-workflows-internal-seam.md`

## Global Constraints

- No new npm dependencies; Node ≥ 18 built-ins only.
- Agent references in workflows are repo names from `repos.json`, and must match `NAME_RE` (`/^[a-z0-9]+(-[a-z0-9]+)*$/`).
- The workflow interface exposes only: workflow name, description, ordered steps of (agent, task, output). Sequencing/checkpoint/handoff mechanics never appear in the manifest.
- `workflows.json` is optional: its absence must not break install, update, or status.
- The `run-workflow` skill must not read skill bodies or the catalog bulk; it names agents and output files only.
- Follow ADR-004: never write user config destructively (no changes needed here — `syncGlobalSkills` overwrite-in-place is the established pattern).

## Review Focus

- `workflows.json` referencing an agent name not in `repos.json` (typo'd or after a repo removal): validator must fail with the workflow name and the bad agent name, not a confusing downstream error.
- Empty `steps` array, or a step missing `agent`/`output`: validator must reject, not pass through as a no-op workflow.
- Duplicate workflow names: second entry must be rejected, not silently overwrite the first.
- `output` paths escaping the project (`../`, absolute, or Windows separators — `..\\outside.md` evades a POSIX segment check): validator must reject any `\` in `output`, plus `..` segments and absolute paths; the skill writes only inside the caller's project.
- Duplicate `output` paths within one workflow (step 2 silently overwrites step 1's handoff file): validator must reject.
- Missing `workflows.json` on `install`/`update`: everything else must work unchanged.
- Malformed `workflows.json`: `install`/`update` print a warning and continue; `status` surfaces the validation error. Never a silent success.
- A step agent that fails mid-run: the skill must stop, report which step failed, and not delete earlier output files. Resume: the user says which step to continue from; steps whose output file already exists and is non-empty are skipped.

---

### Task 1: Workflow manifest loader and validator

**Files:**
- Create: `scripts/workflows.mjs`
- Modify: `scripts/test.mjs` (append tests at the end, following its `test()`/`tmp()`/`w()` pattern)

**Interfaces:**
- Consumes: `NAME_RE` from `scripts/common.mjs`. Deliberately does **not** import from `generate.mjs` (Task 2 makes `generate.mjs` import `loadWorkflows`; importing back would create an ESM cycle and TDZ footgun). Instead, `loadWorkflows` reads `repos.json` itself and uses only the entry `name` fields — it does not re-run `loadManifest`'s full validation.
- Produces: `export function loadWorkflows(root)` → `{ workflows: [{ name, description, steps: [{ agent, task, output }] }] }`; throws `Error` with a message naming the workflow and the offending field on any validation failure. Missing `workflows.json` returns `{ workflows: [] }`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test.mjs`, following its existing `test()`, `tmp()`, `w()`, `clean()` helpers:

```js
import * as wf from "./workflows.mjs";

test("loadWorkflows returns [] when workflows.json is absent", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: "https://x/a", description: "d", persona: "p" } ] }));
  const { workflows } = wf.loadWorkflows(root);
  eq(workflows.length, 0);
  clean(root);
});

test("loadWorkflows returns a valid workflow with steps", () => {
  const root = tmp();
  w(root, "repos.json", JSON.stringify({ repos: [
    { name: "a", url: "https://x/a", description: "d", persona: "p" },
    { name: "b", url: "https://x/b", description: "d", persona: "p" } ] }));
  w(root, "workflows.json", JSON.stringify({ workflows: [
    { name: "review", description: "Two-pass review",
      steps: [
        { agent: "a", task: "Review the code", output: "docs/review-a.md" },
        { agent: "b", task: "Audit the review", output: "docs/review-b.md" } ] } ] }));
  const { workflows } = wf.loadWorkflows(root);
  eq(workflows.length, 1);
  eq(workflows[0].name, "review");
  eq(workflows[0].steps[1].agent, "b");
  clean(root);
});

test("loadWorkflows rejects unknown agent names", () => {
  // same repos.json with agent "a"; step references agent "zzz"
  // expect throw with /review/ and /zzz/ in the message
});

test("loadWorkflows rejects empty steps, missing fields, bad names", () => {
  // three cases: steps: [], step missing output, workflow name "Bad_Name"
  // each expect throw naming the workflow
});

test("loadWorkflows rejects duplicate workflow names", () => {
  // two entries both named "review" — expect throw with /review/ and /duplicate/ in the message
});

test("loadWorkflows rejects escaping output paths", () => {
  // output: "../outside.md", output: "/abs.md", and output: "..\\outside.md" each expect throw
});

test("loadWorkflows rejects duplicate output paths within a workflow", () => {
  // two steps both writing "docs/out.md" — expect throw naming the workflow and the path
});
```

(Write the skipped bodies out fully in the real file; every assertion is `assert.throws(() => wf.loadWorkflows(root), /review/)` style, with the exact messages the implementation produces.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs`
Expected: FAIL — module `./workflows.mjs` not found.

- [ ] **Step 3: Implement `scripts/workflows.mjs`**

```js
export function loadWorkflows(root) { /* ... */ }
```

Approach: read `path.join(root, "workflows.json")`; if absent return `{ workflows: [] }`. JSON.parse, then validate in one pass: top-level `workflows` array; each entry has `name` matching `NAME_RE`, non-empty `description` (normalize with `normalizeText`), unique name, `steps` a non-empty array; each step has `agent` present in the `repos.json` entry names (read `repos.json` directly — see Interfaces), non-empty `task`, and `output` that is relative, does not start with `/`, contains no `\` anywhere, contains no `..` segment, and does not traverse outside the project (`path.normalize(output)` stays relative). `output` values must also be unique within a workflow. Error messages follow the pattern: `workflow "review": step 2 references unknown agent "zzz"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test.mjs`
Expected: PASS, all tests including existing suite.

- [ ] **Step 5: Commit**

```bash
git add scripts/workflows.mjs scripts/test.mjs
git commit -m "feat: add workflows.json loader and validator"
```

---

### Task 2: First workflow in `workflows.json` + status wiring

**Files:**
- Create: `workflows.json` (repo root)
- Modify: `scripts/generate.mjs` (the `status` command's report)
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `loadWorkflows` from Task 1.
- Produces: a committed `workflows.json` with one workflow; `status` output includes a workflows count line.

- [ ] **Step 1: Write the failing tests**

Follow the existing `statusOf` tests (the closest is at `scripts/test.mjs` around line 515): they call `gen.statusOf(root, manifest)` directly against a tmp root and assert on the returned object's fields. Do not capture stdout and do not hard-code `REPO_ROOT`.

```js
test("statusOf includes a workflows count", () => {
  // tmp root with repos.json (one repo) and workflows.json (one workflow)
  // const s = gen.statusOf(root, manifest);
  // eq(s.workflows, 1);
});

test("statusOf is unchanged when workflows.json is absent", () => {
  // tmp root with repos.json only; statusOf must not throw and the
  // workflows field is 0 (or absent — match whatever shape Step 3 chooses)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test.mjs`
Expected: FAIL — no workflows line in status output.

- [ ] **Step 3: Implement**

Add to `workflows.json` a first real workflow using existing repos from `repos.json` — a two-step design review:

```json
{
  "workflows": [
    {
      "name": "design-review",
      "description": "Brainstorm a design with superpowers, then stress-test it",
      "steps": [
        { "agent": "superpowers", "task": "Brainstorm the requested feature and write the design doc", "output": "docs/design.md" },
        { "agent": "ponytail", "task": "Critique docs/design.md bluntly; write your verdict and required changes", "output": "docs/design-review.md" }
      ]
    }
  ]
}
```

(Verify both agent names exist in `repos.json` before committing; substitute equivalent repos if the pinned set has changed.)

In `generate.mjs`: add a `workflows` count field to `statusOf`'s return (root-parameterized — `loadWorkflows(root).workflows.length`, never `REPO_ROOT`), and render it as a `workflows: N` line in `printStatus`. If `loadWorkflows(root)` throws (malformed manifest), `statusOf` must surface the error state, not crash silently — and `install`/`update` treat a malformed `workflows.json` as a printed warning, never a hard failure.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workflows.json scripts/generate.mjs scripts/test.mjs
git commit -m "feat: add design-review workflow and status wiring"
```

---

### Task 3: The `run-workflow` runner — pi and Claude Code skills

**Files:**
- Create: `global-skills/run-workflow/SKILL.md` (pi)
- Create: `global-skills-claude/run-workflow/SKILL.md` (Claude Code)
- Modify: `scripts/generate.mjs` (extend `syncGlobalSkills` to copy the repo-root `workflows.json` into the installed run-workflow dir)
- Modify: `scripts/claude.mjs` (same for `syncClaudeSkills`)
- Test: `scripts/test.mjs`

**Interfaces:**
- Consumes: `syncGlobalSkills` from `scripts/generate.mjs` (syncs `global-skills/` into the pi skills home) and `syncClaudeSkills` from `scripts/claude.mjs` (syncs `global-skills-claude/` into `~/.claude/skills/`). Workflow shape from Task 1.
- Produces: an installed `run-workflow` skill for pi and Claude Code, each with a sibling `workflows.json` manifest copied in at install time. Both bodies are behaviourally identical; only the dispatch tool name and install location differ.

**Manifest discoverability (decided):** the installed skill reads the `workflows.json` that sits **next to its own SKILL.md** — not one in the user's project, and not the skill-router repo root. Extend `syncGlobalSkills` and `syncClaudeSkills` (or add a small step beside them) so install copies the repo-root `workflows.json` into the installed skill dir (`~/.pi/agent/skills/run-workflow/workflows.json`, `~/.claude/skills/run-workflow/workflows.json`). Update overwrites it, matching the generated-boilerplate contract.

- [ ] **Step 1: Write the failing test**

```js
test("syncGlobalSkills installs run-workflow alongside route-skill", () => {
  const root = tmp();
  // copy global-skills fixture layout (route-skill + run-workflow) into tmp root,
  // mirroring the existing syncGlobalSkills tests
  const home = path.join(root, "skills-home");
  const { written } = gen.syncGlobalSkills(root, home);
  eq(written.filter(f => f.includes("run-workflow")).length, 1);
  clean(root);
});

test("pi run-workflow SKILL.md names the manifest, dispatch loop, and checkpoint rule", () => {
  const body = fs.readFileSync(path.join(REPO_ROOT, "global-skills/run-workflow/SKILL.md"), "utf8");
  assert(/workflows\.json/.test(body));
  assert(/subagent/.test(body));
  assert(/checkpoint/i.test(body));
});

test("claude run-workflow SKILL.md names the manifest, Task tool, and checkpoint rule", () => {
  const body = fs.readFileSync(path.join(REPO_ROOT, "global-skills-claude/run-workflow/SKILL.md"), "utf8");
  assert(/workflows\.json/.test(body));
  assert(/Task/.test(body));
  assert(/checkpoint/i.test(body));
});

test("syncClaudeSkills installs run-workflow alongside route-skill", () => {
  // tmp root with global-skills-claude fixture layout (route-skill + run-workflow) plus
  // a workflows.json at root; mirror the existing syncClaudeSkills tests (claude.mjs:449)
  // expect written to include a run-workflow path, and the workflows.json copy to land
  // in the installed run-workflow dir
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node scripts/test.mjs`
Expected: FAIL — the fixture layout cannot contain the not-yet-created `run-workflow` directories and SKILL.md files, so the new tests fail on missing files.

- [ ] **Step 3: Write both SKILL.md files**

Frontmatter mirrors route-skill's in each directory's house style (`name: run-workflow`, one-line `description`). The bodies share one logic, written once and adapted per harness — pi says "the `subagent` tool", Claude Code says "the Task tool":

**Vibe runner:** deferred, docs-first (see Task 3b). Vibe agents get `disabled_tools = ["skill"]`, so a skill cannot be the runner there; a generated orchestrator agent is a later follow-up once Vibe's spawn model is understood.

1. The user names a workflow (or asks to list them). Read the `workflows.json` sitting next to this SKILL.md; if absent, say so and stop.
2. List workflows (name + description) if asked; otherwise confirm the target workflow.
3. For each step in order: dispatch the step's agent with the step's `task` text, telling it to write the step's `output` file (pi: `subagent` tool; Claude Code: Task tool). If the named agent is not installed, report that and stop — do not guess a substitute.
4. After each step: verify the output file exists and is non-empty; if not, report the failed step and stop — earlier outputs stay untouched.
5. **Checkpoint:** after every step, report the output file to the user and wait for their go-ahead before the next step. Never run two steps without a human between them.
6. When all steps are done, list the outputs and stop.
7. **Resume:** if the user asks to continue or rerun a workflow, skip any step whose output file already exists and is non-empty; start from the first step that fails that check.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node scripts/test.mjs`
Expected: PASS.

- [ ] **Step 5: Run a real install and verify**

Run: `./install.sh install` (or the repo's established non-destructive equivalent), then check `~/.pi/agent/skills/run-workflow/SKILL.md`, `~/.pi/agent/skills/run-workflow/workflows.json`, `~/.claude/skills/run-workflow/SKILL.md`, and `~/.claude/skills/run-workflow/workflows.json` all exist.
Expected: all four present; SKILL.md copies match the repo, workflows.json copies match the repo-root manifest.

- [ ] **Step 6: Commit**

```bash
git add global-skills/run-workflow/SKILL.md global-skills-claude/run-workflow/SKILL.md scripts/generate.mjs scripts/claude.mjs scripts/test.mjs
git commit -m "feat: add run-workflow skill for pi and Claude Code with manifest sync and human checkpoints"
```

---

### Task 3b: Vibe workflows documentation (docs-first)

**Files:**
- Modify: `README.md` (Vibe paragraph inside the Workflows section)

**Interfaces:**
- Consumes: Task 2's `workflows.json`.
- Produces: a documented manual procedure for Vibe users.

- [ ] **Step 1: Add the Vibe paragraph to the README Workflows section**

Two or three sentences: on Vibe, run a workflow by reading `workflows.json` yourself and spawning each step's agent in order — verify the output file after each step and pause for a human between steps, the same contract the pi and Claude skills enforce. A generated Vibe orchestrator agent may follow later.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: manual workflow procedure for Vibe"
```

---

### Task 4: README documentation

**Files:**
- Modify: `README.md` (new "Workflows" section after "How it works")
- Test: none (docs)

- [ ] **Step 1: Add the section**

Cover, in the README's existing voice: what a workflow is (name + ordered steps, each an agent and an output file), the `workflows.json` format with the `design-review` example, how to run one (`run-workflow` skill on pi and Claude Code, one human checkpoint per step; manual procedure on Vibe per Task 3b), that `workflows.json` is optional, and one line pointing at ADR-009 for why workflows live here and the split trigger.

- [ ] **Step 2: Verify the documented example matches reality**

Run: `node -e 'import("./scripts/workflows.mjs").then(m => console.log(m.loadWorkflows(".").workflows.map(w=>w.name)))'`
Expected: `[ 'design-review' ]` — the README example validates.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document workflows"
```
