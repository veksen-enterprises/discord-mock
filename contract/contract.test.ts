/**
 * Runs the same bot-triggerable scenarios against the mock and, when DISCORD_CONTRACT_TOKEN is
 * set, against the real test guild, then compares response statuses and shapes.
 *
 * A status or error-code difference always fails: the mock answered the bot differently,
 * and that's never accepted unreviewed. Shape differences can be accepted in baseline.json.
 * A new one fails the run; so does a baseline entry that no longer occurs, so the baseline
 * only shrinks. UPDATE_BASELINE=1 rewrites it from the current run's shape differences.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  firstDispatches,
  runScenarios,
  type Observation,
} from "./scenarios.js";
import { describe as describeDiff, diffShapes, shapeOf } from "./shape.js";
import { discordTarget, mockTarget, type Target } from "./targets.js";

const TOKEN = process.env.DISCORD_CONTRACT_TOKEN;
const GUILD = process.env.DISCORD_CONTRACT_GUILD ?? "1572343051337342976";
const BASELINE = new URL("./baseline.json", import.meta.url);
const REPORT = new URL("./report.json", import.meta.url);

const targets: Target[] = [];
afterAll(async () => {
  for (const t of targets) await t.close();
});

async function observe(target: Target) {
  targets.push(target);
  const responses = await runScenarios(target);
  return { responses, dispatches: firstDispatches(target) };
}

describe("scenarios against the mock", () => {
  it("run end to end, with no Gaps", async () => {
    const { responses } = await observe(await mockTarget());
    const statuses = Object.fromEntries(
      Object.entries(responses).map(([k, v]) => [k, v.status]),
    );
    expect(statuses).toEqual({
      gatewayBot: 200,
      usersMe: 200,
      unknownChannel: 404,
      createChannel: 201,
      sendMessage: 200,
      listMessages: 200,
      editMessage: 200,
      denySendMessages: 204,
      sendWithoutPermission: 403,
      deleteChannel: 200,
    });
    expect(responses.sendWithoutPermission!.body).toMatchObject({
      code: 50013,
    });
  });
});

describe.skipIf(!TOKEN)("mock against real Discord", () => {
  it(
    "agrees on statuses, error codes and shapes",
    { timeout: 60_000 },
    async () => {
      const discord = await observe(await discordTarget(TOKEN!, GUILD));
      const mock = await observe(await mockTarget());

      const differences: string[] = [];
      const statusDifferences: string[] = [];
      const compare = (
        section: string,
        a: Record<string, unknown>,
        b: Record<string, unknown>,
      ) => {
        for (const key of Object.keys(a).sort()) {
          if (!(key in b)) {
            differences.push(`${section}.${key}: Discord has it, mock doesn't`);
            continue;
          }
          for (const d of diffShapes(shapeOf(a[key]), shapeOf(b[key])))
            differences.push(`${section}.${key}.${describeDiff(d)}`);
        }
      };
      const statusOf = (r: Record<string, Observation>) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            {
              status: v.status,
              code: (v.body as { code?: number })?.code ?? null,
            },
          ]),
        );
      for (const [key, real] of Object.entries(statusOf(discord.responses))) {
        const ours = statusOf(mock.responses)[key];
        if (JSON.stringify(real) !== JSON.stringify(ours))
          statusDifferences.push(
            `status.${key}: Discord ${JSON.stringify(real)}, mock ${JSON.stringify(ours)}`,
          );
      }
      compare(
        "rest",
        Object.fromEntries(
          Object.entries(discord.responses).map(([k, v]) => [k, v.body]),
        ),
        Object.fromEntries(
          Object.entries(mock.responses).map(([k, v]) => [k, v.body]),
        ),
      );
      compare("gateway", discord.dispatches, mock.dispatches);

      writeFileSync(
        REPORT,
        JSON.stringify(
          { statusDifferences, differences, discord, mock },
          null,
          2,
        ),
      );
      // The report artifact holds everything; the log gets the summary so it's readable
      // without downloading.
      console.log(
        JSON.stringify(
          {
            statuses: {
              discord: statusOf(discord.responses),
              mock: statusOf(mock.responses),
            },
            discordDispatches: Object.keys(discord.dispatches),
            statusDifferences,
            differences,
          },
          null,
          2,
        ),
      );
      if (process.env.UPDATE_BASELINE)
        writeFileSync(BASELINE, JSON.stringify(differences, null, 2) + "\n");
      expect(statusDifferences).toEqual([]);
      if (process.env.UPDATE_BASELINE) return;
      const baseline: string[] = existsSync(BASELINE)
        ? JSON.parse(readFileSync(BASELINE, "utf8"))
        : [];
      expect({
        new: differences.filter((d) => !baseline.includes(d)),
        fixed: baseline.filter((d) => !differences.includes(d)),
      }).toEqual({ new: [], fixed: [] });
    },
  );
});
