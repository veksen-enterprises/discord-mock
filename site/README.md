# discordjs-test-kit docs site

Astro + Starlight. Its own install, so nothing here reaches the kit's package.

```sh
npm ci            # in the repo root first: the API reference reads ../src with the kit's types
cd site && npm ci
npm run dev       # http://localhost:4321
npm run build     # static site in site/dist
```

- Code samples are tests in `../test/docs/`, rendered by `src/components/Sample.astro`.
- The testing guide page renders `../skills/discordjs-test-kit/SKILL.md`.
- The API reference is generated from `../src/index.ts` on every build (not committed).
- `SITE_URL` sets the absolute URLs in `llms.txt` and the sitemap. It defaults to localhost.

## Deploying to Cloudflare Pages

CI builds the site on every push and pull request. On `main`, after the kit's checks pass, it
uploads `site/dist` to the Pages project `discordjs-test-kit` with `wrangler pages deploy`. The
upload is skipped until the `SITE_URL` variable exists, so steps 1 to 3 can happen in any order.

1. Create the project once, as a direct-upload project (no Git connection):
   `npx wrangler pages project create discordjs-test-kit --production-branch=main`.
   Its address is `https://discordjs-test-kit.pages.dev` if that name is free; Wrangler prints the
   real one.
2. In Cloudflare, create an API token with **Account > Cloudflare Pages > Edit**. Add it and the
   account id as repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Add the repository variable `SITE_URL` with the address from step 1 (or the custom domain).
   The next push to `main` deploys.

To deploy by hand instead: `SITE_URL=https://… npm run build`, then
`npx wrangler pages deploy dist --project-name=discordjs-test-kit --branch=main`.
