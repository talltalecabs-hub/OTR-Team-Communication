# Bin, part, and label UX refinement

This refinement extends the V1.3.0 crew-workflow PR on
`feature/inventory-crew-workflow`. It follows the later
`OTRos_Bin_Part_Label_UX_Handoff` specification. The V1.3.0 production rollout
was authorized on 2026-11-16 after validation, including the prepared crew
workflow migration. This refinement adds no additional schema migration.

## Open-bin contents

Direct contents of an open bin appear in one full-width vertical column. The
contents count describes the full bin, including when search narrows the visible
results. A search field above Contents filters only records directly assigned to
the currently open bin. It searches item names, part numbers, inventory codes,
conditions, categories, notes, and available source-label text.

Clearing the query restores the bin's full direct contents. An empty result has
a clear message. Opening a matching part still opens its normal detail page.
Parent/sub-bin links remain separate, preserving the exact-bin scope.

## Part detail

**Not Found** remains visible and distinct on part detail. This is a status
change, not deletion; it requires a visible Initials field and retains history.
Verify/Correct, Fast Move, and bin navigation remain available through their
existing paths.

An editable **Notes** textarea loads the record's existing `notes`. Saving notes
requires visible initials, trimmed and uppercased using the crew workflow's
1–8-character rule. The update changes `notes` without replacing source metadata,
original label evidence, stock identity, placement, or other assignments.

The existing item audit trigger records the save as `metadata_changed`, with the
previous and new note values in `from_state` and `to_state`. The note and event
commit together. The browser does not insert a ledger row separately. No new
column or migration is needed for this action; the prepared crew-workflow
migration supplies the audit enforcement when the release is later deployed.

## Individual part labels

The latest handoff replaces the previous 4×6 fold-wrap/four-face part tag:

- Individual part labels target **one 2×1-inch face**.
- Human-readable printed wording is **UPPERCASE**.
- Part name and physical location/bin take priority; quantity and a short ID fit
  where legible.
- The placeholder barcode and stable tag identity remain available.
- Unknown quantity remains uncounted rather than appearing as zero.
- Source filenames and photo metadata do not appear on the small label.

There are no repeated or rotated part-label faces. Bin/asset labels continue to
use the full 4×6 layout. This is a layout and preview refinement; final printer
integration, scanner integration, and print calibration are outside scope.

## Lineage and source preservation

The handoff's Center control arm bushing example has inventory code
`E92-002-L249` and tag ID `TAG-E92-002-L249-C599823B`. Its source workbook is
`OTR_Master_Inventory_F22_E92_Rear_Suspension_Update_2026-11-14.xlsx`, with
`source_metadata.source_row = 249`.

`L249` is a source-row lineage token for workbook row 249. It is not a
manufacturer part number, barcode checksum, quantity, or physical bin code.
That token stays in backend identity/provenance and may remain in the stable tag
or barcode payload. The small label emphasizes part name and physical location;
changing presentation does not rewrite the inventory code or source metadata.

## Validation

Use the local checks documented in
[Inventory crew workflow](inventory-crew-workflow.md#local-validation). For this
refinement, browser checks cover current-bin-only search, clearing and
no-result states, single-column contents, part opening, visible Not Found,
notes loading/saving with initials, source preservation, and the single-face
uppercase 2×1 preview. Database checks confirm that notes and their audit
event commit together with old/new values retained.

Static validation passes 15 JavaScript syntax checks and 69 inline handlers.
The local browser suite passes across 32 screens, with 21 inventory changes and
matching events, and no runtime/backend errors. Browser-generated PDFs contain
one page each at 144×72 points for a part label and 288×432 points for a bin
label. The local PostgreSQL suite verifies note before/after values, required
initials, and unchanged source provenance. A rendered label was also reviewed.

These checks use isolated local data. A preview or automated test does not
certify printer/scanner hardware or calibration.
