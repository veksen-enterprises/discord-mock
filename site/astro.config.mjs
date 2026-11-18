import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import starlightTypeDoc, { typeDocSidebarGroup } from "starlight-typedoc";

export default defineConfig({
  integrations: [
    starlight({
      title: "discordjs-test-kit",
      expressiveCode: { defaultProps: { wrap: true } },
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/veksen-enterprises/discordjs-test-kit",
        },
      ],
      plugins: [
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
