-- V2 protects management without changing inventory/submission row structures.
-- Provision and verify an owner account before applying this migration.
do $owner_preflight$
begin
  if not exists(select 1 from auth.users where raw_app_meta_data->>'otr_portal_role'='admin' and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=now())) then
    raise exception 'V2 rollout requires a verified, active owner Admin account first. See docs/v2-auth-rollout.md.';
  end if;
end $owner_preflight$;

create schema if not exists otr_portal_internal;
revoke all on schema otr_portal_internal from public;
grant usage on schema otr_portal_internal to anon,authenticated;

-- Only server-controlled app metadata grants a role. Reading the current Auth
-- record also makes role removals effective without waiting for JWT renewal.
create or replace function otr_portal_internal.portal_role()
returns text language sql stable security definer set search_path=pg_catalog as $$
  select coalesce((select case raw_app_meta_data->>'otr_portal_role' when 'admin' then 'admin' when 'staff' then 'staff' when 'manager' then 'staff' else 'public' end
    from auth.users where id=auth.uid() and email_confirmed_at is not null and deleted_at is null and (banned_until is null or banned_until<=now())),'public');
$$;
revoke all on function otr_portal_internal.portal_role() from public,anon,authenticated;
grant execute on function otr_portal_internal.portal_role() to anon,authenticated;

create or replace function otr_portal_internal.require_role(p_required text)
returns void language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if auth.uid() is null or p_required not in ('staff','admin') or p_required is null or
    (otr_portal_internal.portal_role()<>'admin' and (p_required='admin' or otr_portal_internal.portal_role()<>'staff')) then
    raise exception using errcode='42501',message='Sign in with an authorized team account to use this action';
  end if;
end;
$$;
revoke all on function otr_portal_internal.require_role(text) from public,anon,authenticated;
grant execute on function otr_portal_internal.require_role(text) to authenticated;

create or replace function public.portal_access()
returns jsonb language sql stable security invoker set search_path=pg_catalog as $$
  select jsonb_build_object('role',otr_portal_internal.portal_role(),'user_id',auth.uid());
$$;
revoke all on function public.portal_access() from public,anon,authenticated;
grant execute on function public.portal_access() to anon,authenticated;

-- Preserve the installed operation bodies/signatures/defaults, and put role
-- checks at their public entry points. Management implementations stay invoker.
-- Public Use Part alone gets a narrowly scoped private definer worker, because
-- anon loses all general table-write rights. Its existing exact-vehicle,
-- quantity, initials, retry and atomic-audit checks are retained verbatim.
do $protect_operations$
declare v_name text;v_proc record;v_implementation text;v_definition text;v_call_args text;v_required text;v_schema_name text;
begin
  foreach v_name in array array['assign_inventory_to_bin','commit_inventory_workspace_draft','create_inventory_stock','duplicate_inventory_workspace_draft','move_inventory_part','reconcile_inventory_stock','rename_inventory_bin','rename_inventory_part','retire_inventory_bin','save_inventory_workspace_draft','save_vehicle_registry','use_inventory_part'] loop
    select p.oid,pg_get_function_arguments(p.oid) arguments,pg_get_function_identity_arguments(p.oid) identity_arguments,pg_get_function_result(p.oid) result,p.proargnames into strict v_proc
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=v_name and p.prorettype<>'trigger'::regtype;
    v_implementation:=v_name||'_v2_impl';
    if not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='otr_portal_internal' and p.proname=v_implementation) then
      v_definition:=pg_get_functiondef(v_proc.oid);
      v_definition:=replace(v_definition,'FUNCTION public.'||v_name||'(','FUNCTION otr_portal_internal.'||v_implementation||'(');
      execute v_definition;
    end if;
    execute format('revoke all on function otr_portal_internal.%I(%s) from public,anon,authenticated',v_implementation,v_proc.identity_arguments);
    select string_agg(quote_ident(arg),',') into v_call_args from unnest(v_proc.proargnames) arg;
    if v_name='use_inventory_part' then
      execute format('alter function otr_portal_internal.%I(%s) security definer',v_implementation,v_proc.identity_arguments);
      execute format('grant execute on function otr_portal_internal.%I(%s) to anon,authenticated',v_implementation,v_proc.identity_arguments);
      v_required:='';
    else
      execute format('alter function otr_portal_internal.%I(%s) security invoker',v_implementation,v_proc.identity_arguments);
      execute format('grant execute on function otr_portal_internal.%I(%s) to authenticated',v_implementation,v_proc.identity_arguments);
      v_required:=format('perform otr_portal_internal.require_role(%L);',case when v_name='save_vehicle_registry' then 'admin' else 'staff' end);
    end if;
    execute format('create or replace function public.%I(%s) returns %s language plpgsql security invoker set search_path=pg_catalog as $wrapper$ begin %s return otr_portal_internal.%I(%s); end; $wrapper$',v_name,v_proc.arguments,v_proc.result,v_required,v_implementation,v_call_args);
    execute format('revoke all on function public.%I(%s) from public,anon,authenticated',v_name,v_proc.identity_arguments);
    execute format('grant execute on function public.%I(%s) to authenticated',v_name,v_proc.identity_arguments);
    if v_name='use_inventory_part' then execute format('grant execute on function public.%I(%s) to anon',v_name,v_proc.identity_arguments);end if;
  end loop;
end $protect_operations$;

