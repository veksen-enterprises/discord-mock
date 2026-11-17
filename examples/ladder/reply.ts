import type { ChatInputCommandInteraction } from "discord.js";

/** Answers a deferred interaction with a coloured embed, like sin-bot's `utils/reply`. */
export function reply(interaction: ChatInputCommandInteraction) {
  const send = (color: number) => (r: { title: string; description: string }) =>
    interaction.editReply({
      embeds: [{ title: r.title, description: r.description, color }],
    });
  return { withSuccess: send(0x00ff00), withError: send(0xff0000) };
}
