// Isolated PostgreSQL ledger/RPC regression. Never connects to production.
// PGLITE_MODULE can point to a temporary external install of @electric-sql/pglite.
import assert from "node:assert/strict";
import {readFileSync,readdirSync,existsSync} from "node:fs";
import {dirname,join,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";

const {PGlite}=await import(process.env.PGLITE_MODULE||"@electric-sql/pglite");
const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const read=file=>readFileSync(isAbsolute(file)?file:join(root,file),"utf8");
const migrations=join(root,"supabase/migrations");
const migration=process.env.INVENTORY_LEDGER_SCHEMA||(
  existsSync(migrations)?join(migrations,readdirSync(migrations).filter(name=>name.endsWith("_inventory_crew_workflow.sql")).sort().at(-1)||"missing.sql"):"/tmp/otr-inventory-crew-ledger.sql"
);
const db=new PGlite();
const rows=async(sql,params=[]) => (await db.query(sql,params)).rows;
const one=async(sql,params=[]) => (await rows(sql,params))[0];
const eventCount=async()=>Number((await one("select count(*)::int as total from inventory_events")).total);
const record=async id=>one("select * from inventory_items where id=$1",[id]);
const snapshot=async table=>(await rows(`select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)->>'id',to_jsonb(t)->>'vehicle_code',to_jsonb(t)->>'cart_code'`)).map(row=>row.row);

async function portalTransaction(initials,action){
  await db.exec("begin");
  try{
    const headers=initials===null?{}:{"x-otr-initials":initials};
    await db.query("select set_config('request.headers',$1,true)",[JSON.stringify(headers)]);
    await db.exec("set local role anon");
    const result=await action();
    await db.exec("commit");
    return result;
  }catch(error){
    await db.exec("rollback");
    throw error;
  }
}
const portalWrite=(initials,sql,params=[])=>portalTransaction(initials,()=>rows(sql,params));
async function portalRpc(sql,params=[]){
  await db.exec("set role anon");
  try{return await rows(sql,params);}finally{await db.exec("reset role");}
}
const use=async(item,quantity,initials="jd",vehicle="E92-CHERRY",request=randomUUID()) =>
  (await portalRpc("select use_inventory_part($1,$2,$3,$4,$5) as result",[item,vehicle,quantity,initials,request]))[0].result;
const move=async(item,quantity,category,chassis,cart,bin,initials="mv",request=randomUUID()) =>
  (await portalRpc("select move_inventory_part($1,$2,$3,$4,$5,$6,$7,$8,$9) as result",[item,category,chassis,cart,bin,quantity,false,initials,request]))[0].result;
const event=async(type,actor) => one("select * from inventory_events where event_type=$1 and actor_initials=$2 order by created_at desc limit 1",[type,actor]);

try{
  await db.exec("create role anon; create role authenticated;");
  for(const file of ["schema.sql","vehicles_schema.sql","submissions_schema.sql","seed_inventory.sql","label_assistant_schema.sql","inventory_count_schema.sql","inventory_stock_category_schema.sql","update_inventory_f22_e92_20261108.sql","e92_cart_assignments.sql"]){
    await db.exec(read("supabase/"+file));
  }
  await db.exec("insert into submissions(submission_type,quick_feedback) values('feedback_quick','Existing submission')");
  const preserved={};
  for(const table of ["inventory_items","inventory_bins","inventory_carts","vehicles","submissions"]) preserved[table]=await snapshot(table);
  await db.exec(read(migration));
  assert((await one("select proconfig from pg_proc where oid='public.set_inventory_updated_at()'::regprocedure")).proconfig.includes("search_path=pg_catalog"));
  for(const [table,before] of Object.entries(preserved)) assert.deepEqual(await snapshot(table),before,`${table} changed during ledger installation`);
  assert.equal(await eventCount(),0,"Do not invent historical ledger entries");
  await db.exec(read(migration));
  assert.equal(await eventCount(),0,"Migration rerun should not create events");
  // Supabase's migration owner is not a superuser. Both RPC declarations must
  // be creatable by a normal owner, including all function configuration.
  await db.exec("create role managed_migration_owner; grant create on schema public to managed_migration_owner;");
  await db.exec("set role managed_migration_owner");
  try{
    const rpcDefinitions=[...read(migration).matchAll(/create or replace function public\.(use_inventory_part|move_inventory_part)\([\s\S]*?\n\$\$;/g)];
    assert.equal(rpcDefinitions.length,2);
    for(const [definition,name] of rpcDefinitions){
      await db.exec(definition.replace(`public.${name}(`,`public.test_managed_${name}(`));
    }
  }finally{await db.exec("reset role");}


  const regular=await one("select * from inventory_bins where bin_code='E92-008'");
  const looseE92=await one("select * from inventory_bins where bin_code='E92-000'");
  const looseF22=await one("select * from inventory_bins where bin_code='F22-000'");
  const looseF30=await one("select * from inventory_bins where bin_code='F30-000'");
  const existing=await one("select id from inventory_items where quantity>=1 limit 1");
  await assert.rejects(portalWrite(null,"update inventory_items set quantity=quantity where id=$1",[existing.id]),/Initials are required/);
  await assert.rejects(portalWrite("  ","insert into inventory_items(inventory_code,item_name,quantity) values('NO-ACTOR','No actor',1)"),/Initials are required/);
  await assert.rejects(portalWrite(null,"update inventory_bins set cart_location=cart_location where id=$1",[regular.id]),/Initials are required/);
  await assert.rejects(portalWrite("ABCDEFGHI","update inventory_items set tag_id='INVALID' where id=$1",[existing.id]),/Initials are required/);
  assert.equal(await eventCount(),0);

  const [known]=await portalWrite(" ab ",`insert into inventory_items(
    inventory_code,item_name,quantity,platform,stock_category,inventory_bin_id,location,
    quantity_unit,source_metadata,part_number,compatibility,assignment_type,assigned_vehicle_code,assigned_vehicle,verification_status
  ) values('CREW-KNOWN','Crew coolant sensor',5,'E92','Mobile',$1,'E92-008','pcs','{"source":"unchanged fixture","printed_label":"SENSOR"}'::jsonb,'PN-123','["E92"]'::jsonb,'Specific Vehicle','E92-CHERRY','Cherry','Verified') returning *`,[regular.id]);
  const added=await event("add_stock","AB");
  assert.equal(added.inventory_item_id,known.id);
  assert.equal(added.quantity_before,null);
  assert.equal(added.quantity_after,5);
  assert.equal(added.quantity_delta,5);
  assert.equal(added.bin_code,"E92-008");
  assert.equal(added.cart_code,"E92-A");
  assert.equal(added.actor_initials,"AB");

  const beforeUse=await record(known.id);
  const request=randomUUID();
  const consumed=await use(known.id,2,"jd","E92-CHERRY",request);
  assert.deepEqual({before:consumed.quantity_before,after:consumed.quantity_after,used:consumed.quantity_used,actor:consumed.actor_initials},{before:5,after:3,used:2,actor:"JD"});
  const afterUse=await record(known.id);
  for(const [key,value] of Object.entries(beforeUse)) if(!["quantity","updated_at"].includes(key)) assert.deepEqual(afterUse[key],value,`Use changed ${key}`);
  const usedEvent=await event("use_part","JD");
  assert.equal(usedEvent.vehicle_code,"E92-CHERRY");
  assert.equal(usedEvent.quantity_delta,-2);
  assert.equal(usedEvent.from_state.inventory_bin_id,regular.id);
  assert.equal(usedEvent.to_state.inventory_bin_id,regular.id);
  assert.equal(usedEvent.to_state.assigned_vehicle_code,"E92-CHERRY");
  assert.equal(usedEvent.from_state.physical_location,"E92-A");
  assert.equal(usedEvent.to_state.physical_bin_code,"E92-008");
  assert.equal(usedEvent.request_id,request);

  const beforeReplayCount=await eventCount();
  const replayed=await use(known.id,2," jd ","E92-CHERRY",request);
  assert.equal(replayed.replayed,true);
  assert.equal(replayed.event_id,consumed.event_id);
  assert.equal((await record(known.id)).quantity,3);
  assert.equal(await eventCount(),beforeReplayCount);
  await assert.rejects(use(known.id,1,"JD","E92-CHERRY",request),/different operation/);
  await assert.rejects(use(known.id,4),/exceeds available/);
  await assert.rejects(use(known.id,0),/at least 1/);
  await assert.rejects(use(known.id,1," "),/Initials are required/);
  await assert.rejects(use(known.id,1,"JD","invented-car"),/existing vehicle/);
  assert.equal((await record(known.id)).quantity,3);
  assert.equal(await eventCount(),beforeReplayCount);

  const empty=await use(known.id,3,"zz");
  assert.equal(empty.quantity_after,0);
  assert.equal((await record(known.id)).status,"Out of Stock");
  await assert.rejects(use(known.id,1),/exceeds available/);

  const [unknown]=await portalWrite("un",`insert into inventory_items(
    inventory_code,item_name,quantity,platform,stock_category,inventory_bin_id,location,cart_code,status,source_metadata
  ) values('CREW-UNKNOWN','Uncounted hardware',null,'F22','Mobile',$1,'F22-000','F22-B','Uncounted','{"printed_quantity":"VARIOUS"}'::jsonb) returning *`,[looseF22.id]);
  const unknownBefore=await record(unknown.id);
  const unknownResult=await use(unknown.id,3,"uk","M235-RAPTOR");
  assert.equal(unknownResult.quantity_before,null);
  assert.equal(unknownResult.quantity_after,null);
  assert.equal((await record(unknown.id)).quantity,null);
  assert.equal((await record(unknown.id)).status,"Uncounted");
  for(const [key,value] of Object.entries(unknownBefore)) if(key!=="updated_at") assert.deepEqual((await record(unknown.id))[key],value,`Unknown use changed ${key}`);
  const unknownEvent=await event("use_part","UK");
  assert.equal(unknownEvent.quantity_delta,-3);
  assert.equal(unknownEvent.quantity_before,null);
  assert.equal(unknownEvent.quantity_after,null);
  await assert.rejects(use(unknown.id,2,"JD","E92-CHERRY",request),/different operation/);

  // The event insert is in the same transaction as the stock update.
  await portalWrite("ct","update inventory_items set quantity=4,status='In Stock' where id=$1",[known.id]);
  const countEvent=await event("quantity_corrected","CT");
  assert.equal(countEvent.quantity_before,0);
  assert.equal(countEvent.quantity_after,4);
  assert.equal(countEvent.quantity_delta,4);
  assert.equal(countEvent.vehicle_code,null);
  await db.exec(`create function public.test_reject_ledger_insert() returns trigger language plpgsql as $$begin raise exception 'Test ledger failure'; end;$$;
    create trigger test_ledger_failure before insert on inventory_events for each row execute function public.test_reject_ledger_insert()`);
  const eventsBeforeFailure=await eventCount();
  const stockBeforeFailure=await record(known.id);
  await assert.rejects(use(known.id,1,"lf"),/Test ledger failure/);
  assert.deepEqual(await record(known.id),stockBeforeFailure);
  assert.equal(await eventCount(),eventsBeforeFailure);
  await db.exec("drop trigger test_ledger_failure on inventory_events; drop function public.test_reject_ledger_insert()");

  await portalWrite("rv","update inventory_items set verification_status='Needs Review' where id=$1",[known.id]);
  assert.equal((await event("verification_changed","RV")).to_state.verification_status,"Needs Review");
  await portalWrite("nf","update inventory_items set verification_status='Not Found',status='Missing' where id=$1",[known.id]);
  assert.equal((await event("verification_changed","NF")).to_state.status,"Missing");
  await portalWrite("rf","update inventory_items set reorder_flag=true,reorder_level=2 where id=$1",[known.id]);
  assert.equal((await event("reorder_flag_changed","RF")).to_state.reorder_flag,true);
  await portalWrite("tg","update inventory_items set tag_id='TAG-CREW-KNOWN' where id=$1",[known.id]);
  assert.equal((await event("metadata_changed","TG")).to_state.tag_id,"TAG-CREW-KNOWN");
  await assert.rejects(portalWrite(null,"update inventory_items set verification_status='Verified' where id=$1",[known.id]),/Initials are required/);
  await assert.rejects(portalWrite(null,"update inventory_items set reorder_flag=false where id=$1",[known.id]),/Initials are required/);
  await assert.rejects(portalWrite("bad","update inventory_items set cart_code='E92-A' where id=$1",[known.id]),/inherits its cart/);
  await assert.rejects(portalWrite("bad","update inventory_items set stock_category='Backstock' where id=$1",[known.id]),/Backstock cannot/);
  await portalWrite("bk","update inventory_items set stock_category='Backstock',inventory_bin_id=null,cart_code=null,location='Backstock' where id=$1",[known.id]);
  assert.equal((await event("stock_category_changed","BK")).to_state.stock_category,"Backstock");

  // Full and partial physical moves preserve permanent assignment and provenance.
  const beforeFull=await record(known.id);
  const moveRequest=randomUUID();
  const full=await move(known.id,4,"Mobile","F30","F30-A",looseF30.id,"mv",moveRequest);
  assert.equal(full.item_id,known.id);
  assert.equal(full.split,false);
  const afterFull=await record(known.id);
  assert.equal(afterFull.platform,"F30");
  assert.equal(afterFull.cart_code,"F30-A");
  assert.equal(afterFull.assigned_vehicle_code,beforeFull.assigned_vehicle_code);
  assert.deepEqual(afterFull.compatibility,beforeFull.compatibility);
  assert.deepEqual(afterFull.source_metadata,beforeFull.source_metadata);
  assert.equal(afterFull.tag_id,beforeFull.tag_id);
  assert.equal((await event("move_inventory","MV")).from_state.stock_category,"Backstock");
  assert.equal((await event("move_inventory","MV")).from_state.physical_location,"Backstock");
  assert.equal((await event("move_inventory","MV")).to_state.physical_cart_code,"F30-A");
  const moveEventCount=await eventCount();
  const moveReplay=await move(known.id,4,"Mobile","F30","F30-A",looseF30.id,"MV",moveRequest);
  assert.equal(moveReplay.replayed,true);
  assert.equal(await eventCount(),moveEventCount);
  await assert.rejects(move(known.id,3,"Mobile","F30","F30-A",looseF30.id,"MV",moveRequest),/different operation/);
  await assert.rejects(move(known.id,1,"Mobile","",null,null),/Choose a chassis/);
  await assert.rejects(move(known.id,1,"Mobile","E92","E92-B",regular.id),/inherits its cart/);
  await assert.rejects(move(known.id,1,"Mobile","F30","F30-A",looseE92.id),/Bin must match/);
  await assert.rejects(move(known.id,1,"Backstock","F30","F30-A",null),/Backstock cannot/);
  await assert.rejects(move(unknown.id,1,"Mobile","F22","F22-A",looseF22.id),/Count this inventory/);
  const totalBeforeMove=(await one("select sum(quantity)::int as total from inventory_items")).total;
  const splitRequest=randomUUID();
  const split=await move(known.id,2,"Mobile","F22","F22-B",looseF22.id,"sp",splitRequest);
  assert.equal(split.split,true);
  assert.notEqual(split.item_id,known.id);
  const moved=await record(split.item_id);
  assert.equal(moved.quantity,2);
  assert.equal(moved.cart_code,"F22-B");
  assert.equal(moved.inventory_bin_id,looseF22.id);
  assert.equal(moved.stock_category,"Mobile");
  assert.equal(moved.tag_id,null);
  assert.equal(moved.quantity_unit,afterFull.quantity_unit);
  assert.deepEqual(moved.source_metadata,afterFull.source_metadata);
  assert.deepEqual(moved.compatibility,afterFull.compatibility);
  assert.equal(moved.assignment_type,afterFull.assignment_type);
  assert.equal((await record(known.id)).quantity,2);
  assert.equal((await record(known.id)).cart_code,"F30-A");
  assert.equal((await one("select sum(quantity)::int as total from inventory_items")).total,totalBeforeMove);
  const splitEvents=await rows("select * from inventory_events where request_id=$1 order by quantity_delta",[splitRequest]);
  assert.equal(splitEvents.length,2);
  assert.deepEqual(splitEvents.map(row=>row.quantity_delta),[-2,2]);
  assert(splitEvents.every(row=>row.event_type==="move_inventory" && row.actor_initials==="SP" && row.operation_item_id===split.item_id));
  await move(known.id,2,"Backstock","F30",null,null,"bt");
  assert.equal((await record(known.id)).stock_category,"Backstock");
  assert.equal((await record(known.id)).cart_code,null);
  assert.equal((await record(known.id)).inventory_bin_id,null);
  await move(known.id,2,"Mobile","E92","E92-A",regular.id,"rg");
  assert.equal((await record(known.id)).cart_code,null);
  assert.equal((await record(known.id)).inventory_bin_id,regular.id);
  assert.equal((await event("move_inventory","RG")).cart_code,"E92-A");
  await assert.rejects(portalRpc("select assign_inventory_to_bin($1,$2,1,false)",[known.id,looseE92.id]),/permission denied/);

  await assert.rejects(portalWrite(null,"insert into inventory_bins(bin_code,make,make_prefix,model,system) values('F30-900','BMW','B','F30','Test')"),/Initials are required/);
  const [newBin]=await portalWrite("bc","insert into inventory_bins(bin_code,make,make_prefix,model,system) values('F30-900','BMW','B','F30','Test') returning *");
  assert.equal((await event("bin_created","BC")).bin_code,"F30-900");
  await portalWrite("bm","update inventory_bins set cart_location='A' where id=$1",[newBin.id]);
  const binEvent=await event("bin_moved","BM");
  assert.equal(binEvent.from_state.cart_location,null);
  assert.equal(binEvent.to_state.cart_location,"A");
  assert.equal(binEvent.cart_code,"F30-A");
  await portalWrite("bn","update inventory_bins set description='Useful bin name' where id=$1",[newBin.id]);
  assert.equal((await event("bin_updated","BN")).to_state.description,"Useful bin name");

  // A real physical count can resolve NULL; its delta must not invent a prior count.
  await portalWrite("uc","update inventory_items set quantity=7,status='In Stock',verification_status='Verified',verified_at=now() where id=$1",[unknown.id]);
  const resolvedCount=await event("quantity_corrected","UC");
  assert.equal(resolvedCount.quantity_before,null);
  assert.equal(resolvedCount.quantity_after,7);
  assert.equal(resolvedCount.quantity_delta,null);
  assert.equal((await one("select quantity_after from inventory_events where id=$1",[unknownEvent.id])).quantity_after,null);
  await portalWrite("vv","update inventory_items set verified_at=now() where id=$1",[known.id]);
  assert.equal((await event("verification_changed","VV")).inventory_item_id,known.id);

  // Crew notes use the existing text field; edits audit only metadata and preserve imported provenance.
  const importedForNotes=await one("select id from inventory_items where source_metadata ? 'source_row' and notes is not null limit 1");
  assert(importedForNotes,"Notes regression requires a real workbook record with an existing note");
  await portalWrite("nt","update inventory_items set tag_id='TAG-NOTES-PRESERVED' where id=$1",[importedForNotes.id]);
  const beforeNotes=await record(importedForNotes.id);
  assert.equal(typeof beforeNotes.source_metadata.source_row,"number");
  const notesEventCount=await eventCount();
  const editedNotes="Crew check: inspect the connector before use.\nKeep the physical label with this part.";
  await assert.rejects(portalWrite(" ","update inventory_items set notes=$2,updated_at=$3 where id=$1",[beforeNotes.id,editedNotes,new Date().toISOString()]),/Initials are required/);
  assert.deepEqual(await record(beforeNotes.id),beforeNotes);
  assert.equal(await eventCount(),notesEventCount);
  await portalWrite(" nz ","update inventory_items set notes=$2,updated_at=$3 where id=$1",[beforeNotes.id,editedNotes,new Date().toISOString()]);
  const afterNotes=await record(beforeNotes.id);
  assert.equal(afterNotes.notes,editedNotes);
  for(const [key,value] of Object.entries(beforeNotes)) if(!["notes","updated_at"].includes(key)) assert.deepEqual(afterNotes[key],value,`Notes edit changed ${key}`);
  assert.equal(await eventCount(),notesEventCount+1);
  const notesEvent=await event("metadata_changed","NZ");
  assert.equal(notesEvent.inventory_item_id,beforeNotes.id);
  assert.equal(notesEvent.inventory_code,beforeNotes.inventory_code);
  assert.equal(notesEvent.actor_initials,"NZ");
  assert.equal(notesEvent.from_state.notes,beforeNotes.notes);
  assert.equal(notesEvent.to_state.notes,editedNotes);
  for(const key of ["inventory_code","source","source_metadata","original_quantity","original_item_text","original_location","tag_id","quantity","inventory_bin_id","cart_code","assignment_type","assigned_vehicle_code"]){
    assert.deepEqual(notesEvent.from_state[key],beforeNotes[key],`Notes audit lost prior ${key}`);
    assert.deepEqual(notesEvent.to_state[key],beforeNotes[key],`Notes audit changed ${key}`);
  }
  assert.equal(notesEvent.quantity_delta,0);
  assert.equal(notesEvent.vehicle_code,null);

  // Independent actions in one transaction must not inherit RPC actor/type/request context.
  const txUseRequest=randomUUID(),txMoveRequest=randomUUID(),secondUseRequest=randomUUID();
  await portalTransaction("tx",async()=>{
    await rows("select use_inventory_part($1,'E92-CHERRY',1,'u1',$2)",[known.id,txUseRequest]);
    await rows("update inventory_items set quantity=2,status='In Stock' where id=$1",[known.id]);
    await rows("select move_inventory_part($1,'Mobile','F30','F30-A',$2,2,false,'m1',$3)",[known.id,looseF30.id,txMoveRequest]);
    await rows("update inventory_items set notes='Independent metadata write' where id=$1",[known.id]);
    await rows("select use_inventory_part($1,'E92-CHERRY',1,'u2',$2)",[known.id,secondUseRequest]);
    await rows("update inventory_items set reorder_flag=true where id=$1",[known.id]);
    for(const setting of ["actor_initials","inventory_event_type","inventory_request_id","inventory_operation_item_id","inventory_operation_data","inventory_vehicle_code","inventory_quantity_delta"]){
      assert(!((await one("select current_setting($1,true) as value",["otr."+setting])).value),`Leaked RPC context: ${setting}`);
    }
  });
  const txEvents=await rows("select * from inventory_events where actor_initials='TX'");
  assert.deepEqual(txEvents.map(row=>row.event_type).sort(),["metadata_changed","quantity_corrected","reorder_flag_changed"]);
  assert(txEvents.every(row=>row.vehicle_code===null && row.operation_data===null && row.operation_item_id===null));
  assert(txEvents.every(row=>![txUseRequest,txMoveRequest,secondUseRequest].includes(row.request_id)));
  assert.equal((await event("use_part","U1")).request_id,txUseRequest);
  assert.equal((await event("move_inventory","M1")).request_id,txMoveRequest);
  assert.equal((await event("use_part","U2")).request_id,secondUseRequest);
  const beforeScopedFailure=await record(known.id),eventsBeforeScopedFailure=await eventCount();
  await assert.rejects(portalTransaction(null,async()=>{
    await rows("select use_inventory_part($1,'E92-CHERRY',1,'ux',$2)",[known.id,randomUUID()]);
    await rows("update inventory_items set notes='Missing initials after Use' where id=$1",[known.id]);
  }),/Initials are required/);
  assert.deepEqual(await record(known.id),beforeScopedFailure);
  assert.equal(await eventCount(),eventsBeforeScopedFailure);
  await assert.rejects(portalTransaction(null,async()=>{
    await rows("select move_inventory_part($1,'Mobile','E92',null,$2,1,false,'mx',$3)",[known.id,regular.id,randomUUID()]);
    await rows("update inventory_bins set description='Missing initials after Move' where id=$1",[newBin.id]);
  }),/Initials are required/);
  assert.deepEqual(await record(known.id),beforeScopedFailure);
  assert.equal(await eventCount(),eventsBeforeScopedFailure);
  await portalWrite("mw","update inventory_items set notes='Multi-row request' where id=any($1::uuid[])",[[known.id,unknown.id]]);
  const multiEvents=await rows("select * from inventory_events where actor_initials='MW'");
  assert.equal(multiEvents.length,2);
  assert.equal(new Set(multiEvents.map(row=>row.request_id)).size,2);
  assert(multiEvents.every(row=>row.event_type==='metadata_changed'));
  await assert.rejects(move(unknown.id,1,"Mobile","F30","F30-A",looseF30.id,"MV",moveRequest),/different operation/);

  // Reassigning a bin cannot silently contradict the chassis/category of its contents.
  await portalWrite("bu","update inventory_bins set cart_location=null where id=$1",[newBin.id]);
  await portalWrite("bi",`insert into inventory_items(inventory_code,item_name,quantity,platform,stock_category,inventory_bin_id)
    values('CREW-BACKSTOCK-BIN','Backstock in an unassigned bin',1,'F30','Backstock',$1)`,[newBin.id]);
  await assert.rejects(portalWrite("bp","update inventory_bins set model='E92' where id=$1",[newBin.id]),/Bin chassis must match/);
  await assert.rejects(portalWrite("bp","update inventory_bins set cart_location='A' where id=$1",[newBin.id]),/Bin placement conflicts/);

  // Normal portal roles cannot forge or edit ledger history or call its private writers.
  await db.exec("set role anon");
  assert((await rows("select id from inventory_events limit 1")).length===1);
  await assert.rejects(db.query("insert into inventory_events(event_type,actor_initials) values('add_stock','FAKE')"),/permission denied/);
  await assert.rejects(db.query("update inventory_events set notes='rewrite'"),/permission denied/);
  await assert.rejects(db.query("delete from inventory_events"),/permission denied/);
  await assert.rejects(db.query("select otr_inventory_internal.guard_inventory_mutation()"),/permission denied/);
  await db.exec("reset role");
  await assert.rejects(db.query("update inventory_events set notes='owner rewrite'"),/append-only/);
  await assert.rejects(db.query("delete from inventory_events"),/append-only/);
  assert.equal((await one("select count(*)::int as invalid from inventory_events where actor_initials='' or actor_initials<>upper(btrim(actor_initials))")).invalid,0);
  assert.deepEqual(await snapshot("vehicles"),preserved.vehicles);
  assert.deepEqual(await snapshot("submissions"),preserved.submissions);
  console.log("PASS crew ledger PostgreSQL: data-preserving migration, required uppercase initials on every write, atomic/idempotent Use Part, zero/NULL counts, exact vehicles, immutable private-trigger audit, quantity correction, review/reorder/tag events, notes edits preserving workbook provenance, full/partial moves, placement consistency and transaction-isolated RPC audit context");
}finally{
  await db.close();
}
