// npm run coverage:api [-- --write]
//
// Runs the suite with the recorder, then counts the Discord API the tests reach: REST routes a
// built-in route answered without a Gap, and Gateway Dispatches the Mock sent. Totals come from
// the installed discord-api-types (RoutesDeclarations, GatewayDispatchEvents). Fails when the
// result differs from baseline.json, so a lost route fails CI and a new one must be written down.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayDispatchEvents } from "discord-api-types/v10";

// Routes in discord-api-types that a bot token can't call, so they stay out of the coverage total.
// The source is each route's header on docs.discord.food: a route without the "supports bot"
// marker is user-only (docs.discord.food/reference#authentication). Every other route counts,
// including ones the docs don't list yet.
const notBotCallable: Record<string, string> = {
  // resources/guild: no bot marker. Create Guild and Use Guild Template make the caller the owner;
  // Delete Guild and Modify Guild MFA Level say "User must be the owner".
  "POST /guilds": "user token only (resources/guild#create-guild)",
  "POST /guilds/templates/:":
    "user token only (resources/guild-template#use-guild-template)",
  "DELETE /guilds/:": "user token only, owner (resources/guild#delete-guild)",
  "POST /guilds/:/mfa":
    "user token only, owner (resources/guild#modify-guild-mfa-level)",

  // topics/oauth2: the authorize page is a browser flow; the token routes authenticate with the
  // application's client id and secret, not the bot token; /oauth2/@me needs a bearer token.
  "GET /oauth2/authorize":
    "browser flow (topics/oauth2#authorization-code-grant)",
  "POST /oauth2/token": "client credentials, not the bot token (topics/oauth2)",
  "POST /oauth2/token/revoke":
    "client credentials, not the bot token (topics/oauth2)",
  "GET /oauth2/@me":
    "OAuth2 bearer token (topics/oauth2#get-current-authorization-information)",

  // Bearer-token routes acting for a user.
  "GET /users/@me/connections":
    "OAuth2 bearer token, connections scope (resources/connected-accounts)",
  "GET /users/@me/guilds/:/member":
    "OAuth2 bearer token, guilds.members.read scope (resources/guild#get-current-user-guild-member)",
  "GET /users/@me/applications/:/role-connection":
    "OAuth2 bearer token, role_connections.write scope (resources/application)",
  "PUT /users/@me/applications/:/role-connection":
    "OAuth2 bearer token, role_connections.write scope (resources/application)",
  // Not on docs.discord.food; the same resource as the GET and PUT above.
  "DELETE /users/@me/applications/:/role-connection":
    "OAuth2 bearer token, inferred from the GET and PUT on the same resource",

  // interactions/application-commands: editing command permissions takes a bearer token with
  // applications.commands.permissions.update. The GETs on the same paths have no bot marker on
  // docs.discord.food either, but stay counted: discord.js fetches them with the bot token
  // (ApplicationCommandPermissionsManager#fetch) and the kit already answers them.
  "PUT /applications/:/guilds/:/commands/:/permissions":
    "OAuth2 bearer token (interactions/application-commands#edit-application-command-permissions)",
  "PUT /applications/:/guilds/:/commands/permissions":
    "not on docs.discord.food; a bearer token like the per-command PUT, inferred",
};

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, "baseline.json");
const write = process.argv.includes("--write");

interface ApiRoute {
  key: string;
  regex: RegExp;
  literals: number;
}

/** Every method + path discord-api-types declares, parsed from RoutesDeclarations' JSDoc. */
function apiRoutes(): { version: string; routes: ApiRoute[] } {
  const require = createRequire(import.meta.url);
  // The package's `exports` hide package.json, so walk up from the v10 entry point.
  const pkgPath = join(
    dirname(require.resolve("discord-api-types/v10")),
    "package.json",
  );
  const version = (
    JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }
  ).version;
  const source = readFileSync(
    join(dirname(pkgPath), "_generated_/rest/v10/interfaces.d.ts"),
    "utf8",
  );
  const start = source.indexOf("interface RoutesDeclarations");
  const block = source.slice(start, source.indexOf("\n}\n", start));
  const keys = new Set<string>();
  for (const [, method, path] of block.matchAll(
    /^\s+\* - (GET|POST|PUT|PATCH|DELETE)\s+`([^`?]+)/gm,
  ))
    // `/guilds/${guild.id}/...` appears once with a stray `$`.
    keys.add(`${method} ${path!.replace(/\$?\{[^}]+\}/g, ":")}`);
  const routes = [...keys].map((key) => {
    const [method, path] = key.split(" ") as [string, string];
    const segments = path.split("/");
    const pattern = segments
      .map((s) =>
        s === ":" ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      )
      .join("/");
    return {
      key,
      regex: new RegExp(`^${method} ${pattern}/?$`),
      literals: segments.filter((s) => s !== ":").length,
    };
  });
  return { version, routes };
}

