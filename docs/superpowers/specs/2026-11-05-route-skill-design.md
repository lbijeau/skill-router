# route-skill — Cross-Repo Skill Router Design

Date: 2026-11-05
Status: approved (brainstormed with human partner)
Companion to: [2026-07-09-skill-router-design.md](2026-07-09-skill-router-design.md)

## Purpose

Add a router over **every** skill in every repo pinned by `repos.json`,
modeled on Matt Pocock's `ask-matt` but fixing its two known bugs by
construction:

- **No lag.** `ask-matt` is a hand-written map that drifts behind its
  repo. Our catalog is generated from the clones by `generate.mjs` and
  rebuilt on every `install.sh update`.
- **No answering from summaries.** `ask-matt` states what a skill does
  without opening its `SKILL.md`. Our router subagent must open the
  winning `SKILL.md` and return a digest of the real thing.

## Design

Three pieces:

1. **Generated catalog.** `generate.mjs` emits
   `catalog/skill-catalog.md` (committed): one entry per skill across
   all clones — skill name, repo, description (from SKILL.md
   frontmatter), and a `~`-anchored path to the SKILL.md. Rebuilt on
   every `install`/`update`. Never hand-maintained.

2. **Router subagent.** A generated agent `agents/skill-router.md`,
   wired like the others via `agentScanDirs` (so it is discoverable
   from any project), `inheritSkills: false`. Its persona: read the
   catalog, match the caller's situation, open the winning `SKILL.md`,
   and return: the skill name, its path, why it fits, and a short
   digest of the real SKILL.md. It recommends and stops — it never
   executes the skill. Route **+ digest** was chosen deliberately: the
   digest lets the caller decide whether to commit to the full skill
   before reading it, and it bakes in the
   verify-against-the-real-SKILL.md discipline.

3. **Global skill.** `~/.pi/agent/skills/route-skill/SKILL.md` — a thin
   wrapper. Its body: take the user's situation, spawn the
   `skill-router` subagent with it, relay the recommendation. The
   caller then reads the recommended SKILL.md in-session (no subagent
   spawn of the per-repo agent, no clean-room trip — that was option 2
   of the routing-output decision).

## Why a subagent at all

The catalog is 14 repos of skill descriptions. Routing via a subagent
means that bulk never enters the calling session's context — the caller
receives only the recommendation and digest. The caller's loaded
skills are untouched.

## Non-goals

- No execution of the routed-to skill by the router.
- No routing over the user's own installed skills or other authors'
  skills outside `repos.json` — same scope rule as `ask-matt`.
- No Vibe target for the router (pi only, for now).
- No hand-written routing prose in v1; overlaps between repos
  ("superpowers `writing-plans` vs mattpocock `to-spec`") are the
  router model's inference problem, informed by the descriptions and
  the digests. A hand-written routing layer can be added later.

## It's working if

- Invoking the skill from any project returns a recommendation with a
  readable path, without loading the catalog into the session.
- The recommendation includes a digest that matches the actual
  SKILL.md, not just its frontmatter description.
- `install.sh update` regenerates the catalog and the catalog's git
  diff reflects upstream skill changes.