-- Remove every old permissive beta policy on these app tables. The replacement
-- policies below are the full public/staff/admin access contract.
do $replace_beta_policies$
declare v_policy record;v_table text;
begin
  foreach v_table in array array['inventory_items','inventory_bins','inventory_carts','inventory_events','inventory_workspace_drafts','inventory_workspace_events','vehicles','vehicle_registry_events','submissions'] loop
    execute format('alter table public.%I enable row level security',v_table);
    for v_policy in select policyname from pg_policies where schemaname='public' and tablename=v_table loop
      execute format('drop policy %I on public.%I',v_policy.policyname,v_table);
    end loop;
    execute format('revoke all on table public.%I from public,anon,authenticated',v_table);
  end loop;
end $replace_beta_policies$;

grant select on public.inventory_items,public.inventory_bins,public.inventory_carts,public.vehicles to anon,authenticated;
create policy "V2 public inventory read" on public.inventory_items for select to anon,authenticated using(true);
create policy "V2 public bins read" on public.inventory_bins for select to anon,authenticated using(true);
create policy "V2 public carts read" on public.inventory_carts for select to anon,authenticated using(true);
create policy "V2 public vehicles read" on public.vehicles for select to anon,authenticated using(true);

grant insert,update on public.inventory_items,public.inventory_bins,public.inventory_workspace_drafts to authenticated;
grant select on public.inventory_workspace_drafts,public.inventory_events,public.inventory_workspace_events to authenticated;
create policy "V2 staff inventory insert" on public.inventory_items for insert to authenticated with check((select otr_portal_internal.portal_role()) in ('staff','admin'));
create policy "V2 staff inventory update" on public.inventory_items for update to authenticated using((select otr_portal_internal.portal_role()) in ('staff','admin')) with check((select otr_portal_internal.portal_role()) in ('staff','admin'));
create policy "V2 staff bins insert" on public.inventory_bins for insert to authenticated with check((select otr_portal_internal.portal_role()) in ('staff','admin'));
create policy "V2 staff bins update" on public.inventory_bins for update to authenticated using((select otr_portal_internal.portal_role()) in ('staff','admin')) with check((select otr_portal_internal.portal_role()) in ('staff','admin'));
create policy "V2 staff drafts read" on public.inventory_workspace_drafts for select to authenticated using((select otr_portal_internal.portal_role()) in ('staff','admin'));
create policy "V2 staff drafts insert" on public.inventory_workspace_drafts for insert to authenticated with check((select otr_portal_internal.portal_role()) in ('staff','admin'));
create policy "V2 staff drafts update" on public.inventory_workspace_drafts for update to authenticated using((select otr_portal_internal.portal_role()) in ('staff','admin')) with check((select otr_portal_internal.portal_role()) in ('staff','admin'));
create policy "V2 staff inventory history" on public.inventory_events for select to authenticated using((select otr_portal_internal.portal_role()) in ('staff','admin'));
create policy "V2 staff draft history" on public.inventory_workspace_events for select to authenticated using((select otr_portal_internal.portal_role()) in ('staff','admin'));

grant insert,update on public.vehicles to authenticated;
grant select on public.vehicle_registry_events,public.submissions to authenticated;
create policy "V2 admin vehicles insert" on public.vehicles for insert to authenticated with check((select otr_portal_internal.portal_role())='admin');
create policy "V2 admin vehicles update" on public.vehicles for update to authenticated using((select otr_portal_internal.portal_role())='admin') with check((select otr_portal_internal.portal_role())='admin');
create policy "V2 admin vehicle history" on public.vehicle_registry_events for select to authenticated using((select otr_portal_internal.portal_role())='admin');
create policy "V2 admin submissions read" on public.submissions for select to authenticated using((select otr_portal_internal.portal_role())='admin');
grant insert on public.submissions to anon,authenticated;
create policy "V2 public submissions" on public.submissions for insert to anon,authenticated with check(true);

-- Previously printed draft labels must still resolve publicly after a draft was
-- merged into existing stock. Expose only the two public lookup fields, never
-- unfinished card details or staff photo references.
create or replace function otr_portal_internal.public_tag_links()
returns table(tag_id text,inventory_item_id uuid) language sql stable security definer set search_path=pg_catalog as $$
  select d.tag_id,d.inventory_item_id from public.inventory_workspace_drafts d where d.inventory_item_id is not null;
$$;
revoke all on function otr_portal_internal.public_tag_links() from public,anon,authenticated;
grant execute on function otr_portal_internal.public_tag_links() to anon,authenticated;
create or replace function public.inventory_tag_links()
returns table(tag_id text,inventory_item_id uuid) language sql stable security invoker set search_path=pg_catalog as $$
  select * from otr_portal_internal.public_tag_links();
$$;
revoke all on function public.inventory_tag_links() from public,anon,authenticated;
grant execute on function public.inventory_tag_links() to anon,authenticated;

drop policy if exists "OTR workspace photo read" on storage.objects;
drop policy if exists "OTR workspace photo upload" on storage.objects;
create policy "V2 staff workspace photos" on storage.objects for select to authenticated using(bucket_id='otr-inventory-workspace' and (select otr_portal_internal.portal_role()) in ('staff','admin'));
create policy "V2 staff workspace upload" on storage.objects for insert to authenticated with check(bucket_id='otr-inventory-workspace' and (select otr_portal_internal.portal_role()) in ('staff','admin') and exists(select 1 from public.inventory_workspace_drafts where id::text=split_part(name,'/',1) and state='draft'));
create policy "V2 workspace boundary" on storage.objects as restrictive for all to anon,authenticated using(bucket_id<>'otr-inventory-workspace' or (select otr_portal_internal.portal_role()) in ('staff','admin')) with check(bucket_id<>'otr-inventory-workspace' or (select otr_portal_internal.portal_role()) in ('staff','admin'));
notify pgrst,'reload schema';
