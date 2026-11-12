-- User-confirmed E92 initial cart placement, November 12, 2026.
-- Bin 18 and both sub-bins are Cart A; Exhaust bin 19 is Cart B.
-- No inventory items or quantities are created, moved, or rewritten.
-- Reapplying this batch is a no-op so later manual placements survive.
begin;
lock table public.inventory_bins in share row exclusive mode;
create schema if not exists otr_inventory_archive;
revoke all on schema otr_inventory_archive from public,anon,authenticated;
create table if not exists otr_inventory_archive.bin_cart_assignment_batches (
  batch_id text primary key,
  assignments jsonb not null,
  applied_at timestamptz not null default now()
);
alter table otr_inventory_archive.bin_cart_assignment_batches enable row level security;
revoke all on otr_inventory_archive.bin_cart_assignment_batches from public,anon,authenticated;
do $e92_cart_assignment$
declare
  v_batch text := 'e92-carts-2026-11-12';
  v_a text[] := array['E92-001','E92-002','E92-003','E92-004','E92-005','E92-007','E92-008','E92-010','E92-012','E92-014','E92-016','E92-018','E92-018-A','E92-018-B','E92-020','E92-021'];
  v_b text[] := array['E92-006','E92-009','E92-011','E92-013','E92-015','E92-017','E92-019','E92-022'];
  v_count integer;
begin
  if exists(select 1 from otr_inventory_archive.bin_cart_assignment_batches where batch_id=v_batch) then
    raise notice 'Cart assignment batch % already applied; no placements changed',v_batch;
    return;
  end if;
  if exists(select 1 from public.inventory_bins where bin_code=any(v_a||v_b) and model is distinct from 'E92') then
    raise exception 'E92 Bin ID conflicts with another chassis';
  end if;
  insert into public.inventory_bins(bin_code,make,make_prefix,model,system,description,label_format,qr_value,cart_location)
  values('E92-022','BMW','B','E92','Unclassified','Bin 22 — inventory not yet recorded','4x6','OTR:BIN:E92-022','B')
  on conflict(bin_code) do nothing;
  update public.inventory_bins set cart_location='A' where bin_code=any(v_a) and model='E92';
  get diagnostics v_count=row_count;
  if v_count<>16 then raise exception 'Expected 16 E92 Cart A nodes, updated %',v_count; end if;
  update public.inventory_bins set cart_location='B' where bin_code=any(v_b) and model='E92';
  get diagnostics v_count=row_count;
  if v_count<>8 then raise exception 'Expected 8 E92 Cart B nodes, updated %',v_count; end if;
  insert into otr_inventory_archive.bin_cart_assignment_batches(batch_id,assignments)
  values(v_batch,jsonb_build_object('A',to_jsonb(v_a),'B',to_jsonb(v_b)));
end;
$e92_cart_assignment$;
commit;
