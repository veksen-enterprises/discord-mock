# Changelog

## 0.2.0

Breaking: every name now says what the method does, what it returns and whether it waits. Methods that wait for the bot start with `waitFor`. Rename your calls with this table; nothing else in a test changes.

| 0.1                                    | 0.2                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `discord.find(channel, text)`          | `discord.waitForMessage(channel, text)`                                                            |
| `discord.find(member, text)`           | `discord.waitForDM(member, text)`                                                                  |
| `discord.findThread(channel, name)`    | `discord.waitForThread(channel, name)`                                                             |
| `discord.thread(channel, message)`     | `discord.waitForThreadFrom(message)`                                                               |
| `discord.hearBot(channel)`             | `discord.waitForSound(channel)`                                                                    |
| `discord.idle()`                       | `discord.waitForIdle()`                                                                            |
| `member.run(…)`                        | `member.runCommand(…)`                                                                             |
| `member.runApp(channel, target, name)` | `member.runUserCommand(channel, name, member)`, `member.runMessageCommand(channel, name, message)` |
| `member.autocomplete(…)`               | `member.typeInOption(…)`                                                                           |
| `member.edit(…)`, `member.delete(…)`   | `member.editMessage(…)`, `member.deleteMessage(…)`                                                 |
| `member.nickname(…)`                   | `member.setNickname(…)`                                                                            |
| `member.displayName(…)`                | `member.setDisplayName(…)`                                                                         |
| `member.leave()`                       | `member.leaveGuild()`                                                                              |
| `member.invite(…)`                     | `member.createInvite(…)`                                                                           |
| `member.forumPost(…)`                  | `member.postInForum(…)`                                                                            |
| `discord.lock(thread)`                 | `member.lockThread(thread)`, which needs Manage Threads                                            |
| `discord.deny(channel, permission)`    | `discord.deny(channel, "bot", permission)`; the same for `allow`                                   |
| `discord.archive(thread)`              | `discord.autoArchive(thread)`                                                                      |
| `discord.outage(guild)`                | `discord.startOutage(guild)`                                                                       |
| `discord.commandPermissions(…)`        | `discord.setCommandPermissions(…)`                                                                 |
| `discord.fail(…)`                      | `discord.answerWith(…)`                                                                            |
| `discord.channel(…)`                   | `discord.textChannel(…)`                                                                           |
| `discord.close()`                      | Removed: the server closes when the test ends                                                      |

New and fixed:

- Slash command options of type role, mentionable, attachment, and voice or stage channel. A file is a `FileUpload`.
- Forms (modals) with string, user, role, mentionable and channel selects, radio groups, checkbox groups, checkboxes and file uploads.
- The bot can create voice, category, stage and forum channels, with a parent and permission overwrites.
- A deferred reply waits while the bot keeps working, and fails after 2s of silence or 10s in all, naming the bot's latest requests.
- `click` and `select` wait for the bot to go quiet first, so a collector the bot starts after replying hears the click. A deferred update resolves with the message as the bot leaves it.
- Roles made or given after the bot connects reach it, so `member.permissions` is right.
- Ephemeral replies stay out of channel history, so a purge deletes only the members' messages.
- Bots with `zlib-sync` installed can connect (zlib-stream compression); the deprecated pin routes answer for `@discordjs/core` bots; a bot can rewrite its application description.

## 0.1.1

Docs only; the code is unchanged.

- The README opens with a short test of a one-command bot, compares it with hand-rolled fakes, and lists bugs the fakes miss. The full action and rules tables moved to the docs site.
- The skill's example is written as arrange-act-assert, one action per test, and tells agents to write theirs that way.
- The README, the skill and the API docs say "server" and "unmodelled request" instead of internal terms.

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