function record(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "api-coverage-"));
  execFileSync(
    "npx",
    ["vitest", "run", "--config", join(here, "vitest.config.ts")],
    {
      stdio: "inherit",
      env: { ...process.env, API_COVERAGE_DIR: dir },
    },
  );
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean),
  );
}

const { version, routes } = apiRoutes();
const lines = record();

const restCovered = new Set<string>();
const outsideTypes = new Set<string>();
for (const line of lines.filter((l) => l.startsWith("rest "))) {
  const request = line.slice("rest ".length);
  // `/guilds/1/members/@me` matches both `members/@me` and `members/:`; the literal one is meant.
  const best = routes
    .filter((r) => r.regex.test(request))
    .sort((a, b) => b.literals - a.literals)[0];
  if (best) restCovered.add(best.key);
  else outsideTypes.add(request.replace(/\/\d{5,}/g, "/:"));
}
const events = new Set<string>(Object.values(GatewayDispatchEvents));
const gatewayCovered = new Set(
  lines
    .filter((l) => l.startsWith("gateway "))
    .map((l) => l.slice("gateway ".length)),
);

const unknownExclusions = Object.keys(notBotCallable).filter(
  (k) => !routes.some((r) => r.key === k),
);
if (unknownExclusions.length)
  throw new Error(
    `notBotCallable lists routes discord-api-types doesn't: ${unknownExclusions}`,
  );

const botCallable = routes.filter((r) => !(r.key in notBotCallable));
const result = {
  discordApiTypes: version,
  rest: {
    covered: botCallable.filter((r) => restCovered.has(r.key)).length,
    botCallable: botCallable.length,
    notBotCallable: routes.length - botCallable.length,
  },
  gateway: {
    covered: [...gatewayCovered].filter((e) => events.has(e)).length,
    total: events.size,
  },
  restCovered: [...restCovered].sort(),
  gatewayCovered: [...gatewayCovered].filter((e) => events.has(e)).sort(),
};

const missingRest = botCallable
  .filter((r) => !restCovered.has(r.key))
  .map((r) => r.key);
const missingGateway = [...events].filter((e) => !gatewayCovered.has(e));
console.log(
  `\nREST: ${result.rest.covered} of ${result.rest.botCallable} bot-callable routes` +
    ` (${result.rest.notBotCallable} more need a user or OAuth2 token, not counted)` +
    `\nGateway: ${result.gateway.covered} of ${result.gateway.total} events` +
    `\nAgainst discord-api-types ${version}.`,
);
console.log(
  `\nREST not covered (${missingRest.length}):\n  ${missingRest.sort().join("\n  ")}`,
);
console.log(
  `\nGateway not covered (${missingGateway.length}):\n  ${missingGateway.sort().join("\n  ")}`,
);
if (outsideTypes.size)
  console.log(
    `\nAnswered, but not in discord-api-types:\n  ${[...outsideTypes].sort().join("\n  ")}`,
  );

if (write) {
  writeFileSync(baselinePath, JSON.stringify(result, null, 2) + "\n");
  console.log(`\nWrote ${baselinePath}`);
} else {
  const baseline = JSON.parse(
    readFileSync(baselinePath, "utf8"),
  ) as typeof result;
  const lost = [
    ...baseline.restCovered.filter((k) => !restCovered.has(k)),
    ...baseline.gatewayCovered.filter((e) => !gatewayCovered.has(e)),
  ];
  const gained = [
    ...result.restCovered.filter((k) => !baseline.restCovered.includes(k)),
    ...result.gatewayCovered.filter(
      (e) => !baseline.gatewayCovered.includes(e),
    ),
  ];
  if (lost.length)
    console.error(`\nNo longer covered:\n  ${lost.join("\n  ")}`);
  if (gained.length)
    console.error(
      `\nNewly covered; run \`npm run coverage:api -- --write\`:\n  ${gained.join("\n  ")}`,
    );
  if (lost.length || gained.length || baseline.discordApiTypes !== version)
    process.exit(1);
}
