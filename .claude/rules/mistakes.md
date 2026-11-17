# Lessons from past mistakes

Add new lessons at the top, one bullet each: the rule, then the incident in a
few words.

- **Read the reference before citing it.** If a source can't be fetched, say so
  and stop; don't model from memory under its name. The spike cited
  docs.discord.food in the README without one page of it being read (2026-11-17).
- **Default the World to the least privilege Discord would give.** The first
  draft made the bot the guild owner, so every permission check passed and the
  403 tests couldn't fail (spike, 2026-11-17).
