/** BEFORE: the same test with hand-built fakes, the way sin-bot's command tests are written. */
import type { ChatInputCommandInteraction } from "discord.js";
import { expect, it, vi } from "vitest";
import { executeChallenge } from "./bot.js";

it("DMs the player you challenge", async () => {
  // Arrange
  const bob = { displayName: "Bob", send: vi.fn() };
  const interaction = {
    user: { displayName: "Alice" },
    options: { getUser: () => bob },
    reply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;

  // Act
  await executeChallenge(interaction);

  // Assert
  expect(interaction.reply).toHaveBeenCalledWith("Challenge sent to Bob.");
  expect(bob.send).toHaveBeenCalledWith("Alice challenged you.");
});
