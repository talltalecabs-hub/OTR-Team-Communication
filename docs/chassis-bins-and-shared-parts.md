# Chassis bins and shared parts — V1.3.2

New Bin IDs follow the established chassis sequence: E92-023, F22-012,
F30-009, or 986-004. The next suggestion is one above the largest registered
number for that chassis, ignoring legacy category-based IDs and treating
lettered sub-bins as belonging to their parent's number. Bin 000 remains
reserved for loose stock.

The suggestion is editable. System and subsystem remain classification fields
and never become part of the ID. Changing classification preserves a manual
ID; changing chassis starts that chassis's sequence. Use Next Available reloads
the shared registry. Manual numeric padding is normalized to at least three
digits. Lettered sub-bins require their numbered parent to exist.

Creation reloads shared bins, checks duplicates, and relies on database unique
constraints for concurrent requests. An automatic conflict retries once with the
next shared number. Manual choices are never silently renumbered. A stable
request UUID prevents a lost response from creating a second bin on retry.
Existing IDs, bin contents, carts, and print layouts are not rewritten.

Parts can be compatible with several chassis. Check Compatible chassis when
adding a part or on an existing part's detail page, then save with initials.
The primary chassis is included automatically. F22 and M235 / M235iR are treated
as the same chassis for compatibility searches and vehicle choices.

Both chassis searches show the same stock record and quantity. Compatibility
changes do not move stock, alter quantities, change physical cart/bin assignments,
or overwrite source provenance. The Use Part selector offers relevant vehicles
across the checked chassis; consumption still reduces one shared stock count.
The normal inventory ledger captures compatibility changes as metadata updates.

This is a frontend-only update using the existing compatibility field and bin
registry. No Supabase migration, seed, or bulk inventory change is required.
