# Inventory crew workflow — V1.3.0

This branch prepares the crew workflow handoff for PR review. Production remains
V1.2.1. No production migration, data replacement, or deployment is part of this
delivery.

The same V1.3.0 PR also includes the later
[bin, part, and label refinement](bin-part-label-ux.md). That handoff replaces the
previous part-label fold-wrap specification with one 2×1-inch face; bin labels
remain 4×6. It does not add another database migration.

The branch starts from `main` at
`59a9553cc9839240e8f98145417fb2c01fd629c5`, preserving the previous inventory
navigation, home shortcut, bin directory, carts, and Mobile/Backstock work.

## Crew workflow

The first Inventory screen has two prominent actions:

- **Mobile Inventory Search** opens searchable mobile stock immediately, across
  chassis. Chassis, location, and inventory filters remain available.
- **Inventory Management** contains Backstock, Search All Inventory, Add Part,
  Bins & Placement, Fast Move, and Inventory Activity.

Search cards show quantity plus a physical path such as
`📍 E92-A • BIN E92-018-A`. Part detail combines the same information in one
`Location / Bin` row, with a clickable Bin ID. Unassigned and Backstock locations
remain explicit. Chassis **Open Bins** and exact direct-bin contents remain
available, including loose `XXX-000` bins and separate sub-bin links.
An open bin's direct contents use a single full-width column with a search field
that filters only that bin. Clearing the query restores all direct contents.

The primary part action is:

**Use Part → Car # / Vehicle → Quantity used → Initials → Finish**

Quantity defaults to 1. Vehicles come from the existing shared registry, with
platform/compatibility filtering and a Show all vehicles option. F22 uses the
registry's existing `M235 / M235iR` platform alias. There is no free-text or new
vehicle identity.

For counted inventory, the database subtracts the used quantity and prevents a
negative result. A remaining count of zero sets `Out of Stock`. For an unknown
count, the remaining quantity stays `NULL`; the event still records the quantity
used. Confirmation states whether a remaining count is known.

Consumption preserves the item's ID, source metadata, units, compatibility,
assignment type, vehicle assignment, chassis, bin, cart, and stock category.
Using stock on a vehicle does not make that vehicle its permanent assignment.
Repeated Finish clicks are blocked while saving. A lost Use Part response can be
retried using the same request ID without consuming stock twice.

## Management and placement

Part management retains Verify / Correct, Needs Review, Not Found,
Mobile/Backstock changes, Fast Move, and part tags. Each mutation screen has a
visible **Initials** field. Initials are trimmed, uppercased, and required to be
1–8 characters. Flag/category actions use their part-management field; count,
placement, bin, and tag changes use their own field. Initials are not silently
reused between screens.

Part detail also keeps **Not Found** visible and provides an editable **Notes**
textarea. Both require visible initials to save. Notes use the existing `notes`
column, with old and new values captured by the ledger's `metadata_changed`
event. Notes remain separate from imported/source provenance and use-case data.

Fast Move follows **Inventory Type → Chassis → Cart → Bin** after selecting a
part. Mobile placement requires a chassis. Physical bins inherit their cart;
loose `XXX-000` stock can carry a direct cart assignment. Backstock cannot retain
a mobile cart or be put into a mobile cart bin. Quantity moves require a real
count first.

A full move preserves the stock record identity. A partial move atomically
reduces the source and creates a destination stock lot, preserving total units,
source evidence, units, compatibility, and non-placement assignments. A new lot
gets its own inventory code and no duplicated physical tag ID. A move with an
uncertain network response requires reopening Fast Move to reload current stock
before another move.

## Database changes

The CLI-generated migration is
[`20261114225322_inventory_crew_workflow.sql`](../supabase/migrations/20261114225322_inventory_crew_workflow.sql).
It was created with Supabase CLI 3.1.0 and assumes the existing inventory, vehicle,
count, bin, and cart schemas are already installed.

| Component | Behavior |
| --- | --- |
| `public.inventory_events` | Append-only history with actor, timestamp, event type, stable IDs, human-readable codes, quantity context, and full before/after snapshots. |
| Item/bin write guards | Reject blank initials and contradictory new placement; reject deletion. Existing placement is preserved during unrelated changes. |
| Item/bin audit triggers | Create the event in the same transaction as the stock/bin change. A failed audit insert rolls back the change. |
| `use_inventory_part` | Locks the item, validates the exact vehicle and quantity, consumes known stock, records unknown-count use, and supports idempotent retry. |
| `move_inventory_part` | Validates destination type/chassis/cart/bin and atomically handles full or partial movement with request replay protection. |
| Inventory Activity | Read-only view of the newest 100 events. The browser never inserts ledger records. |

