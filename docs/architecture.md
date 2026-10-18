# Architecture and reuse decisions

> Code and safety contracts retained from [docs/architecture.md at dcd1b3d](https://github.com/Ten98-IO-Company/ten98-monitor/blob/dcd1b3de5f7e0600c6b459e6b20f08b072106097/docs/architecture.md). Historical/planning checkpoints: [implementation archive](https://wiki.ten98.io/s/ten98-docs/p/architecture-and-reuse-decisions-implementation-history-GhVWcWPHsm). Qualifications are preserved; this adds no acceptance claim.

> **Conditional guardrails:** These proposal-derived excerpts preserve implementation, security and measurement constraints. They are not a catalogue of shipped APIs, adapters or services. Establish current support from the implementation and current operational runbooks.

## Source provenance guardrail

This is a new combined repository, not a GitHub fork relationship with three parents. During implementation, import only audited source with commit/path attribution. Preserve useful history through a provenance ledger; do not check private deployment files or research clones into the new repo.

## Provider route guardrail

Gateway routing is selected before a provider request, not an extra second model call. The [archived diagram](https://wiki.ten98.io/s/ten98-docs/p/architecture-and-reuse-decisions-implementation-history-GhVWcWPHsm) shows logical options; the provider contract must not accidentally send both direct and gateway requests.

## Tenant and integration boundaries

Native integration app registrations are instance-owned encrypted configuration; OAuth connections, selected assets and report jobs remain workspace-scoped and independently authorized. Reuse the existing credential/job services and small server-side setup drafts rather than a workflow engine. The [setup design](https://wiki.ten98.io/s/ten98-docs/p/onboarding-polbVhMXd2) specifies one-time bootstrap, idempotent secret initialization, draft OIDC tests, configuration-source precedence and connection state transitions. No central OAuth broker or Zernio service is required. Browser tag configuration and report authorization remain separate contracts.

All project-owned records carry workspace/project ownership. Cross-table foreign keys and uniqueness enforce valid ownership where possible. Request handlers, background jobs, MCP tools and exports call the same authorization/domain functions. Identifier obscurity is never access control. Paginate list/export APIs; validate limits and parameterize SQL.

## Boundary contracts

| Boundary | Required behavior |
|---|---|
| Public `script.js`, collection/record endpoints | Website key is public; bounded schema/body/time validation, spam/rate controls, DNT/exclusion settings, no dashboard-session requirement |
| Internal management API | Authenticated session or scoped machine token, tenant authorization, CSRF checks where cookie sessions apply, safe errors |
| Jobs | Immutable project/workspace ID + caller intent + idempotency key; execution revalidates permissions/configuration and spend; credentials resolved at dispatch |
| Provider request | Typed capability and surface, requested model and actual model, market, quote/reservation, task ID, response status, usage and evidence |
| Browser request | Server-created job only, allowed target, byte/page/time limits, egress controls including redirects/subresources, result artifact references |
| Reports/MCP/assistant | Same services as UI; report output untrusted; tool writes/costs require explicit intent and authorization; revoke shares independently |

## One-snippet tracking and domain aliases

[Tracking & destinations](tracking.md) extends the existing tracker with a centrally configured loader for official vendor scripts. Collection flows browser-to-vendor; PostgreSQL/pg-boss are used for configuration and read-only report imports, not a new advertising conversion proxy. Native analytics ingestion remains independent. Shared consent and duplicate-ownership checks happen before SDK loading/invocation, and a vendor outage cannot block page navigation.

Report credentials never enter the public loader configuration. Connect account/property permissions independently from pixel enablement. Native events, SDK diagnostics and imported aggregates stay distinct; imported snapshots must never become outgoing tracking events. Reuse the same Google connections/services for P58 and the new dashboard.

Domains have canonical/serving/redirect roles. HTTP-only aliases use configured edge/server observations or P44 redirect instrumentation; landing-page JavaScript cannot reconstruct every redirect. Preserve original host and target, independently scoped GSC properties and backlink overlap. No alias grouping creates automatic cross-domain identity. See P70–P81 for acceptance gates.

## Money and execution correctness

1. Prepare a quote using current provider prices, prompt/keyword count, engines, repeats, rendering and schedule frequency. Store quote source/time and upper-bound assumptions. Missing price blocks automatic paid execution.
2. In one database transaction lock the workspace row, check the manual pause and uncertain charges, record the quoted upper bound as the request's idempotent ledger reservation and enqueue the unique request.
3. Dispatch once with provider idempotency/task identity where supported. Scheduling leases and unique period keys prevent overlap after restart or DST changes.
4. Persist results and settlement with unique provider/request identifiers. Release only unused known reservation. Preserve failed-billable and uncertain charges.
5. Reconcile timeouts through provider task lookup before resubmission. If the provider cannot determine whether it charged, the row stays uncertain and blocks new paid work until reconciled. Bounded retries apply only to safely retryable failures.

The ledger covers only this app's dispatches, not activity from other clients sharing the provider account. Show balance age and available-vs-reserved estimates. There is no per-connection or workspace monetary limit in the app (owner decision D3) and nothing pauses automatically; provider-side budgets are the monetary caps, so configure them where available. When a provider unambiguously refuses a request for balance, credit or budget before doing any work, that request fails with a US$0.000000 receipt and the app keeps running; an ambiguous response stays uncertain ([refusal contract](foundation.md#account-api-key-and-provider-controls)). A quote does not guarantee a provider never changes pricing or charges outside it.

Start authorizes every child of a paid parent (owner decision D3): each child runs as its own zero-retry job with its own time limit, quote age is not rechecked after Start, a child may finish after its siblings and the parent's state is derived from its children; future agent sub-tasks follow the same rule. Prompt comparisons enqueue one job per uncached child at Start.

## Metric contract

- Store UTC instants; display/project schedules use a named IANA timezone. Document DST skips/repeats and comparison periods.
- Preserve upstream definitions for visitors, sessions, bounce, funnel windows, attribution, retention, revenue currency and performance percentiles before combining charts. No cross-currency sum without an explicit rate policy.
- AI visibility denominator includes successful eligible observations only; show success/sample coverage and skipped/failed results separately. No successful samples means unavailable, never 0%.
- Consumer UI answers, direct model APIs and dataset research remain separately labeled. A direct model answer is not evidence of what a consumer search UI showed.
- Persist raw answers/citations and actual provider/model/version/location. Query fan-out is shown only when the provider returns it.
- Version mention matching and metric formulas. Reuse source fixtures; maintain baseline-compatible results and explicitly compare any improved alias/domain disambiguation.
- Cross-module insights link evidence: search impressions/rank, observed visit, conversion. They must not claim causal attribution or identify an AI citation as a visit without supporting event evidence.

## Authentication, privacy and assistant security

Instance administrator powers are explicit and audited. Machine tokens have narrower scopes and expiry; public shares expose only selected report data and can expire/revoke.

OIDC uses issuer/subject, state, nonce, PKCE and verified callbacks, not email-only account linking. Role/group mapping cannot silently elevate users; deprovisioning invalidates sessions and tokens. Keep local recovery independent of external identity availability. Use a maintained auth library rather than invent password/session cryptography.

Replay is opt-in per site; block sensitive elements, mask inputs/text by default, sample and cap capture, and test redaction on realistic pages. Do not call all replay data anonymous. Retention, export and erasure apply to raw events, replays, evidence, reports, caches and recoverable backups under an operator policy.

Crawled pages, model answers and MCP results are untrusted content. Assistant instructions and tools cannot be overridden by a page. Separate read tools from writes and paid actions, preview requested changes/cost, require approved scope, and audit execution. Sanitize Markdown; render generated HTML reports in a sandboxed origin/frame with restrictive CSP. No secrets, arbitrary SQL, arbitrary shell or unrestricted network-fetch tools in the product assistant.

## Scaling and operational limits

Start with one PostgreSQL database, one worker and bounded concurrency. `ponytail:` PostgreSQL analytics and a single-host artifact volume are the initial ceiling; benchmark before adding ClickHouse or multi-host storage. No claim of unlimited analytics throughput.

Use indexes keyed by site/workspace/time, bounded batch inserts and retention jobs. Select partitioning/rollups only after the M2 workload shows the need. Protect ingestion from crawling with separate job concurrency, database pool and browser resource limits. Web requests do not run long audits or render browsers.

## Upstream maintenance

Maintain a reviewed patch ledger per imported upstream path/commit and track security fixes. Do not merge upstream main wholesale. Re-run affected parity fixtures before accepting updates. New upstream features enter through an explicit baseline change.
