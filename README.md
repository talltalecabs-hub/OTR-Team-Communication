# OTR Team Portal

Trackside-friendly team feedback, post-event reporting, administration, and shared inventory for Open Throttle Racing.

## Current release

V1 uses GitHub Pages for the portal and Supabase for shared submissions and inventory. Failed submissions are retained in a device-local queue and retried when connectivity returns.

## Project structure

```text
index.html                 Portal screens and accessible page structure
assets/styles.css          Visual system and responsive layout
assets/config.js           Public Supabase project configuration
assets/core.js             Navigation, shared state, and UI utilities
assets/submissions.js      Feedback, post-event, admin, and offline queue
assets/inventory.js        Supabase-backed Inventory Assistant
assets/bootstrap.js        Startup checks and queue synchronization
supabase/schema.sql        Inventory table and current beta policies
supabase/vehicles_schema.sql
                           Exact vehicle registry, inventory assignment key, and 23 vehicle seeds
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
- Inventory loads 297 records / 690 units from Supabase.
- Inventory totals are 58/146 for 986 Boxster, 84/161 for E92, 103/234 for F30, and 52/149 for M235/M235iR.
- Chassis selectors offer the seeded exact vehicle registry (23 vehicles across race, street, tow, and trailer platforms).

To enable exact vehicle selectors in Supabase, run `supabase/schema.sql` (if needed), then run `supabase/vehicles_schema.sql` in the SQL editor. The second script is safe to rerun and upserts the current registry without creating duplicates.

Run the repeatable static checks with:

```text
node scripts/validate.mjs
```

## Beta security note

The current V1 deployment intentionally allows anonymous inventory reads/inserts/updates and anonymous Admin reads. Replace those beta policies with authenticated crew access before broad public use.
