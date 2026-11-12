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
alter table public.inventory_bins add column if not exists cart_location text;

do $cart_location_constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.inventory_bins'::regclass
      and conname = 'inventory_bins_cart_location_valid'
  ) then
    alter table public.inventory_bins
      add constraint inventory_bins_cart_location_valid
      check (cart_location in ('A', 'B'));
  end if;
end;
$cart_location_constraint$;

create unique index if not exists inventory_bins_qr_value_uidx
  on public.inventory_bins(qr_value)
  where qr_value is not null;

-- Eight chassis-local carts. The Boxster uses the physical prefix 986.
create table if not exists public.inventory_carts (
  cart_code text primary key,
  platform text not null check (platform in ('E92','F22','F30','986 Boxster')),
  cart_letter text not null check (cart_letter in ('A','B')),
  unique(platform,cart_letter),
  check (cart_code = (case when platform='986 Boxster' then '986' else platform end) || '-' || cart_letter)
);
insert into public.inventory_carts(cart_code,platform,cart_letter) values
  ('E92-A','E92','A'),('E92-B','E92','B'),
  ('F22-A','F22','A'),('F22-B','F22','B'),
  ('F30-A','F30','A'),('F30-B','F30','B'),
  ('986-A','986 Boxster','A'),('986-B','986 Boxster','B')
on conflict(cart_code) do nothing;
alter table public.inventory_carts enable row level security;
revoke insert,update,delete on public.inventory_carts from anon;
grant select on public.inventory_carts to anon;
drop policy if exists "OTR inventory carts anon read v1" on public.inventory_carts;
create policy "OTR inventory carts anon read v1"
on public.inventory_carts for select to anon using (true);

alter table public.inventory_items add column if not exists cart_code text;
do $item_cart_constraint$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.inventory_items'::regclass and conname='inventory_items_cart_code_fkey') then
    alter table public.inventory_items add constraint inventory_items_cart_code_fkey
      foreign key(cart_code) references public.inventory_carts(cart_code);
  end if;
end;
$item_cart_constraint$;

-- Bin 000 is a shared loose-stock location. Individual item cart_code values
-- distinguish stock on each cart; a 000 bin never owns one cart itself.
do $loose_bin_conflict$
begin
  if exists(select 1 from public.inventory_bins b join
    (values('E92-000','E92'),('F22-000','F22'),('F30-000','F30'),('986-000','986 Boxster')) expected(bin_code,model)
    on b.bin_code=expected.bin_code where b.model is distinct from expected.model) then
    raise exception 'Loose Bin ID conflicts with an existing chassis';
  end if;
end;
$loose_bin_conflict$;
insert into public.inventory_bins(bin_code,make,make_prefix,model,system,description,label_format,qr_value) values
  ('E92-000','BMW','B','E92','Loose Inventory','Loose E92 stock; individual cart assignments','4x6','OTR:BIN:E92-000'),
  ('F22-000','BMW','B','F22','Loose Inventory','Loose F22 stock; individual cart assignments','4x6','OTR:BIN:F22-000'),
  ('F30-000','BMW','B','F30','Loose Inventory','Loose F30 stock; individual cart assignments','4x6','OTR:BIN:F30-000'),
  ('986-000','Porsche','P','986 Boxster','Loose Inventory','Loose Boxster stock; individual cart assignments','4x6','OTR:BIN:986-000')
on conflict(bin_code) do nothing;
do $loose_bin_cart_constraint$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.inventory_bins'::regclass and conname='inventory_bins_loose_cart_unassigned') then
    alter table public.inventory_bins add constraint inventory_bins_loose_cart_unassigned
      check (bin_code not in ('E92-000','F22-000','F30-000','986-000') or cart_location is null);
  end if;
end;
$loose_bin_cart_constraint$;

create index if not exists inventory_bins_classification_idx
  on public.inventory_bins(make, model, system, subsystem, bin_code);

alter table public.inventory_items add column if not exists inventory_bin_id uuid;
alter table public.inventory_items add column if not exists reorder_flag boolean not null default false;
alter table public.inventory_items add column if not exists reorder_level integer;
alter table public.inventory_items add column if not exists quantity_unit text not null default 'pcs';
alter table public.inventory_items add column if not exists source_metadata jsonb not null default '{}'::jsonb;
alter table public.inventory_items add column if not exists stock_category text not null default 'Mobile';

do $stock_category_constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.inventory_items'::regclass
      and conname = 'inventory_stock_category_valid'
  ) then
    alter table public.inventory_items
      add constraint inventory_stock_category_valid
      check (stock_category in ('Mobile', 'Backstock'));
  end if;
end;
$stock_category_constraint$;

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
drop function if exists public.assign_inventory_to_bin(uuid, uuid, integer, boolean);

create or replace function public.assign_inventory_to_bin(
  p_item_id uuid,
  p_bin_id uuid,
  p_quantity integer,
  p_reorder_flag boolean default false,
  p_cart_code text default null
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
  v_destination_cart text;
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

  if v_bin.bin_code in ('E92-000','F22-000','F30-000','986-000') then
    if p_cart_code is not null and not exists(
      select 1 from public.inventory_carts where cart_code=p_cart_code and platform=v_bin.model
    ) then
      raise exception 'Cart must match the destination chassis';
    end if;
    v_destination_cart := p_cart_code;
  else
    v_destination_cart := null;
  end if;

  if p_quantity > v_item.quantity then
    raise exception 'Quantity % exceeds available quantity %', p_quantity, v_item.quantity;
  end if;

  if p_quantity = v_item.quantity then
    update public.inventory_items
    set inventory_bin_id = v_bin.id,
        cart_code = v_destination_cart,
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
    stock_category,
    cart_code,
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
    v_item.stock_category,
    v_destination_cart,
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
revoke execute on function public.assign_inventory_to_bin(uuid, uuid, integer, boolean, text) from public;
grant execute on function public.assign_inventory_to_bin(uuid, uuid, integer, boolean, text) to anon;

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
