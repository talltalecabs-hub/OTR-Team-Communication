# V2.0 design and authenticated management

V2 starts from main `90610eb61d4a96b587bffaad339b8a544c628e46` (V1.3.4).
The supplied handoff did not pin a baseline commit. The implementation preserves
the newer shared creation board, Add/Replace/Separate stock intake, editable
part/bin names, bin retirement, parent-cart inheritance, compatibility, exact
vehicle registry, initials/ledger rules and all three label presets.

## UI and navigation

The homepage order is Driver's Lounge, Inventory, Feedback paired with
Post-Event Crew Questionnaire, Report a Problem paired with Leave an Idea,
then Work in the Shop. Administrative stays below the primary stack. The OTR
wordmark is a local SVG, the heading is Team Portal, and the communications
banner is removed. Existing screen IDs, public submission types and history
handling remain intact. The new presentation is in `assets/v2.css`.

Protected entry points save a tab-local destination and item/bin context.
Successful login replaces the sign-in history entry with that destination.
Blocked Save actions return to the form for review; login never silently
replays an inventory mutation. Back/forward navigation is checked as well as
button clicks. Sign-out clears protected client caches and stops queued work.

## Roles and enforcement

| Capability | Public or unassigned account | Staff / Manager | Admin |
| --- | --- | --- | --- |
| Driver's Lounge, Feedback, event questionnaire, problems, ideas, public shop forms | Yes | Yes | Yes |
| Inventory/chassis/bin/part browse, Mobile and Backstock search | Yes | Yes | Yes |
| Use Part, with the existing exact-vehicle and initials requirements | Yes | Yes | Yes |
| Inventory creation, placement, corrections, notes, flags, carts, labels that change records | No | Yes | Yes |
| Shared drafts, workspace photos and inventory activity | No | Yes | Yes |
| Administrative, submission review, Local Queue tools and vehicle changes | No | No | Yes |
| Submit an Admin access request | Yes | Yes | Yes |

Roles are stored in **server-controlled** `auth.users.raw_app_meta_data` as
`otr_portal_role: "staff"` or `"admin"`. `"manager"` is normalized to staff.
No role, an unknown role, an unconfirmed/deleted/banned account, or no valid
identity means public access. User-editable `user_metadata` is never trusted.
The private role helper reads the current Auth record, so removing a role
does not wait for a stale JWT claim to expire.

RLS and grants deny anonymous management table writes, protected reads and
management RPCs. Staff/admin RPC entry points also check the role. The installed
operation bodies, arguments and defaults are retained in private invoker
implementations. Public Use Part is the deliberate exception: a narrow private
definer worker preserves the existing validated decrement and atomic ledger
operation without granting general inventory UPDATE to public clients. It
cannot set arbitrary names, placement, flags or counts. The public wrapper
remains invoker. Another narrow read worker exposes only committed tag-to-item
links, preserving previously printed merged-draft identities without exposing
unfinished cards. Other management workers remain invoker.

Storage policies allow staff/admin access to the private workspace bucket;
a restrictive boundary prevents broader unrelated policies from opening it.
Existing signed URLs have their ordinary expiry. None of the inventory,
submission, vehicle, bin/cart or ledger row structures are changed.

## Auth client and sessions

The static site vendors the official Supabase JS **2.119.2** browser bundle.
The package tarball's SHA-512 integrity was verified. Its exact version,
source, bundle SHA-256 and license are under `assets/vendor/`. There is no
runtime CDN dependency or service-role key in the browser.

Email/password login uses Supabase Auth. The SDK manages token renewal; only
this tab's sessionStorage retains the session across a refresh, with an
in-memory fallback when tab storage is unavailable. Passwords are never written
to app storage. Inventory drafts and photos remain in Supabase. Existing
offline submission queue behavior is preserved. Role verification uses an
Auth user check and the server `portal_access()` RPC; getSession alone is not
used to authorize management.

The access-request form under sign-in writes the existing submissions table
with type `admin_access_request`, name, email, reason and requested role. It is
visible in Administrative → Form Submissions → Admin Access Requests. It never
creates an account or grants a role automatically. Approval and role assignment
remain deliberate administrator operations for this first version.

## Owner account and rollout sequence

1. **Provision the owner first.** Create an email/password account through
   Supabase Auth. Confirm the email and assign `otr_portal_role: "admin"` using
   trusted server administration. Verify the actual password sign-in and the
   returned Admin app metadata. Deliver the password privately to the owner;
   never commit account credentials, password hashes or session tokens.
2. **Configure Auth URLs.** In the project's Auth → URL Configuration, use
   `https://talltalecabs-hub.github.io/OTR-Team-Communication/` as Site URL and
   an allowed redirect. `localhost:3000` is not a production return URL.
   A verification can succeed before a bad return URL fails; check account
   confirmation before sending another email. The owner reported the URL
   correction complete during preparation.
3. **Review and run the checks below.** Keep the PR open until behavior and the
   owner's ability to sign in are verified. The migration deliberately refuses
   to run without an active, email-confirmed Admin account.
4. **Coordinate database and frontend publication.** Apply only
   `supabase/migrations/20261123001608_portal_v2_auth_access.sql` to the existing
   V1.3.4 project, then publish the reviewed V2 frontend from main and refresh
   open tabs. Public browse, forms and the old Use Part signature remain
   compatible during this short window. Old cached management clients will be
   denied and must refresh/sign in. Do not leave only half of the rollout done.
5. **Smoke-check as owner and logged out.** Confirm the owner can enter
   Administrative and management, then sign out and verify public search/use
   still works while direct management writes are denied.

Do **not** rerun the historical beta schema/seed files over a secured production
database: they can reintroduce anonymous policies. Do not reseed inventory or
the vehicle registry. This migration changes access only.

To assign a reviewed existing account, run trusted server administration after
checking its actual Auth user ID. For example, in the SQL editor:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
      || jsonb_build_object('otr_portal_role', 'staff'),
    updated_at = now()
where id = '<REVIEWED_AUTH_USER_UUID>'::uuid
  and email_confirmed_at is not null
  and deleted_at is null
returning id, raw_app_meta_data->>'otr_portal_role';
```

Use `admin` only for an approved administrator. Remove the metadata key to
revoke management access. Never copy a requested role from a public form or
user metadata into an authorization decision. A role editor/automatic approval
workflow is outside this pass.

## Verification

- `node scripts/validate.mjs`: syntax, inline handlers, canonical seed/workbook
  and label specifications.
- `python scripts/test_portal.py`: real browser with intercepted Supabase/Auth
  endpoints; public search/use, direct API denials, Staff/Admin/default-deny
  roles, login destinations, refresh/sign-out/back navigation, access requests,
  all prior inventory/submission/label flows, and 390/800/1280-width layouts.
- `scripts/test_auth_access.mjs`: actual isolated PostgreSQL RLS/grants/RPCs;
  owner rollout guard, unchanged baseline data, forged/stale metadata denial,
  public decrement/ledger/retry, staff/admin separation, protected Storage and
  public stable-tag lookup.
- Existing `test_inventory_update.mjs`, `test_inventory_crew.mjs`,
  `test_vehicle_admin.mjs`, `test_inventory_workspace.mjs` remain historical
  migration-stage regression checks. They run without production connections.

Set `PGLITE_MODULE` to an installed PGlite `dist/index.js` for SQL checks.
Browser fixtures use fake credentials only; no test login sends email or
touches production. Provisioning the real owner is a separate, authorized
operation, and its secret file stays outside this repository.
