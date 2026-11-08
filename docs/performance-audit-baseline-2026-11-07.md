# SAWARI Fleet Control Performance Audit Baseline

**Measurement date:** 2026-11-07  
**Scope:** Frontend route loading, API behavior, Mongo query behavior, dashboard
data paths, RBAC, and realtime refresh. This is a baseline report; no
performance-related application code or database records were changed for this
audit.

## Executive summary

There is no single measured cause for every slow page. The evidence points to
three different layers:

1. **Route shell/navigation:** A prior local Chrome sample showed authorized
   SPA transitions completing in 1.24–1.36 seconds, with one document
   navigation and no permission request added during those transitions.
   Initial client rendering was considerably slower: FCP 4.72 seconds and LCP
   9.87 seconds in that sample.
2. **Cash and UPI data:** Both clients request a visible page and a separate
   exact summary concurrently. A 3,652-document local Mongo dataset produced
   low single-digit to low double-digit Mongo execution times for representative
   query plans, while summary endpoint observations were 113 ms (cash) and
   141 ms (UPI). The dataset is small and not production-representative.
3. **All Bookings data:** A prior local browser sample measured one
   `/dashboard/payments/booking` request at 13.96 seconds. Its page heading and
   filters appeared in about 1.36 seconds, before the data request completed.
   This is the clearest captured data-fetch bottleneck in the available browser
   evidence.

The requested **≤2-second targets are not established**. Most requested
browser metrics could not be collected because the available Chrome page was
not shared with the integrated browser, and Chrome UI inspection was
interrupted while the user was interacting with that window. No attempt was
made to bypass the interruption.

## Measurement environment and evidence

The report combines three distinct data sources. Do not compare them as if
they were one benchmark:

1. **Prior in-session local Chrome Performance API sample** on the local app,
   using an existing signed-in browser session. It included navigation timing,
   paint timing, resource entries, route transition observations, and one
   All Bookings API request. It was not a controlled cold/warm run and had no
   recorded CPU, heap, React Profiler, or payload-transfer profile.
2. **Read-only local Mongo explain and endpoint observations** against the
   existing locally configured database. The dataset had 3,652 payment-history
   documents; representative unscoped filters matched 780 cash rows and 3,648
   UPI rows. Company scoping was disabled in that local configuration. No
   records were written.
3. **Existing synthetic in-memory-Mongo baseline** documented in
   [payment-verification-performance-baseline.md](./payment-verification-performance-baseline.md).
   It seeded 3,000 synthetic documents and measured the legacy combined
   endpoint response, not the current split `section=page`/`section=summary`
   client request path.

During this audit, unauthenticated local HTTP probes returned the UPI page
HTML with a 143 ms time-to-first-byte and 14,032 bytes, the Pending to Collect
page probe timed out at 8 seconds, and unauthenticated API probes returned
401 in approximately 7–11 ms. These are route-availability checks, not
authenticated page or API performance results.

## Browser and API observations

| Surface / operation | API calls and request observations | Browser / UI time | Interpretation |
|---|---|---|---|
| Initial local authenticated app load | The earlier resource trace included `/auth/login` (2.22 s) and `/auth/permissions/me` (204 ms); exact session/request attribution is uncertain. | Navigation `responseEnd` 2.75 s; DOMContentLoaded 4.57 s; `load` 8.54 s; FCP 4.72 s; LCP 9.87 s. | Initial render exceeded the desired shell and usable-list targets. No trace separated network, hydration, and rendering costs. |
| Authorized SPA navigation | In two measured transitions, the permission-request count did not increase and `PerformanceNavigationTiming` remained at one document navigation. | All Bookings to Revenue: 1.24 s to heading. Revenue to All Bookings: 1.36 s to heading. | Navigation was client-side; these observations do not establish the ≤500 ms target. |
| Pending to Collect (cash) | The client normally issues one page request plus one separate summary request for a filter change. Page and summary calls are in flight-deduplicated independently. The earlier Chrome resource buffer contained 10 cash-page and 10 cash-summary requests over a long, roughly 22-minute tab lifetime; this is not a per-navigation count. | No controlled first-usable-list timing was captured. | Exact totals remain separate from page data, preserving totals beyond the visible page. |
| UPI Verification | The client normally issues one page request plus one summary request for a filter change. Search uses a 300 ms debounce. | No reliable authenticated browser timing was captured for this audit. | Filter interaction latency, paint time, and tab-specific request counts are unknown. |
| All Bookings | One observed `/dashboard/payments/booking` request took 13.96 s. The response eventually represented 1,440 payments/bookings. | Heading and filters appeared in about 1.36 s; data loaded later. | API/data response, not the initial page shell, dominated this observation. It is one local sample, not a p95. |
| Revenue | Route navigation appeared in the local browser sample above. | No isolated page-data waterfall or render profile. | Its date/grouping calculations and data volumes need a controlled browser trace. |
| Fleet Dashboard | Source uses prioritized dashboard requests and company-scoped local cache; no isolated current browser sample. | Unknown. | Periodic refresh and later full-history loading are present; their real production impact is unmeasured. |
| Payments History | Source has a 30-second per-user/query in-memory cache and page prefetch; no isolated browser sample. | Unknown. | Cache hit rates, transfer volume, and render costs are unmeasured. |
| Reports & Analytics | No implemented route is registered; navigation marks it as coming soon with no href. | Not applicable. | There is no page to profile. |

### Resource-buffer caveats

- The earlier resource buffer recorded 27 `/auth/permissions/me` requests over
  about 22 minutes. Subsequent requests were generally near the provider's
  45-second background revalidation interval; they were not attributed to
  ordinary route transitions.
- Resource entries showed `transferSize: 0`; therefore browser transfer sizes
  cannot be inferred from those entries. This may reflect cross-origin timing
  restrictions or unavailable transfer-size data.
- Cumulative resource-buffer counts include the tab's lifetime and are not
  request counts for an individual page visit.

## MongoDB query baseline

The following plans and timings came from read-only observations against the
locally configured database. Execution time is Mongo's reported query
execution, while count latency is a separate endpoint/query observation; they
are not interchangeable.

