# Claude Target Follow-ups C (module split) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline).

**Goal:** Split `scripts/generate.mjs` (about 1,500 lines) so the Claude target lives in its own module, with **no behaviour change**.

**Architecture:** Imports point one way, `common` <- `discover` <- `claude` <- `generate`, so there is no cycle.
- `scripts/common.mjs`: `REPO_ROOT`, `NAME_RE`, `STATE`, `yamlQuote`, `normalizeText`, `tildePath`, `skillRows`, `atomicWrite`, `realPath`, `isSymlink`, `ROUTER_AGENT_NAME`, `ROUTER_DESCRIPTION`, `routerBodyLines`.
- `scripts/discover.mjs`: skill discovery (`globToRegExp`, `walkSkillDirs`, `normalizeDescription`, `parseSkillFrontmatter`, `discoverSkills`).
- `scripts/claude.mjs`: every `claude*` / Claude install function, `resolveClaudeHome`, `runClaudeInstall`, plus a new `pruneClaudeAgents(root, names)` that `prune` calls.
- `scripts/generate.mjs`: manifest, pi and Vibe targets, catalog, prune, pi/Vibe config merges, status, runFlow, CLI. It re-exports the three modules (`export * from ...`), so `scripts/test.mjs` and `install.sh` change nothing.

## Global Constraints
- Zero behaviour change; the existing suite is the safety net and `scripts/test.mjs` is not edited. Generated outputs byte-identical; `./install.sh status` exit 0 and `claude install: in-sync`.
- Code is moved, not rewritten. The only new code is `pruneClaudeAgents` (the claude part of `prune`, unchanged in effect) and the `export` keywords that let moved helpers be imported.
- A scan checks that no module uses a name defined in a module it must not depend on.

## Steps
1. Move the code (scripted, one commit), then run the suite, the import scan and `status`.
2. README: the structure follow-up is done; document the module layout in "How it works".
