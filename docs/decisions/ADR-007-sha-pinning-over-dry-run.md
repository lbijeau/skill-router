# ADR-007: SHA pinning over update --dry-run

## Status
Accepted

## Date
2026-11-15

## Context
The Trust model documented `update` running `git pull --ff-only` on every
clone with no review step in between: `repos.json` pinned a URL, not a
commit, and skill bodies, descriptions and personas were re-pulled and shown
verbatim to agents on every update on upstream's say-so alone (issue #12).
Two directions were weighed: an `update --dry-run` that previews the diff
before applying it, or a per-repo commit pin in the manifest. `--dry-run`
keeps today's trust-every-pull model and only adds a preview step that a
human has to remember to run and read before the real `update`; a forgotten
or skipped `--dry-run` is back to silent trust. A pin makes the trust
decision the default path: `update` cannot move a clone past what
`repos.json` says, and moving it is itself a reviewed, diffable commit.

## Decision
`repos.json` entries accept an optional `pin` field: a commit SHA, hex,
7–40 characters, validated in `loadManifest`/`validateManifestEntry` with an
error naming the entry.

- **Back-compat, adopt-as-you-go**: an entry without `pin` keeps exactly
  today's behavior — `install` shallow-clones and `update` runs
  `git pull --ff-only` to upstream HEAD. The schema change breaks nothing
  for an entry that does not opt in.
- **With `pin`**: `install` clones (full history, not `--depth 1`, so an
  older pinned commit is actually present to check out) and checks out the
  pin. `update` fetches and checks out the pin again — never upstream
  HEAD — so a pinned clone cannot silently move. Checkout failure (a bad or
  unreachable pin) is reported and treated like a clone failure, not
  retried with something else.
- **Drift is reported, never acted on**: when the clone's `origin/HEAD`
  differs from the manifest's `pin`, `install`/`update` print a status line
  naming both SHAs. Nothing in the tool moves the pin forward on its own.
- **Moving a pin is a hand-edited, reviewed manifest commit**, exactly like
  adding a repo (ADR-003) or changing its tool policy (ADR-006).
  `./install.sh pin <name>` (or no name, for every repo) prints the repo's
  current upstream HEAD SHA so the maintainer can copy it into `repos.json`
  deliberately; it writes nothing itself.
- The 13 repos pinned before this change get a `pin` in the same commit,
  read from each clone's current HEAD — the state the committed agents were
  generated from, so the pin matches what is already shipping.

## Alternatives Considered

### `update --dry-run`
Rejected: previews the diff but still trusts upstream by default; the
review step is optional and easy to skip, and the described problem
(`update` moving a clone with no review) isn't actually fixed, only made
visible if invoked.

### Require a pin on every entry (no back-compat path)
Rejected: forces a disruptive manifest migration and blocks a new pin
request (CONTRIBUTING's Pin request flow) on figuring out a SHA up front,
for no safety gain on a repo whose maintainer has already decided to trust
it between pulls (today's documented model, kept available on purpose for
entries that don't opt in yet).

### Pin enforced by refusing to fetch past it (shallow-forever)
Rejected: a shallow `--depth 1` clone only has the tip commit; moving the
pin to an older or different commit later would have no object to check
out. A pinned entry needs full history up front.

## Consequences
- A pinned entry's clone is reproducible across machines and time: the same
  `repos.json` always produces the same commit, independent of what
  upstream does next.
- `update` on a pinned entry costs a full fetch instead of a shallow
  `pull --ff-only`; acceptable since the point is to stop trusting the pull
  itself.
- The README Trust model and `repos.json`'s 13 entries both change in this
  commit; the Tuning section documents the new field alongside `tools` and
  `skillSource`.
- Entries without `pin` are unchanged and keep the residual risk the
  original Trust model already documented — accepted for repos that have
  not opted in yet.
