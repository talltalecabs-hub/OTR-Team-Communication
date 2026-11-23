// Full V2 database boundary checks. Runs only in isolated PGlite PostgreSQL.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(join(root,p),'utf8');
const migration=suffix=>read('supabase/migrations/'+readdirSync(join(root,'supabase/migrations')).find(n=>n.endsWith(suffix)));
const db=new PGlite();
const one=async(q,p=[])=>(await db.query(q,p)).rows[0];
const rows=async(q,p=[])=>(await db.query(q,p)).rows;
const actor={admin:randomUUID(),staff:randomUUID(),unassigned:randomUUID(),disabled:randomUUID()};
const snapshot=async()=>one("select (select md5(string_agg(to_jsonb(i)::text,'' order by id)) from inventory_items i) items,(select md5(string_agg(to_jsonb(b)::text,'' order by id)) from inventory_bins b) bins,(select md5(string_agg(to_jsonb(v)::text,'' order by vehicle_code)) from vehicles v) vehicles");
async function call(who,q,p=[],initials='QA',extraClaims={}){
  await db.query("select set_config('request.jwt.claims',$1,false),set_config('request.headers',$2,false)",[JSON.stringify({role:who==='public'?'anon':'authenticated',...(who==='public'?{}:{sub:actor[who]}),...extraClaims}),JSON.stringify(initials?{'x-otr-initials':initials}:{})]);
  await db.exec(who==='public'?'set role anon':'set role authenticated');
  try{return await db.query(q,p);}finally{await db.exec('reset role');}
}
const rpc=async(who,name,args,initials='QA')=>(await call(who,`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args,initials)).rows[0].result;
try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',encrypted_password text default 'original-auth-password-hash',email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}')$$;
    grant usage on schema auth to anon,authenticated;
    create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,unique(bucket_id,name));alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated;grant select,insert on storage.objects to anon,authenticated;`);
  for(const f of ['schema.sql','vehicles_schema.sql','submissions_schema.sql','seed_inventory.sql','label_assistant_schema.sql','inventory_count_schema.sql','inventory_stock_category_schema.sql','update_inventory_f22_e92_20261108.sql','e92_cart_assignments.sql'])await db.exec(read('supabase/'+f));
  for(const suffix of ['_inventory_crew_workflow.sql','_admin_vehicle_registry.sql','_inventory_creation_workspace.sql','_inventory_bin_retirement_and_stock_intake.sql'])await db.exec(migration(suffix));
  const baseline=await snapshot();const v2=migration('_portal_v2_auth_access.sql');
  await assert.rejects(db.exec(v2),/verified, active owner Admin/);
  for(const [who,id] of Object.entries(actor))await db.query('insert into auth.users(id,raw_app_meta_data,email_confirmed_at,banned_until) values($1,$2,now(),$3)',[id,{otr_portal_role:who==='disabled'?'staff':who==='unassigned'?null:who},who==='disabled'?'2099-01-01':null]);
  await db.exec(v2);assert.deepEqual(await snapshot(),baseline);
  assert.equal((await rpc('public','portal_access',[])).role,'public');
  for(const who of ['staff','admin']){
    const access=await rpc(who,'portal_access',[]);
    assert.equal(access.password_change_required,true);assert.equal(access.role,'public');
    await assert.rejects(rpc(who,'save_inventory_workspace_draft',[randomUUID(),0,{data:{}},'QA']),/authorized team/);
    await assert.rejects(call(who,'select * from otr_portal_internal.password_setup'),/permission denied/);
    await assert.rejects(call(who,'delete from otr_portal_internal.password_setup where user_id=$1',[actor[who]]),/permission denied/);
    await db.query("update auth.users set raw_user_meta_data='{\"password_change_required\":false}' where id=$1",[actor[who]]);
    assert.equal((await rpc(who,'portal_access',[])).password_change_required,true);
    await db.query("update auth.users set encrypted_password='new-auth-password-hash' where id=$1",[actor[who]]);
    assert.equal((await rpc(who,'portal_access',[])).password_change_required,false);
  }
  assert.equal((await rpc('staff','portal_access',[])).role,'staff');
  assert.equal((await rpc('admin','portal_access',[])).role,'admin');
  assert.equal((await rpc('disabled','portal_access',[])).role,'public');
  const forged=(await call('unassigned','select portal_access() as result',[],'QA',{user_metadata:{otr_portal_role:'admin'},app_metadata:{otr_portal_role:'admin'}})).rows[0].result;
  assert.equal(forged.role,'public');
  await assert.rejects(call('unassigned',"update auth.users set raw_app_meta_data='{\"otr_portal_role\":\"admin\"}' where id=$1",[actor.unassigned]),/permission denied/);
  const item=await one("select * from inventory_items where platform='E92' and quantity>=3 order by inventory_code limit 1");
  assert((await call('public','select * from inventory_items where id=$1',[item.id])).rows.length===1);
  for(const table of ['inventory_workspace_drafts','inventory_events','inventory_workspace_events','submissions','vehicle_registry_events'])await assert.rejects(call('public',`select * from ${table}`),/permission denied/);
  await assert.rejects(call('public',"update inventory_items set quantity=100,item_name='Forged' where id=$1",[item.id]),/permission denied/);
  await assert.rejects(call('public',"insert into inventory_bins(bin_code,make,make_prefix,model,system) values('E92-999','BMW','B','E92','Unauthorized')"),/permission denied/);
  const request=randomUUID();
  const used=await rpc('public','use_inventory_part',[item.id,'E92-HULK',1,'NP',request]);
  assert.equal(used.quantity_after,item.quantity-1);
  assert.equal((await rpc('public','use_inventory_part',[item.id,'E92-HULK',1,'NP',request])).replayed,true);
  assert.equal((await one('select count(*)::int n from inventory_events where request_id=$1',[request])).n,1);
  await assert.rejects(rpc('public','use_inventory_part',[item.id,'E92-HULK',1,'',randomUUID()]),/Initials/);
  await assert.rejects(rpc('public','use_inventory_part',[item.id,'NONEXISTENT',1,'NP',randomUUID()]),/existing vehicle/);
  await assert.rejects(rpc('public','use_inventory_part',[item.id,'E92-HULK',999999,'NP',randomUUID()]),/exceeds available/);
  const oldName=item.item_name;
  for(const who of ['public','unassigned','disabled']){
    await assert.rejects(rpc(who,'rename_inventory_part',[item.id,'Unauthorized',oldName,randomUUID(),'QA']),/permission denied|authorized team/);
    await assert.rejects(rpc(who,'save_inventory_workspace_draft',[randomUUID(),0,{data:{}},'QA']),/permission denied|authorized team/);
    await assert.rejects(rpc(who,'save_vehicle_registry',['E92-HULK',1,{vehicle_name:'Unauthorized'},'QA']),/permission denied|authorized team/);
  }
  assert.equal((await one('select item_name from inventory_items where id=$1',[item.id])).item_name,oldName);
  const renamed=await rpc('staff','rename_inventory_part',[item.id,'Authorized correction',oldName,randomUUID(),'AB']);
  assert.equal(renamed.item_name,'Authorized correction');assert.equal(renamed.quantity,item.quantity-1);
  await assert.rejects(call('staff','update inventory_items set quantity=7 where id=$1',[item.id],''),/Initials/);
  await call('staff','update inventory_items set quantity=7 where id=$1',[item.id],'AB');
  assert.equal((await one('select quantity from inventory_items where id=$1',[item.id])).quantity,7);
  const submissionId=randomUUID();
  await call('public',"insert into submissions(id,submission_type,submitted_name,answers) values($1,'admin_access_request','Requestor','{\"email\":\"future@example.test\",\"requested_role\":\"admin\"}')",[submissionId]);
  assert.equal((await call('staff','select * from submissions')).rows.length,0);
  assert.equal((await call('admin','select * from submissions where id=$1',[submissionId])).rows.length,1);
  await assert.rejects(rpc('staff','save_vehicle_registry',['E92-HULK',1,{designation:'999'},'AB']),/authorized team/);
  const vehicle=await one("select * from vehicles where vehicle_code='E92-HULK'");
  await call('staff',"update vehicles set designation='999' where vehicle_code='E92-HULK'");
  assert.deepEqual(await one("select * from vehicles where vehicle_code='E92-HULK'"),vehicle);
  const editedVehicle=await rpc('admin','save_vehicle_registry',[vehicle.vehicle_code,vehicle.revision,{designation:'69x'},'AD']);
  assert.equal(editedVehicle.vehicle_code,vehicle.vehicle_code);
  // Shared drafts/photos and the printed tag identity survive the access split.
  const draftId=randomUUID();let draft=await rpc('staff','save_inventory_workspace_draft',[draftId,0,{data:{item_name:'Auth stock fixture',platform:'F22',quantity:2,stock_category:'Mobile'}},'AB']);
  const path=draftId+'/'+randomUUID()+'.png';
  await assert.rejects(call('public',"insert into storage.objects(bucket_id,name) values('otr-inventory-workspace',$1)",[path]),/row-level security/);
  await assert.rejects(call('unassigned',"insert into storage.objects(bucket_id,name) values('otr-inventory-workspace',$1)",[path]),/row-level security/);
  await call('staff',"insert into storage.objects(bucket_id,name) values('otr-inventory-workspace',$1)",[path]);
  assert.equal((await call('public','select * from storage.objects')).rows.length,0);
  assert.equal((await call('staff','select * from storage.objects')).rows.length,1);
  draft=await rpc('staff','save_inventory_workspace_draft',[draftId,draft.revision,{data:{photo_paths:[path]}},'AB']);
  draft=await rpc('staff','commit_inventory_workspace_draft',[draftId,draft.revision,'AB']);
  assert((await call('public','select * from inventory_tag_links()')).rows.some(link=>link.tag_id===draft.tag_id&&link.inventory_item_id===draftId));
  assert.equal((await one('select tag_id from inventory_items where id=$1',[draftId])).tag_id,draft.tag_id);
  // Role removal is checked against the current Auth row, not stale JWT claims.
  await db.query("update auth.users set raw_app_meta_data='{}' where id=$1",[actor.staff]);
  await assert.rejects(rpc('staff','save_inventory_workspace_draft',[randomUUID(),0,{data:{}},'AB']),/authorized team/);
  const rpcPrivileges=await rows("select p.proname,has_function_privilege('anon',p.oid,'EXECUTE') allowed from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('assign_inventory_to_bin','commit_inventory_workspace_draft','create_inventory_stock','duplicate_inventory_workspace_draft','move_inventory_part','reconcile_inventory_stock','rename_inventory_bin','rename_inventory_part','retire_inventory_bin','save_inventory_workspace_draft','save_vehicle_registry')");
  assert.equal(rpcPrivileges.length,11);assert(rpcPrivileges.every(p=>p.allowed===false));
  const implementations=await rows("select proname,prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='otr_portal_internal' and proname like '%_v2_impl'");
  assert(implementations.every(p=>p.prosecdef===(p.proname==='use_inventory_part_v2_impl')));
  assert.equal((await one("select p.prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname='use_inventory_part'")).prosecdef,false);
  console.log('PASS V2 PostgreSQL: owner preflight, server-enforced first-password change, private setup fingerprints, unchanged data, explicit current roles, forged/stale metadata denied, public browse/Use Part/forms, no anonymous management writes, staff/admin separation, initials/ledger/retry preservation, staff Storage, public printed-tag lookup and immediate role removal');
}finally{await db.close();}
