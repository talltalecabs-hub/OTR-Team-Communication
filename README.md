# OTR Team Portal

Trackside-friendly team feedback, post-event reporting, administration, and shared inventory for Open Throttle Racing.

## Current release

V1.3.2 uses GitHub Pages, with Supabase authoritative for shared submissions, inventory, and the exact vehicle registry. Mobile inventory travels with the team; Backstock stays at the shop. Each race chassis has independent Cart A/B locations. Failed submissions stay in a device-local queue and retry when connectivity returns. Current counts change as the crew works; the historical seed is not the live inventory count.

V1.3.0 adds a search-first crew workflow, atomic Use Part consumption, required initials for inventory changes, and an append-only activity ledger. It also includes the later bin/part refinement: searchable bin contents, direct Not Found and editable notes on part detail, and single-face 2×1 part labels. See [Inventory crew workflow](docs/inventory-crew-workflow.md) and [Bin, part, and label UX](docs/bin-part-label-ux.md) for behavior, local checks, and release requirements.

V1.3.1 adds an **Add Another Part** button after a successful inventory addition. It opens a clean entry and focuses the part name without creating another stock record. No database change is needed.

V1.3.2 continues chassis Bin IDs such as **E92-023**, with an editable suggested ID, and adds multi-chassis compatibility on new and existing parts. A shared F22/F30 part remains one stock record with one quantity and its existing physical location. See [Bin numbering and shared parts](docs/chassis-bins-and-shared-parts.md).

## Project structure

```text
index.html                 Portal screens and accessible page structure
assets/styles.css          Visual system and responsive layout
assets/config.js           Public Supabase project configuration
assets/core.js             Navigation, shared state, and UI utilities
assets/submissions.js      Feedback, post-event, admin, and offline queue
assets/inventory.js        Supabase-backed Inventory Assistant
assets/labels.js           Bin/part assistant, 4x6 bin labels, and 2x1 part labels
assets/crew.js             Use Part, initials, and inventory activity viewer
assets/bootstrap.js        Startup checks and queue synchronization
supabase/migrations/20261114225322_inventory_crew_workflow.sql
                           Prepared inventory ledger, write guards, and atomic Use/Move RPCs
supabase/schema.sql        Inventory table and current beta policies
supabase/vehicles_schema.sql
                           Exact vehicle registry, inventory assignment key, and 23 vehicle seeds
supabase/label_assistant_schema.sql
                           First-class bins, bin assignment RPC, reorder flags, and physical tag IDs
supabase/inventory_count_schema.sql
                           Unknown counts, printed quantity units, and parent/sub-bin hierarchy
supabase/inventory_stock_category_schema.sql
                           Mobile/Backstock classification, per-chassis Cart A/B bin locations
supabase/e92_cart_assignments.sql
                           One-time E92 cart placements confirmed by the team
supabase/update_inventory_f22_e92_20261108.sql
                           Prepared scoped replacement with private backups and rerun protection
data/inventory/f22-e92-2026-11-08.json
                           Canonical transcription of 215 workbook labels and source evidence
supabase/submissions_schema.sql
                           Submission table and current beta policies
supabase/seed_inventory.sql
                           Corrected 297-record inventory seed
supabase/repair_001_inventory_id_collisions.sql
                           Production repair applied on 2026-08-28
```

The Supabase key in `assets/config.js` is a public/publishable browser key. Access is controlled by Supabase row-level security policies.

## Inventory navigation

Inventory is the first home-page button. The Inventory landing offers **Mobile
Inventory Search** and **Inventory Management**. Mobile search opens immediately
across chassis, with optional chassis/location filters and Open Bins. Cards show
cart/location and Bin ID together. Opening a part prioritizes **Use Part**, which
records consumption against an exact vehicle without changing stock placement.

Inventory Management contains Backstock, Search All, Add Part, Bins & Placement,
Fast Move, and Inventory Activity. Corrections, flags, placement, and label actions
remain available through a part's management screen. Not Found and editable Notes
are also available directly on part detail, with required initials for changes.
Open Bins lists chassis bins in numeric order, including 000 for loose stock;
opening a bin shows only its direct contents in one full-width column, with a
search limited to that bin and separate links to sub-bins.

