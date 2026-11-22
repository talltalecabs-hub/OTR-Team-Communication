-- Vehicle administration within the portal's existing beta crew-access model.
-- Removing a vehicle hides it from new selections; it never deletes history.
alter table public.vehicles add column if not exists is_active boolean not null default true;
alter table public.vehicles add column if not exists revision integer not null default 1;
create index if not exists vehicles_active_platform_idx on public.vehicles(is_active,platform,display_order);
create table if not exists public.vehicle_registry_events (
  id uuid primary key default gen_random_uuid(),
  vehicle_code text not null references public.vehicles(vehicle_code) on delete restrict,
  event_type text not null check(event_type in ('vehicle_added','vehicle_updated','vehicle_removed','vehicle_restored')),
  actor_source text not null default 'portal' check(actor_source in ('portal','owner_request')),
  actor_initials text,
  from_state jsonb,
  to_state jsonb not null,
  notes text,
  created_at timestamptz not null default now(),
  check((actor_source='portal' and actor_initials is not null and actor_initials=upper(btrim(actor_initials)) and char_length(actor_initials) between 1 and 8 and actor_initials !~ '[[:cntrl:]]') or (actor_source='owner_request' and actor_initials is null and notes is not null))
);
create index if not exists vehicle_registry_events_vehicle_idx on public.vehicle_registry_events(vehicle_code,created_at desc);
alter table public.vehicle_registry_events enable row level security;
revoke all on public.vehicle_registry_events from public,anon,authenticated;
grant select on public.vehicle_registry_events to anon;
drop policy if exists "OTR vehicle history read" on public.vehicle_registry_events;
create policy "OTR vehicle history read" on public.vehicle_registry_events for select to anon using(true);
drop trigger if exists vehicle_registry_events_immutable on public.vehicle_registry_events;
create trigger vehicle_registry_events_immutable before update or delete on public.vehicle_registry_events for each row execute function otr_inventory_internal.reject_event_mutation();

create or replace function otr_inventory_internal.guard_vehicle_registry()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare v_actor text;v_headers jsonb;
begin
  if tg_op='DELETE' then raise exception 'Remove the vehicle from active choices instead of deleting its history'; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  v_actor:=upper(btrim(coalesce(nullif(current_setting('otr.vehicle_actor_initials',true),''),v_headers->>'x-otr-initials','')));
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required (1 to 8 characters)'; end if;
  if tg_op='INSERT' then
    if new.revision<>1 then raise exception 'New vehicles start at revision 1'; end if;
    new.created_at:=now();
  else
    if new.vehicle_code<>old.vehicle_code or new.created_at<>old.created_at then raise exception 'Vehicle identity and history links cannot change'; end if;
    if new.revision<>old.revision+1 then raise exception 'Vehicle revision must advance by one'; end if;
  end if;
  new.vehicle_name:=btrim(new.vehicle_name);new.platform:=btrim(new.platform);
  new.designation:=nullif(btrim(new.designation),'');new.status:=btrim(new.status);
  if new.vehicle_code !~ '^[A-Z0-9][A-Z0-9-]{2,79}$' or char_length(new.vehicle_name) not between 1 and 120 or char_length(new.platform) not between 1 and 80 or char_length(new.status) not between 1 and 40 or char_length(coalesce(new.designation,''))>40 then raise exception 'Enter a vehicle name, chassis and status within the allowed lengths'; end if;
  new.updated_at:=now();return new;
end;
$$;
revoke all on function otr_inventory_internal.guard_vehicle_registry() from public,anon,authenticated;
create or replace function otr_inventory_internal.audit_vehicle_registry()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v_actor text;v_headers jsonb;v_before jsonb;v_type text;
begin
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  v_actor:=upper(btrim(coalesce(nullif(current_setting('otr.vehicle_actor_initials',true),''),v_headers->>'x-otr-initials','')));
  if tg_op='INSERT' then v_type:='vehicle_added';else
    v_before:=to_jsonb(old);
    v_type:=case when old.is_active and not new.is_active then 'vehicle_removed' when not old.is_active and new.is_active then 'vehicle_restored' else 'vehicle_updated' end;
  end if;
  insert into public.vehicle_registry_events(vehicle_code,event_type,actor_initials,from_state,to_state)
  values(new.vehicle_code,v_type,v_actor,v_before,to_jsonb(new));
  return new;
end;
$$;
revoke all on function otr_inventory_internal.audit_vehicle_registry() from public,anon,authenticated;
drop trigger if exists vehicles_require_actor on public.vehicles;
create trigger vehicles_require_actor before insert or update or delete on public.vehicles for each row execute function otr_inventory_internal.guard_vehicle_registry();
drop trigger if exists vehicles_audit on public.vehicles;
create trigger vehicles_audit after insert or update on public.vehicles for each row execute function otr_inventory_internal.audit_vehicle_registry();
grant insert,update on public.vehicles to anon;
drop policy if exists "OTR vehicle admin create" on public.vehicles;
create policy "OTR vehicle admin create" on public.vehicles for insert to anon with check(true);
drop policy if exists "OTR vehicle admin update" on public.vehicles;
create policy "OTR vehicle admin update" on public.vehicles for update to anon using(true) with check(true);

