# Contributing to Myelin

Thanks for your interest. Myelin is maintained by one person, so small, focused contributions are the easiest to review.

## Before you start
- Bugs and ideas: open an issue using a template.
- Code changes: comment on an existing issue (or open one) before starting anything larger than a small fix, so we agree on the approach.
- Good starting points: issues labeled `good first issue` or `help wanted`.

## Rules
- Everything in English: code, comments, docs, commit messages, UI text.
- Text files: UTF-8 without BOM, LF line endings (`.editorconfig` and `.gitattributes` enforce this).
- Read `AGENTS.md` (decisions and rules) and `docs/` before changing architecture.

## Commit messages
[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, with the subject imperative, lower case, no period.
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`.
- Scope is the area (`vault`, `editor`, `graph`, `ui`, `tooling`); omit it when none fits.
- Breaking change: `type(scope)!: subject`.
- PR titles use the same format.

## Pull requests
1. Fork the repo and create a branch: `<issue-number>-short-slug` (e.g. `7-watcher-loop-guard`).
2. Keep the PR small and about one issue. Write `Closes #N` in the description.
3. Make sure checks pass (typecheck, tests, build, once CI exists).
4. The maintainer reviews. PRs are squash-merged: the PR title becomes the commit message, so write it as a Conventional Commit (`feat(vault): add watcher loop guard`).

## License
By contributing, you agree that your contributions are licensed under the MIT License (see `LICENSE`).
