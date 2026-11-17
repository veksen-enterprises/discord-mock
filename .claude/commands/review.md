Perform a self-code-review of the current uncommitted changes using a subagent (clean context).

Run `git diff` and review it as a senior engineer against the project's standards
(apply them, don't restate them here):

- **Code quality** — `.claude/rules/code-quality.md`.
- **Fidelity** — does each modelled behaviour match Discord, with a cited
  source? Flag anything that could let a broken bot's test pass.
- **Tests** — do they drive behaviour through a stock discord.js `Client` and
  assert what a user would see?
- **Language** — names and prose use `GLOSSARY.md` terms; no `_Avoid_` words.
- **Comments** — explain WHY not WHAT; no AI-slop (CLAUDE.md "Code Comments").

Provide prioritized findings. If everything looks good, say so.
