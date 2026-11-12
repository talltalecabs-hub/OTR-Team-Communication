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
  assert.equal((await single("select count(*)::int as records from inventory_bins")).records,45);
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
  const set=await single("select * from inventory_items where quantity_unit in ('set','sets') and quantity>1 limit 1");
  assert(set,"Expected a multi-set source record");
  await db.exec("set role anon");
  const split=await single("select assign_inventory_to_bin($1,$2,1,true) as id",[set.id,bin.id]);
  await db.exec("reset role");
  const moved=await single("select * from inventory_items where id=$1",[split.id]);
  assert.equal(moved.quantity,1);
  assert.equal(moved.quantity_unit,set.quantity_unit);
  assert.deepEqual(moved.source_metadata,set.source_metadata);
  assert.equal((await single("select quantity from inventory_items where id=$1",[set.id])).quantity,set.quantity-1);
  assert.equal(moved.reorder_flag,true);
  console.log("PASS local PostgreSQL: scoped replacement, 215 labels, 45 bin nodes, five unknown counts, units/provenance, dynamic backup, rollback on conflict, idempotency, RLS archive privacy, RPC count guard and set-lot split");
}finally{
  await db.close();
}
