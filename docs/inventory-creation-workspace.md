# Shared inventory creation workspace

User direction: duplicate and move part cards in a whiteboard-style workspace.
Photos, draft details, and positions belong in Supabase with minimal/no end-device
persistence. Drafts stay outside inventory counts until Save to Inventory.

The previous homepage V1.3.1 patch is preserved on the local
`feature/homepage-hierarchy` branch at `adadd89`; inventory work takes priority.
This feature branch starts from released V1.3.0 (`035ff06`).

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
- Archive retains history. No draft/photo binary data in localStorage, IndexedDB or caches.

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
Production remains untouched while implementation/validation is in progress.
