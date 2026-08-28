-- OTR Team Portal — Inventory Assistant schema
-- Rerunnable against a new or existing project.

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  inventory_code text unique not null,
  platform text,
  location text,
  category text,
  item_name text not null,
  quantity integer not null default 0,
  condition text default 'Unspecified',
  status text default 'In Stock',
  notes text,
  source text,
  verification_status text not null default 'Imported',
  original_quantity integer,
  original_item_text text,
  original_location text,
  part_number text,
  compatibility jsonb not null default '[]'::jsonb,
  assignment_type text not null default 'General Inventory',
  assigned_vehicle text,
  use_case text,
  tag_id text,
  verified_at timestamptz,
  verified_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.inventory_items add column if not exists platform text;
alter table public.inventory_items add column if not exists location text;
alter table public.inventory_items add column if not exists category text;
alter table public.inventory_items add column if not exists quantity integer default 0;
alter table public.inventory_items add column if not exists condition text default 'Unspecified';
alter table public.inventory_items add column if not exists status text default 'In Stock';
alter table public.inventory_items add column if not exists notes text;
alter table public.inventory_items add column if not exists source text;
alter table public.inventory_items add column if not exists verification_status text default 'Imported';
alter table public.inventory_items add column if not exists original_quantity integer;
alter table public.inventory_items add column if not exists original_item_text text;
alter table public.inventory_items add column if not exists original_location text;
alter table public.inventory_items add column if not exists part_number text;
alter table public.inventory_items add column if not exists compatibility jsonb default '[]'::jsonb;
alter table public.inventory_items add column if not exists assignment_type text default 'General Inventory';
alter table public.inventory_items add column if not exists assigned_vehicle text;
alter table public.inventory_items add column if not exists use_case text;
alter table public.inventory_items add column if not exists tag_id text;
alter table public.inventory_items add column if not exists verified_at timestamptz;
alter table public.inventory_items add column if not exists verified_by text;
alter table public.inventory_items add column if not exists created_at timestamptz default now();
alter table public.inventory_items add column if not exists updated_at timestamptz default now();

alter table public.inventory_items drop constraint if exists inventory_quantity_nonnegative;
alter table public.inventory_items
  add constraint inventory_quantity_nonnegative check (quantity >= 0);

alter table public.inventory_items drop constraint if exists inventory_verification_status_valid;
alter table public.inventory_items
  add constraint inventory_verification_status_valid check (
    verification_status in ('Imported', 'Verified', 'Needs Review', 'Not Found', 'Consumed/Removed')
  );

alter table public.inventory_items drop constraint if exists inventory_assignment_type_valid;
alter table public.inventory_items
  add constraint inventory_assignment_type_valid check (
    assignment_type in ('General Inventory', 'Program Spare', 'Specific Vehicle')
  );

create or replace function public.set_inventory_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists inventory_items_set_updated_at on public.inventory_items;
create trigger inventory_items_set_updated_at
before update on public.inventory_items
for each row execute function public.set_inventory_updated_at();

alter table public.inventory_items enable row level security;
grant select, insert, update on table public.inventory_items to anon;

drop policy if exists "OTR inventory anon read v1" on public.inventory_items;
create policy "OTR inventory anon read v1"
on public.inventory_items for select to anon using (true);

drop policy if exists "OTR inventory anon insert v1" on public.inventory_items;
create policy "OTR inventory anon insert v1"
on public.inventory_items for insert to anon with check (true);

drop policy if exists "OTR inventory anon update v1" on public.inventory_items;
create policy "OTR inventory anon update v1"
on public.inventory_items for update to anon using (true) with check (true);

-- These anonymous policies are intentional for the current beta only.
-- Replace them with authenticated crew policies before broader deployment.
