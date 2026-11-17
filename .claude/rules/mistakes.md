# Lessons from past mistakes

Add new lessons at the top, one bullet each: the rule, then the incident in a
few words.

- **Default the World to the least privilege Discord would give.** The first
  draft made the bot the guild owner, so every permission check passed and the
  403 tests couldn't fail (spike, 2026-11-17).
