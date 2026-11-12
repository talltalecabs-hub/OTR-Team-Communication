import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root=join(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir=join(root, "assets");
const javascriptFiles=readdirSync(assetsDir)
  .filter(name=>name.endsWith(".js"))
  .map(name=>join(assetsDir, name));

const allJavascriptFiles=[...javascriptFiles,...[root,join(root,"scripts")].flatMap(directory=>
  readdirSync(directory).filter(name=>/\.(?:mjs|js)$/.test(name)).map(name=>join(directory,name)))];
for(const file of allJavascriptFiles){
  execFileSync(process.execPath, ["--check", file], {stdio:"pipe"});
}

const html=readFileSync(join(root, "index.html"), "utf8");
const javascript=javascriptFiles.map(file=>readFileSync(file, "utf8")).join("\n");
const handlerNames=[...(html+"\n"+javascript).matchAll(/\bon(?:click|change|input)="([A-Za-z_$][\w$]*)\s*\(/g)]
  .map(match=>match[1]);
const functionNames=new Set(
  [...javascript.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)]
    .map(match=>match[1])
);
const missingHandlers=[...new Set(handlerNames)].filter(name=>!functionNames.has(name));

if(missingHandlers.length){
  throw new Error(`Missing inline handlers: ${missingHandlers.join(", ")}`);
}

function parseValues(line){
  const start=line.toLowerCase().indexOf(" values (")+9;
  const end=line.toLowerCase().lastIndexOf(") on conflict");
  const source=line.slice(start, end);
  const values=[];
  let current="";
  let quoted=false;

  for(let index=0;index<source.length;index+=1){
    const character=source[index];
    if(character==="'"){
      if(quoted && source[index+1]==="'"){
        current+="''";
        index+=1;
        continue;
      }
      quoted=!quoted;
      current+=character;
      continue;
    }
    if(character==="," && !quoted){
      values.push(current.trim());
      current="";
    }else{
      current+=character;
    }
  }
  values.push(current.trim());

  return values.map(value=>{
    if(value.startsWith("'") && value.endsWith("'")){
      return value.slice(1, -1).replaceAll("''", "'");
    }
    return value;
  });
}

const seed=readFileSync(join(root, "supabase", "seed_inventory.sql"), "utf8");
const seedRows=seed.split(/\r?\n/)
  .filter(line=>/^insert into public\.inventory_items/i.test(line))
  .map(parseValues);
const inventoryCodes=seedRows.map(values=>values[0]);
const totalUnits=seedRows.reduce((total, values)=>total+Number(values[5]), 0);

if(seedRows.length!==297 || new Set(inventoryCodes).size!==297 || totalUnits!==690){
  throw new Error(
    `Inventory seed mismatch: ${seedRows.length} rows, `+
    `${new Set(inventoryCodes).size} unique IDs, ${totalUnits} units.`
  );
}

const snapshot=JSON.parse(readFileSync(join(root,"data/inventory/f22-e92-2026-11-08.json"),"utf8"));
assert.equal(snapshot.parts.length,215);
assert.equal(new Set(snapshot.parts.map(row=>row.inventory_code)).size,215);
assert.equal(snapshot.bins.length,43);
assert.equal(new Set(snapshot.bins.map(row=>row.parent_bin_code)).size,39);
for(const [platform,records,unknown,units] of [
  ["F22",92,4,{pcs:197,set:1,sets:4}],
  ["E92",123,1,{pcs:193,set:2,sets:2,"lot (2 pcs)":1}]
]){
  const rows=snapshot.parts.filter(row=>row.platform===platform);
  assert.equal(rows.length,records);
  assert.equal(rows.filter(row=>row.quantity===null).length,unknown);
  const totals={};
  for(const row of rows){
    if(row.quantity===null) continue;
    assert.ok(Number.isInteger(row.quantity)&&row.quantity>=0);
    totals[row.quantity_unit]=(totals[row.quantity_unit]||0)+row.quantity;
  }
  assert.deepEqual(totals,units);
}
for(const bin of snapshot.bins){
  assert.equal(snapshot.parts.filter(row=>row.bin_code===bin.bin_code).length,bin.tagged_entries);
}
assert.equal(snapshot.parts.filter(row=>row.source_chassis==="F22/F30" && row.platform==="F22" && row.compatibility.includes("F30")).length,3);
assert.equal(snapshot.parts.filter(row=>row.quantity===null && row.quantity_raw==="VARIOUS").length,1);
assert.equal(snapshot.parts.find(row=>row.item_name==="Valvetronic actuator").quantity,0);
const css=readFileSync(join(assetsDir,"styles.css"),"utf8");
assert.match(css,/@page\s*\{\s*size:\s*4in 6in/);
assert.doesNotMatch(css,/@page\s*\{\s*size:\s*2in 3in/);
execFileSync(process.execPath,[join(root,"scripts/build_inventory_update.mjs"),"--check"],{stdio:"inherit"});

console.log(`PASS ${allJavascriptFiles.length} JavaScript syntax checks`);
console.log(`PASS ${new Set(handlerNames).size} inline handler checks`);
console.log("PASS preserved V1 seed: 297 unique records / 690 units");
console.log("PASS workbook: F22 92 labels / E92 123 labels; 5 unknown counts; source units preserved");
console.log("PASS bin directory: 43 entries / 39 numbered parent bins; 4×6 print stock only");
