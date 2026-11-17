// Each line below is a misuse. `@ts-expect-error` fails the typecheck if the misuse compiles.
import { createDiscord } from "./index.js";

const d = await createDiscord();
const sin = d.guild("sin");
const other = d.guild("other");
const ladder = d.category(sin, "Test Ladder");
const challenges = d.channel(sin, "challenges", ladder);
const elsewhere = d.channel(other, "elsewhere");
const alice = d.member(sin, "alice");

// 1. misspelled channel
// @ts-expect-error
void d.run(alice, chalenges, "join");
// 2. misspelled user
// @ts-expect-error
void d.run(alise, challenges, "join");
// 3. a category where a text channel goes
// @ts-expect-error
void d.run(alice, ladder, "join");
// 4. arguments swapped
// @ts-expect-error
void d.run(challenges, alice, "join");
// 5. member of another guild
// NOT CAUGHT: compiles
void d.run(alice, elsewhere, "join");
// 6. membership in an undeclared guild
// @ts-expect-error
void d.member(nowhere, "bob");
// 7. a command the bot never registered
// NOT CAUGHT: compiles
void d.run(alice, challenges, "jion");
