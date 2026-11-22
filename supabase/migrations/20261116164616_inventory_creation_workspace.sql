-- Shared creation space. Drafts and photos never use browser persistence.
-- Existing inventory is untouched until an operator commits one draft.
create table if not exists public.inventory_workspace_drafts (
  id uuid primary key,
  data jsonb not null default '{}'::jsonb check(jsonb_typeof(data)='object' and octet_length(data::text)<=131072),
  x integer not null default 1200 check(x between 0 and 12000),
  y integer not null default 1200 check(y between 0 and 12000),
  state text not null default 'draft' check(state in ('draft','committed','archived')),
  revision integer not null default 1 check(revision>0),
  tag_id text generated always as ('TAG-D-'||upper(replace(id::text,'-',''))) stored unique,
  source_draft_id uuid references public.inventory_workspace_drafts(id) on delete restrict,
  inventory_item_id uuid references public.inventory_items(id) on delete restrict,
  created_by text not null,
  actor_initials text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check((state='draft' and inventory_item_id is null) or
        (state='committed' and inventory_item_id is not null) or
        (state='archived'))
);
create index if not exists inventory_workspace_state_updated_idx on public.inventory_workspace_drafts(state,updated_at desc);
create index if not exists inventory_workspace_item_idx on public.inventory_workspace_drafts(inventory_item_id) where inventory_item_id is not null;
create index if not exists inventory_workspace_source_idx on public.inventory_workspace_drafts(source_draft_id) where source_draft_id is not null;
alter table public.inventory_workspace_drafts enable row level security;
revoke all on public.inventory_workspace_drafts from public,anon,authenticated;
grant select,insert,update on public.inventory_workspace_drafts to anon;
drop policy if exists "OTR crew draft read" on public.inventory_workspace_drafts;
create policy "OTR crew draft read" on public.inventory_workspace_drafts for select to anon using(true);
drop policy if exists "OTR crew draft create" on public.inventory_workspace_drafts;
create policy "OTR crew draft create" on public.inventory_workspace_drafts for insert to anon with check(true);
drop policy if exists "OTR crew draft update" on public.inventory_workspace_drafts;
create policy "OTR crew draft update" on public.inventory_workspace_drafts for update to anon using(true) with check(true);

