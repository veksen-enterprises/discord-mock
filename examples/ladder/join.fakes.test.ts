/** BEFORE: the style of sin-bot's `commands/join.spec.ts`. */
import { afterEach, expect, it, vi } from "vitest";
import { executeJoin, ladders, type Store } from "./bot.js";
import { createMockChatInputCommandInteraction } from "./fakes.js";
import * as replyModule from "./reply.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("should add the member to the ladder", async () => {
  const store: Store = new Map([["Test Ladder", new Map()]]);
  const interaction = createMockChatInputCommandInteraction({
    displayName: "Bravo",
  });
  vi.spyOn(ladders, "fromChannel").mockReturnValue(store.get("Test Ladder"));
  vi.spyOn(replyModule, "reply").mockReturnValue({
    withSuccess: vi.fn(),
    withError: vi.fn(),
  });

  await executeJoin(interaction, store);

  expect(interaction.deferReply).toHaveBeenCalled();
  expect(store.get("Test Ladder")?.get("123456789")).toBe("Bravo");
  expect(replyModule.reply(interaction).withSuccess).toHaveBeenCalledWith({
    title: "Joined the Ladder!",
    description: "You have successfully joined the ladder. Good luck!",
  });
});
