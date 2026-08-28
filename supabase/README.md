# Supabase inventory files

Apply `schema.sql` and `submissions_schema.sql` before `seed_inventory.sql` on a new database.

`seed_inventory.sql` contains 297 unique inventory codes and uses `ON CONFLICT DO NOTHING`, so rerunning it will not overwrite quantities, verification state, locations, or other crew corrections.

`repair_001_inventory_id_collisions.sql` documents the one-time repair applied to production on August 28, 2026. The original seed generated 13 duplicate-code groups, collapsing 15 rows. The repair restored 297 records / 690 units and is safe to rerun.