create or replace function public.save_vehicle_registry(p_vehicle_code text,p_revision integer,p_changes jsonb,p_actor_initials text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_row public.vehicles%rowtype;v_actor text:=upper(btrim(coalesce(p_actor_initials,'')));v_previous text:=coalesce(current_setting('otr.vehicle_actor_initials',true),'');v_key text;
begin
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required'; end if;
  if p_vehicle_code is null or p_revision is null or p_revision<0 or jsonb_typeof(p_changes) is distinct from 'object' then raise exception 'Invalid vehicle update'; end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('vehicle_name','designation','platform','status','display_order','is_active') then raise exception 'Unknown vehicle field'; end if;
  end loop;
  select * into v_row from public.vehicles where vehicle_code=p_vehicle_code for update;
  if found and p_revision=0 then return to_jsonb(v_row); end if;
  if found and v_row.revision<>p_revision then raise exception using errcode='40001',message='This vehicle changed since you opened it. Reload before saving.'; end if;
  if not found and p_revision<>0 then raise exception 'Vehicle not found'; end if;
  perform set_config('otr.vehicle_actor_initials',v_actor,true);
  if v_row.vehicle_code is null then
    insert into public.vehicles(vehicle_code,vehicle_name,designation,platform,status,display_order,is_active)
    values(p_vehicle_code,p_changes->>'vehicle_name',p_changes->>'designation',p_changes->>'platform',coalesce(p_changes->>'status','Active'),coalesce((p_changes->>'display_order')::integer,0),coalesce((p_changes->>'is_active')::boolean,true))
    on conflict(vehicle_code) do nothing;
    select * into strict v_row from public.vehicles where vehicle_code=p_vehicle_code;
  else
    update public.vehicles set vehicle_name=coalesce(p_changes->>'vehicle_name',vehicle_name),
      designation=case when p_changes ? 'designation' then p_changes->>'designation' else designation end,
      platform=coalesce(p_changes->>'platform',platform),status=coalesce(p_changes->>'status',status),
      display_order=coalesce((p_changes->>'display_order')::integer,display_order),is_active=coalesce((p_changes->>'is_active')::boolean,is_active),revision=revision+1
    where vehicle_code=p_vehicle_code returning * into v_row;
  end if;
  perform set_config('otr.vehicle_actor_initials',v_previous,true);
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.save_vehicle_registry(text,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.save_vehicle_registry(text,integer,jsonb,text) to anon;

-- Apply the active check at event insertion. Replays of an already successful
-- request remain valid even if the vehicle was subsequently removed.
create or replace function otr_inventory_internal.guard_active_use_vehicle()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  if new.event_type='use_part' and not exists(select 1 from public.vehicles where vehicle_code=new.vehicle_code and is_active) then raise exception 'This vehicle was removed from active choices. Select an active vehicle.'; end if;
  return new;
end;
$$;
revoke all on function otr_inventory_internal.guard_active_use_vehicle() from public,anon,authenticated;
drop trigger if exists inventory_events_active_vehicle on public.inventory_events;
create trigger inventory_events_active_vehicle before insert on public.inventory_events for each row execute function otr_inventory_internal.guard_active_use_vehicle();
notify pgrst,'reload schema';

-- Capture the explicitly requested rename already applied on 2026-11-20.
-- No initials were supplied for that owner request; do not invent any.
insert into public.vehicle_registry_events(vehicle_code,event_type,actor_source,actor_initials,from_state,to_state,notes,created_at)
select 'E92-HULK','vehicle_updated','owner_request',null,'{"status":"Deceased","platform":"E92","created_at":"2026-08-28T18:20:57.78192+00:00","updated_at":"2026-08-28T18:20:57.78192+00:00","designation":"63","vehicle_code":"E92-HULK","vehicle_name":"Hulk","display_order":30}'::jsonb,'{"status":"Active","platform":"E92","created_at":"2026-08-28T18:20:57.78192+00:00","updated_at":"2026-11-20T20:22:22.304582+00:00","designation":"69x","vehicle_code":"E92-HULK","vehicle_name":"Phoenix","display_order":30}'::jsonb,'Owner requested: replace Hulk with Phoenix #69x. Stable vehicle key retained.','2026-11-20T20:22:22.304582Z'::timestamptz
where exists(select 1 from public.vehicles where vehicle_code='E92-HULK') and not exists(select 1 from public.vehicle_registry_events where vehicle_code='E92-HULK' and actor_source='owner_request' and notes like 'Owner requested: replace Hulk with Phoenix #69x%');
