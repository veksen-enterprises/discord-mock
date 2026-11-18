import { ComponentType, MessageFlags } from "discord-api-types/v10";
import type { RestResponse } from "./rest.js";

// Discord's length and count limits on a message body: create, edit, interaction callback, followup.
// Limits: discord-api-docs resources/message (Create Message params, "Embed Limits": inclusive,
// whitespace trimmed, 6000 combined) and components/reference (5 rows, 5 buttons or one select per
// row, custom_id 1-100, button label 80, select options 25). docs.discord.food/resources/message gives
// the same maxima. Discord answers 400 + 50035; the per-field `errors` codes and messages aren't
// documented, so the ones below are inferred, not checked.

type Problem = { path: (string | number)[]; message: string };

export function messageLimitError(body: unknown): RestResponse | undefined {
  return limitError(messageProblems(body as MessageBody | undefined));
}

// interactions/receiving-and-responding#interaction-response-object-modal: title max 45 characters,
// custom_id 1-100, "Between 1 and 5 (inclusive) components". discord.js's ModalBuilder doesn't check
// the 5, so a bot can send 6. The field codes are inferred, as above.
export function modalLimitError(body: unknown): RestResponse | undefined {
  const modal = (body ?? {}) as {
    title?: unknown;
    custom_id?: unknown;
    components?: unknown[];
  };
  const problems: Problem[] = [];
  if (typeof modal.title === "string" && modal.title.length > 45)
    problems.push({
      path: ["title"],
      message: "Must be 45 or fewer in length.",
    });
  if (typeof modal.custom_id === "string" && modal.custom_id.length > 100)
    problems.push({
      path: ["custom_id"],
      message: "Must be 100 or fewer in length.",
    });
  if ((modal.components?.length ?? 0) > 5)
    problems.push({
      path: ["components"],
      message: "Must be 5 or fewer in length.",
    });
  return limitError(problems);
}

// receiving-and-responding#interaction-response-object-autocomplete: "max of 25 choices". A choice's
// name and value are 1-100 characters (application-commands#application-command-option-choice-structure).
export function choicesLimitError(body: unknown): RestResponse | undefined {
  const choices =
    ((body ?? {}) as { choices?: { name?: unknown; value?: unknown }[] })
      .choices ?? [];
  const problems: Problem[] = [];
  if (choices.length > 25)
    problems.push({
      path: ["choices"],
      message: "Must be 25 or fewer in length.",
    });
  choices.forEach((choice, i) => {
    if (typeof choice.name === "string" && choice.name.length > 100)
      problems.push({
        path: ["choices", i, "name"],
        message: "Must be 100 or fewer in length.",
      });
    if (typeof choice.value === "string" && choice.value.length > 100)
      problems.push({
        path: ["choices", i, "value"],
        message: "Must be 100 or fewer in length.",
      });
  });
  return limitError(problems);
}

function limitError(problems: Problem[]): RestResponse | undefined {
  if (problems.length === 0) return undefined;
  const errors: Record<string, unknown> = {};
  for (const { path, message } of problems) {
    let node = errors;
    for (const key of path) node = (node[String(key)] ??= {}) as typeof node;
    ((node._errors ??= []) as unknown[]).push({
      code: "BASE_TYPE_MAX_LENGTH",
      message,
    });
  }
  return {
    status: 400,
    body: { message: "Invalid Form Body", code: 50035, errors },
  };
}

interface MessageBody {
  content?: string | null;
  flags?: number;
  embeds?: Embed[] | null;
  components?: Component[] | null;
}
interface Embed {
  title?: string;
  description?: string;
  fields?: { name?: string; value?: string }[];
  footer?: { text?: string };
  author?: { name?: string };
}
interface Component {
  type: number;
  custom_id?: string;
  label?: string;
  options?: unknown[];
  components?: Component[];
}

function messageProblems(body: MessageBody | undefined): Problem[] {
  if (!body || typeof body !== "object") return [];
  const problems: Problem[] = [];
  const tooLong = (path: Problem["path"], text: unknown, max: number) => {
    if (typeof text === "string" && text.trim().length > max)
      problems.push({ path, message: `Must be ${max} or fewer in length.` });
  };

  tooLong(["content"], body.content, 2000);

  const embeds = body.embeds ?? [];
  if (embeds.length > 10)
    problems.push({
      path: ["embeds"],
      message: "Must be 10 or fewer in length.",
    });
  let total = 0;
  const count = (text: unknown) =>
    typeof text === "string" ? text.trim().length : 0;
  embeds.forEach((embed, i) => {
    tooLong(["embeds", i, "title"], embed.title, 256);
    tooLong(["embeds", i, "description"], embed.description, 4096);
    tooLong(["embeds", i, "footer", "text"], embed.footer?.text, 2048);
    tooLong(["embeds", i, "author", "name"], embed.author?.name, 256);
    const fields = embed.fields ?? [];
    if (fields.length > 25)
      problems.push({
        path: ["embeds", i, "fields"],
        message: "Must be 25 or fewer in length.",
      });
    fields.forEach((field, j) => {
      tooLong(["embeds", i, "fields", j, "name"], field.name, 256);
      tooLong(["embeds", i, "fields", j, "value"], field.value, 1024);
      total += count(field.name) + count(field.value);
    });
    total +=
      count(embed.title) +
      count(embed.description) +
      count(embed.footer?.text) +
      count(embed.author?.name);
  });
  if (total > 6000)
    problems.push({
      path: ["embeds"],
      message: "Embed size exceeds maximum size of 6000",
    });

  // Components V2 messages have their own limits (40 components, 4000 characters of text), not modelled.
  if (((body.flags ?? 0) & MessageFlags.IsComponentsV2) === 0) {
    const rows = body.components ?? [];
    if (rows.length > 5)
      problems.push({
        path: ["components"],
        message: "Must be 5 or fewer in length.",
      });
    rows.forEach((row, i) => {
      const children = row.components ?? [];
      if (children.length > 5)
        problems.push({
          path: ["components", i, "components"],
          message: "Must be 5 or fewer in length.",
        });
      children.forEach((child, j) => {
        const path = ["components", i, "components", j];
        tooLong([...path, "custom_id"], child.custom_id, 100);
        if (child.type === ComponentType.Button)
          tooLong([...path, "label"], child.label, 80);
        if ((child.options?.length ?? 0) > 25)
          problems.push({
            path: [...path, "options"],
            message: "Must be 25 or fewer in length.",
          });
      });
    });
  }
  return problems;
}