create table if not exists public.inventory_workspace_events (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references public.inventory_workspace_drafts(id) on delete restrict,
  event_type text not null check(event_type in ('draft_created','draft_duplicated','draft_updated','draft_moved','draft_committed','draft_archived','draft_restored')),
  actor_initials text not null check(actor_initials=upper(btrim(actor_initials)) and char_length(actor_initials) between 1 and 8 and actor_initials !~ '[[:cntrl:]]'),
  from_state jsonb,
  to_state jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists inventory_workspace_events_draft_idx on public.inventory_workspace_events(draft_id,created_at desc);
alter table public.inventory_workspace_events enable row level security;
revoke all on public.inventory_workspace_events from public,anon,authenticated;
grant select on public.inventory_workspace_events to anon;
drop policy if exists "OTR crew draft history read" on public.inventory_workspace_events;
create policy "OTR crew draft history read" on public.inventory_workspace_events for select to anon using(true);
drop trigger if exists inventory_workspace_events_immutable on public.inventory_workspace_events;
create trigger inventory_workspace_events_immutable before update or delete on public.inventory_workspace_events
for each row execute function otr_inventory_internal.reject_event_mutation();

create or replace function otr_inventory_internal.guard_workspace_draft()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v_actor text; v_headers jsonb; v_path text;
begin
  if tg_op='DELETE' then raise exception 'Archive drafts instead of deleting history'; end if;
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  v_actor:=upper(btrim(coalesce(nullif(current_setting('otr.actor_initials',true),''),v_headers->>'x-otr-initials','')));
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required (1 to 8 characters)'; end if;
  if tg_op='INSERT' then
    if new.state<>'draft' or new.inventory_item_id is not null or new.revision<>1 then raise exception 'New cards must start as drafts'; end if;
    new.created_by:=v_actor; new.created_at:=now();
  else
    if new.id<>old.id or new.created_by<>old.created_by or new.created_at<>old.created_at or new.source_draft_id is distinct from old.source_draft_id then raise exception 'Draft identity and provenance are immutable'; end if;
    if new.revision<>old.revision+1 then raise exception 'Draft revision must advance by one'; end if;
    if old.inventory_item_id is not null and (new.data is distinct from old.data or new.inventory_item_id is distinct from old.inventory_item_id or new.state='draft') then raise exception 'Open the saved inventory record to change stock; duplicate this card for a new part'; end if;
  end if;
  if new.inventory_item_id is not null and not exists(select 1 from public.inventory_items where id=new.inventory_item_id and ((id=new.id and source_metadata->>'workspace_draft_id'=new.id::text) or exists(select 1 from public.inventory_events where inventory_item_id=new.inventory_item_id and request_id=new.id and operation_data->>'type'='stock_intake'))) then raise exception 'Draft must link to its own committed stock'; end if;
  if new.data ? 'quantity' and jsonb_typeof(new.data->'quantity') not in ('number','null') then raise exception 'Quantity must be a whole number or unknown'; end if;
  if new.data->>'quantity' is not null and ((new.data->>'quantity')::numeric<>trunc((new.data->>'quantity')::numeric) or (new.data->>'quantity')::numeric not between 0 and 2147483647) then raise exception 'Quantity must be a nonnegative whole number'; end if;
  if new.data ? 'compatibility' then
    if jsonb_typeof(new.data->'compatibility')<>'array' or jsonb_array_length(new.data->'compatibility')>20 then raise exception 'Invalid compatible chassis'; end if;
    if exists(select 1 from jsonb_array_elements(new.data->'compatibility') c where jsonb_typeof(c)<>'string' or char_length(btrim(c #>> '{}')) not between 1 and 80) then raise exception 'Invalid compatible chassis'; end if;
  end if;
  if new.data ? 'stock_category' and new.data->>'stock_category' not in ('Mobile','Backstock') then raise exception 'Invalid inventory type'; end if;
  if new.data ? 'label_media_id' and new.data->>'label_media_id' not in ('inch4x6','metric25x50','metric150x100') then raise exception 'Invalid label media'; end if;
  if new.data ? 'photo_paths' then
    if jsonb_typeof(new.data->'photo_paths')<>'array' then raise exception 'Invalid photos'; end if;
    if jsonb_array_length(new.data->'photo_paths')>8 then raise exception 'A card supports up to eight photos'; end if;
    for v_path in select jsonb_array_elements_text(new.data->'photo_paths') loop
      if not exists(select 1 from storage.objects where bucket_id='otr-inventory-workspace' and name=v_path) then raise exception 'Photo upload must complete before it is attached'; end if;
    end loop;
  end if;
  new.actor_initials:=v_actor; new.updated_at:=now();
  return new;
end;
$$;
revoke all on function otr_inventory_internal.guard_workspace_draft() from public,anon,authenticated;
create or replace function otr_inventory_internal.audit_workspace_draft()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare v_before jsonb; v_type text;
begin
  if tg_op='INSERT' then v_type:=case when new.source_draft_id is null then 'draft_created' else 'draft_duplicated' end;
  else
    v_before:=to_jsonb(old);
    v_type:=case when new.state='archived' and old.state<>'archived' then 'draft_archived'
      when old.state='archived' and new.state<>'archived' then 'draft_restored'
      when new.state='committed' and old.state<>'committed' then 'draft_committed'
      when new.data is distinct from old.data then 'draft_updated' else 'draft_moved' end;
  end if;
  insert into public.inventory_workspace_events(draft_id,event_type,actor_initials,from_state,to_state)
  values(new.id,v_type,new.actor_initials,v_before,to_jsonb(new));
  return new;
end;
$$;
revoke all on function otr_inventory_internal.audit_workspace_draft() from public,anon,authenticated;
drop trigger if exists inventory_workspace_require_actor on public.inventory_workspace_drafts;
create trigger inventory_workspace_require_actor before insert or update or delete on public.inventory_workspace_drafts for each row execute function otr_inventory_internal.guard_workspace_draft();
drop trigger if exists inventory_workspace_audit on public.inventory_workspace_drafts;
create trigger inventory_workspace_audit after insert or update on public.inventory_workspace_drafts for each row execute function otr_inventory_internal.audit_workspace_draft();

create or replace function public.save_inventory_workspace_draft(p_id uuid,p_revision integer,p_changes jsonb,p_actor_initials text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_row public.inventory_workspace_drafts%rowtype; v_actor text:=upper(btrim(coalesce(p_actor_initials,''))); v_previous text:=coalesce(current_setting('otr.actor_initials',true),''); v_key text;
begin
  if p_id is null or p_revision is null or p_revision<0 then raise exception 'Invalid draft request'; end if;
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required'; end if;
  if jsonb_typeof(p_changes) is distinct from 'object' then raise exception 'Invalid card changes'; end if;
  for v_key in select jsonb_object_keys(p_changes) loop
    if v_key not in ('data','x','y','state','source_draft_id') then raise exception 'Invalid card field'; end if;
  end loop;
  if p_changes ? 'data' and jsonb_typeof(p_changes->'data')<>'object' then raise exception 'Invalid card details'; end if;
  select * into v_row from public.inventory_workspace_drafts where id=p_id for update;
  if p_changes->>'state'='committed' and v_row.inventory_item_id is null then raise exception 'Use Save to Inventory to commit a draft'; end if;
  if found and p_revision=0 then return to_jsonb(v_row); end if; -- retry after lost create response
  if found and v_row.revision<>p_revision then raise exception using errcode='40001',message='This card changed on another device. Reload it before saving.'; end if;
  if not found and p_revision<>0 then raise exception 'Draft no longer available'; end if;
  perform set_config('otr.actor_initials',v_actor,true);
  if v_row.id is null then
    insert into public.inventory_workspace_drafts(id,data,x,y,source_draft_id,created_by,actor_initials)
    values(p_id,coalesce(p_changes->'data','{}'),coalesce((p_changes->>'x')::integer,1200),coalesce((p_changes->>'y')::integer,1200),(p_changes->>'source_draft_id')::uuid,v_actor,v_actor)
    on conflict(id) do nothing;
    select * into strict v_row from public.inventory_workspace_drafts where id=p_id;
  else
    if p_changes ? 'source_draft_id' then raise exception 'Source identity cannot change'; end if;
    update public.inventory_workspace_drafts set data=data||coalesce(p_changes->'data','{}'),
      x=coalesce((p_changes->>'x')::integer,x),y=coalesce((p_changes->>'y')::integer,y),
      state=coalesce(p_changes->>'state',state),revision=revision+1 where id=p_id returning * into v_row;
  end if;
  perform set_config('otr.actor_initials',v_previous,true);
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.save_inventory_workspace_draft(uuid,integer,jsonb,text) from public,anon,authenticated;
grant execute on function public.save_inventory_workspace_draft(uuid,integer,jsonb,text) to anon;

create or replace function public.duplicate_inventory_workspace_draft(p_source_id uuid,p_new_id uuid,p_actor_initials text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_source public.inventory_workspace_drafts%rowtype; v_data jsonb; v_stock public.inventory_items%rowtype;
begin
  if p_source_id=p_new_id then raise exception 'A duplicate needs a new identity'; end if;
  select * into strict v_source from public.inventory_workspace_drafts where id=p_source_id;
  v_data:=v_source.data;
  if v_source.inventory_item_id is not null then
    select * into strict v_stock from public.inventory_items where id=v_source.inventory_item_id;
    v_data:=v_data||jsonb_build_object('item_name',v_stock.item_name,'quantity',v_stock.quantity,'quantity_unit',v_stock.quantity_unit,'platform',v_stock.platform,'stock_category',v_stock.stock_category,'cart_code',v_stock.cart_code,'inventory_bin_id',v_stock.inventory_bin_id,'condition',v_stock.condition,'category',v_stock.category,'part_number',v_stock.part_number,'notes',v_stock.notes,'source_inventory_item_id',v_stock.id,'compatibility',v_stock.compatibility);
  end if;
  return public.save_inventory_workspace_draft(p_new_id,0,jsonb_build_object('data',v_data,'x',least(11700,v_source.x+36),'y',least(11700,v_source.y+36),'source_draft_id',p_source_id),p_actor_initials);
end;
$$;
revoke all on function public.duplicate_inventory_workspace_draft(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.duplicate_inventory_workspace_draft(uuid,uuid,text) to anon;

create or replace function public.commit_inventory_workspace_draft(p_id uuid,p_revision integer,p_actor_initials text,p_mode text default 'separate',p_existing_item_id uuid default null,p_expected_quantity integer default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog as $$
declare v_row public.inventory_workspace_drafts%rowtype; v_data jsonb; v_actor text:=upper(btrim(coalesce(p_actor_initials,''))); v_previous text:=coalesce(current_setting('otr.actor_initials',true),''); v_platform text; v_bin public.inventory_bins%rowtype; v_cart text; v_category text; v_quantity integer; v_source public.inventory_items%rowtype; v_meta jsonb; v_compatibility jsonb;
begin
  if char_length(v_actor) not between 1 and 8 or v_actor ~ '[[:cntrl:]]' then raise exception 'Initials are required'; end if;
  if p_id is null or p_revision is null or p_revision<1 then raise exception 'Invalid draft revision'; end if;
  select * into strict v_row from public.inventory_workspace_drafts where id=p_id for update;
  if v_row.state='committed' then return to_jsonb(v_row); end if; -- idempotent Finish/retry
  if v_row.state<>'draft' then raise exception 'Restore this draft before adding stock'; end if;
  if v_row.revision<>p_revision then raise exception using errcode='40001',message='This card changed on another device. Reload it before saving.'; end if;
  v_data:=v_row.data;
  if nullif(btrim(v_data->>'item_name'),'') is null then raise exception 'Give this part a name before saving it to inventory'; end if;
  v_platform:=coalesce(nullif(v_data->>'platform',''),'Unassigned');
  select coalesce(jsonb_agg(code order by code),'[]'::jsonb) into v_compatibility
  from (select distinct case when value='M235 / M235iR' then 'F22' else value end as code
        from jsonb_array_elements_text(coalesce(v_data->'compatibility','[]')||case when v_platform='Unassigned' then '[]'::jsonb else jsonb_build_array(v_platform) end)) codes;
  v_category:=coalesce(v_data->>'stock_category','Mobile');
  v_quantity:=(v_data->>'quantity')::integer;
  v_cart:=nullif(v_data->>'cart_code','');
  if nullif(v_data->>'inventory_bin_id','') is not null then
    select * into strict v_bin from public.inventory_bins where id=(v_data->>'inventory_bin_id')::uuid;
    if v_bin.model<>v_platform then raise exception 'Choose a bin from this chassis'; end if;
    if v_bin.bin_code !~ '-000$' then v_cart:=null; end if;
  end if;
  v_meta:=jsonb_build_object('workspace_draft_id',v_row.id,'photo_paths',coalesce(v_data->'photo_paths','[]'),'source_draft_id',v_row.source_draft_id);
  if nullif(v_data->>'source_inventory_item_id','') is not null then
    select * into strict v_source from public.inventory_items where id=(v_data->>'source_inventory_item_id')::uuid;
    v_meta:=v_meta||jsonb_build_object('copied_from_inventory_id',v_source.id,'copied_source_metadata',v_source.source_metadata);
  end if;
  perform set_config('otr.actor_initials',v_actor,true);
  if p_mode not in ('add','replace','separate') or p_mode is null then raise exception 'Choose how this stock should be saved'; end if;
  if p_mode<>'separate' then
    select * into strict v_source from public.inventory_items where id=p_existing_item_id;
    if v_source.quantity_unit<>coalesce(nullif(v_data->>'quantity_unit',''),'pcs') then raise exception 'Units differ. Keep a separate record.'; end if;
    perform public.reconcile_inventory_stock(p_existing_item_id,p_mode,v_quantity,p_expected_quantity,v_row.id,v_actor);
    update public.inventory_workspace_drafts set state='committed',inventory_item_id=p_existing_item_id,revision=revision+1 where id=p_id returning * into v_row;
    perform set_config('otr.actor_initials',v_previous,true);
    return to_jsonb(v_row);
  end if;
  if p_existing_item_id is not null then raise exception 'A separate record does not need an existing target'; end if;
  insert into public.inventory_items(id,inventory_code,item_name,quantity,quantity_unit,platform,category,condition,status,notes,source,verification_status,part_number,stock_category,cart_code,inventory_bin_id,location,tag_id,compatibility,source_metadata,verified_by,verified_at)
  values(v_row.id,'WS-'||upper(replace(v_row.id::text,'-','')),btrim(v_data->>'item_name'),v_quantity,coalesce(nullif(v_data->>'quantity_unit',''),'pcs'),v_platform,coalesce(nullif(v_data->>'category',''),'Uncategorized'),coalesce(nullif(v_data->>'condition',''),'Unspecified'),case when v_quantity is null then 'Uncounted' when v_quantity=0 then 'Out of Stock' else 'In Stock' end,nullif(v_data->>'notes',''),'Creation Workspace',case when v_quantity is null then 'Needs Review' else 'Verified' end,nullif(v_data->>'part_number',''),v_category,v_cart,v_bin.id,coalesce(v_bin.bin_code,case when v_category='Backstock' then 'Backstock' else coalesce(v_cart,'Unassigned') end),v_row.tag_id,v_compatibility,v_meta,v_actor,case when v_quantity is not null then now() end);
  update public.inventory_workspace_drafts set state='committed',inventory_item_id=id,revision=revision+1 where id=p_id returning * into v_row;
  perform set_config('otr.actor_initials',v_previous,true);
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.commit_inventory_workspace_draft(uuid,integer,text,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.commit_inventory_workspace_draft(uuid,integer,text,text,uuid,integer) to anon;

-- Immutable private photo objects. Duplicates share references without copying or
-- deleting bytes. Removing a photo from a card only removes its reference.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('otr-inventory-workspace','otr-inventory-workspace',false,10485760,array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict(id) do nothing;
drop policy if exists "OTR workspace photo read" on storage.objects;
create policy "OTR workspace photo read" on storage.objects for select to anon using(bucket_id='otr-inventory-workspace');
drop policy if exists "OTR workspace photo upload" on storage.objects;
create policy "OTR workspace photo upload" on storage.objects for insert to anon with check(bucket_id='otr-inventory-workspace' and exists(select 1 from public.inventory_workspace_drafts where id::text=split_part(name,'/',1) and state='draft'));
notify pgrst,'reload schema';
