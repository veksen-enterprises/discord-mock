# Changelog

## 0.1.0

First release. A stock discord.js 14 `Client` logs in to a fake Discord (REST and Gateway on `127.0.0.1`), and a test drives it through `createDiscord`.

- Servers, channels (text, voice, stage, forum, threads), roles, permission overwrites and members, with Discord's permission checks.
- Messages, edits, reactions, attachments, polls, typing, pins and history.
- Slash commands, autocomplete, buttons, selects (string and entity), modals, and the 3-second deadline.
- Moderation: kicks, bans, timeouts, prune, AutoMod rules, audit log entries.
- Scheduled events, emojis, stickers, stage instances and bot voice connections.
- Failures: `fail()` for 5xx and 429, `deny()` for a missing permission, `disconnect()` and `reconnect()` for the Gateway, server outages.
- Anything the kit doesn't model is a Gap, and a Gap fails the test.

Behaviour checked against a real test server is listed in `contract/`; everything else is modelled from Discord's docs.
