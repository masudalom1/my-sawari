# Payment Verification and QR Generator Performance Baseline

## Scope and method

This is a Phase 1 baseline for `/verify-upi-collections`, `/pending-to-collect`,
and `/admin/qr-codes`. No application behavior was changed for this audit.

Endpoint measurements were collected once against the local Express app backed
by the test harness's in-memory MongoDB replica set. The test seeded 3,000
synthetic payment documents (1,500 cash and 1,500 GPay), then requested the
default 25-row UPI and cash views. QR generation was measured separately with
100 valid synthetic codes. Times include local HTTP and application overhead;
Mongo timings are summed Mongoose query-operation wall times, not server-side
Mongo profiler execution times. These figures are reproducible local
observations, not production, browser, or p95 latency measurements.

## Baseline measurements

| Page / operation | Request | Matching payment records fetched | Returned page rows | Endpoint wall time | Mongo operation wall time | Response JSON |
|---|---|---:|---:|---:|---:|---:|
| UPI initial view | `GET /api/v1/dashboard/payments-history/upi?tab=pending&limit=25` | 3,000 | 25 | 451.84 ms | 242.91 ms cumulative across 3 operations | 53,507 bytes |
| Cash initial view | `GET /api/v1/dashboard/payments-history/cash?tab=today&limit=25` | 1,500 | 25 | 104.93 ms | 49.08 ms cumulative across 3 operations | 32,465 bytes |
| QR generation action | `POST /api/v1/qr/qr-codes/bulk` with 100 codes | N/A | 100 saved codes | 156.39 ms | Not separately instrumented | 945 bytes |

The verification route measurements include one full matching `PaymentHistory`
query and page creator lookups. The 3 Mongo operations include authentication
and access-control work; the timing harness did not isolate each operation's
server execution time. QR's measurement is for the explicit Generate action,
not the page's initial mount.

## Traced request paths

- UPI page: `GET /api/v1/dashboard/payments-history/upi`; the React client
  requests page 1 with `limit=25` and default `tab=pending`. The API is served
  by `src/routes/paymentHistory.js` and
  `src/controllers/upiVerification.controller.js`, then
  `readUpiView()` in `src/services/upiVerification.service.js`.
- Pending to Collect page: `GET /api/v1/dashboard/payments-history/cash`; the
  React client requests page 1 with `limit=25` and default `tab=today`. The API
  is served by `src/routes/paymentHistory.js` and
  `readCashCollectionView()` in `src/controllers/paymentHistory.controller.js`.
- QR generator: the page does not fetch QR records on initial mount. Its
  Generate action sends `POST /api/v1/qr/qr-codes/bulk`, handled by
  `src/routes/qrRoutes.js` and `bulkCreate()` in
  `src/controllers/qrController.js`. A saved batch may be restored from
  `sessionStorage` and rendered locally on mount. `/admin/qr-codes/list` is a
  separate page and is not the QR generator.

## Findings

### UPI and cash

- Both APIs fetch all documents matching their broad payment-type/method query
  before applying the default tab, status, and search filters in Node.js.
  Pagination slices the resulting in-memory array only after status, summaries,
  method facets, and groups have been computed. Therefore, a 25-row page does
  not bound records read or processing work.
- UPI transforms payment rows and repeatedly maps/filters them for method
  facets and tab summaries, then sorts the selected result set. Explicit
  `date`/`month` filters are pushed into the Mongo query; the default view has
  no date bound.
- Cash computes effective payment dates and collection fields for all cash
  candidates, filters and sorts them in Node.js, and builds summaries and
  groups before slicing the requested page. Explicit `date`/`month` filters
  are pushed into Mongo; the default Today tab still reads all cash/mixed
  candidates and narrows to today in Node.js.
- Both views resolve creator records with one batched `User.find()` for visible
  page rows. This is not an N+1 query. They do not populate bookings or vehicle
  records for these views.
- Per-page queries are not duplicated by the normal production client flow:
  page/filter changes request a new view, and corrected pages are accepted
  without an extra fetch. Development React Strict Mode can re-run mount
  effects, so development request logs may show duplicates. This benchmark
  directly invoked each endpoint once and did not measure browser network
  traces.
- The browser first fetches the authenticated access profile in the shared
  application shell; protected page content/data loading follows permission
  resolution. A shared realtime socket is also opened by the shell for
  permission-change refresh. The verification clients do not create their own
  realtime subscriptions or refetch payment data on realtime events.

### QR generator

- Initial page mount has no QR-data API request and fetches no QR database
  records. Without a saved session batch, initial QR generation/normalization
  work is zero.
- On the Generate action, the backend validates and bulk-inserts submitted
  codes. The client then renders the saved QR images locally using `qrcode`,
  in chunks of 50. For the configured maximum of 1,000 codes, this can mean
  substantial client CPU, memory, and image-data-URL work after the API
  response; this audit did not measure browser CPU or React render duration.
- A prior saved batch can be rerendered from `sessionStorage` at mount, which
  is client work and not a server/API request.

## Measurement gaps

Initial navigation-to-painted time, browser request waterfall, compressed
transfer size, client normalization duration, React commit/render duration,
and production Mongo query execution times were not measured. They require a
browser profiler and production-like data/environment; API timings from the
in-memory test database are not substitutes. QR generation's local rendering
time likewise needs browser profiling.

## Baseline bottleneck

The strongest measured and code-supported bottleneck is the unbounded
full-history read and Node.js processing on both payment-verification APIs,
despite returning only 25 records. This increases database transfer, server
CPU, and response time as payment history grows. The QR generator's separate
potential bottleneck is client-side QR rendering for large batches, not its
initial page load.

## Phase 2 loading strategy

The cash and UPI view endpoints now accept `section=page` and
`section=summary`. The client requests both independently: page results render
as soon as they arrive, while summary cards, tab counts, and pagination totals
can continue loading or be retried separately. Initial card loading uses
compact skeletons; a totals failure does not hide loaded cards.

The page section returns only the requested page. UPI walks a sorted Mongo
cursor and stops after the requested matching page plus one row. Cash uses a
Mongo aggregation cursor sorted by its effective payment date, applies
date-bound conditions for Today/Yesterday views, and stops after the requested
matching page plus one row. Search and state filters retain their existing
normalization and calculation routines. The summary section retains full-set
calculations but returns only summary metadata, not payment rows. Legacy calls
without a `section` continue to return the combined response.

This removes full-history document materialization from the first-page API
response, but the independent summary still examines the complete matching
history to preserve exact totals. Cash's effective-date sort may also require
Mongo to sort candidate documents. Production query execution time and browser
paint/render timing still require profiling against production-like data.
