/**
 * The hand-rolled fakes, as sin-bot has them in `src/test/discord-utils.ts` (trimmed). Kept here only
 * to show what the mock replaces.
 */
import type { ChatInputCommandInteraction } from "discord.js";
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

export function createMockChatInputCommandInteraction(
  options: { userId?: string; username?: string; displayName?: string } = {},
) {
  const { userId = "123456789", username = "TestUser", displayName } = options;
  return {
    user: { id: userId, username, displayName: username },
    member: displayName === undefined ? null : { displayName },
    guildId: "987654321",
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
}
