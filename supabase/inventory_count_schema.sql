-- Prepared only: do not run against production until the inventory rollout is approved.
-- Prerequisite: schema.sql, then label_assistant_schema.sql.
-- Unknown quantity is NULL, never an inferred zero. Units remain printed units.
begin;

alter table public.inventory_items alter column quantity drop not null;
alter table public.inventory_items add column if not exists quantity_unit text not null default 'pcs';
alter table public.inventory_items add column if not exists source_metadata jsonb not null default '{}'::jsonb;

alter table public.inventory_bins add column if not exists parent_bin_id uuid
  references public.inventory_bins(id) on delete restrict;
alter table public.inventory_bins add column if not exists source_metadata jsonb not null default '{}'::jsonb;
create index if not exists inventory_bins_parent_bin_id_idx on public.inventory_bins(parent_bin_id);

commit;
