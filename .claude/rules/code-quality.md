# Code Quality Checklist

Before declaring done, verify:

- Does this actually solve the stated problem?
- Any obvious bugs, off-by-one, unhandled cases?
- Does each new Rule cite its source, and does a test drive it through a stock `Client`?
- Could this make a broken bot's test pass? (A lenient default, a guessed answer, a swallowed Gap.)
- Is the code readable to someone who didn't write it?
- Names descriptive and consistent with `GLOSSARY.md`?
- Any dead code, debugging artifacts, or abandoned TODOs?
- Any unnecessary new dependencies? Runtime dependencies reach every consumer.
- Could this break existing functionality, or a consumer's tests?

## Scope Discipline

- The diff contains only what the task required. No drive-by cleanups.
- Never reformat code you didn't functionally change. After `npm run format`,
  review `git diff` and revert unrelated hunks.
- Never modify `package-lock.json` by hand; never delete it.

## Rules

- Follow existing codebase patterns. Don't introduce new patterns without discussion.
- Prefer simple, boring code over clever code.
- Don't over-engineer. Build the Route the consumer's flow needs, not the API
  surface around it.
- Run `npm run lint:fix && npm run format` after changes. Fix all issues.
