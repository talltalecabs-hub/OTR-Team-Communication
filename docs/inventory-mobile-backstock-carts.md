# Mobile, Backstock, and chassis carts

Mobile inventory travels with the team. Backstock stays at the shop. These
inventory categories are separate from part categories such as Cooling or Brakes,
and from the chassis/platform and exact vehicle registry.

All 376 current inventory records start as Mobile. The upgrade adds a column
default rather than rewriting rows, so quantities, unknown counts, units, source
metadata, bins, timestamps, and part categories stay unchanged. Backstock begins
empty and can be populated as shop-held stock is added or reclassified.

## Browse and classify stock

Choose Inventory directly on the home page, then Mobile Inventory or Backstock. Mobile opens
the existing chassis selections; Backstock can also be filtered by chassis.
Search All Inventory includes both categories. Part cards display the assigned Bin ID without opening the item. Browse filters combine inventory
category, chassis, and cart location. Choose Open Bins from a chassis view to
browse all its registered bins, including 000, by ID and name in numeric order.
The bin list starts with all carts and can be narrowed afterward. Opening a bin
shows its direct contents only; sub-bins have separate links. Search Parts stays
available for cross-bin part lookup.

When adding inventory, choose Mobile or Backstock. Each item detail also has
Move to Backstock / Move to Mobile, which changes the category of the whole
inventory record without changing its quantity or verification state. The
Verify / Correct form also includes the category. Partial bin moves retain the
source record's Mobile/Backstock classification, units, and provenance.

## Assign physical cart locations

The cart registry contains E92-A/B, F22-A/B, F30-A/B, and 986-A/B. Location
displays one of these cart IDs, Backstock, or Unassigned. Each numbered bin
retains its existing Bin ID; its chassis/model and A/B placement determine its
cart ID. Bin labels and item cards use the same location names.

1. Open Label & Bin Assistant → Open Bin, or choose Bins / Cart Assignments
   while browsing a chassis inventory.
2. Choose the chassis, then open the bin.
3. Select Cart A or Cart B and choose Save Cart Location.

New bins can also be assigned a cart when created. The bin browser filters by
chassis and cart, and inventory browsing can filter parts by their bin's cart.
Item details retain the existing layout: Location displays a cart ID, Backstock, or Unassigned; Bin retains the existing Bin ID; Assignment displays Mobile Inventory or Backstock Inventory. Legacy vehicle-specific assignment information remains available. Cart location also appears on bin details and full 4×6 bin labels. Additional location
details remain available for a shelf or position on a cart.

Normal edits affect one bin at a time; parent and child placements do not cascade.
Unbinned parts can be placed directly on a cart. No quantities or physical
locations are inferred. On Add / Verify, choose Location, then a matching Bin ID.
Choosing Backstock also selects Backstock Inventory; choosing a cart or Unassigned
selects Mobile Inventory. All existing stock starts as Mobile.

## Confirmed E92 placements

The user supplied this initial map and corrected the labels: bin 018 and both
its Sensors and Seals sub-bins belong on Cart A; bin 019 (Exhaust) is on Cart B.

| E92 location | Numbered bins |
| --- | --- |
| Cart A | 01, 02, 03, 04, 05, 07, 08, 10, 12, 14, 16, 18, 20, 21 |
| Cart B | 06, 09, 11, 13, 15, 17, 19, 22 |

E92-018-A and E92-018-B are on Cart A. E92-022 is newly registered without
inventing any contents; its physical count remains unknown. The map has 14
Cart A numbered bins plus their bin-18 sub-bins (16 nodes total), and 8 Cart B
nodes. E92-019 retains its Exhaust description. F22 bins remain unassigned until
the team supplies their map.
The registry has 50 bin nodes after the loose-bin placeholders and E92-022 are
added; item counts remain 376.

## Loose and bulky parts

E92-000, F22-000, F30-000, and 986-000 are assignable Bin IDs for loose stock such
as radiators and rotors. They are shared chassis placeholders, not one physical
tote. An item in a 000 bin stores its own cart ID, so parts can share E92-000 while
some are on E92-A and others on E92-B. A 000 bin itself has no single cart.
Choose the cart and 000 Bin ID when adding/verifying an item, or choose the 000
destination and loose-item location in Add / Move Part to Bin. Partial moves
preserve quantities and apply the selected destination cart atomically.

## Upgrade and validation

For an existing V1.1 database, apply `supabase/inventory_stock_category_schema.sql`
before deploying the V1.2 frontend. It adds the inventory category and bin cart
fields, registers all eight carts and four 000 placeholders, validates allowed
values, and updates the atomic bin-assignment RPC to retain the inventory
category and apply the loose-item cart on splits. Rerunning it preserves later Backstock
choices and A/B placements. Apply `supabase/e92_cart_assignments.sql` once for the
confirmed map; its private marker prevents reruns from resetting later edits.
Do not rerun the historical inventory seed or workbook replacement for this upgrade.

For a new environment, the current label schema includes both fields; follow the
existing inventory setup and workbook import order, then apply the E92 map.

Static checks cover all JavaScript and inline handlers. Local PostgreSQL tests
verify defaults, unchanged counts and provenance, constraints, eight per-chassis carts, loose parts on both carts,
initial E92 placements, and rerun safety. Browser tests cover Mobile/Backstock and
cart filters, adding shop stock, reclassification, cart assignment, unknown
quantities, 27 screens, submissions, offline sync, and the 4×6 print workflow.
