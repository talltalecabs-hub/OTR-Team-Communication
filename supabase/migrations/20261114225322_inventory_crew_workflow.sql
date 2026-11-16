-- Crew workflow ledger. Apply after the existing inventory, cart and bin schemas.
-- Existing inventory rows are not rewritten or backfilled with invented events.
-- Pin the existing timestamp helper as well as the new audit/RPC functions.
alter function public.set_inventory_updated_at() set search_path=pg_catalog;

create schema if not exists otr_inventory_internal;
revoke all on schema otr_inventory_internal from public, anon, authenticated;

create table if not exists public.inventory_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  event_type text not null check (event_type in (
    'use_part','add_stock','quantity_corrected','move_inventory',
    'stock_category_changed','bin_assigned','verification_changed',
    'reorder_flag_changed','metadata_changed','bin_created','bin_moved','bin_updated'
  )),
  actor_initials text not null check (
    actor_initials = upper(btrim(actor_initials)) and
    char_length(actor_initials) between 1 and 8 and
    actor_initials !~ '[[:cntrl:]]'
  ),
  inventory_item_id uuid references public.inventory_items(id) on delete restrict,
  inventory_code text,
  bin_id uuid references public.inventory_bins(id) on delete restrict,
  bin_code text,
  cart_code text,
  vehicle_code text references public.vehicles(vehicle_code) on delete restrict,
  quantity_delta integer,
  quantity_before integer,
  quantity_after integer,
  from_state jsonb,
  to_state jsonb,
  notes text,
  source text not null default 'portal',
  request_id uuid not null default gen_random_uuid(),
  operation_item_id uuid,
  operation_data jsonb
);
create index if not exists inventory_events_item_created_idx
  on public.inventory_events(inventory_item_id,created_at desc) where inventory_item_id is not null;
create index if not exists inventory_events_bin_created_idx
  on public.inventory_events(bin_id,created_at desc) where bin_id is not null;
create index if not exists inventory_events_vehicle_created_idx
  on public.inventory_events(vehicle_code,created_at desc) where vehicle_code is not null;
create index if not exists inventory_events_created_idx on public.inventory_events(created_at desc);
create index if not exists inventory_events_request_idx on public.inventory_events(request_id,event_type);
create unique index if not exists inventory_events_use_request_uidx
  on public.inventory_events(request_id) where event_type='use_part';
create unique index if not exists inventory_events_move_item_request_uidx
  on public.inventory_events(request_id,inventory_item_id) where event_type='move_inventory';

alter table public.inventory_events enable row level security;
revoke all on public.inventory_events from public,anon,authenticated;
grant select on public.inventory_events to anon;
drop policy if exists "OTR inventory events anon read" on public.inventory_events;
create policy "OTR inventory events anon read"
  on public.inventory_events for select to anon using(true);

create or replace function otr_inventory_internal.reject_event_mutation()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  raise exception 'Inventory events are append-only';
end;
$$;
revoke all on function otr_inventory_internal.reject_event_mutation() from public,anon,authenticated;
drop trigger if exists inventory_events_immutable on public.inventory_events;
create trigger inventory_events_immutable before update or delete on public.inventory_events
  for each row execute function otr_inventory_internal.reject_event_mutation();

-- This trigger validates caller-supplied initials at the database boundary.
-- It has no client-callable grants and never performs inventory DML itself.
create or replace function otr_inventory_internal.guard_inventory_mutation()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_headers jsonb;
  v_actor text;
  v_bin public.inventory_bins%rowtype;
  v_expected_cart text;
  v_placement_changed boolean;
