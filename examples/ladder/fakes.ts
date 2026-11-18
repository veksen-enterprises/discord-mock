/**
 * The hand-rolled fakes, as sin-bot has them in `src/test/discord-utils.ts` (trimmed). Kept here only
 * to show what the mock replaces.
 */
import type { StringSelectMenuInteraction } from "discord.js";
import { vi } from "vitest";

// Runs for every test file that imports this module: discord.js's builders become stubs.
vi.mock("discord.js", async () => ({
  ...(await vi.importActual("discord.js")),
  ButtonBuilder: vi.fn().mockImplementation(() => ({
    setCustomId: vi.fn().mockReturnThis(),
    setLabel: vi.fn().mockReturnThis(),
    setStyle: vi.fn().mockReturnThis(),
  })),
}));

/** A pick from a select menu, with the channel lookup and the DM send stubbed. */
export function createMockStringSelectMenuInteraction(options: {
  userId: string;
  values: string[];
  channels: { name: string; isSendable(): boolean; send: unknown }[];
}) {
  return {
    user: { id: options.userId },
    values: options.values,
    channel: null,
    guild: { channels: { cache: options.channels } },
    client: { users: { send: vi.fn().mockResolvedValue(undefined) } },
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as StringSelectMenuInteraction;
}
