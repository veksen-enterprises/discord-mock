# Variant 2: declarative World

Describe the server once; get typed handles back.

```ts
const discord = await createDiscord({
  guilds: {
    sin: { channels: { challenges: { category: "Test Ladder" }, general: {} } },
  },
  users: { alice: { guilds: { sin: { nick: "Bravo" } } } },
});
const { challenges } = discord.guilds.sin.channels;
const { alice } = discord.users;

const reply = await discord.run(alice, challenges, "join");
discord.fail(
  "PATCH",
  "/webhooks/:app/:token/messages/@original",
  respond.serverError(503),
);
await discord.close();
```

- `guilds.<name>.channels.<name>`: text channels; `category` puts a channel in a category of that
  name, created once per guild.
- `users.<name>.guilds`: the guilds the user joined, keyed by a guild declared above, with an
  optional `nick`.
- The handles are typed from the spec: a misspelled channel or user doesn't compile, and neither
  does running a command in a guild the user isn't in.
- The World is fixed at creation. There is no call to add a channel or a member mid-test.
- Not checked by the types: that the command exists (the mock throws at runtime).
