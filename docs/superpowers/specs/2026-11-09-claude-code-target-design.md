# Skill Router — Claude Code Output Target Design

Date: 2026-11-09
Status: proposed
Companions: [2026-07-09-skill-router-design.md](2026-07-09-skill-router-design.md) (pi),
[2026-10-04-skill-router-vibe-design.md](2026-10-04-skill-router-vibe-design.md) (Vibe)

## Intent

The owner runs Claude Code on a **Claude subscription** and wants the same
clean-room skill agents that skill-router already generates for pi and Vibe,
launchable from inside a normal Claude Code session. One agent per
third-party skills repo, each seeing exactly that repo's skills and nothing
else, so it behaves as that repo's author intended.

Why this is simple on the terms-of-use side: a Claude Code custom subagent
runs inside the official client, in the owner's own session, under their own
login. Nothing in skill-router ever touches credentials, OAuth tokens or API
keys. That is the whole compliance story and it must stay that way (see
anti-goals).

## Goals

- A third derived output target, `agents-claude/<name>.md` (committed, like
  `agents/` and `agents-vibe/`), generated from the same `repos.json`
  manifest and the same skill discovery as the other targets.
- `./install.sh install|update|status` also installs, refreshes and reports
  the Claude Code target. Idempotent, like the others.
- The Claude Code model can spawn any room from any project, routed by each
  agent's `description`.
- The `skill-router` agent and the `route-skill` capability (skill-name
  routing over the generated catalog) also work from Claude Code.
- The README states honestly what the room does and does not isolate.

## Non-goals

- Standalone or headless runs (`claude -p`, SDK). The owner explicitly wants
  in-session only.
- Packaging as a Claude Code plugin. (My call: plugin agents have the lowest
  priority and ignore `hooks`/`mcpServers`/`permissionMode`; plain files in
  `~/.claude/agents/` are simpler and sufficient.)
- Changing the pi or Vibe outputs, the manifest schema, discovery or
  curation. The Claude target is purely additive.
- Making routed skills visible to Claude Code's global skill catalog (that
  is the opposite of the guarantee).

## Anti-goals (a failure even if it technically works)

- Anything that extracts, stores, forwards or reuses subscription
  credentials, or that calls Anthropic from a process other than the user's
  own Claude Code session.
- Silently overwriting or deleting an agent file the user wrote themselves in
  `~/.claude/agents/`.
- Claiming isolation the spike did not demonstrate.

## What the spike established (2026-11-09, throwaway, since deleted)

A hand-written agent with `tools: Read, Grep, Glob` and `omitClaudeMd: true`,
asked to report its own starting context, reported (self-report, one run):

- Tools: only the three listed plus the harness hand-back tool. No `Skill`,
  no MCP tools.
- No other skills visible. No CLAUDE.md or memory text. The superpowers
  session hook did not fire. No hook output before its first action.
- Reading `skills/humanizer/SKILL.md` needed no permission prompt, **but the
  clone was inside the session's working directory**, so this says nothing
  about use from other projects.

Residuals that leaked and are accepted (to be documented, not fixed):

- A git-status snapshot of the launching project (harness-injected).
- After its first read, the clone's own `AGENTS.md` (the upstream repo's
  author guide) was added to context.
- Instruction text for connected MCP servers (e.g. Claude Docs) was present
  even though the agent has none of their tools.

Docs-based facts the design rests on: subagents inherit the `Skill` tool and
MCP tools unless a `tools:` allowlist excludes them; `omitClaudeMd: true`
skips CLAUDE.md except managed-policy files; settings/plugin hooks cannot be
suppressed per subagent; `~/.claude/agents/` is watched live, but the first
file in a brand-new agents directory needs a restart; there is no settings
key pointing at another agents directory; reads outside the working
directory prompt unless allowed via `permissions.allow` `Read(...)` rules.

## Decided

- **Isolation recipe per agent file** (as spiked): frontmatter `name`,
  `description` (routing signal, from the manifest), `tools: Read, Grep,
  Glob`, `omitClaudeMd: true`. Body: the manifest `persona`, then boilerplate
  mirroring the Vibe one ("you have no skill tool; skills are files; read
  SKILL.md with Read and follow it; follow cross-skill references the same
  way; say so if a read is truncated"), then the skill table (name,
  description, `~`-anchored `SKILL.md` path, falling back to absolute paths
  outside the home dir, exactly as the Vibe target does).
- **In-session only**, official client only, subscription auth untouched.
- **Residual leakage is accepted and documented**, not engineered around.
  The owner was unsure about hooks/plugins leaking; the spike showed none
  fired and only the three minor items above leaked.

## My calls (builder may refine; owner to check while reading)

- **Install mechanism:** the installer *copies* the generated files into
  `~/.claude/agents/` (not symlinks: live-watch behaviour on symlinks is
  undocumented). Each installed file carries a marker line in the body so
  the installer can recognise files it owns. It updates and prunes only
  marked files, and refuses (with a printed warning) to overwrite an
  unmarked file of the same name.
- **Permissions wiring:** add a `Read(...)` allow rule for the clones
  directory to `~/.claude/settings.json` `permissions.allow`, using the same
  safe-bail pattern as the existing settings edits: `.bak` backup, never
  touch an unparseable file, idempotent, print the exact manual remedy when
  skipped.
- **Name collisions:** agent names are global in Claude Code. Use the
  manifest names unchanged; the marker rule above covers collisions with the
  user's own agents.
- **Restart note:** if `~/.claude/agents/` did not exist before install, the
  installer's closing reminder says Claude Code needs one restart; after
  that, updates are picked up live.
