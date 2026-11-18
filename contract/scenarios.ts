import type { Target } from "./targets.js";

export interface Observation {
  status: number;
  body: unknown;
}

const SEND_MESSAGES = 1n << 11n;

/**
 * Bot-triggerable requests, run in order against one Target. Each step is something a bot
 * does; user actions (slash commands, button presses) can't be triggered from a bot, so they
 * stay out of the contract.
 */
export async function runScenarios(
  target: Target,
): Promise<Record<string, Observation>> {
  const call = async (method: string, path: string, body?: unknown) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${target.api}${path}`, {
        method,
        headers: {
          authorization: `Bot ${target.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const parsed = text ? JSON.parse(text) : null;
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) =>
          setTimeout(r, (parsed.retry_after ?? 1) * 1000),
        );
        continue;
      }
      return { status: res.status, body: parsed };
    }
  };

  const out: Record<string, Observation> = {};
  out.gatewayBot = await call("GET", "/gateway/bot");
  out.usersMe = await call("GET", "/users/@me");
  out.unknownChannel = await call("GET", "/channels/1000000000000000000");

  out.createChannel = await call("POST", `/guilds/${target.guildId}/channels`, {
    name: `contract-${Date.now()}`,
    type: 0,
  });
  const channelId = (out.createChannel.body as { id?: string })?.id;
  if (!channelId) return out;

  try {
    out.sendMessage = await call("POST", `/channels/${channelId}/messages`, {
      content: "contract test",
    });
    const messageId = (out.sendMessage.body as { id?: string })?.id;
    out.listMessages = await call(
      "GET",
      `/channels/${channelId}/messages?limit=10`,
    );
    if (messageId) {
      // The test bot isn't invited with CREATE_PUBLIC_THREADS, so this checks the inferred
      // permission behind Start Thread from Message.
      out.startThreadWithoutPermission = await call(
        "POST",
        `/channels/${channelId}/messages/${messageId}/threads`,
        { name: "contract thread" },
      );
      out.editMessage = await call(
        "PATCH",
        `/channels/${channelId}/messages/${messageId}`,
        { content: "contract test, edited" },
      );
    }
    out.denySendMessages = await call(
      "PUT",
      `/channels/${channelId}/permissions/${target.botId}`,
      { type: 1, allow: "0", deny: String(SEND_MESSAGES) },
    );
    out.sendWithoutPermission = await call(
      "POST",
      `/channels/${channelId}/messages`,
      { content: "should be refused" },
    );
  } finally {
    out.deleteChannel = await call("DELETE", `/channels/${channelId}`);
  }
  // Let the gateway deliver the dispatches the steps above caused.
  await new Promise((r) => setTimeout(r, 1_000));
  return out;
}

/** The first dispatch of each type, for shape comparison. */
export function firstDispatches(target: Target): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { t, d } of target.dispatches) if (!(t in out)) out[t] = d;
  return out;
}
