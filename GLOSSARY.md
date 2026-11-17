# discord-mock

The ubiquitous language of discord-mock: a fake Discord that a real discord.js
bot connects to in tests. **Core** holds the terms every area shares; each
subsection after it holds the language local to one area. Discord's own terms
(guild, channel, member, role, snowflake, intent) keep their Discord meaning and
aren't repeated here.

## Language

### Core

**Mock**:
One running fake Discord: an HTTP server for REST and a WebSocket server for the
Gateway on a local port, plus the Model behind them. One test gets one mock.
_Avoid_: server (it's two), stub, fake (as a noun)

**Bot**:
The code under test, as it ships: the consumer's handlers on a stock discord.js
`Client`.
_Avoid_: client (that's the discord.js object inside the bot), app

**Consumer**:
A project whose bot is tested with discord-mock. Today: sin-bot and the d2armory
bot.

**Model**:
The Mock's in-memory Discord: users, guilds, members, roles, channels, messages,
registered commands and interactions. REST writes change it; the Gateway
announces the changes; tests read it to assert what the bot did.
_Avoid_: state (in prose), store, database, fixtures

**Rule**:
A Discord behaviour the Mock enforces on its own, such as permission checks,
intent filtering, or the interaction deadline. Every rule cites where it comes
from: a docs.discord.food page, Discord's docs, or a contract test.
_Avoid_: validation (too generic), constraint

**Fidelity**:
How closely the Mock's answers match real Discord's for the same request. A
Rule raises fidelity; an Override lowers it on purpose for one test.
_Avoid_: accuracy, realism

**Gap**:
A request from the bot that no route handles. The Mock answers 404 and records
it; `assertNoUnhandledRequests()` fails the test. A Gap means the Mock can't
vouch for that code path.
_Avoid_: unhandled route (in prose), missing mock

### World building

**World**:
What a test sets up in the Model before the bot logs in: guilds, channels,
users, members, roles, overwrites.
_Avoid_: seed, fixture data

**Actor**:
A user the test acts as, via `mock.as(user)`: sending a message, running a
slash command, pressing a button. An Actor's action becomes a Gateway dispatch
to the bot, as on Discord.
_Avoid_: fake user, test user, sender

### REST

**Route**:
A method and path pattern the Mock answers, like `POST /channels/:id/messages`.
Built-in routes read and write the Model.
_Avoid_: endpoint (fine in Discord's docs, but here it's a Route), handler (the
function behind a route)

**Override**:
A test's own answer for a Route, checked before the built-in one, optionally
`once`. Used for what the Model can't produce: 5xx, 429, a dropped connection.
_Avoid_: stub, mock (as a verb), intercept

**Request log**:
Every request the bot made, in order, with its status. Tests assert on it when
the request itself is the behaviour, such as retry counts.

### Gateway

**Dispatch**:
An event the Mock sends to the bot over the Gateway (op 0): `READY`,
`MESSAGE_CREATE`, `INTERACTION_CREATE`. Subject to the session's intents.
_Avoid_: emit, push, event (alone)

**Session**:
One identified Gateway connection, with its intents, sequence number and the
dispatches it missed while disconnected. A resume picks the session back up and
replays what it missed.

### Interactions

**Interaction run**:
One interaction an Actor triggered, followed through its life: pending, then
deferred or replied. Tests await its reply with `run.reply()`.
_Avoid_: interaction (alone, it's ambiguous with discord.js's object), command
call

**Acknowledge**:
The bot's first callback to an interaction: a reply, a defer, or an update.
Discord accepts exactly one, within the deadline.
_Avoid_: respond (discord.js uses `respond` for autocomplete)

**Deadline**:
The 3 seconds Discord gives a bot to acknowledge an interaction. After it, the
callback fails with 10062.

**Original**:
The message an interaction's `@original` webhook path points at: the reply, or
for a button press, the message the button is on.