| Query | Plan and work | Mongo execution | Endpoint/count latency |
|---|---|---:|---:|
| Cash page, `pending`, payment date | Existing index scan with OR; 781 keys and 880 documents examined; 780 returned. | 11 ms | Not separately recorded for this page query. |
| Cash summary, same filters | Existing index scan with OR; 781 keys and 880 documents examined; 780 returned. | 5 ms | 113 ms. |
| UPI page, `pending`, created date | Collection scan and sort; 3,652 documents examined; 3,648 returned. | 10 ms | Not separately recorded for this page query. |
| UPI summary, same filters | Collection scan; 3,652 documents examined; 3,648 returned. | 3 ms | 141 ms. |

The UPI filter matched nearly the entire local dataset, and company scoping was
disabled. The result does not establish how the query behaves with a
representative, much larger production dataset or selective date/company
filters. These plans do not justify adding an index without further measured
query plans.

The existing synthetic baseline reported the following **different, legacy
combined-endpoint** measurements:

| Synthetic operation | Data read / returned | Endpoint wall time | Cumulative Mongo wall time | Response JSON |
|---|---:|---:|---:|---:|
| UPI default combined view | 3,000 matching documents / 25 rows | 451.84 ms | 242.91 ms over 3 operations | 53,507 bytes |
| Cash default combined view | 1,500 matching documents / 25 rows | 104.93 ms | 49.08 ms over 3 operations | 32,465 bytes |

Those synthetic tests are useful as a repeatable small-data check, but are not
current split-section endpoint timings, production data, or p95 results.

## Code-path audit

### Frontend

- **Cash Collections:** [client](../../my-sawari-Frontend/app/pending-to-collect/_PendingToCollectClient.jsx)
  sends independent `section=page` and `section=summary` requests via
  `acquireSharedRequest`. Tab/date/filter state is URL-backed; search is
  session-scoped and debounced 300 ms. The displayed rows are page-bounded;
  exact summary values are fetched separately.
- **UPI Verification:** [client](../../my-sawari-Frontend/app/verify-upi-collections/_VerifyUpiClient.jsx)
  uses the same page/summary split, request deduplication, URL-backed filters,
  and 300 ms search debounce. It retains full-filter summary values across
  pagination and refreshes on payment-topic events.
- **All Bookings:** [client](../../my-sawari-Frontend/app/AllBookings/_AllBookingsClient.jsx)
  server-filters and server-paginates, with shared in-flight requests and
  URL/session filter state. It supports `All`, which can return a large dataset,
  and renders returned rows directly rather than virtualizing the table.
- **Payments History:** [client](../../my-sawari-Frontend/app/paymentshistory/_PaymentsHistoryClient.jsx)
  uses a per-user/query in-memory cache with a 30-second freshness window,
  stale-while-revalidate, shared requests, and next-page prefetch.
- **Revenue:** [RevenueDashboard](../../my-sawari-Frontend/app/features/revenue/RevenueDashboard.jsx)
  loads vehicles, payments, bookings, and maintenance in parallel. Revenue
  filters operate over normalized client data and memoized report calculations;
  the data-volume/render cost was not profiled.
- **Fleet Dashboard:** [client](../../my-sawari-Frontend/app/_DashboardClient.jsx)
  prioritizes live/visible-range data, uses company-scoped local cached data and
  shared requests, then loads full history when idle. Fallback polling remains
  when realtime is unavailable.
- **Reports & Analytics:** The permission/navigation registry has no
  implemented route; it is marked coming soon.
- **Navigation and permissions:** [FleetSidebar](../../my-sawari-Frontend/components/FleetSidebar.jsx)
  selectively prefetches dashboard and All Bookings only.
  [AuthGate](../../my-sawari-Frontend/components/AuthGate.jsx) initializes the
  session; [PermissionGate](../../my-sawari-Frontend/components/PermissionGate.jsx)
  reads the shared access context. [AuthPermissionsProvider](../../my-sawari-Frontend/components/AuthPermissionsProvider.jsx)
  deduplicates permission loads and revalidates in the background. Normal
  authorized route changes reuse the in-memory session profile.
- **API and realtime:** [API service](../../my-sawari-Frontend/services/api.js)
  uses Axios; another fetch wrapper exists at
  [lib/api.js](../../my-sawari-Frontend/lib/api.js). The shared
  [Socket.IO service](../../my-sawari-Frontend/services/realtime.js) publishes
  topic invalidations, after which relevant pages refetch HTTP data.

### Backend

- **UPI:** [controller](../src/controllers/upiVerification.controller.js)
  calls [`readUpiView`](../src/services/upiVerification.service.js). The
  current page section streams a cursor and can stop after enough matching
  rows for created-date ordering. For other date bases, date filtering and
  sorting can require scanning candidates in Node. The summary-only path
  streams matching records and retains exact metric accumulators rather than
  payment rows; the legacy combined path still materializes its full result.
- **Cash:** [`readCashCollectionView`](../src/controllers/paymentHistory.controller.js)
  streams the full matching set for summary-only requests and retains metric
  and date-group accumulators rather than payment rows. The page path uses a
  Mongo aggregation cursor with computed effective dates and a computed-date
  sort; search/status checks still run in application code. A 25-row page
  therefore does not necessarily mean only 25 Mongo candidates are processed.
- **Dashboard:** [controller](../src/controllers/dashboard.controller.js)
  processes overlapping bookings and vehicle data for stats. Booking revenue
  runs multiple concurrent aggregation facets, including all-time company
  summaries. These paths can scale with company history and are not covered by
  the cash/UPI explain sample.
- **Schemas and indexes:** Payment indexes are declared in
  [paymentHistory.model.js](../src/models/paymentHistory.model.js), and booking
  indexes in [booking.model.js](../src/models/booking.model.js). Mongo
  connection sets `autoIndex: false` in [db.js](../src/config/db.js), so schema
  declarations alone do not prove which indexes are installed in each
  environment.
- **Auth and RBAC:** Protected API routes resolve the active user and check
  permissions. Permission resolution is memoized within a request for
  non-super-admin paths, not as a cross-request Redis cache. Do not bypass these
  checks for performance.
