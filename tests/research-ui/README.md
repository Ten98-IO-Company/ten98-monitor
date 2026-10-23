# Opt-in Research UI acceptance

These production-browser scripts exercise real application routes, PostgreSQL receipts and explicit job handlers. Provider responses and audit network responses are synthetic. They never call a paid provider or public website. They are not part of the default unit suite. GPT ran the keyword core/lifecycle, prompt core/lifecycle and audit groups against the reviewed production build on 2026-10-13 and inspected desktop/360px screenshots; see the [acceptance record](https://wiki.ten98.io/s/ten98-docs/p/research-ui-QI3jrak1kA). A syntax check alone is not a browser pass, and a later build needs its own relevant acceptance.

Use Node 24, installed application dependencies, an installed Playwright module/browser, and one newly provisioned, migrated, otherwise empty PostgreSQL database. Run from the repository root, sequentially. Do not run a background worker against this database. Each runner consumes its named fixture once; preserve a failed fixture for diagnosis instead of resetting it.

Supply an explicit, ignored environment file (called `.env.research-ui-test` in the commands below) containing:

- The ordinary application configuration, with fresh synthetic `AUTH_SECRET`, `CREDENTIAL_KEYS` and active key ID; no production credentials.
- `TEN98_INTEGRATION_TEST=1` and `TEN98_RESEARCH_BROWSER=1`.
- `DATABASE_URL` pointing to loopback PostgreSQL, with a database named `ten98_research_ui_` followed by lowercase letters, digits or underscores. Query parameters and fragments are rejected because PostgreSQL connection options can override the URL hostname. Provisioning, migration and later cleanup are the operator's separate actions; these scripts do none of them.
- Equal `APP_URL` and `BASE_URL` loopback origins, for example `http://localhost:3049`, plus corresponding `HOST=127.0.0.1` and `PORT=3049`. Verify the port is unused first.
- `PLAYWRIGHT_MODULE`: the installed Playwright package's importable module specifier or file URL. There is no machine-specific fallback. `PLAYWRIGHT_CHANNEL` defaults to `msedge`; set it to another installed Chromium channel if required.
- `ARTIFACT_DIR=./test-results/research-ui/artifacts`.

All generated passwords, receipts, screenshots and failure details stay under ignored `test-results/research-ui/`. Do not publish that directory. The seed refuses an existing manifest or nonempty database. No script discovers private configuration, drops databases, deletes prior evidence or changes production rate limits. Create the configured artifact directory before starting the web process; readiness requires it to exist and be writable.

```sh
node --env-file=.env.research-ui-test tests/research-ui/fixtures.mjs seed
node -e "require('node:fs').mkdirSync('test-results/research-ui/artifacts',{recursive:true})"
pnpm build
node --env-file=.env.research-ui-test --import=./tests/research-ui/preload.mjs .output/server/index.mjs
```

Keep that web process running. The preload is mandatory: it blocks every unrecognized fetch and refuses paid dispatch from the web process. In another terminal with the same repository and explicit environment file, run:

```sh
node --env-file=.env.research-ui-test tests/research-ui/keyword-browser.mjs
node --env-file=.env.research-ui-test tests/research-ui/keyword-lifecycle-browser.mjs
node --env-file=.env.research-ui-test tests/research-ui/prompt-browser.mjs
node --env-file=.env.research-ui-test tests/research-ui/audit-browser.mjs
```

For a corrected rerun of the keyword core alone, supply a new lowercase/hyphen fixture label, for example `node --env-file=.env.research-ui-test tests/research-ui/keyword-browser.mjs core-recheck`. This creates a separate synthetic actor/workspace and preserves the failed fixture. A reused label is rejected.

If the prompt core already passed, rerun only its lifecycle groups using `node --env-file=.env.research-ui-test tests/research-ui/prompt-browser.mjs --lifecycle-only recheck`. The required new suffix (1–20 lowercase letters/hyphens, beginning with a letter) creates distinct actors for acknowledgement recovery, cancellation, access recovery, reconciliation and empty-answer checks. It does not rerun or claim the skipped core checks, and never resets the prior fixtures. Keyword and prompt start/replay endpoints both return 202; audit start returns 202 for a new receipt and 200 for a replay.

To rerun the full audit checks without resetting a prior audit fixture, use `node --env-file=.env.research-ui-test tests/research-ui/audit-browser.mjs recheck`. The new suffix creates a separate actor/workspace, canonical project, serving-domain proof and redirect-alias proof through the same synthetic DNS helpers used by the seed; lifecycle actors receive the same suffix. The guard has a pure check requiring no database, configuration file or browser: `node --test tests/research-ui/guard.test.mjs`.

The runners invoke only their owned synthetic jobs and acknowledge the actual queue records after each handler returns. Audit jobs additionally replace native DNS/HTTP boundaries with exact-origin responses. Browser requests outside the application origin are blocked. Lost acknowledgements are created only after the real POST commits; retries must preserve the complete request body and produce one receipt.

Coverage includes exact costs and absent-versus-zero metrics; explicit paid intent; committed response loss, malformed nested keyword results and expired-quote retries; held reads interrupted by cancellation; stale responses across real project navigation; current permission loss; raw evidence expiry; immutable prompt versions; plain text and safe citation rendering; selected-result focus; and desktop/360px layout with keyboard-scrollable tables. Screenshot bounds do not establish contrast compliance. Inspect the saved screenshots as part of acceptance.

Failures print a bounded stage label. The stack, current synthetic DOM and screenshot are saved under `test-results/research-ui/research-evidence/`, with known fixture/configuration secrets redacted from text. Stop the fixture web process after the checks; retain evidence and perform any database cleanup separately after confirming ownership and no live sessions.
