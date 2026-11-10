# Claude Target Follow-ups B (refactor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** Remove the duplication and positional-argument strain PR #4 left in `scripts/generate.mjs`, with **no behaviour change**.

**Spec:** `docs/superpowers/specs/2026-11-09-claude-code-target-design.md` (nothing in it changes). Follow-up list: README "Follow-ups > Structure" and "Naming".

## Global Constraints
- Zero behaviour change: every generated file (`agents/`, `agents-vibe/`, `agents-claude/`, `catalog/`), every status value and every report line stays byte-identical. The existing suite is the safety net; tests change only where a refactor renames or reshapes a call (signature changes listed below).
- Run the whole suite after every step; commit per step. `./install.sh status` must stay exit 0 with `claude install: in-sync` on the real checkout.

## Steps
1. **Status helpers.** `STATE` constants; `fileState(file, expectedThunk)`; `repoOutputState(file, skillCount, absentLabel, render)`; `isSettled(state)`. Use them for the agent, vibe and claude rows, catalog, router and claude router in `statusOf`.
2. **`claudeInstallStatus(root, claudeHome): { state, warnings }`** extracted from `statusOf` (including its try/catch).
3. **One settings read and one skills status.** `claudeRulesState(settingsPath, rules, home): "ok" | "missing-file" | "unparseable" | "missing-rules"` (`hasClaudeReadRules` becomes `=== "ok"`); `claudeSkillsStatus(root, skillsHome): { stale, refused }` replaces `claudeSkillsState` and `claudeSkillsRefused` (tests updated).
4. **`ownedOrphans(dir, knownStems): string[]`** replaces the three orphan loops (`prune`, `installClaudeAgents`, `claudeAgentsInstallState`).
5. **`claudeFrontmatter(name, descriptionLine): string[]`** shared by the agent and router renderers.
6. **Options object.** `runInstall(root, paths = {})`, `runUpdate(root, paths = {})`, internal `runFlow(root, mode, paths)`, where `paths = { settingsPath, vibeConfigPath, skillsHome, claudeHome }`; `runCli` and all test call sites updated (mechanically).
7. **Naming.** `normRule` to `normalizeReadRule`; `normalizeTomlText` to `normalizeText` (it serves TOML and markdown); `step` to `attempt`; the `skip` helper in `mergeClaudePermissions` to `fail`.

## Review Focus
- Any difference in `status` output or exit code between master and the branch for the same fixtures.
- `claudeInstallStatus` warnings keep their exact text and order.
