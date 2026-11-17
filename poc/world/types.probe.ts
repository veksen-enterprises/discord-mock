// Each line below is a misuse. `@ts-expect-error` fails the typecheck if the misuse compiles.
import { createDiscord } from "./index.js";

const d = await createDiscord({
  guilds: {
    sin: { channels: { challenges: { category: "Test Ladder" } } },
    other: { channels: { elsewhere: {} } },
  },
  users: { alice: { guilds: { sin: {} } } },
});
const { challenges } = d.guilds.sin.channels;
const { elsewhere } = d.guilds.other.channels;
const { alice } = d.users;

// 1. misspelled channel
// @ts-expect-error
void d.run(alice, d.guilds.sin.channels.chalenges, "join");
// 2. misspelled user
// @ts-expect-error
void d.run(d.users.alise, challenges, "join");
// 3. a category where a text channel goes (categories have no handle at all)
// @ts-expect-error
void d.run(alice, d.guilds.sin.categories, "join");
// 4. arguments swapped
// @ts-expect-error
void d.run(challenges, alice, "join");
// 5. member of another guild
// @ts-expect-error
void d.run(alice, elsewhere, "join");
// 6. membership in an undeclared guild
void (await createDiscord({
  guilds: { sin: { channels: {} } },
  // @ts-expect-error
  users: { bob: { guilds: { nowhere: {} } } },
}));
// 7. a command the bot never registered
// NOT CAUGHT: compiles
void d.run(alice, challenges, "jion");
