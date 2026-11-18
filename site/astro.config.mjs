import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

export default defineConfig({
  // Absolute URLs in llms.txt and the sitemap. The deploy sets SITE_URL to the public address.
  site: process.env.SITE_URL || "http://localhost:4321",
  integrations: [
    starlight({
      title: "discordjs-test-kit",
      description:
        "A fake Discord that a stock discord.js bot logs in to, so a test runs the bot as it ships.",
      expressiveCode: { defaultProps: { wrap: true } },
      logo: { src: "./src/assets/mark.svg" },
      customCss: [
        "@fontsource-variable/archivo/wdth.css",
        "@fontsource-variable/jetbrains-mono",
        "./src/styles/custom.css",
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/veksen-enterprises/discordjs-test-kit",
        },
      ],
      plugins: [
        // llms.txt for agents reading the docs on the web: guides first, the API reference last,
        // and llms-small.txt without the reference.
        starlightLlmsTxt({
          promote: [
            "index",
            "quickstart",
            "concepts/the-world",
            "concepts/members",
            "concepts/waiting",
            "concepts/gaps",
            "recipes/**",
            "testing-guide",
          ],
          demote: ["api/**"],
          exclude: ["api/**"],
          // Collapsing whitespace runs the testing guide's heading into its first paragraph.
          minify: { whitespace: false },
        }),
        // The reference is generated from the kit's public API on every build, so it can't drift.
        starlightTypeDoc({
          entryPoints: ["../src/index.ts"],
          tsconfig: "../tsconfig.build.json",
          sidebar: { label: "API reference", collapsed: true },
          typeDoc: {
            sourceLinkTemplate:
              "https://github.com/veksen-enterprises/discordjs-test-kit/blob/{gitRevision}/{path}#L{line}",
          },
        }),
      ],
      sidebar: [
        { label: "Quickstart", slug: "quickstart" },
        {
          label: "Concepts",
          items: [{ autogenerate: { directory: "concepts" } }],
        },
        {
          label: "Recipes",
          items: [{ autogenerate: { directory: "recipes" } }],
        },
        { label: "Testing guide", slug: "testing-guide" },
        typeDocSidebarGroup,
      ],
    }),
  ],
  // Pages pull their code samples from ../test/docs, outside the site's root.
  vite: { server: { fs: { allow: [".."] } } },
});
