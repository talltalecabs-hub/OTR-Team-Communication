# Administrative vehicle registry

Administrative → Vehicle Registry supports adding and editing names, numbers,
chassis, status and display order, plus removal from active choices and restoration.
Removing a vehicle keeps its stable key, earlier reports, inventory assignments,
and consumption history. Include removed vehicles to restore one.

Every portal change requires visible initials and an immutable before/after event.
Revision checks prevent an older editor from overwriting a newer change. New
vehicle creation retains its generated key if the response is lost. Direct
registry deletion is not granted to portal roles.

The owner requested Phoenix #69x in place of Hulk on 2026-11-20. The live shared
row now reads Phoenix / 69x / Active while retaining E92-HULK as its historical
key and E92 as its chassis. The actual before/after records are retained in
`data/vehicle-registry/phoenix-20261120.json`. The migration records this owner
request separately without inventing crew initials.

The existing beta Administrative access model remains. Initials are accountability,
not authenticated identity. RLS applies to the registry and history; private audit
writers have fixed search paths, and public save RPCs use invoker permissions.
A failed audit rolls back its registry update. New use of a removed vehicle is
blocked atomically, while replay of an earlier successful use remains valid.

The migration is `20261120202150_admin_vehicle_registry.sql`.
Local checks: `node scripts/validate.mjs`, `python scripts/test_portal.py`, and
`scripts/test_vehicle_admin.mjs` with PGlite. The isolated database checks and
34-screen browser suite passed before integration with later frontend patches.