begin
  if tg_op='DELETE' then
    raise exception 'Inventory records cannot be deleted; use review or stock status instead';
  end if;
  begin
    v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  exception when invalid_text_representation then
    v_headers:='{}'::jsonb;
  end;
  v_actor:=upper(btrim(coalesce(nullif(current_setting('otr.actor_initials',true),''),v_headers->>'x-otr-initials','')));
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then
    raise exception 'Initials are required (1 to 8 characters)';
  end if;

  if tg_table_name='inventory_items' then
    if tg_op='INSERT' then
      v_placement_changed:=true;
    else
      v_placement_changed:=row(new.stock_category,new.platform,new.inventory_bin_id,new.cart_code)
        is distinct from row(old.stock_category,old.platform,old.inventory_bin_id,old.cart_code);
    end if;
    -- Existing historical placement is preserved unless it is explicitly changed.
    if v_placement_changed then
      if new.stock_category='Backstock' and new.cart_code is not null then
        raise exception 'Backstock cannot have a mobile cart assignment';
      end if;
      if new.cart_code is not null and not exists(
        select 1 from public.inventory_carts where cart_code=new.cart_code and platform=new.platform
      ) then
        raise exception 'Cart must match the item chassis';
      end if;
      if new.inventory_bin_id is not null then
        select * into v_bin from public.inventory_bins where id=new.inventory_bin_id;
        if not found then raise exception 'Inventory bin not found'; end if;
        if new.platform is distinct from v_bin.model then
          raise exception 'Bin must match the item chassis';
        end if;
        if v_bin.bin_code !~ '-000$' then
          if new.cart_code is not null then
            raise exception 'Binned stock inherits its cart from the bin';
          end if;
          if new.stock_category='Backstock' and v_bin.cart_location is not null then
            raise exception 'Backstock cannot be placed in a mobile cart bin';
          end if;
        end if;
      end if;
    end if;
  elsif tg_table_name='inventory_bins' then
    if new.cart_location is not null and not exists(
      select 1 from public.inventory_carts where platform=new.model and cart_letter=new.cart_location
    ) then
      raise exception 'Cart must exist for this chassis';
    end if;
    if tg_op='UPDATE' and row(new.model,new.cart_location,new.bin_code)
      is distinct from row(old.model,old.cart_location,old.bin_code) then
      if exists(select 1 from public.inventory_items where inventory_bin_id=new.id and platform is distinct from new.model) then
        raise exception 'Bin chassis must match its existing inventory';
      end if;
      if new.bin_code !~ '-000$' and exists(
        select 1 from public.inventory_items where inventory_bin_id=new.id and
          (cart_code is not null or (stock_category='Backstock' and new.cart_location is not null))
      ) then
        raise exception 'Bin placement conflicts with its existing inventory';
      end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function otr_inventory_internal.guard_inventory_mutation() from public,anon,authenticated;

