# Variant 3: user stories

Describe and drive the server by name.

```ts
import { createDiscord } from "discord-mock/story"; // also registers toBeEphemeral and toShowEmbed

const discord = await createDiscord();
discord
  .guild("sin")
  .channel("#challenges", { category: "Test Ladder" })
  .member("alice", { nick: "Bravo" });

const reply = await discord.as("alice").in("#challenges").run("/join");
expect(reply).toBeEphemeral();
expect(reply).toShowEmbed("Joined the Ladder!");
discord.fail(
  "PATCH",
  "/webhooks/:app/:token/messages/@original",
  respond.serverError(503),
);
await discord.close();
```

- Names are the handles. `guild(name)` and `member(name)` create on first use and reuse after.
- The leading `#` on channels and `/` on commands are optional.
- `in()` throws if no channel or several channels have that name.
- Nothing about names is checked by the types: a typo fails when the test runs.
- Ids aren't exposed. To assert on state keyed by a user id, you look the user up yourself.