- **Caching and Redis:** The response cache is a process-local map and is
  enabled only when the change stream is active, for selected dashboard
  reads. Cash/UPI routes are not response-cache wrapped; UPI sends `no-store`.
  No Redis integration or Redis client was found.
- **Realtime:** The Socket.IO change feed emits debounced company/topic change
  notifications rather than payment records. Pages refetch their relevant
  HTTP endpoints. This keeps payloads scoped but means relevant changes incur
  new page and summary requests.
- **Instrumentation:** Express request logging includes request duration;
  `X-Dashboard-Cache` reports selected response-cache outcomes. There is no
  general Mongo query-duration hook or endpoint-level JSON serialization
  measurement in the inspected code.

## Requested metrics: collection status

| Metric | Baseline status |
|---|---|
| API request count | Partially measured: earlier browser resource-buffer counts are cumulative across a long-lived tab; per-interaction page/summary request shape is established from source. |
| API response time | Partially measured: one All Bookings request (13.96 s), synthetic legacy endpoint timings, and local Cash/UPI summary observations. No representative authenticated production p95. |
| Mongo query execution time | Measured for four local Cash/UPI plans; not measured for Dashboard, Revenue, All Bookings, or production. |
| Documents examined vs. returned | Measured for local Cash/UPI plans only. |
| Response payload size | Measured only for the old synthetic combined endpoints. Live browser resource entries had zero transfer-size values. |
| JSON serialization time | Not instrumented. |
| Frontend JSON parse time | Not instrumented. |
| React rendering time | No React Profiler capture. |
| Filter execution time | No browser interaction trace; only debounce intervals and source-level flow are known. |
| Total time until usable UI | Partially measured for one app load and two route headings; first usable payment row not timed consistently. |
| Main-thread blocking | No Chrome Performance trace or Long Task profile collected. |
| Memory usage | Not collected; no browser heap snapshot. |
| Duplicate API calls | Partially measured: one permission request on ordinary tested route transitions; long-lived resource-buffer counts are not attributable per interaction. |
| Network waterfall | Not captured for the requested pages. |
| Cold vs. warm performance | Not measured under controlled cache/server/database conditions. |

## Existing validation evidence

Previously run focused tests reported 51 passing Cash/UPI frontend tests and
41 passing Cash/UPI backend tests. They cover filters, pagination, complete
financial summaries, permission-gated actions, stale responses, refresh, and
realtime behavior. Functional tests do not establish production latency,
memory, or render performance.

## Conclusions and next measurements required

1. The All Bookings data endpoint is the largest directly observed latency
   (13.96 seconds); capture its Mongo execution plan, response bytes, and server
   breakdown with representative authorized data.
2. Cash and UPI exact summaries intentionally process full matching sets.
   The observed local plans are fast at 3,652 documents, but production-scale
   and selective company/date query plans are required before query/index
   changes.
3. The UPI plan used a collection scan for a created-date page and summary in
   the local sample. Since that sample's filter matched 3,648 of 3,652 records,
   it does not quantify the benefit of an index.
4. Initial FCP/LCP exceed targets in the prior sample, but no network waterfall
   or React trace identifies whether the dominant cause is bundle evaluation,
   server response, hydration, or page data.
5. To complete the requested baseline, repeat each page in a controlled
   production-like environment with Chrome DevTools Network/Performance and
   React Profiler, server request/serialization timers, and Mongo
   `explain("executionStats")`. Capture cold and warm runs, a representative
   data distribution, browser version/device/CPU throttling, cache state, and
   p50/p95. Record payload sizes without retaining customer/payment fields.

No Redis, index, cache, or business-logic change is justified by this baseline
alone.

## Phase 2 UPI page-query follow-up

The Cash and UPI clients already use separate `section=page` and
`section=summary` requests; they do not download all payment rows and then
filter them in React. The exact summary request intentionally processes the
complete matching set so financial totals and status/method facets remain
authoritative.

The UPI page path now applies IST Created Date ranges and Today/Yesterday
boundaries in Mongo, and payment-date pages are sorted by the same effective
date basis used by the row normalizer. The cursor stops after the requested
page plus one matching row for those date bases. The payment-date prefilter is
a safe superset over `customPaymentDate` and `paymentDate`; existing
normalization still decides precedence and final inclusion. A row without
optional payment date/time remains available in unfiltered pages, and
Created Date continues to use `createdAt`. Collected Date keeps its existing
derived-audit filtering and sorting because pushing that derived status/date
logic into Mongo without equivalent validation could change which receipts
qualify.

These are query-path changes, not a measured latency claim. No new
production-like before/after timing is available; exact-summary processing,
the derived Collected Date path, and production-scale database behavior remain
measurement follow-ups. The focused backend suites passed after the change:
42 UPI tests and 18 Cash tests.

## Phase 3 server-side pagination

The `section=page` handlers for Cash and UPI now return an exact matching
record count and page count, clamp out-of-range page requests to the last
page, and return only that selected page for sizes 25, 50, and 100. Existing
`total`, `pageSize`, `hasMore`/`hasNext`, and `from`/`to` fields remain; the
pagination object also provides `totalRecords`, `hasNextPage`, and
`hasPreviousPage`. Results keep deterministic selected-date ordering with
payment ID as a tie-breaker. Cash, and UPI Created/Payment Date pages, count
through the cursor while retaining only the requested page and a bounded tail
needed for out-of-range correction. UPI Collected Date must retain matching
rows for the existing derived audit-date ordering before selecting a page.

The existing **All** option still returns every match and does not silently
truncate data. Its date groups now start collapsed so React renders row
components only when a group is expanded, and only one All-mode group can be
expanded at a time. This defers and bounds row DOM rendering but does not
reduce the All response payload or client-side data memory. Very large All
requests therefore remain a known payload/memory limitation; incremental
fetching or true list virtualization remains future work if production-sized
All views prove too large. No such threshold has been measured here.

