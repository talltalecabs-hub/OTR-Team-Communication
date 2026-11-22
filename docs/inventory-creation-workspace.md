# Shared inventory creation workspace

User direction: duplicate and move part cards in a whiteboard-style workspace.
Photos, draft details, and positions belong in Supabase with minimal/no end-device
persistence. Drafts stay outside inventory counts until Save to Inventory.

Release V1.3.4 builds on published V1.3.3 (`bc8761a`). The earlier homepage hierarchy change remains isolated on `feature/homepage-hierarchy`; inventory work takes priority.

## Interaction contract

- Open shared cards; enter visible initials once for the current workspace visit.
- New empty card, photo, name, quantity, placement and label preview work in any order.
- Autosave edits and positions to shared drafts, with revision checks for concurrent edits.
- Duplicate makes a new draft UUID/tag ID and copies details/photo references, never stock.
- Pan/zoom the board; drag a card by its header or move it with arrow keys.
- Inspector edits the selected card without switching through a wizard.
- Print from the card with 4×6in, 25×50mm (50mm wide ×25mm high), or 150×100mm stock.
  Exact 4×6in dimensions differ slightly from 150×100mm; keep distinct presets.
- Save to Inventory commits once atomically, preserving the draft tag ID and photos.
  Blank quantity stays unknown; known counts require a real observed whole count.
- Committed cards link to live inventory. Duplicate as a new draft for another part.
- Archive retains history. No draft/photo data is intentionally persisted in localStorage or IndexedDB. Uploads request `Cache-Control: no-store`; only transient edits and signed URLs remain in memory.

## Backend contract

`inventory_workspace_drafts` stores data JSON, x/y, state, revision, generated
stable tag ID, source-draft ID and optional committed inventory ID. Public RPCs
`save_inventory_workspace_draft`, `duplicate_inventory_workspace_draft`, and
`commit_inventory_workspace_draft` use invoker permissions and explicit initials.
Private guard/audit triggers require initials and record append-only workspace
events. Inventory commit also uses the existing inventory audit trigger.

Photos use a private `otr-inventory-workspace` Storage bucket, immutable objects,
and expiring signed display URLs. Duplicate cards share immutable photo references.
The portal's existing beta crew access model stays in place; initials are not auth.
This feature does not add authentication or change existing submission storage.

Generated migration: `20261116164616_inventory_creation_workspace.sql`.
The second migration is `20261122214323_inventory_bin_retirement_and_stock_intake.sql`. It adds a nullable bin display name, atomic incoming-stock/rename/bin-retirement RPCs and parent-cart inheritance triggers. Apply both migrations before publishing the frontend. Neither migration changes existing stock or existing cart assignments on installation.

## Crew operations

- **Add Part / Parts & Labels:** enter initials, make a blank card or add photos, fill in whatever is known, and print at any point. Save to Inventory is the only step that adds stock. Add Another Part immediately starts a clean card.
- **Matching parts:** choose the exact existing record by condition, Bin ID, quantity and record code. Add increases its count; Replace uses the entered number as the complete observed total; Separate retains a distinct lot. Existing record names, condition, location and source metadata remain unchanged. Unknown counts cannot be added mathematically; use a confirmed replacement total or separate record. A revision check rejects changed counts. A draft merged into existing stock keeps a searchable tag alias through its committed link.
- **Part name:** edit Part Name on the part detail and save with visible initials. IDs, stock, placement and unsaved Notes remain intact.
- **Bin name:** edit Bin Name under Bin Management. Bin ID stays fixed; directories and labels show the new name.
- **Delete Bin:** choose Backstock or a same-chassis destination bin. The operation moves all direct and descendant stock without changing quantities, then removes the bin and its sub-bins from available choices. Deleted IDs remain reserved with audit history. Bin 000 remains the reserved loose-stock location. Changed contents or structure require a fresh review; the whole operation rolls back if any move/audit fails.
- **Cart assignment:** assign a parent; its sub-bins and deeper descendants follow atomically. New sub-bins inherit that cart. Individual sub-bin cart controls direct users to the parent. Existing legacy mismatches can be repaired by saving the parent's cart again with real operator initials.

## Labels and photos

The three explicit media presets are 4×6 inches (portrait), 25×50 mm (50 mm wide ×25 mm high), and 150×100 mm (landscape). These are distinct page sizes; physical printer calibration and the actual 150×100 stock still need to be checked on the crew's printer. Long part identities use a QR symbol on 25×50 stock so the full identity fits at a practical module size. Larger labels retain Code 39. The vendored QR library is pinned with its license, source and SHA-256 under `assets/vendor/`.

Photo bytes go directly to a private Supabase bucket. Drafts support eight JPEG/PNG/WebP/HEIC/HEIF references, up to 10 MiB per upload. Duplicates share immutable objects. Removing a reference or archiving a card retains server history and original photo bytes; unreferenced object cleanup is a future administration task. HEIC/HEIF preview depends on browser support; JPEG/PNG/WebP are the portable preview choices.

## Validation

Run `node scripts/validate.mjs`, `python scripts/test_portal.py`, and `PGLITE_MODULE=<installed PGlite module> node scripts/test_inventory_workspace.mjs`. The browser suite intercepts Supabase and writes no production records. It covers independent-device drafts, photos, conflicts, duplication, pointer/keyboard movement, retry-safe commit, Add Another Part, matching decisions, tag aliases, names, bin retirement, cart inheritance, exact PDF sizes and existing portal flows. PostgreSQL tests cover RLS, preserved baseline data, null counts, idempotency, audits, concurrent-change rejection and rollback.


## Existing cart correction

On 2026-11-22, the owner supplied initials **NPH** to correct F22-008-A/B/C and F22-015-A from Unassigned to their parents' Cart A. Four existing inventory audit entries record the before/after changes. A within-transaction fingerprint verified that no inventory item field changed; 442 item records were present at that point. The inheritance migration adds behavior and does not replay this data correction.
