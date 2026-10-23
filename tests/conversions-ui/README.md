# Opt-in conversion browser acceptance

This harness tests the real saved funnel/goal APIs and synthetic PostgreSQL events in a production browser. It does not supply successful response DTOs, contact providers, crawl websites or start workers. The HTTP fault cases forward and commit the actual mutation before replacing its acknowledgement. Syntax checking is not browser acceptance; a run records its result in ignored `test-results/conversions-ui/acceptance.json` only after all assertions pass.

Use Node 24, installed application dependencies, an installed Chromium browser and Playwright module. Run sequentially from the repository root with a **fresh, separately provisioned and migrated** database. No script creates, resets or drops a database. Preserve failed fixture data instead of rerunning the same seed.

Provide an explicit ignored environment file, for example `.env.funnels-browser`, containing:

- Ordinary application configuration with fresh synthetic secrets, including `AUTH_SECRET`; never copy production credentials.
- `TEN98_INTEGRATION_TEST=1` and `TEN98_CONVERSIONS_BROWSER=1`.
- A loopback `DATABASE_URL` whose database is `ten98_funnels_` followed by lowercase letters, digits or underscores. Query parameters, fragments and `DATABASE_URL_FILE` are rejected, including PostgreSQL options that could override the hostname.
- Identical loopback `APP_URL` and `BASE_URL` origins, such as `http://localhost:3051`, with matching `HOST=127.0.0.1` and `PORT=3051`. Check the port is unused.
- `PLAYWRIGHT_MODULE`, an explicit importable module specifier or file URL for installed Playwright. There is no workstation-specific fallback. `PLAYWRIGHT_CHANNEL` defaults to `msedge`.
- `ARTIFACT_DIR=./test-results/conversions-ui/artifacts`; create that directory before starting the web process.

```sh
node --test tests/conversions-ui/guard.test.mjs
node --env-file=.env.funnels-browser --import=./tests/conversions-ui/preload.mjs tests/conversions-ui/fixture.mjs seed
node -e "require('node:fs').mkdirSync('test-results/conversions-ui/artifacts',{recursive:true})"
pnpm build
node --env-file=.env.funnels-browser --import=./tests/conversions-ui/preload.mjs .output/server/index.mjs
```

Keep the last process running. The preload is mandatory and blocks every server `fetch`; this slice needs no outbound HTTP. Do not start a worker or configure any external integration in the fixture. In another terminal:

```sh
node --env-file=.env.funnels-browser --import=./tests/conversions-ui/preload.mjs tests/conversions-ui/browser.mjs
node --env-file=.env.funnels-browser --import=./tests/conversions-ui/preload.mjs tests/conversions-ui/editor.mjs
```

The browser blocks requests outside the exact application origin. Direct loopback API requests and forwarded routes disable redirects. Seeded names, identities, credentials, events, screenshots and failure evidence stay in ignored `test-results/conversions-ui/`; do not publish that directory. The fixture is bound to its recorded database and application origin. A real membership change in the owned synthetic workspace tests permission loss; `finally` restores that membership without touching other users or workspaces.

Coverage includes create/edit/delete; exact 3/2/1 visitor chains, drop-offs and rates; cross-visit witness observations; a typed string property condition; page-view versus custom-event goals and their shared 3-visitor denominator; unidentified exclusion; immutable retries after an accepted 503 or malformed 2xx; blocked saving after a failed edit read; real optimistic revision conflict; current permission loss (404) and late success/401 during workspace changes; selected-heading and return-button focus; and desktop/360px table layout with keyboard scrolling. The independent backend suite covers the larger combinatorial matching, time-zone and retention matrix. Screenshot dimensions do not prove color contrast or complete accessibility conformance.

The separate editor runner reuses the existing fixture and never submits a definition. It blocks all browser writes, checks dirty Cancel dismissal and acceptance, keyboard add/reorder/remove with the 2–8 step bounds, raw property drafts through missing/type transitions, visible input labels and desktop/360px editor screenshots. It compares the saved list before and after and writes its own `editor-acceptance.json` only on success. It can be rerun against that fixture without reseeding.

Failures print a bounded stage label and write redacted details plus a synthetic screenshot under the ignored evidence directory. A failed run does not write a pass record. Inspect screenshots after the browser run. Stop the owned fixture web process afterwards; database cleanup remains a separate action after confirming ownership and active sessions.
