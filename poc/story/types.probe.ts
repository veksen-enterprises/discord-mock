// Each line below is a misuse. `@ts-expect-error` fails the typecheck if the misuse compiles.
import { createDiscord } from "./index.js";

const d = await createDiscord();
d.guild("sin")
  .channel("#challenges", { category: "Test Ladder" })
  .member("alice");
d.guild("other").channel("#elsewhere");

// 1. misspelled channel
// NOT CAUGHT: compiles
void d.as("alice").in("#chalenges").run("/join");
// 2. misspelled user
// NOT CAUGHT: compiles
void d.as("alise").in("#challenges").run("/join");
// 3. a category where a text channel goes
// NOT CAUGHT: compiles
void d.as("alice").in("Test Ladder").run("/join");
// 4. arguments swapped
// NOT CAUGHT: compiles
void d.as("#challenges").in("alice").run("/join");
// 5. member of another guild
// NOT CAUGHT: compiles
void d.as("alice").in("#elsewhere").run("/join");
// 6. membership in an undeclared guild: guild() creates it, so there is no such thing
// NOT CAUGHT: compiles
void d.guild("nowhere").member("bob");
// 7. a command the bot never registered
// NOT CAUGHT: compiles
void d.as("alice").in("#challenges").run("/jion");
