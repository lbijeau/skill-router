# Claude Target Follow-ups A (behaviour fixes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the small behaviour gaps and weak tests left from PR #4, with no change to what the Claude target generates.

**Architecture:** All changes are in `scripts/generate.mjs` and `scripts/test.mjs`, plus the README follow-ups list. One new exported seam, `runCli`, makes the CLI testable.

**Spec:** `docs/superpowers/specs/2026-11-09-claude-code-target-design.md` (see "Decisions after the PR #4 review").

## Global Constraints
- Every fix starts with a failing test, watched red. Generated output bytes for pi, Vibe and `agents-claude/` stay identical (the one exception: a C1 control character is now stripped from skill descriptions in all targets and the catalog).
- Tests never write under the real home. `claudeHome` null/undefined still means "skip the Claude install".
- Dropped by decision (ledger and README note, no code): `.bak` is still overwritten by each merge and created at the default mode before the chmod; `--no-claude` stays non-sticky.

## Tasks

### Task 1: report line and reminders
- `runFlow`: the per-repo line ends `agent written (pi, vibe, claude)` when a Claude agent was written (track `claudeResult.written`). Update the two tests that match `(pi, vibe)`.
- `runClaudeInstall`: decide the restart and `/reload-skills` reminders from whether the agents/skills directory existed before the step and exists after it, so a step that throws after `mkdir` still prints the reminder; `syncClaudeSkills` returns `dirCreated` true only if it created the directory.
- Tests: agents step throws (a read-only subdirectory trick is not portable: use a regular file named `settings.json` directory case instead is already covered) — assert (a) summary line contains `claude`, (b) `syncClaudeSkills` with no sources or only refused files returns `dirCreated: false` and creates no directory, (c) reminder printed when the skills dir was created even if a later step reports an error.

### Task 2: status warnings and orphan parity
- `statusOf`: a missing `settings.json` adds the warning `claude: <path> missing, allow rules not installed`.
- `claudeAgentsInstallState`: when no source is valid, owned orphans are not stale (the installer skips its prune then).
- Tests for both.

### Task 3: allow rules
- `claudeReadRules`: also refuse a backslash (`\`) in the checkout path.
- `normRule(rule, home = os.homedir())` expands `~/` with the given home and canonicalises the path part with `realPath` (keep the trailing `/**`); `hasClaudeReadRules(settingsPath, rules, home?)` and `mergeClaudePermissions(settingsPath, rules, { home, onBeforeCommit } = {})` pass `home` through.
- Tests: a rule written through a symlinked path counts as present (no duplicate added); an injected home is honoured; backslash path is refused.

### Task 4: NEL in descriptions
- `normalizeDescription`: also replace C1 controls `\u0080-\u009F` with a space. Test through `parseSkillFrontmatter` and a rendered Claude agent row.

### Task 5: testable CLI
- `export function runCli(argv, env, opts = {}): { exitCode, lines }` with `opts = { root, home, settingsPath, vibeConfigPath, skillsHome }`; the file-bottom block calls it with real defaults and prints. Behaviour unchanged.
- Tests (tmp root, tmp config paths): `status --no-claude` skips the Claude install; `status` with a bad `CLAUDE_CONFIG_DIR` exits 1 and shows `claude install: error`; `install --no-claude` prints `claude: skipped (--no-claude)` and writes nothing under a tmp claude home; `install` with a bad `CLAUDE_CONFIG_DIR` exits 1 with the skip line.

### Task 6: weak tests
- Rewrite "syncClaudeSkills: nothing is written under a pi skills home" as an install test with a real pi `skillsHome`: it stays empty while the Claude skills dir gets `route-skill`.
- The symlinked-destination installer test also covers an unmarked target.
- The mid-merge test also covers a same-size change (rewrite the file with equal-length content and a different mtime); confirm by mutation that removing the mtime check fails it.
- The HOME test pre-creates `<HOME>/.claude/agents` and asserts it stays empty.

### Task 7: README
- Remove the fixed items from Follow-ups; add the two dropped-by-decision items under "Deferred by design". Run the suite, push, open the PR.

## Review Focus
- A reminder is printed exactly when a directory was created, never spuriously.
- The canonicalised comparison never treats two different directories as equal (only a symlinked spelling of the same path).
