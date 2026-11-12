# OTR Team Portal

Trackside-friendly team feedback, post-event reporting, administration, and shared inventory for Open Throttle Racing.

## Current release

Production V1.1.0 uses GitHub Pages for the portal and Supabase for shared submissions and inventory. The Label & Bin Assistant and November 8 F22/E92 inventory replacement were activated on November 12, 2026. Active inventory has 92 F22, 123 E92, 103 F30, and 58 Boxster records (376 total), with five unknown counts preserved. Failed submissions are retained in a device-local queue and retried when connectivity returns.

## Project structure

```text
index.html                 Portal screens and accessible page structure
assets/styles.css          Visual system and responsive layout
assets/config.js           Public Supabase project configuration
assets/core.js             Navigation, shared state, and UI utilities
assets/submissions.js      Feedback, post-event, admin, and offline queue
assets/inventory.js        Supabase-backed Inventory Assistant
assets/labels.js           Inventory Label & Bin Assistant + 4x6 print layouts
assets/bootstrap.js        Startup checks and queue synchronization
supabase/schema.sql        Inventory table and current beta policies
supabase/vehicles_schema.sql
                           Exact vehicle registry, inventory assignment key, and 23 vehicle seeds
supabase/label_assistant_schema.sql
                           First-class bins, bin assignment RPC, reorder flags, and physical tag IDs
supabase/inventory_count_schema.sql
                           Unknown counts, printed quantity units, and parent/sub-bin hierarchy
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

## Local preview

Serve this directory with any static web server, then open `index.html`. Avoid opening it directly from the filesystem because browser security rules can behave differently from GitHub Pages.

## Deployment

GitHub Pages publishes the root of the `main` branch. Changes should be previewed and regression-tested before merging or replacing the live files.

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
- Label Assistant handlers resolve, 4×6 print rules are present, and the existing 297-record inventory seed remains unchanged.

To enable exact vehicle selectors in Supabase, run `supabase/schema.sql` (if needed), then run `supabase/vehicles_schema.sql` in the SQL editor. The second script is safe to rerun and upserts the current registry without creating duplicates.

The Label Assistant uses only 4×6 thermal adhesive stock. Full bin labels occupy a 4×6 sheet; individual part labels use that same stock in a fold-wrap prototype around a 2×3 paper tag. There is no separate 2×3 media or printer path. Physical fold geometry and barcode scanning still require a printer test.

Production activation is complete. See [F22/E92 inventory update](docs/inventory-f22-e92-update.md) for source totals, private backups, rollout results, and deployment order for another environment: label schema, count schema, then replacement SQL. Frontend and database rollout must be coordinated; merging the frontend alone does not update shared inventory. Do not rerun the historical seed after the replacement.

Run the repeatable static checks with:

```text
node scripts/validate.mjs
```

For isolated PostgreSQL regression tests (no production connection):

```bash
npm install --prefix /tmp/otr-db-test --no-audit --no-fund --ignore-scripts @electric-sql/pglite@0.3.14
PGLITE_MODULE=/tmp/otr-db-test/node_modules/@electric-sql/pglite/dist/index.js node scripts/test_inventory_update.mjs
```

With Python Playwright and Chromium installed, `python scripts/test_portal.py` runs local browser regressions against a simulated Supabase backend. It never connects to production. Set `CHROMIUM_PATH` if needed and `OTR_TEST_OUTPUT` to retain label PDFs and the preview screenshot in a chosen directory.

## Beta security note

The current V1 deployment intentionally allows anonymous inventory reads/inserts/updates and anonymous Admin reads. Replace those beta policies with authenticated crew access before broad public use.
