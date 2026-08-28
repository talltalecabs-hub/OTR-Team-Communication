-- OTR Team Portal V1 — exact vehicle registry
-- Rerunnable migration and seed for chassis -> vehicle selectors.

create table if not exists public.vehicles (
  vehicle_code text primary key,
  platform text not null,
  vehicle_name text not null,
  designation text,
  status text not null default 'Active',
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(platform, vehicle_name)
);

create index if not exists vehicles_platform_name_idx
  on public.vehicles(platform, display_order, vehicle_name);

alter table public.inventory_items add column if not exists assigned_vehicle_code text;
alter table public.inventory_items
  drop constraint if exists inventory_items_assigned_vehicle_code_fkey;
alter table public.inventory_items
  add constraint inventory_items_assigned_vehicle_code_fkey
  foreign key (assigned_vehicle_code) references public.vehicles(vehicle_code);

alter table public.vehicles enable row level security;
grant select on table public.vehicles to anon;

drop policy if exists "OTR vehicles anon read v1" on public.vehicles;
create policy "OTR vehicles anon read v1"
on public.vehicles for select to anon using (true);

insert into public.vehicles
  (vehicle_code, platform, vehicle_name, designation, status, display_order)
values
  ('F30-GOLDIE', 'F30', 'Goldie', '69', 'Active', 10),
  ('F30-PHO30', 'F30', 'Pho30', '65', 'Active', 20),
  ('F30-68-CAR', 'F30', '68 car', '68', 'Active', 30),
  ('F30-ESTHER', 'F30', 'Esther', 'Street', 'Street', 40),
  ('F30-HALF-AND-HALF', 'F30', 'Half and Half 428i', '70 / Street', 'Street', 50),
  ('E92-CHERRY', 'E92', 'Cherry', '64', 'Active', 10),
  ('E92-ACID-TRIP', 'E92', 'Acid Trip', '67', 'Active', 20),
  ('E92-HULK', 'E92', 'Hulk', '63', 'Deceased', 30),
  ('E92-HIGH-BOI', 'E92', 'High Boi', 'Street', 'Street', 40),
  ('E92-PRINCE', 'E92', 'Prince', '69', 'Active', 50),
  ('M235-RAPTOR', 'M235 / M235iR', 'Raptor', '62', 'Active', 10),
  ('M235-TRIXIE', 'M235 / M235iR', 'Trixie', '61', 'Active', 20),
  ('986-BRUNO', '986 Boxster', 'Bruno', '58', 'Active', 10),
  ('986-RED-BOX', '986 Boxster', 'Red Box', '59', 'Active', 20),
  ('E46-BLUE-BETTY', 'E46', 'Blue Betty', 'Street', 'Street', 10),
  ('E46-CLOWN-SHOE-Z3', 'E46', 'Clown Shoe Z3', '67', 'Active', 20),
  ('TOW-RON-BURGUNDY', 'Tow', 'Ron Burgundy', 'F350', 'Active', 10),
  ('TOW-VICKY', 'Tow', 'Vicky', 'F350', 'Active', 20),
  ('TOW-CAYENNE', 'Tow', 'Cayenne', 'Tow', 'Active', 30),
  ('TRAILER-WHITE-LIGHTNING', 'Trailer', 'White Lightning', 'Trailer', 'Active', 10),
  ('TRAILER-WEDGE', 'Trailer', 'Wedge', 'Trailer', 'Active', 20),
  ('TRAILER-TWO-CAR', 'Trailer', 'Two Car', 'Trailer', 'Active', 30),
  ('TRAILER-SINGLE-CAR', 'Trailer', 'Single Car', 'Trailer', 'Active', 40)
on conflict (vehicle_code) do update set
  platform=excluded.platform,
  vehicle_name=excluded.vehicle_name,
  designation=excluded.designation,
  status=excluded.status,
  display_order=excluded.display_order,
  updated_at=now();

-- This anonymous read is intentional for the current beta only.
-- Replace it with authenticated crew access before broader deployment.
