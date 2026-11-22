# mend: one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jinan86/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/jinan86/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) ($100, 10 places).

`main.ts` (Node 22, standard library only) is `mend`, the command-line tool
`SPEC.md` specifies: it reads a patch in one of four formats — unified diffs
(often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON
text-editor tool calls — finds the lines each edit names at the first of
three matching tiers (exact, trailing whitespace ignored, leading and trailing
whitespace ignored with re-indentation), and changes every file or none.

Run it as `node main.ts [options] [PATCH]` with the working directory as the
root of a tree of text files; `PATCH` is the patch file, or `-`/absent for
standard input. Options: `--format=auto|unified|search-replace|v4a|json`,
`--check` (same output and exit code, writes nothing), `--strict` (tier 0
matching only).

Practice score: **1000** (100 of 100 practice checks pass), plus 36 extra
edge-case checks written against sentences of SPEC.md the practice set does
not show, all passing.

## The files

- `main.ts`: the CLI. Its last lines hand a trial over to `runner.ts` when
  `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env,
  runs `node main.ts` on each one in a fresh directory, and posts what
  `main.ts` did (its exit code, its stdout and the files left in the
  directory).
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts <path to practice.json>
      node check.ts <path to practice.json> u-offset s-basic

  It prints every check `main.ts` gets wrong, with what differed, and the
  practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
