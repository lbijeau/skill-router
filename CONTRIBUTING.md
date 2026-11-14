# Contributing

## Ground rules

- The suite is offline and fixture-based: `node scripts/test.mjs`. No network,
  no cloned repos needed. Every change ships with a test that fails without
  it; the suite must be green before you push.
- Nothing that runs on a stranger's machine may write user config
  destructively. Atomic writes with a `.bak`, refuse what you can't merge
  safely, print the manual remedy. See ADR-004.
- Test fixtures live in `mkdtemp` directories and are cleaned on every exit
  path. Never let a fixture path reach persistent user settings. See ADR-005.
- Manifest entries are validated at load (`loadManifest`): names, required
  fields, URL shape, `tools` policy. New manifest fields get validation and
  tests in the same change.

## Setup

```sh
git clone https://github.com/lbijeau/skill-router ~/repositories/skill-router
cd ~/repositories/skill-router
node scripts/test.mjs          # should be green before you start
git config core.hooksPath hooks   # gitleaks pre-commit (or copy hooks/pre-commit to .git/hooks/)
```

The pre-commit hook runs `gitleaks protect --staged` and refuses to commit
without it. `brew install gitleaks` if it is missing.

## What changes look like

- **Code**: one commit per coherent change, terse subject line, body that
  says why. Look at `git log` for the register.
- **Decisions**: anything expensive to reverse — manifest schema, tool
  policy, config-writing behavior — gets an ADR in `docs/decisions/`
  (numbered, superseding, never deleted). If your change contradicts an
  ADR, say so and supersede it; that's a normal outcome, not a problem.
- **Pinning a new repo**: open a Pin request issue (the template walks the
  license and trust questions). Don't hand-edit `repos.json` in a PR first —
  the manifest is a reviewed trust decision, not a casual list.
- **Generated artifacts** (`agents/`, `agents-vibe/`, `agents-claude/`,
  `catalog/`) are committed but generated: change the generator, run it,
  commit the regenerated files in the same change. Never hand-edit them.

## Sending it

PRs to `master`, squash-merged, history-protected (no force pushes).
Draft release notes and docs changes in the repo's voice: plain verbs,
no marketing, claims hedged exactly as far as the code supports — the
README's Trust model is the register to match.

## License

MIT (see [LICENSE](LICENSE)). Contributions land under the same terms.
