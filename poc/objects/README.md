# Variant 1: objects

Every entity is a value you create and pass around.

```ts
const discord = await createDiscord();
const sin = discord.guild("sin");
const ladder = discord.category(sin, "Test Ladder");
const challenges = discord.channel(sin, "challenges", ladder);
const alice = discord.member(sin, "alice", "Bravo"); // nickname optional

const reply = await discord.run(alice, challenges, "join"); // the APIMessage Alice sees
discord.fail(
  "PATCH",
  "/webhooks/:app/:token/messages/@original",
  respond.serverError(503),
);
await discord.close(); // throws if the bot hit a Gap
```

- `guild`, `category`, `channel`, `member` build the World. Each returns a typed handle; a
  category can't be passed where a channel goes, a channel can't be passed where a member goes.
- `run` resolves with the visible reply, after any defer. It rejects if the reply never comes.
- Not checked by the types: that the member belongs to the channel's guild (the mock throws at
  runtime), and that the command exists (the mock throws if the bot never registered it).
