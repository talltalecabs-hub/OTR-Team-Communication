-- OTR Team Portal V1 — Inventory Label & Bin Assistant
-- Rerunnable migration for first-class bins, bin assignment, reorder flags,
-- and stable 4x6 physical tag identities.

create table if not exists public.inventory_bins (
  id uuid primary key default gen_random_uuid(),
  bin_code text unique not null,
  make text not null,
  make_prefix text not null,
  model text not null,
  system text not null,
  subsystem text,
  location text,
  description text,
  label_format text not null default '4x6',
  qr_value text unique,
  status text not null default 'Active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.inventory_bins add column if not exists make_prefix text;
alter table public.inventory_bins add column if not exists subsystem text;
alter table public.inventory_bins add column if not exists location text;
alter table public.inventory_bins add column if not exists description text;
alter table public.inventory_bins add column if not exists label_format text default '4x6';
alter table public.inventory_bins add column if not exists qr_value text;
alter table public.inventory_bins add column if not exists status text default 'Active';
alter table public.inventory_bins add column if not exists created_at timestamptz default now();
alter table public.inventory_bins add column if not exists updated_at timestamptz default now();

create unique index if not exists inventory_bins_qr_value_uidx
  on public.inventory_bins(qr_value)
  where qr_value is not null;

create index if not exists inventory_bins_classification_idx
  on public.inventory_bins(make, model, system, subsystem, bin_code);

alter table public.inventory_items add column if not exists inventory_bin_id uuid;
alter table public.inventory_items add column if not exists reorder_flag boolean not null default false;
alter table public.inventory_items add column if not exists reorder_level integer;
alter table public.inventory_items add column if not exists quantity_unit text not null default 'pcs';
alter table public.inventory_items add column if not exists source_metadata jsonb not null default '{}'::jsonb;

alter table public.inventory_items
  drop constraint if exists inventory_items_inventory_bin_id_fkey;
alter table public.inventory_items
  add constraint inventory_items_inventory_bin_id_fkey
  foreign key (inventory_bin_id) references public.inventory_bins(id)
  on delete set null;

create index if not exists inventory_items_inventory_bin_id_idx
  on public.inventory_items(inventory_bin_id);

create unique index if not exists inventory_items_tag_id_uidx
  on public.inventory_items(tag_id)
  where tag_id is not null;

create or replace function public.set_inventory_bin_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists inventory_bins_set_updated_at on public.inventory_bins;
create trigger inventory_bins_set_updated_at
before update on public.inventory_bins
for each row execute function public.set_inventory_bin_updated_at();

-- Move an inventory quantity into a bin atomically.
-- Existing inventory_items rows act as stock lots. A partial move splits the lot;
-- a full move simply relocates the existing row.
create or replace function public.assign_inventory_to_bin(
  p_item_id uuid,
  p_bin_id uuid,
  p_quantity integer,
  p_reorder_flag boolean default false
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_item public.inventory_items%rowtype;
  v_bin public.inventory_bins%rowtype;
  v_new_id uuid;
  v_new_code text;
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception 'Quantity must be at least 1';
  end if;

  select * into v_item
  from public.inventory_items
  where id = p_item_id
  for update;

  if not found then
    raise exception 'Inventory item not found';
  end if;

  if v_item.quantity is null then
    raise exception 'Count this inventory item before moving it to a bin';
  end if;

  select * into v_bin
  from public.inventory_bins
  where id = p_bin_id;

  if not found then
    raise exception 'Inventory bin not found';
  end if;

  if p_quantity > v_item.quantity then
    raise exception 'Quantity % exceeds available quantity %', p_quantity, v_item.quantity;
  end if;

  if p_quantity = v_item.quantity then
    update public.inventory_items
    set inventory_bin_id = v_bin.id,
        location = v_bin.bin_code,
        reorder_flag = coalesce(p_reorder_flag, false),
        verification_status = 'Verified',
        verified_at = now()
    where id = v_item.id;

    return v_item.id;
  end if;

  update public.inventory_items
  set quantity = quantity - p_quantity
  where id = v_item.id;

  v_new_code := left(v_item.inventory_code, 48)
    || '-BIN-'
    || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into public.inventory_items (
    inventory_code,
    platform,
    location,
    category,
    item_name,
    quantity,
    quantity_unit,
    source_metadata,
    condition,
    status,
    notes,
    source,
    verification_status,
    original_quantity,
    original_item_text,
    original_location,
    part_number,
    compatibility,
    assignment_type,
    assigned_vehicle,
    assigned_vehicle_code,
    use_case,
    tag_id,
    verified_at,
    verified_by,
    inventory_bin_id,
    reorder_flag,
    reorder_level,
    created_at,
    updated_at
  ) values (
    v_new_code,
    v_item.platform,
    v_bin.bin_code,
    v_item.category,
    v_item.item_name,
    p_quantity,
    v_item.quantity_unit,
    v_item.source_metadata,
    v_item.condition,
    v_item.status,
    v_item.notes,
    'Label Assistant bin assignment',
    'Verified',
    v_item.original_quantity,
    v_item.original_item_text,
    v_item.original_location,
    v_item.part_number,
    v_item.compatibility,
    v_item.assignment_type,
    v_item.assigned_vehicle,
    v_item.assigned_vehicle_code,
    v_item.use_case,
    null,
    now(),
    v_item.verified_by,
    v_bin.id,
    coalesce(p_reorder_flag, false),
    v_item.reorder_level,
    now(),
    now()
  ) returning id into v_new_id;

  return v_new_id;
end;
$$;

alter table public.inventory_bins enable row level security;
grant select, insert, update on table public.inventory_bins to anon;
revoke execute on function public.assign_inventory_to_bin(uuid, uuid, integer, boolean) from public;
grant execute on function public.assign_inventory_to_bin(uuid, uuid, integer, boolean) to anon;

drop policy if exists "OTR inventory bins anon read v1" on public.inventory_bins;
create policy "OTR inventory bins anon read v1"
on public.inventory_bins for select to anon using (true);

drop policy if exists "OTR inventory bins anon insert v1" on public.inventory_bins;
create policy "OTR inventory bins anon insert v1"
on public.inventory_bins for insert to anon with check (true);

drop policy if exists "OTR inventory bins anon update v1" on public.inventory_bins;
create policy "OTR inventory bins anon update v1"
on public.inventory_bins for update to anon using (true) with check (true);

-- These anonymous policies and RPC access match the current V1 beta model.
-- Replace them with authenticated crew access before broader deployment.
