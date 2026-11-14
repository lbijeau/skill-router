# ADR-005: Refuse temp-dir entries in persistent pi settings and prune stale ones

## Status
Accepted

## Date
2026-11-13

## Context
GitHub issue #11: `scripts/test.mjs` builds fixtures in `mkdtemp` directories
(`sr-*` under `os.tmpdir()`), and `runCli` computes the agents dir from the
root it is given. A test failure that skipped cleanup stranded a fixture
directory in the temp dir; if that run had merged into the real
`~/.pi/agent/settings.json`, the fixture's agents dir would have been
registered in `subagents.agentScanDirs` — a persistent entry pointing at a
path that vanishes on the next reboot. pi would then scan a dead path on
every session, forever, and the entry would look legitimate to anyone
inspecting the file. The bug class is not test-specific: any checkout under
the temp dir produces the same worthless persistent entry.

## Decision
As of commit 5d97739, `mergeSettings` (in `scripts/generate.mjs`) treats the
system temp dir as a hard boundary for persistent settings:

- **Refuse**: when writing a persistent settings file, never register an
  agents dir that lives under `os.tmpdir()` (resolved through symlinks with
  `realPath`); the merge reports "refusing to register an agents dir under
  the system temp dir" and changes nothing.
- **Prune**: on every merge into persistent settings, drop existing
  `agentScanDirs` entries that live under the temp dir, so a stale entry
  from an earlier leak self-heals on the next `install`/`update`.
- **Exempt fixtures**: a settings file that is itself inside the temp dir is
  a test fixture, not user config — the refuse/prune rules do not apply to
  it.
- **Test-side fix**: `test.mjs` registers every `mkdtemp` fixture and
  removes any leftovers in a runner-level `finally`, so a failing assertion
  can no longer strand `sr-*` directories in the temp dir.

## Alternatives Considered

### Filter by fixture name prefix (`sr-*`) only
- Pros: targets exactly this project's fixtures.
- Cons: name-based filtering is fragile — any other tool's temp checkout, or
  a differently named fixture, slips through; the property that matters is
  "under the temp dir", not the name.
- Rejected: the path property is the invariant, not the prefix.

### Rely on test cleanup alone
- Pros: no production-code change.
- Cons: issue #11 proved a failing assertion can skip cleanup; and even a
  clean test suite does not protect a real checkout under `/tmp`.
- Rejected: defense in depth — the guard is cheap and the failure mode is
  persistent user-config pollution.

### Rely on `runCli`'s explicit-paths requirement
- Pros: tests already must pass explicit `settingsPath`/`skillsHome` for a
  custom root, so in theory the real settings are never a merge target.
- Cons: `mergeSettings` is exported and callable directly; a single new
  call site that forgets the guard reopens the leak. The boundary belongs
  at the write, not at every caller.
- Rejected: same reason.

## Consequences
- Persistent pi settings can never gain (or keep) a temp-dir scan entry;
  existing leaks are pruned automatically on the next run.
- A checkout genuinely living under `/tmp` cannot be registered — by
  design; the refusal message says so.
- Tests keep using temp fixtures freely, including temp settings files,
  which are exempt from the refuse/prune rules.
- The temp-dir check resolves through symlinks (`realPath`), so a symlinked
  temp location cannot smuggle an entry past the guard.
