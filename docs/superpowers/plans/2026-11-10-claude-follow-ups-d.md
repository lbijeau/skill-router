# Claude Target Follow-ups D (review leftovers) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline).

**Goal:** Close the small leftovers recorded in the README follow-ups after PRs A and C. Every behaviour change starts with a failing test.

**Spec:** `docs/superpowers/specs/2026-11-09-claude-code-target-design.md`.

## Tasks
1. **Reminders.** `runClaudeInstall(root, claudeHome, report, impl = {})`, where `impl` can override `installClaudeAgents`, `mergeClaudePermissions` and `syncClaudeSkills` (a fault-injection seam for tests). The restart and `/reload-skills` reminders print only when the directory did not exist before and now holds at least one entry, so an empty directory left by a failed write no longer triggers a reminder, and a step that fails after writing something still does.
2. **`normalizeReadRule`.** A glob in the first path segment (`Read(//**)`) is not resolved against the cwd; `hasClaudeReadRules(..., null)` falls back to the real home instead of throwing.
3. **`runCli` guard.** An `install`/`update` with a custom `root` must also pass `settingsPath`, `vibeConfigPath` and `skillsHome`; otherwise exit 1 with a message and no writes (it would fall back to the real pi and Vibe config).
4. **`flowPaths` guard.** `runInstall`/`runUpdate` throw a `TypeError` naming the new signature when the second argument is not an object (a stale positional call, or `null`).
5. **Export list.** A test asserts every name exported by `common`, `discover` and `claude` is also exported by `generate` (ESM silently drops ambiguous `export *` names).
6. **Tidy.** `isSymlink` moves from `common.mjs` to `claude.mjs` (its only user); `pruneClaudeAgents` moves next to `ownedOrphans`; `prune` uses `const claudeAgents = pruneClaudeAgents(root, names)`; the pi-skills-home test pre-creates the directory and asserts it stays empty.
7. **README.** Remove the fixed follow-ups; record that threading an injected home through `statusOf`/`runClaudeInstall` is deliberately not done (no consumer needs it).

## Global Constraints
- No change to generated output; `./install.sh status` stays exit 0 and `claude install: in-sync`.
- Tests never write under the real home.