## Local preview

Serve this directory with any static web server, then open `index.html`. Avoid opening it directly from the filesystem because browser security rules can behave differently from GitHub Pages.

## Deployment

GitHub Pages publishes the root of `main`. The V1.3.0 rollout was authorized on 2026-11-16. V1.3.0 requires a coordinated database/frontend release and refreshed browser tabs; see the [compatibility and rollout notes](docs/inventory-crew-workflow.md#compatibility-and-future-rollout).

## Required checks

- Every JavaScript file passes a syntax check.
- Every inline HTML handler resolves to a function.
- Home navigation works from every screen.
- Quick and detailed feedback remain separate submission types.
- Post-Event Reports appear in the Admin viewer.
- Offline submissions appear under Admin → Local Queue.
- Historical V1 seed remains 297 records / 690 units. Current shared inventory may include later crew changes.
- Prepared replacement has 92 F22 and 123 E92 labels, five unknown counts, and printed set/lot units. F30 and Boxster rows are preserved exactly.
- Chassis selectors offer the seeded exact vehicle registry (23 vehicles across race, street, tow, and trailer platforms).
- Label Assistant handlers resolve, bin labels remain 4×6, part labels are single-face 2×1 with uppercase wording, and the historical inventory seed remains unchanged.
- Use Part and Fast Move commit inventory changes and ledger events atomically.
- Inventory writes require visible initials; audit history is append-only for portal users.
- Known stock cannot be consumed below zero; unknown stock remains uncounted after use.

For a new empty environment, install `supabase/schema.sql` and `supabase/vehicles_schema.sql` before the dependent inventory schemas. The current deployment already has the exact vehicle registry; V1.3.0 does not replace or reseed it.

The latest label handoff replaces the earlier part-tag fold-wrap requirement. Bin labels remain full 4×6 labels. Individual part labels now target one 2×1-inch face with uppercase wording and a placeholder barcode. Stable tag/inventory identities and source provenance are preserved. Final printer/scanner integration and calibration are deferred; see [Bin, part, and label UX](docs/bin-part-label-ux.md).

The earlier F22/E92 production activation is complete. See [F22/E92 inventory update](docs/inventory-f22-e92-update.md) for source totals, private backups, rollout results, and deployment order for another environment: label schema, count schema, then replacement SQL. Frontend and database rollout must be coordinated; merging the frontend alone does not update shared inventory. Do not rerun the historical seed after the replacement.

See [Mobile, Backstock, and cart locations](docs/inventory-mobile-backstock-carts.md) for inventory category selection, cart assignment, the confirmed E92 map, and the V1.1-to-V1.2 upgrade. Quantities, part categories, bin identities, and source records are preserved.

Run the repeatable static checks with:

```text
node scripts/validate.mjs
```

For isolated PostgreSQL regression tests (no production connection):

```bash
npm install --prefix /tmp/otr-db-test --no-audit --no-fund --ignore-scripts @electric-sql/pglite@0.3.14
PGLITE_MODULE=/tmp/otr-db-test/node_modules/@electric-sql/pglite/dist/index.js node scripts/test_inventory_update.mjs
PGLITE_MODULE=/tmp/otr-db-test/node_modules/@electric-sql/pglite/dist/index.js node scripts/test_inventory_crew.mjs
```

With Python Playwright and Chromium installed, `python scripts/test_portal.py` runs local browser regressions against a simulated Supabase backend. It never connects to production. Set `CHROMIUM_PATH` if needed and `OTR_TEST_OUTPUT` to retain screenshots in a chosen directory.

## Beta security note

The current V1 deployment intentionally allows anonymous inventory reads/inserts/updates and anonymous Admin reads. Replace those beta policies with authenticated crew access before broad public use.

V1.3.0 initials provide recorded accountability, not authenticated identity. The ledger adds database-enforced auditing within the existing beta access model; it does not introduce authentication.