The page-number UI already resets to page 1 on tab, method, date, date-type,
search, and page-size changes; existing URL state preserves filters while
moving between pages. Added regressions cover exact totals, page 2, stable
non-overlapping rows, and out-of-range clamping for both Cash and UPI.

## Phase 4 MongoDB query and index audit

### Measurement scope

Read-only `explain("executionStats")` calls were run against the configured
**remote development** database, with `autoIndex:false`. No index was created,
dropped, hinted, or otherwise changed, and the explain output contained only
plans and counters (no payment/customer documents). At measurement time the
collections contained 3,657 payment-history documents and 2,361 bookings.
These results are useful for identifying query shapes, not production
latency/SLO claims. PAYMENTS_SCOPE_BY_COMPANY was false, so company-scoped
plans were not measured.

### Observed query plans

| Query shape | Winning plan / work | Finding |
|---|---|---|
| UPI Created Date page, last 30 days, receipt `type` set, sort by `createdAt` then `_id`, limit 26 | `IXSCAN` on `createdAt_-1` plus blocking `SORT`; 1,499 keys/docs examined, 26 returned, 4 ms. | Existing single-field index helps the date range, but does not satisfy the stable `_id` tie-break sort. Exact record counting still requires examining all matching candidates. |
| UPI Payment Date range over `customPaymentDate` or `paymentDate`, receipt `type` set | `COLLSCAN`; 3,657 docs examined, 26 returned, 5 ms. | The physical collection does not have the schema-declared `paymentDate_-1` or `customPaymentDate_-1` indexes. The effective-date sort is also computed with custom-date precedence, so a plain field index cannot satisfy that sort. |
| UPI full summary across receipt types | `COLLSCAN`; 3,657 docs examined, 3,654 returned, 5 ms. | This selection includes almost the entire collection; a type index is unlikely to reduce the work materially. The exact summary must still evaluate mixed allocations and audit state. |
| Cash summary, cash or mixed-cash method branch | `OR` with `IXSCAN`; 781 keys, 880 docs examined, 780 returned, 7 ms. | Existing method indexes are used. Derived cash amount/status and exact totals still require application logic. |
| Cash Created Date page with method branch, date range, stable sort | `OR`/`IXSCAN` with a blocking `SORT`; representative run examined 249 keys and 292 docs, returned 26, 12 ms. | The present method/date indexes prune candidates but do not cover the complete stable sort. |
| Cash Payment Date filter with legacy fallback precedence | `OR`/`IXSCAN` using `paymentMethod_1_createdAt_-1`; 781 keys, 880 docs examined, 250 returned, 9 ms. | Created-date index is used for the fallback branch; the payment-date indexes declared by the schema are absent from this database. |
| Revenue payment lookup: 78 active vehicle snapshots plus 1,931 linked payment IDs, recent `createdAt` range | `IXSCAN` on `createdAt_-1`; 1,499 keys/docs examined, 1,498 returned, 5 ms. | No full booking scan is involved; recent payments are fetched with a projection and filtered against active vehicle references. |
| Revenue booking lookup by active vehicle IDs and trip-date overlap | `OR`/`IXSCAN`; 2,907 keys, 805 docs examined, 708 returned, 14 ms. | Existing vehicle/date indexes are used. This is not a full collection scan, though examined-key work is larger than result count. |
| Latest payment snapshot per booking (`bookingId` match, `createdAt` descending, first per booking) | `IXSCAN` with blocking `SORT`; the sampled single-booking explain examined 2 keys/docs and returned one group. | Add a compound index candidate to support this real lookup; validate it with a multi-booking explain after deployment. |

### Query/schema review and changes

- Cash and UPI page queries use projections/cursors and `.lean()` or aggregation;
  creators are loaded in one `$in` query for the selected page, not one query
  per payment. Payment History reporting uses a row projection and `.lean()`;
  Mongoose population is limited to the selected page. No repeated per-row
  relationship fetch was found in the inspected payment-list paths.
- `loadRevenuePayments` and `loadRevenueBookings` restrict by date/active
  vehicle references. Revenue payment snapshots are aggregated by
  `bookingId`; the explain identifies a sort opportunity, not an N+1 query.
- `collectionStatus`, `verificationStatus`, and top-level `verifiedAt` are not
  fields in the payment schema. Cash completion is partly derived from
  `isCollected`, `collectedAmount`, and the cash portion of mixed payments.
  UPI verification is derived from `collectionHistory` entries, including
  channel, actor, and timestamp. I did not add indexes on nonexistent status
  fields or change this accounting logic.
- Cash/UPI substring filtering is performed after fetching candidate documents.
  General payment history uses escaped, case-insensitive, unanchored regexes
  across customer/vehicle snapshot fields. Ordinary B-tree indexes do not
  efficiently serve those semantics. Replacing them with prefix, text, or
  Atlas Search would change matching behavior; that needs a separately
  specified search contract and representative benchmarks.
- The payment schema now declares `{ createdAt: -1, _id: -1 }` for stable
  created-date sorts and `{ bookingId: 1, createdAt: -1 }` for latest-payment
  snapshots. The single-field `bookingId` schema index was removed because it
  is a prefix of the compound index. Existing `paymentDate` and
  `customPaymentDate` single-field schema indexes were already declared, but
  are absent from the inspected deployment. Database connections disable
  `autoIndex`; changing a schema declaration alone does not deploy indexes.

### Index deployment instructions (manual, not applied)

Use the staging database first, then the intended production database during
a low-traffic window. Confirm the database name and collection before running
DDL. The application connects with `autoIndex:false`, so index changes must be
deployed explicitly. Inspect current indexes with
`db.paymenthistories.getIndexes()` and create only missing keys:

```javascript
db.paymenthistories.createIndex(
  { createdAt: -1, _id: -1 },
  { name: "createdAt_-1__id_-1" }
);
db.paymenthistories.createIndex(
  { bookingId: 1, createdAt: -1 },
  { name: "bookingId_1_createdAt_-1" }
);
db.paymenthistories.createIndex(
  { paymentDate: -1 },
  { name: "paymentDate_-1" }
);
db.paymenthistories.createIndex(
  { customPaymentDate: -1 },
  { name: "customPaymentDate_-1" }
);
```

