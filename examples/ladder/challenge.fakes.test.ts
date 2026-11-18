/** BEFORE: the style of sin-bot's `commands/challenge.spec.ts`. */
import { afterEach, expect, it, vi } from "vitest";
import { executePickOpponent, ladders, type Store } from "./bot.js";
import { createMockStringSelectMenuInteraction } from "./fakes.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("challenges another player from the menu", async () => {
  // Arrange
  const store: Store = new Map([
    [
      "Test Ladder",
      new Map([
        ["111", "Alice"],
        ["222", "Bob"],
      ]),
    ],
  ]);
  const updates = { name: "updates", isSendable: () => true, send: vi.fn() };
  const interaction = createMockStringSelectMenuInteraction({
    userId: "111",
    values: ["222"],
    channels: [updates],
  });
  vi.spyOn(ladders, "fromChannel").mockReturnValue(store.get("Test Ladder"));

  // Act
  await executePickOpponent(interaction, store);

  // Assert
  expect(interaction.update).toHaveBeenCalledWith({
    content: "Challenge sent to Bob.",
    components: [],
  });
  expect(interaction.client.users.send).toHaveBeenCalledWith(
    "222",
    "Alice challenged you. Play within 7 days.",
  );
  expect(updates.send).toHaveBeenCalledWith("Alice challenged Bob!");
});