The later Notes action uses the existing item audit trigger and `notes` column;
the bin-search and label layout refinements are frontend changes. No additional
migration is required for those refinements.

Direct item/bin requests pass normalized initials in `x-otr-initials`. RPCs take
explicit actor initials and transaction-scoped operation context. Private trigger
helpers live in a schema unavailable to portal roles; public RPCs use invoker
permissions and existing RLS. Normal portal roles can read ledger events but
cannot insert, edit, or delete them. UPDATE/DELETE protection also guards the
ledger itself.

The migration does not rewrite inventory, bins, carts, vehicles, submissions, or
source history. It does not invent events for past activity. Auditing starts with
new changes after deployment. Before/after snapshots include physical bin/cart
labels so later placement changes do not erase historical meaning.

Initials are self-entered accountability, not proof of authenticated identity.
The existing beta anonymous access model remains; an authentication redesign is
outside this change.

## Data preservation baseline

A read-only production check during this work found 421 inventory records, six
unknown counts, and the existing 23 vehicles. The crew has added records since
the earlier workbook import. Those counts are observations, not a replacement
target. Supabase remains authoritative.

The historical V1 seed stays at 297 records / 690 units. The canonical F22/E92
workbook snapshot remains 215 labels with its source units and five original
unknown counts. Neither historical file is rerun against current stock.

Feedback, Post-Event Report, Driver's Lounge, Shop Talk, Admin / Local Queue,
exact vehicle identities, and existing source records remain within the
regression scope. The latest label handoff keeps bin labels at 4×6 and changes
individual part labels to one 2×1-inch face, with uppercase human-readable text
and the placeholder barcode retained. It supersedes the earlier fold-wrap part
tag. Final printer/scanner integration and calibration remain deferred.

Lineage identifiers are preserved. In the handoff example `E92-002-L249`, `L249`
means source workbook row 249, not a part number or bin code. Label presentation
does not rewrite that identity or its source metadata.

## Local validation

Run static checks, including all JavaScript syntax and inline handlers:

```bash
node scripts/validate.mjs
```

Run isolated PostgreSQL regressions, without a production connection:

```bash
npm install --prefix /tmp/otr-db-test --no-audit --no-fund --ignore-scripts @electric-sql/pglite@0.3.14
PGLITE_MODULE=/tmp/otr-db-test/node_modules/@electric-sql/pglite/dist/index.js node scripts/test_inventory_update.mjs
PGLITE_MODULE=/tmp/otr-db-test/node_modules/@electric-sql/pglite/dist/index.js node scripts/test_inventory_crew.mjs
```

With Python Playwright and Chromium installed:

```bash
python scripts/test_portal.py
```

The browser suite intercepts Supabase requests and uses a stateful local fixture.
It checks crew search, exact vehicle filtering, known/zero/unknown consumption,
required initials, retry behavior, corrections, flags, stock category changes,
bin/cart management, Fast Move, tag/count changes, exact bin contents, home
navigation, submissions, and the offline queue. PostgreSQL tests independently
exercise atomic rollback, ledger immutability, actor enforcement, preservation,
request replay, and placement consistency. Local success does not constitute
production deployment or a physical printer test.

## Compatibility and future rollout

The frontend and migration must be released together when separately authorized.
This PR does not perform those steps.

1. Review the PR and migration against the current production schema and take the
   normal database backup/snapshot. Keep live crew inventory writes paused during
   the coordinated release.
2. Apply the new migration after the existing schemas. It creates the ledger and
   RPCs and tightens item/bin writes to require initials.
3. Publish the matching frontend from `main`, then refresh all portal tabs and
   confirm the V1.3.0 assets loaded before resuming inventory changes.
4. Verify a controlled inventory operation and its ledger event, along with
   existing read and submission flows.

Old tabs do not send the required initials and their writes will be rejected
after migration. The legacy `assign_inventory_to_bin` RPC loses portal execution
permission; Fast Move uses the new `move_inventory_part` RPC. Conversely, the new
Use Part and Fast Move cannot run against an unmigrated backend. These are
intentional compatibility boundaries that require the coordinated release.

A read-only live OPTIONS preflight returned HTTP 200 and allowed
`apikey,content-type,prefer,x-otr-initials`, confirming that the production API's
current CORS configuration accepts the audit header. No live write was used to
check this.

Do not rerun historical seeds or replacement SQL as part of this upgrade. A
frontend-only rollback after migration restores old pages but not old write
compatibility; retaining the new frontend or preparing an explicit reviewed
database rollback is necessary. Ledger history must be preserved.
