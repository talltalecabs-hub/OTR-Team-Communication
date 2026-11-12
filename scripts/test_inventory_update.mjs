// Optional local PostgreSQL test. Install @electric-sql/pglite outside this checkout,
// then set PGLITE_MODULE to its dist/index.js path. Never connects to production.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";

const {PGlite}=await import(process.env.PGLITE_MODULE||"@electric-sql/pglite");
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const read=name=>readFileSync(join(root,name),"utf8");
const source=JSON.parse(read("data/inventory/f22-e92-2026-11-08.json"));
const db=new PGlite();
const rows=async(sql,params=[]) => (await db.query(sql,params)).rows;
const single=async(sql,params=[]) => (await rows(sql,params))[0];

try{
  await db.exec("create role anon; create role authenticated;");
  await db.exec(read("supabase/schema.sql"));
  await db.exec(read("supabase/vehicles_schema.sql"));
  await db.exec(read("supabase/seed_inventory.sql"));
  assert.deepEqual(await single("select count(*)::int as records,sum(quantity)::int as quantity from inventory_items"),{records:297,quantity:690});
  // Simulate the extra live record observed since the V1 seed. Backup must be dynamic.
  await db.exec("insert into inventory_items(inventory_code,platform,item_name,quantity) values('M235-LIVE-EXTRA','M235 / M235iR','Live extra stock',2)");
  await db.exec(read("supabase/label_assistant_schema.sql"));
  await db.exec(read("supabase/inventory_count_schema.sql"));
  const unrelated=await rows("select * from inventory_items where platform in ('F30','986 Boxster') order by id");
  const vehicles=await rows("select * from vehicles order by vehicle_code");

  // A pre-existing Bin ID owned by another chassis must abort the entire replacement.
  await db.exec("insert into inventory_bins(bin_code,make,make_prefix,model,system) values('F22-001','BMW','B','F30','Unrelated bin')");
  await assert.rejects(db.exec(read("supabase/update_inventory_f22_e92_20261108.sql")),/conflicts/);
  await db.exec("rollback");
  assert.equal((await single("select count(*)::int as records from inventory_items")).records,298);
  await db.exec("delete from inventory_bins where bin_code='F22-001'");
  await db.exec(read("supabase/update_inventory_f22_e92_20261108.sql"));

  assert.deepEqual(await rows("select * from inventory_items where platform in ('F30','986 Boxster') order by id"),unrelated);
  assert.deepEqual(await rows("select * from vehicles order by vehicle_code"),vehicles);
  assert.deepEqual(await rows("select platform,count(*)::int as records,count(*) filter(where quantity is null)::int as unknown from inventory_items where platform in ('F22','E92') group by platform order by platform"),[
    {platform:"E92",records:123,unknown:1},{platform:"F22",records:92,unknown:4}
  ]);
  assert.equal((await single("select count(*)::int as records from inventory_bins")).records,49);
  assert.equal((await single("select count(*)::int as records from inventory_bins where parent_bin_id is not null")).records,6);
  assert.equal((await single("select count(*)::int as records from inventory_bins where bin_code in ('F22-004','F22-013')")).records,0);
  assert.equal((await single("select count(*)::int as records from otr_inventory_archive.inventory_items")).records,137);
  assert.equal((await single("select count(*)::int as records from inventory_items where platform='M235 / M235iR'")).records,0);

  const imported=await rows("select inventory_code,quantity,quantity_unit,source_metadata,part_number,condition from inventory_items where platform in ('F22','E92')");
  const byCode=new Map(imported.map(item=>[item.inventory_code,item]));
  for(const original of source.parts){
    const item=byCode.get(original.inventory_code);
    assert(item,original.inventory_code);
    assert.equal(item.quantity,original.quantity);
    assert.equal(item.quantity_unit,original.quantity_unit);
    assert.equal(item.part_number,original.part_number);
    assert.equal(item.condition,original.condition);
    for(const [key,value] of Object.entries(original)) assert.deepEqual(item.source_metadata[key],value,`${original.inventory_code}.${key}`);
  }
  assert.equal(imported.filter(item=>item.source_metadata.quantity_raw==="VARIOUS").length,1);
  assert.equal(imported.filter(item=>item.quantity_unit==="lot (2 pcs)").length,1);
  assert.equal(imported.filter(item=>["set","sets"].includes(item.quantity_unit)).length,6);

  // Exercise the production upgrade from the previous schema, which had no
  // Mobile/Backstock field. The additive default must not rewrite any old data.
  await db.exec("alter table inventory_items drop column stock_category");
  await db.exec("alter table inventory_bins drop column cart_location");
  await db.exec("alter table inventory_items drop column cart_code; drop table inventory_carts");
  const beforeClassification=(await rows("select to_jsonb(i) as original_fields from inventory_items i order by id")).map(item=>item.original_fields);
  const beforeCarts=(await rows("select to_jsonb(b) as original_fields from inventory_bins b order by id")).map(bin=>bin.original_fields);
  await db.exec(read("supabase/inventory_stock_category_schema.sql"));
  assert.equal((await single("select count(*)::int as records from inventory_items where stock_category='Mobile'")).records,376);
  assert.deepEqual(
    (await rows("select to_jsonb(i)-array['stock_category','cart_code'] as original_fields from inventory_items i order by id")).map(item=>item.original_fields),
    beforeClassification
  );
  assert.equal((await single("select count(*)::int as records from inventory_bins where cart_location is null")).records,49);
  assert.deepEqual(
    (await rows("select to_jsonb(b)-'cart_location' as original_fields from inventory_bins b order by id")).map(bin=>bin.original_fields),
    beforeCarts
  );
  await db.exec("update inventory_bins set cart_location='A' where bin_code in ('F22-001','E92-005'); update inventory_bins set cart_location='B' where bin_code='F22-002'");
  await assert.rejects(db.query("update inventory_bins set cart_location='C' where bin_code='F22-001'"),/inventory_bins_cart_location_valid/);
  assert.deepEqual(await rows("select bin_code,model,cart_location from inventory_bins where cart_location is not null order by bin_code"),[
    {bin_code:"E92-005",model:"E92",cart_location:"A"},
    {bin_code:"F22-001",model:"F22",cart_location:"A"},
    {bin_code:"F22-002",model:"F22",cart_location:"B"}
  ]);
  // Parent/sub-bin cart placement is independent; assigning a parent does not
  // guess the physical placement of any child container.
  await db.exec("update inventory_bins set cart_location='A' where bin_code='F22-008'");
  assert.equal((await single("select cart_location from inventory_bins where bin_code='F22-008-A'")).cart_location,null);
  await db.exec("update inventory_bins set cart_location='B' where bin_code='F22-008-A'");
  assert.equal((await single("select cart_location from inventory_bins where bin_code='F22-008'")).cart_location,"A");
  const placedBins=await rows("select id,bin_code,parent_bin_id,cart_location,updated_at from inventory_bins order by id");
  assert.equal((await single("select count(*)::int as records from inventory_carts")).records,8);
  assert.equal((await single("select count(*)::int as records from inventory_items where cart_code is null")).records,376);
  await db.exec("set role anon");
  assert.equal((await single("select count(*)::int as records from inventory_carts")).records,8);
  await assert.rejects(db.query("update inventory_carts set cart_letter='B' where cart_code='E92-A'"),/permission denied/);
  await db.exec("reset role");
  await assert.rejects(db.query("update inventory_items set cart_code='E92-C' where id=(select id from inventory_items limit 1)"),/inventory_items_cart_code_fkey/);
  await assert.rejects(db.query("update inventory_bins set cart_location='A' where bin_code='E92-000'"),/inventory_bins_loose_cart_unassigned/);
  await assert.rejects(db.query("update inventory_items set stock_category='Garage' where id=(select id from inventory_items limit 1)"),/inventory_stock_category_valid/);
  await assert.rejects(db.query("update inventory_items set stock_category=null where id=(select id from inventory_items limit 1)"),/not-null|null value/i);

  const backstock=await single("select id from inventory_items where quantity_unit in ('set','sets') and quantity>1 limit 1");
  await db.query("update inventory_items set stock_category='Backstock' where id=$1",[backstock.id]);
  await db.exec(read("supabase/inventory_stock_category_schema.sql"));
  await db.exec(read("supabase/label_assistant_schema.sql"));
  assert.equal((await single("select stock_category from inventory_items where id=$1",[backstock.id])).stock_category,"Backstock");
  assert.equal((await single("select count(*)::int as records from inventory_items")).records,376);
  assert.deepEqual(await rows("select id,bin_code,parent_bin_id,cart_location,updated_at from inventory_bins order by id"),placedBins);

  // Newly entered stock defaults to Mobile when no explicit category is sent.
  await db.exec("begin");
  const added=await single("insert into inventory_items(inventory_code,item_name,quantity) values('DEFAULT-MOBILE-TEST','Test default',1) returning stock_category");
  assert.equal(added.stock_category,"Mobile");
  await db.exec("rollback");

  // One-time E92 mapping adds only bin22; preserve all item data and F22 placements.
  const beforeE92Items=await rows("select * from inventory_items order by id");
  const beforeE92F22=await rows("select * from inventory_bins where model='F22' order by id");
  const beforeE92Identities=await rows("select id,bin_code,parent_bin_id from inventory_bins order by id");
  await db.exec(read("supabase/e92_cart_assignments.sql"));
  assert.equal((await single("select count(*)::int as records from inventory_bins")).records,50);
  assert.deepEqual(await rows("select * from inventory_items order by id"),beforeE92Items);
  assert.deepEqual(await rows("select * from inventory_bins where model='F22' order by id"),beforeE92F22);
  const afterE92Identities=await rows("select id,bin_code,parent_bin_id from inventory_bins order by id");
  for(const original of beforeE92Identities) assert.deepEqual(afterE92Identities.find(bin=>bin.bin_code===original.bin_code),original);
  assert.deepEqual(await rows("select cart_location,count(*)::int as records from inventory_bins where model='E92' group by cart_location order by cart_location nulls last"),[
    {cart_location:"A",records:16},{cart_location:"B",records:8},{cart_location:null,records:1}
  ]);
  assert.equal((await single("select cart_location from inventory_bins where bin_code='E92-018'")).cart_location,"A");
  assert.equal((await single("select cart_location from inventory_bins where bin_code='E92-018-A'")).cart_location,"A");
  assert.equal((await single("select cart_location from inventory_bins where bin_code='E92-019'")).cart_location,"B");
  assert.equal((await single("select count(*)::int as records from inventory_items i join inventory_bins b on b.id=i.inventory_bin_id where b.bin_code='E92-022'")).records,0);
  const bin22=await single("select * from inventory_bins where bin_code='E92-022'");
  assert.equal(bin22.description,"Bin 22 — inventory not yet recorded");
  await db.query("update inventory_bins set cart_location='B' where bin_code='E92-001'");
  await db.exec(read("supabase/e92_cart_assignments.sql"));
  assert.equal((await single("select cart_location from inventory_bins where bin_code='E92-001'")).cart_location,"B");
  assert.equal((await single("select count(*)::int as records from inventory_bins where bin_code='E92-022'")).records,1);
  assert.equal((await single("select count(*)::int as records from otr_inventory_archive.bin_cart_assignment_batches")).records,1);
  await db.exec("set role anon");
  await assert.rejects(db.query("select * from otr_inventory_archive.bin_cart_assignment_batches"),/permission denied/);
  await db.exec("reset role");

  // A second application must not reset quantities or recreate snapshot rows.
  const edited=source.parts.find(item=>item.quantity>2 && item.quantity_unit==="pcs");
  await db.query("update inventory_items set quantity=99 where inventory_code=$1",[edited.inventory_code]);
  await db.exec(read("supabase/update_inventory_f22_e92_20261108.sql"));
  assert.equal((await single("select quantity from inventory_items where inventory_code=$1",[edited.inventory_code])).quantity,99);
  assert.equal((await single("select count(*)::int as records from otr_inventory_archive.replacement_batches")).records,1);

  // Public clients cannot inspect original archived rows.
  await db.exec("set role anon");
  await assert.rejects(db.query("select * from otr_inventory_archive.inventory_items"),/permission denied/);
  await db.exec("reset role");

  const unknown=await single("select id from inventory_items where quantity is null limit 1");
  const bin=await single("select id from inventory_bins where bin_code='F22-001'");
  await assert.rejects(db.query("select assign_inventory_to_bin($1,$2,1,false)",[unknown.id,bin.id]),/count|quantity|unknown/i);
  // Partial moves of a counted set retain the printed unit and provenance.
  const set=await single("select * from inventory_items where id=$1",[backstock.id]);
  assert(set,"Expected a multi-set source record");
  const beforeMoveQuantity=(await single("select sum(quantity)::int as known_quantity from inventory_items")).known_quantity;
  await db.exec("set role anon");
  const split=await single("select assign_inventory_to_bin($1,$2,1,true) as id",[set.id,bin.id]);
  await db.exec("reset role");
  const moved=await single("select * from inventory_items where id=$1",[split.id]);
  assert.equal(moved.quantity,1);
  assert.equal(moved.quantity_unit,set.quantity_unit);
  assert.equal(moved.stock_category,"Backstock");
  assert.deepEqual(moved.source_metadata,set.source_metadata);
  assert.equal((await single("select quantity from inventory_items where id=$1",[set.id])).quantity,set.quantity-1);
  assert.equal(moved.reorder_flag,true);

  // A full move also keeps the category, and both moves conserve stock counts.
  const remaining=await single("select * from inventory_items where id=$1",[set.id]);
  await db.exec("set role anon");
  const fullMove=await single("select assign_inventory_to_bin($1,$2,$3,false) as id",[remaining.id,bin.id,remaining.quantity]);
  await db.exec("reset role");
  assert.equal(fullMove.id,remaining.id);
  assert.equal((await single("select stock_category from inventory_items where id=$1",[remaining.id])).stock_category,"Backstock");
  assert.equal((await single("select sum(quantity)::int as known_quantity from inventory_items")).known_quantity,beforeMoveQuantity);
  // Loose stock uses per-item cart IDs so the same logical bin can span carts.
  const looseBin=await single("select id from inventory_bins where bin_code='E92-000'");
  const looseSource=await single("select * from inventory_items where platform='E92' and quantity>=2 order by id limit 1");
  await db.query("update inventory_items set stock_category='Backstock' where id=$1",[looseSource.id]);
  await assert.rejects(db.query("select assign_inventory_to_bin($1,$2,1,false,'F22-A')",[looseSource.id,looseBin.id]),/destination chassis/);
  await assert.rejects(db.query("select assign_inventory_to_bin($1,$2,1,false,'E92-C')",[looseSource.id,looseBin.id]),/destination chassis/);
  const looseA=await single("select assign_inventory_to_bin($1,$2,1,false,'E92-A') as id",[looseSource.id,looseBin.id]);
  const left=await single("select quantity from inventory_items where id=$1",[looseSource.id]);
  const looseB=await single("select assign_inventory_to_bin($1,$2,$3,false,'E92-B') as id",[looseSource.id,looseBin.id,left.quantity]);
  assert.equal((await single("select cart_code from inventory_items where id=$1",[looseA.id])).cart_code,"E92-A");
  assert.equal((await single("select cart_code from inventory_items where id=$1",[looseB.id])).cart_code,"E92-B");
  assert.equal((await single("select stock_category from inventory_items where id=$1",[looseA.id])).stock_category,"Backstock");
  assert.equal((await single("select cart_location from inventory_bins where id=$1",[looseBin.id])).cart_location,null);
  await db.query("select assign_inventory_to_bin($1,$2,1,false)",[looseA.id,bin.id]);
  assert.equal((await single("select cart_code from inventory_items where id=$1",[looseA.id])).cart_code,null);
  await db.query("select assign_inventory_to_bin($1,$2,1,false,null)",[looseA.id,looseBin.id]);
  assert.equal((await single("select cart_code from inventory_items where id=$1",[looseA.id])).cart_code,null);
  console.log("PASS local PostgreSQL: scoped replacement, 215 labels, 49 baseline/50 placed bin nodes, eight carts, five unknown counts, units/provenance, dynamic backup, rollback on conflict, idempotency, RLS archive privacy, RPC count guard, Mobile defaults, Backstock preservation, category constraints, independent chassis Cart A/B locations, one-time E92 mapping, loose-cart assignments and full/partial set-lot moves");
}finally{
  await db.close();
}
