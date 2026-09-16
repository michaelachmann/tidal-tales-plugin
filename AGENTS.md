# Repository guidance

These rules apply to all work in this repository.

## Workflow and commits

- Split work into coherent, reviewable steps. Commit each medium or large step separately once its relevant checks pass; small related edits may share a commit.
- Use concise commit messages describing the change and its purpose. Keep unrelated fixes and refactors in separate commits when they can stand on their own.
- Inspect the working tree before editing or committing. Stage explicit paths or hunks; preserve unrelated user changes and never commit incidental files such as `.DS_Store`.
- Do not rewrite history or push changes unless requested. Report what changed, what was checked, and any remaining limitations.

## Code quality

- Prefer simple, established patterns, clear names, and small functions with one responsibility. Avoid speculative abstractions and unnecessary dependencies.
- Follow DRY principles: share genuinely repeated behavior, while keeping platform-specific parsing explicit and easy to change.
- Keep response parsing, persistence/downloads, and popup presentation separate. Parsers should return data without initiating downloads or modifying the database.
- Comment intent, assumptions, platform quirks, and non-obvious tradeoffs. Avoid comments that merely repeat the code; update comments when behavior changes.
- Treat captured platform data as untrusted. Validate shapes and URLs, sanitize filenames, render text safely, and handle missing or malformed fields.
- Handle asynchronous failures explicitly. Keep capture responsive, bound download concurrency, and distinguish requested downloads from completed files.

## Compatibility and verification

- Preserve the local-only design. Do not add uploads, telemetry, or remote storage without an explicit user request; keep extension permissions minimal.
- Preserve existing stored data and file conventions where practical. Make necessary schema or export changes explicit and document migration implications.
- Add focused regression tests for bugs and meaningful behavior changes. Use synthetic or sanitized fixtures, never credentials or private browsing data.
- Run `node --test tests/*.test.cjs` for code changes and `git diff --check` before committing. Use Firefox smoke tests for browser-specific changes when available; clearly distinguish mocked tests from live verification.
- Update the README when setup, supported capture behavior, export formats, or limitations change. Preserve attribution and licensing when adapting Zeeschuimer code; leave vendored libraries in `inc/` alone unless a dependency update is intentional.

## Delegation

- Use subagents when independent, bounded work benefits from parallel review or implementation. Prefer cheaper models for routine, well-scoped tasks; give agents distinct file ownership and review their changes before integration.
