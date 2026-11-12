# F22 / E92 inventory snapshot — November 8, 2026

The source is `OTR_Master_Inventory_F22_E92_Cooling_Update_2026-11-08.xlsx`.
The canonical transcription is
[`data/inventory/f22-e92-2026-11-08.json`](../data/inventory/f22-e92-2026-11-08.json).
It records the workbook file hash, Excel source row, original label text,
condition, printed part number, label date, photographs, notes, and review
decisions. `PARTS REGISTER` supplies the physical stock records; `BIN DIRECTORY`
supplies their locations and hierarchy. Review notes and stock movements are
retained as evidence. The stock movements are already reflected in the register
counts and **must not be replayed** as additional quantity adjustments.

## Counts and units

| Chassis | Physical label records | Records with a count | Records with an unknown count | Numeric quantities, preserving source units |
| --- | ---: | ---: | ---: | --- |
| F22 | 92 | 88 | 4 | 197 `pcs`, 1 `set`, 4 `sets` |
| E92 | 123 | 122 | 1 | 193 `pcs`, 2 `set`, 2 `sets`, 1 `lot (2 pcs)` |

These are mixed units, so their numerical subtotals are not a global piece
count. Sets remain sets. The heat-shield lot remains one labeled lot containing
two pieces. Repeated photographed labels remain separate inventory records,
including the E92 water pumps, O-rings, thermostat housings, expansion tanks,
and vent hoses.

Four F22 labels have blank quantities: the front-end, under-car, and engine-bay
hardware in `F22-015-A`, and rod-end spacers in `F22-016`. Their quantities remain
`null`. The miscellaneous radiator-hose assortment in `E92-008` preserves the
literal quantity `VARIOUS` in source metadata, with a `null` numeric quantity.
Unknown stock is never converted to zero. The removed F22 Valvetronic actuator
is a known zero: its source movement records the change from one to zero.

Three register rows marked `F22/F30` belong physically to `F22-003`: the upper
knuckle bolt with nut, front wheel speed sensor, and front hub bolt. They are
owned by F22 and retain compatibility with both F22 and F30. They do not create
or modify any F30 inventory rows.

## Bin structure

The workbook defines 43 directory rows across 39 numbered parent-bin groups:
20 F22 directory rows in 18 parent groups, and 23 E92 rows in 21 parent groups.
`F22-008` and `F22-015` appear only as parent references; their explicit child
rows are `F22-008-A/B/C` and `F22-015-A`. The SQL creates those two parent
containers, resulting in 45 bin nodes with six child relationships. They add
no inferred parts or quantities. `E92-018` already has its own directory row
and contains `E92-018-A/B`.

Bins without individual item tags remain established locations with unknown
stock. Missing F22 bin numbers `004` and `013` are not invented. These source
IDs are preserved rather than replaced with newly generated classification IDs.

## Replacement scope and production status

The user authorized replacing the older E92 and `M235 / M235iR` inventory groups
with this F22/E92 workbook. The old M235 inventory group is replaced by F22;
the exact vehicle registry retains its existing names and identities. The
replacement archives complete prior inventory rows and any overwritten bin
rows in the private `otr_inventory_archive` schema before changing active
records. Unrelated inventory and the vehicle registry are checked for changes
within the replacement transaction. A recorded snapshot is a no-op on rerun,
so later crew edits are not overwritten.

The read-only production observation on November 12, 2026 was:

| Existing group | Records | Numeric units in existing schema |
| --- | ---: | ---: |
| E92 | 84 | 161 |
| M235 / M235iR | 53 | 151 |
| F30 | 103 | 234 |
| 986 Boxster | 58 | 146 |
| Total | 298 | 692 |

This differs from the original V1 seed's 297 records / 690 units. Live
M235 additions must be archived along with the other replaced records; the
update does not reconstruct production from the older seed. F30 and 986 Boxster
retain their current rows and counts. Based on this observation, the replacement
projects 366 active records: 215 workbook records plus 161 preserved F30/Boxster
records. A single global unit total would misrepresent the workbook's mixed
units and unknown quantities.

**Production application is withheld.** The JSON, schema changes, and replacement
SQL are prepared for review on the feature branch. No production migration or
inventory update is performed by the extraction or generation commands.

## Reproduce and review

Python uses only its standard library. From the repository root:

```bash
python scripts/import_inventory_workbook.py /path/to/OTR_Master_Inventory_F22_E92_Cooling_Update_2026-11-08.xlsx --output data/inventory/f22-e92-2026-11-08.json
node scripts/build_inventory_update.mjs
node scripts/build_inventory_update.mjs --check
node scripts/validate.mjs
```

The source attachment's filename is recorded for provenance. Re-extraction from
an identically named workbook with identical content produces the same JSON.
Source row identities are stable within this fixed snapshot, including
physically distinct repeated labels.

For a future approved rollout, the existing base inventory schema must be in
place. Apply prerequisites in this order: `supabase/label_assistant_schema.sql`,
then `supabase/inventory_count_schema.sql`, then the replacement SQL generated
at `supabase/update_inventory_f22_e92_20261108.sql` by
`node scripts/build_inventory_update.mjs`. The count schema allows unknown
quantities, preserves source quantity units and metadata, and adds parent-bin
relationships. Review the generated SQL and a current inventory backup before
the approved production rollout; do not run the historical inventory seed as
part of this replacement.
