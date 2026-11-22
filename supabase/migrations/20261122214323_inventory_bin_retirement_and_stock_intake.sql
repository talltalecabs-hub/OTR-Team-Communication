-- Retire physical bins without losing historical identities or stock.
-- Reconcile incoming units only after an explicit operator choice.
alter table public.inventory_bins add column if not exists name text check(name is null or char_length(btrim(name)) between 1 and 120);
create or replace function public.rename_inventory_bin(p_bin_id uuid,p_name text,p_expected_name text,p_request_id uuid,p_actor_initials text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_bin public.inventory_bins%rowtype; v_event public.inventory_events%rowtype; v_data jsonb;
  v_actor text:=upper(btrim(coalesce(p_actor_initials,''))); v_setting text; v_previous jsonb:='{}';
begin
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required'; end if;
  if p_request_id is null or p_name is null or char_length(btrim(p_name)) not between 1 and 120 then raise exception 'Enter a bin name from 1 to 120 characters'; end if;
  v_data:=jsonb_build_object('type','bin_name','name',btrim(p_name),'expected_name',p_expected_name);
  perform pg_advisory_xact_lock(hashtextextended('otr.rename-bin:'||p_request_id::text,0));
  select * into v_event from public.inventory_events where request_id=p_request_id and bin_id=p_bin_id and operation_data->>'type'='bin_name' limit 1;
  if found then
    if v_event.actor_initials<>v_actor or v_event.operation_data<>v_data then raise exception 'This request belongs to a different bin name change'; end if;
    select * into strict v_bin from public.inventory_bins where id=p_bin_id;return to_jsonb(v_bin);
  end if;
  select * into strict v_bin from public.inventory_bins where id=p_bin_id for update;
  if v_bin.name is distinct from p_expected_name then raise exception using errcode='40001',message='The bin name changed. Reload before editing it.'; end if;
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop v_previous:=v_previous||jsonb_build_object(v_setting,coalesce(current_setting(v_setting,true),'')); end loop;
  perform set_config('otr.actor_initials',v_actor,true);perform set_config('otr.inventory_request_id',p_request_id::text,true);
  perform set_config('otr.inventory_operation_data',v_data::text,true);perform set_config('otr.inventory_event_type','',true);
  update public.inventory_bins set name=btrim(p_name),updated_at=now() where id=p_bin_id returning * into v_bin;
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop perform set_config(v_setting,v_previous->>v_setting,true); end loop;
  return to_jsonb(v_bin);
end;
$$;
revoke all on function public.rename_inventory_bin(uuid,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.rename_inventory_bin(uuid,text,text,uuid,text) to anon;

create or replace function public.rename_inventory_part(p_item_id uuid,p_name text,p_expected_name text,p_request_id uuid,p_actor_initials text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_item public.inventory_items%rowtype; v_event public.inventory_events%rowtype; v_data jsonb;
  v_actor text:=upper(btrim(coalesce(p_actor_initials,''))); v_setting text; v_previous jsonb:='{}';
begin
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required'; end if;
  if p_request_id is null or p_name is null or char_length(btrim(p_name)) not between 1 and 200 then raise exception 'Enter a part name from 1 to 200 characters'; end if;
  v_data:=jsonb_build_object('type','part_name','name',btrim(p_name),'expected_name',p_expected_name);
  perform pg_advisory_xact_lock(hashtextextended('otr.rename-part:'||p_request_id::text,0));
  select * into v_event from public.inventory_events where request_id=p_request_id and inventory_item_id=p_item_id and operation_data->>'type'='part_name' limit 1;
  if found then
    if v_event.actor_initials<>v_actor or v_event.operation_data<>v_data then raise exception 'This request belongs to a different part name change'; end if;
    select * into strict v_item from public.inventory_items where id=p_item_id;return to_jsonb(v_item);
  end if;
  select * into strict v_item from public.inventory_items where id=p_item_id for update;
  if v_item.item_name is distinct from p_expected_name then raise exception using errcode='40001',message='The part name changed. Reload before editing it.'; end if;
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop v_previous:=v_previous||jsonb_build_object(v_setting,coalesce(current_setting(v_setting,true),'')); end loop;
  perform set_config('otr.actor_initials',v_actor,true);perform set_config('otr.inventory_request_id',p_request_id::text,true);
  perform set_config('otr.inventory_operation_data',v_data::text,true);perform set_config('otr.inventory_event_type','',true);
  update public.inventory_items set item_name=btrim(p_name),updated_at=now() where id=p_item_id returning * into v_item;
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop perform set_config(v_setting,v_previous->>v_setting,true); end loop;
  return to_jsonb(v_item);
end;
$$;
revoke all on function public.rename_inventory_part(uuid,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.rename_inventory_part(uuid,text,text,uuid,text) to anon;

create or replace function public.create_inventory_stock(p_item jsonb,p_request_id uuid,p_actor_initials text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_item public.inventory_items%rowtype; v_event public.inventory_events%rowtype;
  v_actor text:=upper(btrim(coalesce(p_actor_initials,''))); v_setting text; v_previous jsonb:='{}';
begin
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required'; end if;
  if p_request_id is null or jsonb_typeof(p_item) is distinct from 'object' or nullif(btrim(p_item->>'item_name'),'') is null then raise exception 'Enter a part name'; end if;
  if (p_item->>'quantity')::integer is null or (p_item->>'quantity')::integer<0 then raise exception 'Enter a whole quantity'; end if;
  perform pg_advisory_xact_lock(hashtextextended('otr.create-stock:'||p_request_id::text,0));
  select * into v_event from public.inventory_events where request_id=p_request_id and event_type='add_stock' limit 1;
  if found then
    if v_event.actor_initials<>v_actor or v_event.operation_data->'item' is distinct from p_item then raise exception 'This request belongs to a different new part'; end if;
    select * into strict v_item from public.inventory_items where id=v_event.inventory_item_id;
    return to_jsonb(v_item);
  end if;
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop
    v_previous:=v_previous||jsonb_build_object(v_setting,coalesce(current_setting(v_setting,true),''));
  end loop;
  perform set_config('otr.actor_initials',v_actor,true);perform set_config('otr.inventory_request_id',p_request_id::text,true);
  perform set_config('otr.inventory_operation_data',jsonb_build_object('type','create_stock','item',p_item)::text,true);perform set_config('otr.inventory_event_type','',true);
  insert into public.inventory_items(id,inventory_code,item_name,quantity,quantity_unit,platform,category,condition,status,notes,source,verification_status,part_number,stock_category,cart_code,inventory_bin_id,location,tag_id,compatibility,assignment_type,assigned_vehicle,use_case,verified_at,verified_by)
  values(p_request_id,p_item->>'inventory_code',btrim(p_item->>'item_name'),(p_item->>'quantity')::integer,coalesce(p_item->>'quantity_unit','pcs'),p_item->>'platform',coalesce(p_item->>'category','Uncategorized'),p_item->>'condition',p_item->>'status',p_item->>'notes',p_item->>'source',p_item->>'verification_status',p_item->>'part_number',p_item->>'stock_category',p_item->>'cart_code',(p_item->>'inventory_bin_id')::uuid,p_item->>'location',p_item->>'tag_id',coalesce(p_item->'compatibility','[]'),coalesce(p_item->>'assignment_type','General Inventory'),p_item->>'assigned_vehicle',p_item->>'use_case',now(),v_actor) returning * into v_item;
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop perform set_config(v_setting,v_previous->>v_setting,true); end loop;
  return to_jsonb(v_item);
end;
$$;
revoke all on function public.create_inventory_stock(jsonb,uuid,text) from public,anon,authenticated;
grant execute on function public.create_inventory_stock(jsonb,uuid,text) to anon;

create or replace function public.reconcile_inventory_stock(
  p_item_id uuid,p_mode text,p_quantity integer,p_expected_quantity integer,
  p_request_id uuid,p_actor_initials text
) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_item public.inventory_items%rowtype; v_event public.inventory_events%rowtype;
  v_actor text:=upper(btrim(coalesce(p_actor_initials,''))); v_data jsonb; v_setting text; v_previous jsonb:='{}'; v_quantity integer;
begin
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required'; end if;
  if p_request_id is null or p_item_id is null or p_mode not in ('add','replace') or p_mode is null or p_quantity is null or p_quantity<0 then raise exception 'Choose Add or Replace and a whole quantity'; end if;
  v_data:=jsonb_build_object('type','stock_intake','mode',p_mode,'quantity',p_quantity,'expected_quantity',p_expected_quantity);
  perform pg_advisory_xact_lock(hashtextextended('otr.intake:'||p_request_id::text,0));
  select * into v_event from public.inventory_events where request_id=p_request_id and operation_data->>'type'='stock_intake' limit 1;
  if found then
    if v_event.inventory_item_id<>p_item_id or v_event.actor_initials<>v_actor or v_event.operation_data<>v_data then raise exception 'This request belongs to a different stock change'; end if;
    return v_event.to_state;
  end if;
  select * into strict v_item from public.inventory_items where id=p_item_id for update;
  if v_item.quantity is distinct from p_expected_quantity then raise exception using errcode='40001',message='The stock count changed. Review the latest quantity before continuing.'; end if;
  if p_mode='add' and v_item.quantity is null then raise exception 'Existing quantity is uncounted. Replace it with a physically confirmed total, or keep a separate record.'; end if;
  v_quantity:=case when p_mode='add' then v_item.quantity+p_quantity else p_quantity end;
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop
    v_previous:=v_previous||jsonb_build_object(v_setting,coalesce(current_setting(v_setting,true),''));
  end loop;
  perform set_config('otr.actor_initials',v_actor,true);
  perform set_config('otr.inventory_request_id',p_request_id::text,true);
  perform set_config('otr.inventory_operation_data',v_data::text,true);
  perform set_config('otr.inventory_event_type','',true);
  update public.inventory_items set quantity=v_quantity,status=case when v_quantity=0 then 'Out of Stock' else 'In Stock' end,updated_at=now() where id=p_item_id returning * into v_item;
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop
    perform set_config(v_setting,v_previous->>v_setting,true);
  end loop;
  return to_jsonb(v_item);
end;
$$;
revoke all on function public.reconcile_inventory_stock(uuid,text,integer,integer,uuid,text) from public,anon,authenticated;
grant execute on function public.reconcile_inventory_stock(uuid,text,integer,integer,uuid,text) to anon;

create or replace function otr_inventory_internal.guard_active_bin_placement()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare v_status text;
begin
  if tg_table_name='inventory_items' then
    if new.inventory_bin_id is not null and (tg_op='INSERT' or new.inventory_bin_id is distinct from old.inventory_bin_id) then
      select status into strict v_status from public.inventory_bins where id=new.inventory_bin_id for share;
      if v_status='Archived' then raise exception 'This bin has been deleted. Choose an available bin.'; end if;
    end if;
  else
    if tg_op='UPDATE' and old.status='Archived' then raise exception 'Deleted bin identities are retained for history and cannot be reused'; end if;
    if new.parent_bin_id is not null and (tg_op='INSERT' or new.parent_bin_id is distinct from old.parent_bin_id) then
      select status into strict v_status from public.inventory_bins where id=new.parent_bin_id for share;
      if v_status='Archived' then raise exception 'The parent bin has been deleted'; end if;
    end if;
    if new.status='Archived' and (tg_op='INSERT' or old.status is distinct from new.status) then
      if new.bin_code ~ '-000$' then raise exception 'Bin 000 is the reserved loose-stock location'; end if;
      if exists(select 1 from public.inventory_items where inventory_bin_id=new.id) or exists(select 1 from public.inventory_bins where parent_bin_id=new.id and status<>'Archived') then raise exception 'Move all contents and remove sub-bins before deleting this bin'; end if;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function otr_inventory_internal.guard_active_bin_placement() from public,anon,authenticated;
create trigger inventory_items_active_bin before insert or update on public.inventory_items for each row execute function otr_inventory_internal.guard_active_bin_placement();
create trigger inventory_bins_active_parent before insert or update on public.inventory_bins for each row execute function otr_inventory_internal.guard_active_bin_placement();

create or replace function public.retire_inventory_bin(
  p_bin_id uuid,p_destination text,p_target_bin_id uuid,p_expected_bin_ids uuid[],
  p_expected_item_ids uuid[],p_request_id uuid,p_actor_initials text
) returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_bin public.inventory_bins%rowtype; v_target public.inventory_bins%rowtype; v_event public.inventory_events%rowtype;
  v_actor text:=upper(btrim(coalesce(p_actor_initials,''))); v_bin_ids uuid[]; v_item_ids uuid[]; v_data jsonb;
  v_setting text; v_previous jsonb:='{}'; v_id uuid;
begin
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required'; end if;
  if p_bin_id is null or p_request_id is null or p_destination is null or p_destination not in ('backstock','bin') then raise exception 'Choose where the bin contents should go'; end if;
  perform pg_advisory_xact_lock(hashtextextended('otr.retire-bin:'||p_request_id::text,0));
  select * into v_event from public.inventory_events where request_id=p_request_id and bin_id=p_bin_id and operation_data->>'type'='retire_bin' order by created_at desc limit 1;
  if found then
    if v_event.actor_initials<>v_actor or v_event.operation_data->>'destination'<>p_destination or (v_event.operation_data->>'target_bin_id')::uuid is distinct from p_target_bin_id then raise exception 'This request belongs to a different bin deletion'; end if;
    return v_event.operation_data;
  end if;
  -- Lock physical identities before collecting stock. New placements/children
  -- take a conflicting share lock in the guard above.
  perform id from public.inventory_bins where id=p_bin_id for update;
  select * into strict v_bin from public.inventory_bins where id=p_bin_id;
  if v_bin.status='Archived' then raise exception 'This bin has already been deleted'; end if;
  if v_bin.bin_code ~ '-000$' then raise exception 'Bin 000 is the reserved loose-stock location'; end if;
  with recursive tree as(select id from public.inventory_bins where id=p_bin_id union all select b.id from public.inventory_bins b join tree t on b.parent_bin_id=t.id where b.status<>'Archived')
  select array_agg(id order by id) into v_bin_ids from tree;
  perform id from public.inventory_bins where id=any(v_bin_ids) order by id for update;
  -- Detect children that arrived while acquiring descendant locks.
  with recursive tree as(select id from public.inventory_bins where id=p_bin_id union all select b.id from public.inventory_bins b join tree t on b.parent_bin_id=t.id where b.status<>'Archived')
  select array_agg(id order by id) into v_bin_ids from tree;
  if v_bin_ids is distinct from (select array_agg(id order by id) from unnest(p_expected_bin_ids) id) then raise exception using errcode='40001',message='The bin structure changed. Reload and review before deleting.'; end if;
  perform id from public.inventory_items where inventory_bin_id=any(v_bin_ids) order by id for update;
  select coalesce(array_agg(id order by id),'{}'::uuid[]) into v_item_ids from public.inventory_items where inventory_bin_id=any(v_bin_ids);
  if v_item_ids is distinct from coalesce((select array_agg(id order by id) from unnest(p_expected_item_ids) id),'{}'::uuid[]) then raise exception using errcode='40001',message='The bin contents changed. Reload and review before deleting.'; end if;
  if p_destination='bin' then
    if p_target_bin_id is null or p_target_bin_id=any(v_bin_ids) then raise exception 'Choose an available bin outside this bin and its sub-bins'; end if;
    select * into strict v_target from public.inventory_bins where id=p_target_bin_id for share;
    if v_target.status='Archived' or v_target.model<>v_bin.model then raise exception 'Choose an available bin for the same chassis'; end if;
  elsif p_target_bin_id is not null then raise exception 'Backstock does not need a target bin'; end if;
  v_data:=jsonb_build_object('type','retire_bin','source_bin_id',p_bin_id,'source_bin_code',v_bin.bin_code,'destination',p_destination,'target_bin_id',p_target_bin_id,'bin_ids',v_bin_ids,'item_ids',v_item_ids,'bin_count',cardinality(v_bin_ids),'item_count',cardinality(v_item_ids));
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop
    v_previous:=v_previous||jsonb_build_object(v_setting,coalesce(current_setting(v_setting,true),''));
  end loop;
  perform set_config('otr.actor_initials',v_actor,true);perform set_config('otr.inventory_request_id',p_request_id::text,true);
  perform set_config('otr.inventory_operation_data',v_data::text,true);perform set_config('otr.inventory_event_type','move_inventory',true);
  update public.inventory_items set inventory_bin_id=v_target.id,cart_code=null,stock_category=case when p_destination='backstock' then 'Backstock' else 'Mobile' end,location=coalesce(v_target.bin_code,'Backstock'),updated_at=now() where id=any(v_item_ids);
  for v_id in with recursive tree as(select id,0 depth from public.inventory_bins where id=p_bin_id union all select b.id,t.depth+1 from public.inventory_bins b join tree t on b.parent_bin_id=t.id where b.id=any(v_bin_ids)) select id from tree order by depth desc,id loop
    update public.inventory_bins set status='Archived',updated_at=now() where id=v_id;
  end loop;
  foreach v_setting in array array['otr.actor_initials','otr.inventory_request_id','otr.inventory_operation_data','otr.inventory_event_type'] loop
    perform set_config(v_setting,v_previous->>v_setting,true);
  end loop;
  return v_data;
end;
$$;
revoke all on function public.retire_inventory_bin(uuid,text,uuid,uuid[],uuid[],uuid,text) from public,anon,authenticated;
grant execute on function public.retire_inventory_bin(uuid,text,uuid,uuid[],uuid[],uuid,text) to anon;

-- A parent and its sub-bins form one physical cart group. Cascades run in the
-- same statement/transaction and use the caller's visible initials for audits.
create or replace function otr_inventory_internal.inherit_parent_bin_cart()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
declare v_parent public.inventory_bins%rowtype;
begin
  if new.parent_bin_id is not null then
    select * into strict v_parent from public.inventory_bins where id=new.parent_bin_id for share;
    if new.model<>v_parent.model then raise exception 'Sub-bin chassis must match its parent'; end if;
    if tg_op='INSERT' or new.parent_bin_id is distinct from old.parent_bin_id then new.cart_location:=v_parent.cart_location;
    elsif new.cart_location is distinct from old.cart_location and new.cart_location is distinct from v_parent.cart_location then raise exception 'Assign the parent bin cart; all sub-bins follow it'; end if;
  end if;
  return new;
end;
$$;
revoke all on function otr_inventory_internal.inherit_parent_bin_cart() from public,anon,authenticated;
create trigger inventory_bins_00_inherit_cart before insert or update on public.inventory_bins for each row execute function otr_inventory_internal.inherit_parent_bin_cart();
create or replace function otr_inventory_internal.cascade_parent_bin_cart()
returns trigger language plpgsql security invoker set search_path=pg_catalog as $$
begin
  update public.inventory_bins set cart_location=new.cart_location,updated_at=now()
  where parent_bin_id=new.id and status<>'Archived' and cart_location is distinct from new.cart_location;
  return new;
end;
$$;
revoke all on function otr_inventory_internal.cascade_parent_bin_cart() from public,anon,authenticated;
create trigger inventory_bins_cascade_cart after update of cart_location on public.inventory_bins for each row execute function otr_inventory_internal.cascade_parent_bin_cart();
notify pgrst,'reload schema';