These are schema/query-backed candidates, not a command to apply them without
review. After building on staging, rerun the measured queries with
`explain("executionStats")`; confirm `IXSCAN`, whether `SORT` remains, and
keys/docs examined versus returned. Also measure index size and write latency.
The date indexes should reduce selective date-range candidate reads if the
planner can use the `$or` branches; they cannot eliminate the computed
effective-date sort. The compound booking index should be tested with the
actual multi-booking aggregation. Do not remove existing prefix indexes
(`createdAt_-1` or `bookingId_1`) until staging confirms the compound
replacements cover their other workload uses and production plans. If a
candidate does not improve the target plan, do not deploy it or remove it
blindly.

If PAYMENTS_SCOPE_BY_COMPANY is enabled, do not assume these unscoped indexes
are optimal. Capture company-scoped plans and test company-leading candidates
(for example `{ company: 1, createdAt: -1, _id: -1 }`) in staging before
deployment. No company index was added based on the unscoped evidence.

## Phase 5 full-dataset summary aggregation

Cash and UPI `section=summary` requests now stream the complete MongoDB
candidate set and maintain exact running totals rather than materializing all
matching payment rows. UPI keeps the existing selected summary, method totals,
status counts/amounts, and reconciliation warning count. Cash keeps the
selected summary, pending/completed and Today/Yesterday metrics, collected
today/total values, partial-collection count, and complete date-wise groups.
Both continue to apply the existing scope, filters, mixed-payment portions,
and paise-level rounding; page data remains independently paginated.

The endpoints still inspect every candidate required by application-level
date precedence, search, and derived audit/status rules. Streaming reduces
summary-path retained row memory and redundant array passes; it does not claim
to reduce MongoDB documents examined or establish a production latency target.
Cash and UPI regressions compare summary-only results with the complete view,
including global totals beyond a 25-row page.

## Phase 6 Redis caching evaluation

### Existing infrastructure

No Redis client dependency, connection setup, Redis environment variable, or
Redis cache implementation was found in the backend source, package manifest,
or `.env.example`. The application does have a bounded process-local dashboard
response/value cache in
[`responseCache.js`](../src/realtime/responseCache.js). It is active only
while the MongoDB change stream is healthy, shares concurrent identical
requests, expires entries, and clears cached data on change-feed invalidation.
Dashboard routes key cached values by authenticated user ID plus request URL.
Cash and UPI summary endpoints are not wrapped by this cache and return
`Cache-Control: no-store`.

### Benefit assessment

The available development explain samples reported about 5 ms for the broad
UPI summary scan and about 7 ms for the cash summary query at roughly 3,657
payment-history documents. These are database execution samples, not
production endpoint p95 or evidence of repeated-request frequency. Recent
summary-path tests confirm exact filtered totals but run against a test
database and are not production benchmarks. Production-scale concurrency,
cache-hit ratio, request p50/p95, and end-to-end page timings remain
unmeasured.

The Phase 5 summary paths now stream and accumulate exact metrics without
retaining full payment rows. They still inspect the candidate records needed
for legacy date precedence, mixed allocations, search, audit-derived
verification/collection status, and exact counts. Indexing and measuring
selective tenant/date queries should be evaluated before adding another cache
layer; client request deduplication already shares in-flight reads. Caching
large payment lists is not justified.

**Decision: do not add or deploy Redis now.** The current evidence does not
show that cache lookup would materially improve payment summary latency over
the observed query cost, and it does not quantify a repeated-hit workload.
Redis would add connection, deployment, invalidation, stampede, monitoring,
and outage-fallback responsibilities. The existing change-stream-backed
process cache is appropriate for the dashboard routes already using it, but
its broad invalidation behavior and process-local storage are not a basis for
silently caching payment summaries.

Reconsider Redis only after collecting production-like per-endpoint request
p50/p95, Mongo execution time and documents examined, exact-summary
repetition/hit opportunity, and the effect of proposed indexes. If those
measurements show material repeated summary cost, prototype a short-lived,
tenant/scope/filter-complete cache with mutation invalidation and an
uncached-Mongo fallback, then compare hit/miss latency and financial parity
under writes and Redis failure before deployment. No Redis package, service,
or cache behavior was added in this phase.

## Phase 12 backend response optimization

The Cash page query now selects only card, date, and cash-audit fields; its
paginated aggregation also projects those fields before returning rows. Cash
audit entries sent to clients omit collector IDs and unrelated adjustment
metadata. UPI read queries omit unused company/version fields from their
database result; the version field remains selected for verification writes'
optimistic concurrency check and is not included in the response. The
Payments History controller already uses a bounded page and an explicit row
projection.

Express response compression was already enabled before API routes, and the
backend opens one reusable Mongoose connection at startup with the driver's
default connection-pool settings. Neither needed a code change. Normal Cash
and UPI page requests remain page-bounded; the explicit `All` option retains
its existing all-record semantics.

The response-field changes are covered by the Cash and UPI API regression
suites (42 tests passed). Exact serialized-byte and JSON serialization
before/after measurements were not collected, and no production dataset or
network profile was available; response-size improvement is therefore
structural, not a quantified latency claim.

## Phase 13 deployment and hosting audit

