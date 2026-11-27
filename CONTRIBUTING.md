# Contributing to Myelin

Thanks for your interest. Myelin is maintained by one person, so small, focused contributions are the easiest to review.

## Before you start
- Bugs and ideas: open an issue using a template.
- Code changes: comment on an existing issue (or open one) before starting anything larger than a small fix, so we agree on the approach.
- Good starting points: issues labeled `good first issue` or `help wanted`.

## Rules
- Everything in English: code, comments, docs, commit messages, UI text.
- Text files: UTF-8 without BOM, LF line endings (`.editorconfig` and `.gitattributes` enforce this).
- Read `CLAUDE.md` (decisions and rules) and `docs/` before changing architecture.

## Pull requests
1. Fork the repo and create a branch: `<issue-number>-short-slug` (e.g. `7-watcher-loop-guard`).
2. Keep the PR small and about one issue. Write `Closes #N` in the description.
3. Make sure checks pass (typecheck, tests, build, once CI exists).
4. The maintainer reviews. PRs are squash-merged: the PR title becomes the commit message, so write it as a short imperative sentence ("Add watcher loop guard").

## License
By contributing, you agree that your contributions are licensed under the MIT License (see `LICENSE`).