create or replace function otr_inventory_internal.snapshot_inventory_location(p_state jsonb,p_table text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare
  v_bin public.inventory_bins%rowtype;
  v_cart text;
  v_location text;
  v_bin_code text;
begin
  if p_state is null then return null; end if;
  if p_table='inventory_bins' then
    v_bin_code:=p_state->>'bin_code';
    if p_state->>'cart_location' is not null then
      v_cart:=(case when p_state->>'model'='986 Boxster' then '986' else p_state->>'model' end)||'-'||(p_state->>'cart_location');
    end if;
  else
    if p_state->>'inventory_bin_id' is not null then
      select * into v_bin from public.inventory_bins where id=(p_state->>'inventory_bin_id')::uuid;
      v_bin_code:=v_bin.bin_code;
    end if;
    if p_state->>'stock_category'='Backstock' then v_location:='Backstock';
    elsif v_bin.id is not null and v_bin.bin_code !~ '-000$' then
      if v_bin.cart_location is not null then
        v_cart:=(case when v_bin.model='986 Boxster' then '986' else v_bin.model end)||'-'||v_bin.cart_location;
      end if;
    else v_cart:=p_state->>'cart_code'; end if;
  end if;
  return p_state||jsonb_build_object('physical_location',coalesce(v_location,v_cart,'Unassigned'),'physical_cart_code',v_cart,'physical_bin_code',v_bin_code);
end;
$$;
revoke all on function otr_inventory_internal.snapshot_inventory_location(jsonb,text) from public,anon,authenticated;

-- The only privileged write is inserting an audit event from a table trigger.
-- Keeping it outside the exposed public schema prevents direct RPC execution.
create or replace function otr_inventory_internal.audit_inventory_mutation()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_before jsonb;
  v_after jsonb:=to_jsonb(new);
  v_headers jsonb;
  v_actor text;
  v_type text;
  v_item_id uuid;
  v_inventory_code text;
  v_bin_id uuid;
  v_bin_code text;
  v_cart text;
  v_vehicle text;
  v_quantity_before integer;
  v_quantity_after integer;
  v_delta integer;
  v_request uuid;
  v_operation_item uuid;
  v_operation_data jsonb;
  v_bin public.inventory_bins%rowtype;
begin
  if tg_op='UPDATE' then v_before:=to_jsonb(old); end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  v_actor:=upper(btrim(coalesce(nullif(current_setting('otr.actor_initials',true),''),v_headers->>'x-otr-initials','')));
  v_type:=nullif(current_setting('otr.inventory_event_type',true),'');
  if v_type not in ('use_part','move_inventory') then v_type:=null; end if;
  v_request:=coalesce(nullif(current_setting('otr.inventory_request_id',true),'')::uuid,gen_random_uuid());
  v_operation_item:=nullif(current_setting('otr.inventory_operation_item_id',true),'')::uuid;
  v_operation_data:=nullif(current_setting('otr.inventory_operation_data',true),'')::jsonb;

  if tg_table_name='inventory_items' then
    v_item_id:=new.id;
    v_inventory_code:=new.inventory_code;
    v_bin_id:=new.inventory_bin_id;
    v_quantity_after:=new.quantity;
    if tg_op='UPDATE' then v_quantity_before:=old.quantity; end if;
    v_delta:=case when tg_op='INSERT' then v_quantity_after else v_quantity_after-v_quantity_before end;
    if v_type='use_part' then
      v_delta:=nullif(current_setting('otr.inventory_quantity_delta',true),'')::integer;
      v_vehicle:=nullif(current_setting('otr.inventory_vehicle_code',true),'');
    end if;
    if v_bin_id is not null then
      select * into v_bin from public.inventory_bins where id=v_bin_id;
      v_bin_code:=v_bin.bin_code;
    end if;
    if new.stock_category='Mobile' then
      if new.inventory_bin_id is not null and v_bin.bin_code !~ '-000$' then
        if v_bin.cart_location is not null then
          v_cart:=(case when v_bin.model='986 Boxster' then '986' else v_bin.model end)||'-'||v_bin.cart_location;
        end if;
      else v_cart:=new.cart_code;
      end if;
    end if;
    if v_type is null then
      if tg_op='INSERT' then v_type:='add_stock';
      elsif new.quantity is distinct from old.quantity then v_type:='quantity_corrected';
      elsif new.stock_category is distinct from old.stock_category then v_type:='stock_category_changed';
      elsif row(new.inventory_bin_id,new.cart_code,new.platform) is distinct from row(old.inventory_bin_id,old.cart_code,old.platform) then
        v_type:=case when old.inventory_bin_id is null and new.inventory_bin_id is not null then 'bin_assigned' else 'move_inventory' end;
      elsif row(new.verification_status,new.status,new.verified_at,new.verified_by) is distinct from row(old.verification_status,old.status,old.verified_at,old.verified_by) then v_type:='verification_changed';
      elsif row(new.reorder_flag,new.reorder_level) is distinct from row(old.reorder_flag,old.reorder_level) then v_type:='reorder_flag_changed';
      else v_type:='metadata_changed'; end if;
    end if;
  else
    v_bin_id:=new.id;
    v_bin_code:=new.bin_code;
    if new.cart_location is not null then
      v_cart:=(case when new.model='986 Boxster' then '986' else new.model end)||'-'||new.cart_location;
    end if;
    if tg_op='INSERT' then v_type:='bin_created';
    elsif row(new.model,new.cart_location,new.location,new.parent_bin_id) is distinct from row(old.model,old.cart_location,old.location,old.parent_bin_id) then v_type:='bin_moved';
    else v_type:='bin_updated'; end if;
  end if;

  v_before:=otr_inventory_internal.snapshot_inventory_location(v_before,tg_table_name);
  v_after:=otr_inventory_internal.snapshot_inventory_location(v_after,tg_table_name);
  insert into public.inventory_events(
    event_type,actor_initials,inventory_item_id,inventory_code,bin_id,bin_code,cart_code,
    vehicle_code,quantity_delta,quantity_before,quantity_after,from_state,to_state,
    request_id,operation_item_id,operation_data
  ) values (
    v_type,v_actor,v_item_id,v_inventory_code,v_bin_id,v_bin_code,v_cart,
    v_vehicle,v_delta,v_quantity_before,v_quantity_after,v_before,v_after,
    v_request,v_operation_item,v_operation_data
  );
  return new;
end;
$$;
revoke all on function otr_inventory_internal.audit_inventory_mutation() from public,anon,authenticated;

drop trigger if exists inventory_items_require_initials on public.inventory_items;
create trigger inventory_items_require_initials before insert or update or delete on public.inventory_items
  for each row execute function otr_inventory_internal.guard_inventory_mutation();
drop trigger if exists inventory_items_audit_event on public.inventory_items;
create trigger inventory_items_audit_event after insert or update on public.inventory_items
  for each row execute function otr_inventory_internal.audit_inventory_mutation();
drop trigger if exists inventory_bins_require_initials on public.inventory_bins;
create trigger inventory_bins_require_initials before insert or update or delete on public.inventory_bins
  for each row execute function otr_inventory_internal.guard_inventory_mutation();
drop trigger if exists inventory_bins_audit_event on public.inventory_bins;
create trigger inventory_bins_audit_event after insert or update on public.inventory_bins
  for each row execute function otr_inventory_internal.audit_inventory_mutation();

create or replace function public.use_inventory_part(
  p_item_id uuid,
  p_vehicle_code text,
  p_quantity integer,
  p_actor_initials text,
  p_request_id uuid
)
returns jsonb language plpgsql security invoker set search_path=pg_catalog
-- Function-local GUC scopes restore all audit context on return or exception;
-- another inventory action in the same transaction must use its own initials.
set otr.actor_initials='' set otr.inventory_event_type=''
set otr.inventory_request_id='' set otr.inventory_operation_item_id=''
set otr.inventory_operation_data='' set otr.inventory_vehicle_code=''
set otr.inventory_quantity_delta='' as $$
declare
  v_actor text:=upper(btrim(coalesce(p_actor_initials,'')));
  v_item public.inventory_items%rowtype;
  v_event public.inventory_events%rowtype;
  v_operation jsonb;
  v_after integer;
begin
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required (1 to 8 characters)'; end if;
  if p_quantity is null or p_quantity<1 then raise exception 'Quantity used must be at least 1'; end if;
  if p_request_id is null then raise exception 'Request ID is required'; end if;
  if not exists(select 1 from public.vehicles where vehicle_code=p_vehicle_code) then raise exception 'Select an existing vehicle'; end if;
  select * into v_item from public.inventory_items where id=p_item_id for update;
  if not found then raise exception 'Inventory item not found'; end if;
  v_operation:=jsonb_build_object('item_id',p_item_id,'vehicle_code',p_vehicle_code,'quantity',p_quantity,'actor_initials',v_actor);
  select * into v_event from public.inventory_events where request_id=p_request_id and event_type='use_part';
  if found then
    if v_event.operation_data is distinct from v_operation then raise exception 'Request ID was already used for a different operation'; end if;
    return jsonb_build_object('event_id',v_event.id,'item_id',p_item_id,'quantity_before',v_event.quantity_before,'quantity_after',v_event.quantity_after,'quantity_used',p_quantity,'vehicle_code',p_vehicle_code,'actor_initials',v_actor,'replayed',true);
  end if;
  if v_item.quantity is not null and p_quantity>v_item.quantity then raise exception 'Quantity used exceeds available stock'; end if;
  v_after:=v_item.quantity-p_quantity;
  perform set_config('otr.actor_initials',v_actor,true);
  perform set_config('otr.inventory_event_type','use_part',true);
  perform set_config('otr.inventory_request_id',p_request_id::text,true);
  perform set_config('otr.inventory_operation_item_id',p_item_id::text,true);
  perform set_config('otr.inventory_operation_data',v_operation::text,true);
  perform set_config('otr.inventory_vehicle_code',p_vehicle_code,true);
  perform set_config('otr.inventory_quantity_delta',(-p_quantity)::text,true);
  update public.inventory_items set
    quantity=v_after,
    status=case when v_after=0 then 'Out of Stock' else status end,
    updated_at=now()
  where id=p_item_id;
  select * into v_event from public.inventory_events where request_id=p_request_id and event_type='use_part';
  if not found then raise exception 'Inventory event was not recorded'; end if;
  return jsonb_build_object('event_id',v_event.id,'item_id',p_item_id,'quantity_before',v_item.quantity,'quantity_after',v_after,'quantity_used',p_quantity,'vehicle_code',p_vehicle_code,'actor_initials',v_actor,'replayed',false);
end;
$$;
revoke all on function public.use_inventory_part(uuid,text,integer,text,uuid) from public,anon,authenticated;
grant execute on function public.use_inventory_part(uuid,text,integer,text,uuid) to anon;

create or replace function public.move_inventory_part(
  p_item_id uuid,
  p_stock_category text,
  p_chassis text,
  p_cart_code text,
  p_bin_id uuid,
  p_quantity integer,
  p_reorder_flag boolean,
  p_actor_initials text,
  p_request_id uuid
)
returns jsonb language plpgsql security invoker set search_path=pg_catalog
-- Function-local GUC scopes restore all audit context on return or exception;
-- another inventory action in the same transaction must use its own initials.
set otr.actor_initials='' set otr.inventory_event_type=''
set otr.inventory_request_id='' set otr.inventory_operation_item_id=''
set otr.inventory_operation_data='' set otr.inventory_vehicle_code=''
set otr.inventory_quantity_delta='' as $$
declare
  v_actor text:=upper(btrim(coalesce(p_actor_initials,'')));
  v_item public.inventory_items%rowtype;
  v_bin public.inventory_bins%rowtype;
  v_cart text;
  v_expected_cart text;
  v_platform text;
  v_location text;
  v_result_id uuid;
  v_operation jsonb;
  v_event public.inventory_events%rowtype;
  v_new public.inventory_items%rowtype;
begin
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required (1 to 8 characters)'; end if;
  if p_request_id is null then raise exception 'Request ID is required'; end if;
  if p_stock_category not in ('Mobile','Backstock') or p_stock_category is null then raise exception 'Choose Mobile or Backstock'; end if;
  if p_quantity is null or p_quantity<1 then raise exception 'Quantity to move must be at least 1'; end if;
  if p_stock_category='Mobile' and nullif(btrim(p_chassis),'') is null then raise exception 'Choose a chassis for Mobile inventory'; end if;
  -- A split records two item events, so request_id cannot be globally unique.
  -- Serialize retries even when conflicting requests name different source rows.
  perform pg_advisory_xact_lock(hashtextextended('otr.inventory.move:'||p_request_id::text,0));
  select * into v_item from public.inventory_items where id=p_item_id for update;
  if not found then raise exception 'Inventory item not found'; end if;
  v_platform:=coalesce(nullif(btrim(p_chassis),''),v_item.platform);
  v_operation:=jsonb_build_object('item_id',p_item_id,'stock_category',p_stock_category,'chassis',v_platform,'cart_code',p_cart_code,'bin_id',p_bin_id,'quantity',p_quantity,'reorder_flag',coalesce(p_reorder_flag,false),'actor_initials',v_actor);
  select * into v_event from public.inventory_events where request_id=p_request_id and event_type='move_inventory' limit 1;
  if found then
    if v_event.operation_data is distinct from v_operation then raise exception 'Request ID was already used for a different operation'; end if;
    return jsonb_build_object('item_id',v_event.operation_item_id,'split',v_event.operation_item_id<>p_item_id,'replayed',true);
  end if;
  if v_item.quantity is null then raise exception 'Count this inventory item before moving a quantity'; end if;
  if p_quantity>v_item.quantity then raise exception 'Quantity to move exceeds available stock'; end if;
  if p_stock_category='Backstock' and p_cart_code is not null then raise exception 'Backstock cannot have a mobile cart assignment'; end if;
  if p_cart_code is not null and not exists(select 1 from public.inventory_carts where cart_code=p_cart_code and platform=v_platform) then raise exception 'Cart must match the chosen chassis'; end if;
  v_cart:=p_cart_code;
  if p_bin_id is not null then
    select * into v_bin from public.inventory_bins where id=p_bin_id;
    if not found then raise exception 'Inventory bin not found'; end if;
    if v_bin.model is distinct from v_platform then raise exception 'Bin must match the chosen chassis'; end if;
    if v_bin.bin_code !~ '-000$' then
      v_expected_cart:=case when v_bin.cart_location is null then null else (case when v_bin.model='986 Boxster' then '986' else v_bin.model end)||'-'||v_bin.cart_location end;
      if p_stock_category='Backstock' and v_expected_cart is not null then raise exception 'Backstock cannot be placed in a mobile cart bin'; end if;
      if p_cart_code is not null and p_cart_code is distinct from v_expected_cart then raise exception 'Binned stock inherits its cart from the bin'; end if;
      v_cart:=null;
    end if;
  end if;
  v_location:=coalesce(v_bin.bin_code,case when p_stock_category='Backstock' then 'Backstock' else coalesce(p_cart_code,'Unassigned') end);
  v_result_id:=case when p_quantity=v_item.quantity then v_item.id else gen_random_uuid() end;
  perform set_config('otr.actor_initials',v_actor,true);
  perform set_config('otr.inventory_event_type','move_inventory',true);
  perform set_config('otr.inventory_request_id',p_request_id::text,true);
  perform set_config('otr.inventory_operation_item_id',v_result_id::text,true);
  perform set_config('otr.inventory_operation_data',v_operation::text,true);
  if v_result_id=v_item.id then
    update public.inventory_items set platform=v_platform,stock_category=p_stock_category,
      inventory_bin_id=p_bin_id,cart_code=v_cart,location=v_location,
      reorder_flag=coalesce(p_reorder_flag,false),updated_at=now()
    where id=v_item.id;
  else
    update public.inventory_items set quantity=quantity-p_quantity,updated_at=now() where id=v_item.id;
    v_new:=v_item;
    v_new.id:=v_result_id;
    v_new.inventory_code:=left(v_item.inventory_code,48)||'-MOVE-'||upper(substr(replace(v_result_id::text,'-',''),1,8));
    v_new.platform:=v_platform;
    v_new.stock_category:=p_stock_category;
    v_new.inventory_bin_id:=p_bin_id;
    v_new.cart_code:=v_cart;
    v_new.location:=v_location;
    v_new.quantity:=p_quantity;
    v_new.reorder_flag:=coalesce(p_reorder_flag,false);
    v_new.tag_id:=null;
    v_new.created_at:=now();
    v_new.updated_at:=now();
    insert into public.inventory_items select (v_new).*;
  end if;
  return jsonb_build_object('item_id',v_result_id,'split',v_result_id<>p_item_id,'replayed',false);
end;
$$;
revoke all on function public.move_inventory_part(uuid,text,text,text,uuid,integer,boolean,text,uuid) from public,anon,authenticated;
grant execute on function public.move_inventory_part(uuid,text,text,text,uuid,integer,boolean,text,uuid) to anon;

-- Old browser tabs must refresh. The old placement RPC cannot supply ledger
-- operation context and is no longer an anonymous portal write path.
revoke execute on function public.assign_inventory_to_bin(uuid,uuid,integer,boolean,text) from public,anon,authenticated;

notify pgrst,'reload schema';
