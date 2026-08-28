import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root=join(dirname(fileURLToPath(import.meta.url)), "..");
const assetsDir=join(root, "assets");
const javascriptFiles=readdirSync(assetsDir)
  .filter(name=>name.endsWith(".js"))
  .map(name=>join(assetsDir, name));

for(const file of javascriptFiles){
  execFileSync(process.execPath, ["--check", file], {stdio:"pipe"});
}

const html=readFileSync(join(root, "index.html"), "utf8");
const handlerNames=[...html.matchAll(/\bon(?:click|change|input)="([A-Za-z_$][\w$]*)\s*\(/g)]
  .map(match=>match[1]);
const javascript=javascriptFiles.map(file=>readFileSync(file, "utf8")).join("\n");
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

console.log(`PASS ${javascriptFiles.length} JavaScript syntax checks`);
console.log(`PASS ${new Set(handlerNames).size} inline handler checks`);
console.log("PASS inventory seed: 297 unique records / 690 units");
