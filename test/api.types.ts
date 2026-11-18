// Type probes for the public API: each line marked @ts-expect-error is a misuse, and `npm run
// typecheck` fails if it compiles. Never run, only typechecked.
import { createDiscord } from "../src/index.js";

const discord = await createDiscord();
const server = discord.guild("SIN");
const otherServer = discord.guild("Other");
const ladderCategory = discord.category(server, "Test Ladder");
const challengesChannel = discord.channel(server, "challenges", ladderCategory);
const otherChannel = discord.channel(otherServer, "elsewhere");
const alice = discord.member(server, "alice");
const carol = discord.member(otherServer, "carol");

// A category where a text channel goes
// @ts-expect-error
void alice.run(ladderCategory, "join");
// A member where a channel goes
// @ts-expect-error
void alice.run(carol, "join");
// A channel in another server
// @ts-expect-error
void alice.run(otherChannel, "join");
// A user option from another server
// @ts-expect-error
void alice.run(challengesChannel, "challenge", { opponent: carol });
// A category from another server
// @ts-expect-error
discord.channel(otherServer, "late", ladderCategory);
// Posting in another server's channel
// @ts-expect-error
alice.post(otherChannel, { content: "hi" });
// Joining a text channel's voice
// @ts-expect-error
alice.joinVoice(challengesChannel);
// Joining another server's voice channel
// @ts-expect-error
alice.joinVoice(discord.voiceChannel(otherServer, "lobby"));
// Running a command in a voice channel's chat isn't modelled
// @ts-expect-error
void alice.run(discord.voiceChannel(server, "lobby"), "join");

// Not caught, by design: command names, whose literal type discord.js's builders erase.
void alice.run(challengesChannel, "jion");
