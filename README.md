# OTR Team Portal

A touch-friendly portal for Open Throttle Racing: crew forms, inventory, labels and team administration. GitHub Pages publishes the root of `main`; Supabase is authoritative for shared data and authentication.

## V2.0

V2 adds a cleaner homepage and the exact Driver’s Lounge → Inventory → paired Feedback / Post-Event Crew Questionnaire → paired Report a Problem / Leave an Idea → Work in the Shop hierarchy. The logo stays; the text heading is **Team Portal**.

Email/password sign-in protects Inventory Management and Administrative. Public inventory search, bins/parts, **Use Part** and public communication forms stay open. Staff/Manager and Admin are explicit server-controlled roles; unassigned accounts have no management access. The sign-in page also accepts Admin access requests for review without granting a role automatically.

Read [V2 auth, preservation and rollout](docs/v2-auth-rollout.md) before deployment. The migration refuses to enable protection without a confirmed, active owner Admin. Owner credentials are provisioned separately and never committed.

## Preserved production work

The verified starting main is V1.3.4 at `90610eb61d4a96b587bffaad339b8a544c628e46`. V2 retains:

- The exact vehicle registry, Phoenix #69x’s stable identity, and administrative add/edit/remove/restore history.
- Mobile/Backstock stock, independent chassis Cart A/B groups, parent/sub-bin inheritance, reserved `000` loose-stock bins, and editable chassis-series Bin IDs.
- Shared inventory drafts/photos/positions, duplicate/move cards, Add Another Part, Add/Replace/Separate intake, bin retirement and editable part/bin names.
- Multi-chassis compatibility with one shared count, null/uncounted quantities, source units and workbook provenance.
- Initials on inventory changes, immutable audit history, atomic/idempotent Use Part and full/partial moves.
- 4×6-inch, 25×50-mm and 150×100-mm label presets and stable printed identities.
- Feedback, operational forms, event questionnaires, device-local submission retries, and browser/back navigation.

Current stock changes as the crew works. The historical 297-record/690-unit seed and 215-label F22/E92 workbook are verification fixtures, not current live counts. Never reseed production to deploy V2.

## Structure

- `index.html`: existing screens plus the V2 homepage and sign-in/access-request UI.
- `assets/v2.css`, `assets/brand/`: V2 presentation and local SVG wordmark.
- `assets/auth.js`: Supabase session lifecycle, explicit roles, destination return and protected request/route/action boundaries.
- `assets/{core,submissions,inventory,crew,labels,workspace,intake,bin-management,vehicles}.js`: existing portal workflows.
- `assets/vendor/`: pinned local Supabase JS and QR bundles with licenses and integrity metadata.
- `assets/config.js`: public project URL/key and application version; no privileged keys.
- `supabase/migrations/`: database changes, including the V2 access migration.
- `scripts/`: static, browser and isolated PostgreSQL checks.

## Preview and validate

Serve the repository with a static web server. The backend must have the V2 migration and authorized accounts for real protected operations; the browser regression suite provides an isolated fixture instead.

```sh
node scripts/validate.mjs
python scripts/test_portal.py
```

With PGlite installed outside the checkout, set `PGLITE_MODULE` to its `dist/index.js`, then run each SQL suite:

```sh
node scripts/test_inventory_update.mjs
node scripts/test_inventory_crew.mjs
node scripts/test_vehicle_admin.mjs
node scripts/test_inventory_workspace.mjs
node scripts/test_auth_access.mjs
```

The browser suite needs Python Playwright and Chromium (`CHROMIUM_PATH` may override `/usr/bin/chromium`). `OTR_TEST_OUTPUT` chooses a screenshot/PDF directory. Tests never connect to production.

## Deployment and access

Apply the reviewed V2 migration and frontend together using the [rollout sequence](docs/v2-auth-rollout.md). Do not replay the old beta schema files over secured production: their anonymous policies predate Auth. Public Use Part has a constrained server operation; anonymous clients have no general inventory UPDATE privilege. Management requires both a valid Auth session and the assigned role. Auth does not replace visible initials.

Temporary-password accounts must set their own password before management access is enabled; the database enforces this requirement. Signed-in users can also change their password from the header.

Sessions use tab-scoped sessionStorage, with an in-memory fallback. Draft/photo data remains in Supabase; the existing offline submission queue is retained. No password or server key is stored in application files.

## Workflow references

[Shared creation and bin management](docs/inventory-creation-workspace.md) · [Bin IDs and compatibility](docs/chassis-bins-and-shared-parts.md) · [Crew workflow and ledger](docs/inventory-crew-workflow.md) · [Vehicle administration](docs/vehicle-administration.md) · [Inventory activation history](docs/inventory-f22-e92-update.md) · [Mobile, Backstock and carts](docs/inventory-mobile-backstock-carts.md)