| Area | Repository evidence | Finding / limitation |
|---|---|---|
| Backend target | Frontend revenue API defaults to `https://my-sawari.onrender.com/api/v1/dashboard`; other source comments use the same Render API hostname. | Production API is configured to target Render in these paths. No Render service manifest or provider-console configuration is present, so the active service plan, region, health, and instance count are unconfirmed. |
| Backend runtime | `src/server.js` starts `node src/server.js`, binds an HTTP server, starts Socket.IO and a MongoDB change stream, and closes both on process signals. | This is a persistent Node server design, not a serverless-function entry point. Whether the deployed plan sleeps, scales to zero, or keeps an instance warm cannot be established from source. |
| Frontend host | The frontend is a Next.js 16 app with `next build` / `next start`, an empty Next config, and generic README deployment guidance. Local `.env` uses localhost for its API. | Actual production frontend host and region are not established. The README’s Vercel suggestion is template text, not deployment evidence. |
| MongoDB | Backend connects once during startup through Mongoose using `MONGO_URI` with `autoIndex: false`. The local backend environment contains an Atlas SRV URI. | This confirms the local environment is configured for MongoDB Atlas, not which cluster/region the deployed backend uses. The Atlas SRV hostname does not identify the database region. |
| Backend-to-database latency | No production command monitoring, ping metric, trace, or hosting telemetry is available in this repository. | Cannot determine production network RTT or query latency from local configuration or source. Existing local explain samples are not a production network measurement. |
| CPU / memory / cold starts | No deployment resource limits, instance sizing, cold-start telemetry, or production request traces are checked in. | Unknown. A single local request or an unauthenticated probe would not establish cold-start behavior or CPU/memory constraints. |
| Connection reuse | Mongoose connects once at process startup and reuses its default driver pool; no custom pool limits are set. | Connection reuse is configured within each running process. Pooling is not shared across instances. |
| Cache / Redis | No Redis client or Redis configuration is present. `src/realtime/responseCache.js` holds bounded `Map` stores and in-flight work in process memory, and only enables them while that process's Mongo change stream is active. | Dashboard cache entries and deduplication are instance-local and volatile; they are not shared across serverless invocations or backend instances. Payment endpoints are not made Redis-dependent. |
| Deployment manifests | No Docker, Render, Vercel, or other hosting manifest was found in either app root. | Repository configuration alone cannot confirm deployed service topology or frontend/backend region distance. |

### Infrastructure recommendation

Do not add Redis or another paid service based on this evidence. First read
the deployed provider settings and collect per-request backend duration,
Mongo command duration, Mongo connection wait time, process CPU/memory, and
instance-start timestamps for authenticated payment-list requests. Compare
first request after an idle period with warm requests. Confirm the Atlas
cluster region and provider regions from their consoles rather than inferring
them from a client-side URI.

If measurements show an actual sleep/cold-start penalty, the smallest
targeted change is to use an always-on backend instance (or the provider's
minimum-one-instance setting) and keep it in the same region as Atlas. If
Mongo command time is low but command-to-response time is high, investigate
backend CPU/serialization and frontend-to-backend distance before adding
infrastructure. Redis is only warranted if measured repeated expensive
queries justify a shared managed cache and its invalidation/operations cost.

The hosting console, production database region, network RTT, server plan,
cold-start behavior, CPU/memory limits, and production frontend region remain
unverified; none can be safely reported as measured by this repository audit.

## Phase 14 other heavy-page audit and targeted changes

| Surface | Audit result |
|---|---|
| All Bookings | Client uses server-side pagination, request deduplication/cancellation, and URL/session filter state. The explicit `All` export/view remains unbounded by design. Backend calculates booking ledgers and exact summaries across the filtered set, so a small page does not guarantee proportionally small database work. The previous 13.96 s local request sample has not been re-measured after prior changes. No financial or ledger logic was changed here. |
| Payments History | Normal requests are paginated, explicitly projected, cached per user/query for 30 seconds, and prefetch the next page. Full-filter export requests additional pages only when export is explicitly selected. No safe additional change was justified without new measurements. |
| Revenue | The page intentionally loads its four source datasets in parallel and recomputes date filters locally. Its maintenance calculation needs only vehicle ID, start/end dates, and status. Revenue now calls the existing `/dashboard/maintenance/timeline` endpoint, which returns only those fields and uses the change-stream-backed response cache. This replaces the full maintenance endpoint, which populated complete vehicle and employee records. Payment and booking calculation semantics were left unchanged. |
| Fleet Dashboard | Existing client prioritizes timeline/visible-range data, uses per-user cached data and shared requests, and falls back to full history only when needed. The dashboard already uses the compact maintenance timeline endpoint. No new refresh behavior was added. |
| Reports & Analytics | No page is implemented; the permission registry marks it “coming soon.” |
| Customers | No frontend page is implemented; the permission registry marks it “coming soon.” A legacy backend endpoint still scans all handovers and returns one record per customer, including identity/contact fields. It is not referenced by a current frontend route; avoid expanding its use without first adding pagination and a minimal response contract. |
| Maintenance & Service | No frontend page is implemented; the registry marks it “coming soon.” The fleet maintenance list endpoint has pagination in its response but currently fetches/populates and filters the full matching collection before slicing in memory; no current frontend consumer was found. The dashboard and Revenue use the compact timeline endpoint instead. |
| QR Codes | The current list endpoint returns a projected page (default 48, maximum 200), but also computes status counts and batch options on every list request. Change-stream invalidation does not currently track QR documents, so reusing the generic process cache would risk stale counts. QR image generation is limited to the visible page. Unconditional list logging is now disabled by default and can be enabled with `NEXT_PUBLIC_DEBUG_QR_LIST=true`. |
| Roles & Permissions | Settings requests employee rows and role policies only for Super Admin; the employee query is business-scoped and projected, and role policies are projected. There is no evidence that these lists are a current dominant bottleneck. Access rules and management behavior were not changed. |

Validation for this phase: the maintenance timeline endpoint regression test
passed, confirming the compact response shape used by Revenue and the
dashboard; all five maintenance timeline frontend regressions passed; and the
frontend production build succeeded. No production-like page timings or
before/after payload bytes were collected, so no numerical performance gain
is claimed.

## Phase 15 regression verification

| Test group | Result |
|---|---|
| Cash and UPI API regressions | 42 passed. Covers server-side filters, IST date handling, full-set summaries, pagination, mixed payment allocation, missing optional metadata, reconciliation warnings, company scoping, and mutation guards. |
| Cash/UPI UI, shared requests, and sidebar/navigation | 103 passed. Covers filter and pagination behavior, stale responses, incremental All mode, session-bound caches, route access, and navigation lifecycle. |
| Socket.IO and permission invalidation | 20 passed. Covers company isolation, mutation signals, event sequencing/coalescing, reconnect behavior, and permission refresh behavior. |
| RBAC regression | Passed after updating the QR self-claim assertion to the existing `410 Gone` behavior; public QR self-registration is intentionally disabled. |
| Payment-report company-access integration test | Not verifiable against the running application: its report URLs are not mounted. The application mounts `src/routes/paymentHistory.js`, which has no report handlers; the report handlers in `src/routes/paymentHistory.routes.js` are not mounted and no current frontend consumer references them. Endpoint assertions therefore receive 404 rather than testing tenant access. No route was mounted solely to make this stale test pass. |