- **`route-skill` on Claude Code:** the existing global skill is pi-flavoured.
  Provide a Claude-flavoured equivalent synced to `~/.claude/skills/`,
  spawning the `skill-router` agent. Mechanism (separate source dir vs. one
  templated source) is the builder's choice.
- **Status:** `./install.sh status` gains a Claude column (agent file
  present, in sync, installed copy present and current, allow rule present).
- **Tests:** extend the offline fixture suite (`node scripts/test.mjs`);
  no network, no real `~/.claude` writes (injectable paths, like the existing
  `settingsPath`/`skillsHome` parameters).

## More calls, from the builder check (mine; owner to check)

- **Marker:** a single trailing line in the file body (an HTML comment such
  as `<!-- generated by skill-router -->`), so frontmatter stays exactly the
  recipe above. A marked installed file whose repo is no longer in the
  manifest is pruned. A marked file is always overwritten on update (it is
  generated boilerplate; hand edits do not survive, like `route-skill`). An
  unmarked file is never touched.
- **Clones directory:** fixed, `skills/` inside this repo, as for the other
  targets. The allow rule therefore embeds this checkout's `~`-anchored path
  in `~/.claude/settings.json`, same as the pi and Vibe wiring does in their
  configs. If the rule does not suppress prompts from another project, the
  installer prints a warning with the manual remedy instead of failing.
  Add `Grep`/`Glob` rules only if verification shows they also prompt.
  Uninstall stays a documented manual remedy in the README (as today), now
  including removing `~/.claude/agents/` marked files and the allow rule.
- **`skill-router` agent on Claude Code:** the existing router only reads the
  catalog, opens the winning `SKILL.md` and recommends; it never spawns
  anything. So it gets the same `tools: Read, Grep, Glob` and
  `omitClaudeMd: true`, with the existing router body. The Claude-flavoured
  `route-skill` runs in the main session, calls the `skill-router` agent,
  then the main session reads the recommended `SKILL.md` and follows it.
- **`omitClaudeMd`:** it is in the current sub-agents docs. Acceptance check
  3 (the probe) stays as a required manual gate after install, since a
  silently ignored key would regress isolation.
- **Machine-specific paths:** handled exactly as the Vibe target (home-anchored
  when under `~`, absolute otherwise), and `status` compares generated output
  with the committed file using the same function.
- **Opt-out and exit codes:** the Claude target is installed only when
  `~/.claude` already exists (Claude Code is present). Otherwise it is
  skipped with one note and `status` shows "n/a", which is not a failure,
  so pi-only and Vibe-only users are unaffected. Once installed, drift is
  a non-zero exit like the other targets.

## Revisions after SME review (2026-11-09)

Four independent reviews (Claude Code platform, Node/test engineering,
security, terms/product fit) changed these decisions; they override anything
above that conflicts:

- **Allow rules:** two rules, `skills/**` and `catalog/**` (the router reads
  the catalog), built from realpaths; a checkout path containing glob
  characters is refused. Path-specific `Grep(...)`/`Glob(...)` rules never
  match per the docs, so there is no Grep/Glob rule fallback; if those tools
  prompt, use agent-body guidance or `additionalDirectories` instead.
- **Ownership:** a file is owned only if it is a regular file, its last
  non-empty line is the marker and its `name` equals its stem. Symlinked or
  unowned destinations are refused. Installer sources are validated
  (`tools: Read, Grep, Glob` exactly once, name, marker) because a file
  missing `tools:` would inherit every tool. Writes are atomic. Prune is
  skipped when the source has no owned files.
- **`route-skill` (Claude):** never overwrites an unowned user file.
- **Opt-out and config dir:** `--no-claude` flag; `CLAUDE_CONFIG_DIR` must be
  an absolute existing directory. `null`/`undefined` Claude dir means skip.
- **Discovery:** a symlinked `SKILL.md` is skipped with a warning (applies to
  all targets and the catalog). A full post-clone symlink sweep is deferred
  unless the live symlink probe shows reads are not prompted.
- **Install order:** the Claude install runs after `prune()`.
- **Status:** read-only helpers decide `claudeInstall`; refusals are
  warnings; unparseable `settings.json` is a warning, not stale.
- **Reload and version:** a newly created `~/.claude/skills/` needs
  `/reload-skills` or a restart; `omitClaudeMd` needs Claude Code 2.1.271+.
- **README:** claims worded as reviewed (verified-on-date, not guaranteed),
  lists exactly what the installer writes, states in-session-only, quota use,
  that isolation protects the subagent's context and not the parent from its
  output, project-level shadowing, and "not legal advice"; written only after
  the live probe passes.
- **Deferred or documented only:** uninstall helper, checkout path in the
  marker, two checkouts pruning each other's agents (documented).

## Left to the builder

- Exact YAML escaping for descriptions; how to share boilerplate with the
  Vibe renderer.
- The precise `permissions.allow` rule syntax that works from `~/.claude/
  settings.json` (docs describe `~/` home-relative and `//` absolute forms)
  and whether `Grep`/`Glob` outside the working directory also need rules.
- Whether the installed-copy marker lives in frontmatter or body, provided
  Claude Code accepts it.
- Test strategy details.

## Acceptance

1. `./install.sh install` on a machine with no `~/.claude/agents/` produces
   the agents, the allow rule and a restart reminder; rerun is a no-op.
2. After restart, from a **different project directory**, spawning one
   room and having it read its own `SKILL.md` causes no permission prompt.
   (This is the check the spike could not make.)
3. Re-running the context probe against a generated agent shows no `Skill`
   tool, no other skills, no CLAUDE.md text.
4. A hand-written agent of the same name in `~/.claude/agents/` is left
   untouched and reported.
5. `status` reports the Claude target and exits non-zero when out of sync.
6. README documents the target, the accepted residual leakage, and the
   no-credentials stance.
