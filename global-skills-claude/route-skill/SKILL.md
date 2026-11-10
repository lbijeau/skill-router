---
name: route-skill
description: Route a described situation to the best skill across all skill-router repos, via the skill-router subagent
---

<!-- Generated-style boilerplate; overwritten by skill-router install/update.
Put custom behavior in your own CLAUDE.md or say it in the invocation. -->

The user has described a situation and wants to know which skill fits.
The full catalog of pinned-repo skills is large; do not read it in this
session. Instead:

1. Capture the user's situation in one or two sentences.
2. Launch the `skill-router` agent with the Agent tool
   (`subagent_type: skill-router`), passing the situation as its prompt.
   It reads the catalog, opens the winning SKILL.md, and returns the skill
   name, its path, why it fits, and a short digest.
3. Relay the recommendation verbatim.
4. Offer to read the recommended SKILL.md and follow it in this session.
   Do not start the work unless the user says so.