These are regression results, not a production-scale load or multi-user
performance benchmark. Production deployment latency, large-dataset behavior,
and measured end-user timing targets remain unverified.

## Phase 16 synthetic API load test

**Measurement date:** 2026-11-08.

The repeatable runner is `npm run load:payments`, implemented in
`scripts/load-test-payments.mjs`. It starts a private in-memory MongoDB
instance, inserts synthetic payment/customer/vehicle snapshots, creates
50 synthetic Super Admin identities, and exercises the existing Cash and UPI
page and summary APIs. It does not read or connect to `.env` database settings,
write to a shared staging/production system, or mutate payment records. Each
virtual client sends a page and summary request concurrently. The script caps
the dataset at 100,000, concurrency at 50, samples at 50, and each tier at two
minutes; `PAYMENT_LOAD_SIZES`, `PAYMENT_LOAD_CONCURRENCY`,
`PAYMENT_LOAD_SAMPLES`, and `PAYMENT_LOAD_MAX_TIER_MS` can narrow or tune a
local run.

The default command is limited to 1,000 records / 1 client and 10,000 records /
10 clients. Larger tiers require explicitly setting the environment values;
this avoids accidentally repeating the resource-intensive run by default.

### Completed measurements

| Dataset / virtual clients | Endpoint / section | Samples | p50 ms | p95 ms | p99 ms* | HTTP errors |
|---|---|---:|---:|---:|---:|---:|
| 1,000 / 1 | Cash page | 25 | 73.8 | 100.9 | 405.2 | 0% |
| 1,000 / 1 | Cash summary | 25 | 72.5 | 99.9 | 387.4 | 0% |
| 1,000 / 1 | UPI page | 25 | 153.9 | 350.8 | 454.6 | 0% |
| 1,000 / 1 | UPI summary | 25 | 184.8 | 364.3 | 491.5 | 0% |
| 1,000 / 25 | Cash page | 25 | 6,854.4 | 6,920.1 | 7,832.8 | 0% |
| 1,000 / 25 | Cash summary | 25 | 6,642.1 | 6,683.9 | 6,689.9 | 0% |
| 1,000 / 25 | UPI page | 25 | 5,379.2 | 8,826.8 | 10,690.4 | 0% |
| 1,000 / 25 | UPI summary | 25 | 5,390.8 | 8,836.6 | 10,707.7 | 0% |
| 1,000 / 50 | Cash page | 25 | 10,841.5 | 10,863.2 | 10,863.8 | 0% |
| 1,000 / 50 | Cash summary | 25 | 10,613.7 | 10,639.0 | 10,807.2 | 0% |
| 1,000 / 50 | UPI page | 25 | 10,933.8 | 10,960.4 | 11,008.0 | 0% |
| 1,000 / 50 | UPI summary | 25 | 10,994.7 | 11,029.8 | 11,032.3 | 0% |
| 10,000 / 10 | Cash page | 25 | 5,907.9 | 9,248.4 | 9,263.2 | 0% |
| 10,000 / 10 | Cash summary | 25 | 9,378.1 | 10,892.0 | 11,035.9 | 0% |
| 10,000 / 10 | UPI page | 25 | 4,413.0 | 9,317.8 | 9,428.5 | 0% |
| 10,000 / 10 | UPI summary | 25 | 18,375.3 | 30,832.4 | 31,185.3 | 0% |
| 50,000 / 1 | Cash page | 10 | 1,924.6 | 3,477.0 | 3,477.0 | 0% |
| 50,000 / 1 | Cash summary | 10 | 2,346.3 | 4,382.0 | 4,382.0 | 0% |
| 50,000 / 1 | UPI page | 10 | 4,459.0 | 5,129.2 | 5,129.2 | 0% |
| 50,000 / 1 | UPI summary | 10 | 7,282.9 | 7,944.9 | 7,944.9 | 0% |
| 100,000 / 1 | Cash page | 9 | 3,906.4 | 4,967.8 | 4,967.8 | 0% of completed requests |
| 100,000 / 1 | Cash summary | 9 | 4,805.9 | 5,656.7 | 5,656.7 | 0% of completed requests |
| 100,000 / 1 | UPI page | 9 | 10,479.8 | 17,544.6 | 17,544.6 | 0% of completed requests |
| 100,000 / 1 | UPI summary | 9 | 15,495.0 | 23,994.3 | 23,994.3 | 0% of completed requests |

The 1,000/1, 1,000/25, 1,000/50, and 10,000/10 tiers each completed all 100
requests (25 per endpoint/section) on the final standalone in-memory runner.
The 50,000/1 tier completed all 40 requests (10 per endpoint/section) on the
earlier in-memory replica-set runner. The 100,000/1 tier reached its
three-minute request-launch limit after 36 of 40 requests on that replica-set
runner; all completed requests returned HTTP 200. Its four distributions
therefore have nine samples each and are incomplete.

### Concurrency and resource limits

| Scenario | Outcome |
|---|---|
| 50,000 / 25 | Did not finish within the two-minute request-launch window. 72 calls settled before teardown; 36 returned HTTP 200 and remaining in-flight requests errored during cleanup. Observed successful latencies were approximately 74–109 seconds and Node RSS peaked at 1.77 GB. The tier was incomplete and its partial percentiles are not reported as representative. |
| 100,000 / 50 | Not run. The lower 50,000/25 tier exceeded the local time and memory budget, so escalating the synthetic in-memory workload would not be a responsible local test. |

For completed tiers, measured Node RSS peaks were 263.1 MB (1,000/1),
434.5 MB (1,000/25), 447.5 MB (1,000/50), 464.0 MB (10,000/10),
742.2 MB (50,000/1), and 728.5 MB (100,000/1). Mongo command-monitor
durations summed to 76.6 ms, 1,693.0 ms, 2,524.3 ms, 7,052.9 ms, 2,642.4 ms,
and 5,755.1 ms per HTTP request respectively; the sum includes authentication
and other database commands and concurrent command time. These are driver
command round-trip durations (network plus server time), not isolated Mongo
`executionStats`. The separate in-memory `mongod` RSS was not measured.

The first attempted concurrency run was discarded because all virtual clients
shared one IP and triggered the app's normal rate limiter. The runner now
assigns distinct synthetic private test IPs per virtual client; application
rate limits were not changed. The 50,000/25 and 50,000/1 / 100,000/1 runs
used the replica-set harness, while the final repeatable runner uses a
standalone in-memory MongoDB server; do not compare these local figures as
production benchmarks.

The payment endpoints set `Cache-Control: no-store` and do not use the shared
dashboard response cache, so backend cache-hit rate is not applicable. The
test exercises API response arrival only; browser interactions, client-cache
hit rate, render time, and time to first usable UI data were not measured.
With 9–25 observations per endpoint, p99 is the observed maximum and is not a
statistically reliable tail-latency estimate. These results identify a clear
latency/resource concern as data size and concurrency grow; they are not a
production capacity claim.

## Phase 17 before/after performance report

The table below distinguishes recorded legacy observations from current load
test measurements. The legacy baseline used a 3,000-document in-memory
replica-set test and combined endpoint; the current default uses a standalone
in-memory MongoDB server, split page/summary endpoints, and separate
dataset/concurrency tiers. They are **not like-for-like**, so no percentage
change or speedup is inferred. “Not measured” is intentional; the available
evidence does not contain authenticated browser interaction timings for
individual filters.

| Metric | Before | After | Target | Comparison |
|---|---|---|---|---|
| UPI initial load | 451.84 ms API response for legacy combined UPI view at 3,000 synthetic documents; not browser first-usable time. | Not measured as one page-load event. At 1,000 / 1, the current `tab=all` page API p50/p95 was 153.9/350.8 ms and summary API p50/p95 was 184.8/364.3 ms. At 10,000 / 10 these were 4,413/9,317.8 ms and 18,375.3/30,832.4 ms respectively. | ≤2 s | Not comparable; 10k concurrent API calls exceed target. UI first usable row remains unmeasured. |
| Cash initial load | 104.93 ms API response for legacy `tab=today` at 1,500 synthetic documents; not browser first-usable time. | No like-for-like `tab=today` load measured. For current `tab=all`, 1,000 / 1 page and summary API p50/p95 were 73.8/100.9 ms and 72.5/99.9 ms; at 10,000 / 10 they were 5,907.9/9,248.4 ms and 9,378.1/10,892 ms. | ≤2 s | Not comparable; the 10k concurrent API calls exceed target. |
| Today filter | Not measured separately. | Not measured separately. | ≤2 s | No interaction-timing evidence. |
| Yesterday filter | Not measured separately. | Not measured separately. | ≤2 s | No interaction-timing evidence. |
| Pending filter | Not measured separately. | Not measured separately. | ≤2 s | No interaction-timing evidence. |
| Completed filter | Not measured separately. | Not measured separately. | ≤2 s | No interaction-timing evidence. |
| All filter | Legacy UPI API: 451.84 ms at 3,000 documents; legacy Cash result was for Today, not All. | Current `tab=all`: values and concurrency tiers are reported in the Phase 16 table above; 10k / 10 p95 ranged from 9.25 s (Cash page) to 30.83 s (UPI summary). | ≤2 s | Incomplete comparison; higher-load tiers miss target. |
| Date filter | Not measured separately. | Not measured separately. | ≤2 s | No interaction-timing evidence. |
| Search | Not measured as elapsed time. | Not measured as elapsed time. | ≤2 s | Tests verify search results/debounce, not latency. |
| Pagination | Not measured as elapsed time. | Not measured as elapsed time. | ≤1 s | Tests verify page contents and counts, not latency. |

### What the changes demonstrably improved

- **Bounded page materialization:** Cash/UPI page handlers retain the requested
  page (and bounded state needed for exact page counts/correction) rather than
  materializing every matching row for the response. This reduces returned
  list size and page-path retained rows by design; no paired memory or
  same-dataset before/after measurement quantifies the reduction.
- **Summary memory behavior:** Summary-only handlers stream candidates into
  accumulators instead of retaining full payment rows. This preserves totals
  across the full filtered set, but the latest load results show that full-set
  scanning remains expensive under larger data/concurrency.
- **Faster usable page versus waiting for totals:** The client requests page
  and summary sections separately and can display cards while totals load.
  The load runner measured API responses, not first-card paint, so the UX
  improvement is structurally supported but not timed here.
- **Other structural changes:** Shared permission initialization/deduplication,
  session-scoped client caching, targeted socket invalidation, and Revenue's
  compact maintenance timeline avoid repeated or excess work in their
  respective paths. Available checks are functional; no controlled before /
  after timing or cache-hit-rate measurement establishes their speedup.

### Remaining bottleneck and conclusion

The current page query still walks candidates to establish exact counts and
apply derived status/search/date rules, while summary requests intentionally
process the entire matching set for accurate totals. The synthetic 10k / 10
results miss the 2-second target substantially; 50k / 25 exhausted the local
time/memory budget. Thus the available evidence does **not** establish that
normal filters or initial page loads meet the requested targets. No claims are
made for Today, Yesterday, Pending, Completed, specific Date, Search,
pagination latency, browser rendering, or production performance.

The changes with the clearest verified benefit are functional/resource-shape
changes (bounded page data, streamed summary state, compact timeline
responses), not proven end-to-end latency reductions. The actual before/after
speedup for each required interaction remains unknown because there is no
controlled same-dataset, same-host, same-query browser/API baseline. Do not
deploy production query/index/cache changes solely from this in-memory test;
repeat representative authenticated measurements in staging, capture Mongo
`explain("executionStats")`, API and browser p50/p95, memory, payload sizes,
and verify financial/RBAC regressions before claiming success.
