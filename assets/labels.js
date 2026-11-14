// ----- Inventory Label & Bin Assistant V1 -----
// 4x6 thermal stock only. Part tags use a 4x6 fold-wrap layout around a 2x3 paper tag.

const BIN_MAKE_PREFIX={
  BMW:"B",
  Porsche:"P",
  "Trailer / Tow":"T",
  Ford:"F",
  Chevrolet:"C"
};

const BIN_MODEL_OPTIONS={
  BMW:["E92","F22","F30","M235 / M235iR","E46","Other BMW"],
  Porsche:["986 Boxster","Other Porsche"],
  "Trailer / Tow":["Tow","Trailer","Other support"],
  Ford:["F350","Other Ford"],
  Chevrolet:["Chevrolet","Other Chevrolet"]
};

const BIN_SYSTEM_OPTIONS=[
  "Engine",
  "Cooling",
  "Fuel",
  "Intake / Exhaust",
  "Transmission",
  "Driveline",
  "Suspension",
  "Steering",
  "Brakes",
  "Wheels / Tires",
  "Electrical",
  "Body / Aero",
  "Safety",
  "Interior",
  "Tools / Shop",
  "Fluids",
  "Fasteners",
  "Trailer / Tow",
  "Miscellaneous"
];

const BIN_SUBSYSTEM_OPTIONS={
  "Engine":["Long block","Cylinder head","Timing","Lubrication","Mounts","Sensors","Ancillary"],
  "Cooling":["Radiator","Water pump","Thermostat","Hoses / plumbing","Oil cooling","Diff cooling","Fans"],
  "Fuel":["Pump","Filter","Injectors","Lines / fittings","Cell / tank","Filler / vent"],
  "Intake / Exhaust":["Airbox / intake","Throttle","Manifold","Headers","Exhaust","O2 / emissions"],
  "Transmission":["Gearbox","Clutch","Flywheel","Shifter","Mounts","Hardware"],
  "Driveline":["Differential","Axles","Driveshaft","Hubs","Bearings"],
  "Suspension":["Control arms","Struts / shocks","Springs","Bushings","Sway bars","Mounts"],
  "Steering":["Rack","Tie rods","Pump / assist","Column","Hardware"],
  "Brakes":["Pads","Rotors","Calipers","Lines / fittings","Master / booster","ABS"],
  "Wheels / Tires":["Wheels","Tires","Studs / lug hardware","Spacers","Valves / sensors"],
  "Electrical":["Harness","Relays / fuses","Sensors","Data / AIM","Radio","Cameras","Power distribution"],
  "Body / Aero":["Body panels","Lexan","Splitter","Wing","Undertray","Ducting","Fasteners"],
  "Safety":["Belts","Seat","Fire system","Net","Kill switch","PPE"],
  "Interior":["Dash","Controls","Pedals","HVAC / ventilation","Trim"],
  "Tools / Shop":["Hand tools","Power tools","Special tools","Consumables","Measuring"],
  "Fluids":["Engine oil","Gear oil","Brake fluid","Coolant","Fuel / additives","Cleaners"],
  "Fasteners":["Metric","SAE","Clips / retainers","Washers / spacers","Special hardware"],
  "Trailer / Tow":["Tie-downs","Loading","Electrical","Hitch","Wheels / tires","Brakes","Recovery"],
  "Miscellaneous":["General"]
};

const BIN_SYSTEM_CODES={
  "Engine":"ENG",
  "Cooling":"COOL",
  "Fuel":"FUEL",
  "Intake / Exhaust":"INT",
  "Transmission":"TRANS",
  "Driveline":"DRV",
  "Suspension":"SUSP",
  "Steering":"STR",
  "Brakes":"BRK",
  "Wheels / Tires":"TIRE",
  "Electrical":"ELEC",
  "Body / Aero":"AERO",
  "Safety":"SAFE",
  "Interior":"INTL",
  "Tools / Shop":"TOOL",
  "Fluids":"FLUID",
  "Fasteners":"FAST",
  "Trailer / Tow":"TOW",
  "Miscellaneous":"MISC"
};

let inventoryBins=[];
let inventoryBinsReady=false;
let currentInventoryBin=null;
let currentBinAssignmentItem=null;
let currentLabelPayload=null;
let binAssignmentPending=false;
let binCartSavePending=false;
let binCreatePending=false;
let binMoveUnconfirmed=false;
let binMoveDestinationPreset=false;

const CART_CHASSIS_CODES={E92:"E92",F22:"F22",F30:"F30","986 Boxster":"986"};
let inventoryCarts=[];
let inventoryCartsReady=false;

function isLooseInventoryBin(bin){
  return /-000$/.test(bin?.bin_code||"");
}
function binCartCode(bin){
  const prefix=CART_CHASSIS_CODES[bin?.model];
  return prefix && bin.cart_location && !isLooseInventoryBin(bin) ? `${prefix}-${bin.cart_location}` : "";
}
function binCartLocationLabel(bin){
  return binCartCode(bin)||"Unassigned";
}
function inventoryItemLocationLabel(item){
  if(inventoryStockCategoryLabel(item)==="Backstock") return "Backstock";
  const bin=item.inventory_bin_id ? findInventoryBin(item.inventory_bin_id) : null;
  if(bin && !isLooseInventoryBin(bin)) return binCartCode(bin)||"Unassigned";
  return item.cart_code||"Unassigned";
}
async function loadInventoryCarts(){
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/inventory_carts?select=*&order=cart_code.asc`,{headers:{"apikey":SUPABASE_KEY}});
    if(!response.ok) throw new Error(`Cart registry ${response.status}`);
    const rows=await response.json();
    if(!Array.isArray(rows)) throw new Error("Invalid cart registry");
    inventoryCarts=rows;
    inventoryCartsReady=true;
    return true;
  }catch(error){
    console.error("Cart registry unavailable",error);
    inventoryCarts=[];
    inventoryCartsReady=false;
    return false;
  }
}
function populateInventoryCartFilter(){
  const select=document.getElementById("inventoryCartSelect");
  select.innerHTML='<option value="ALL">All locations</option>'+inventoryCarts.map(cart=>`<option value="${escapeHtml(cart.cart_code)}">${escapeHtml(cart.cart_code)}</option>`).join("")+'<option>Backstock</option><option>Unassigned</option>';
  select.value=[...select.options].some(option=>option.value===inventoryCartFilter)?inventoryCartFilter:"ALL";
  inventoryCartFilter=select.value;
}
function inventoryPlacementPlatform(prefix){
  return prefix==="inv" ? currentInventoryItem?.platform||"" : document.getElementById("addPlatform").value;
}
function setupInventoryPlacement(prefix,item=null){
  const select=document.getElementById(prefix+"Location");
  const platform=inventoryPlacementPlatform(prefix);
  const previous=item ? inventoryItemLocationLabel(item) : select.value;
  select.innerHTML='<option>Unassigned</option>'+inventoryCarts.filter(cart=>cart.platform===platform).map(cart=>`<option value="${escapeHtml(cart.cart_code)}">${escapeHtml(cart.cart_code)}</option>`).join("")+'<option>Backstock</option>';
  select.value=[...select.options].some(option=>option.value===previous)?previous:"Unassigned";
  if(!item && document.getElementById(prefix+"StockCategory").value==="Backstock") select.value="Backstock";
  refreshInventoryPlacementBins(prefix,item?.inventory_bin_id||"");
}
function refreshInventoryPlacementBins(prefix,selectedBin=null){
  const select=document.getElementById(prefix+"BinId");
  const previous=selectedBin??select.value;
  const platform=inventoryPlacementPlatform(prefix);
  const location=document.getElementById(prefix+"Location").value;
  const bins=inventoryBins.filter(bin=>bin.model===platform && ((selectedBin && bin.id===selectedBin) || isLooseInventoryBin(bin) || (location==="Backstock" ? !bin.cart_location : binCartLocationLabel(bin)===location)));
  select.innerHTML='<option value="">Unassigned bin</option>'+bins.map(bin=>`<option value="${escapeHtml(bin.id)}">${escapeHtml(bin.bin_code)}${isLooseInventoryBin(bin)?" — Loose / bulky items":""}</option>`).join("");
  select.value=bins.some(bin=>bin.id===previous)?previous:"";
}
function changeInventoryPlacement(prefix){
  document.getElementById(prefix+"StockCategory").value=document.getElementById(prefix+"Location").value==="Backstock"?"Backstock":"Mobile";
  refreshInventoryPlacementBins(prefix);
}
function changeInventoryAssignment(prefix){
  const location=document.getElementById(prefix+"Location");
  if(document.getElementById(prefix+"StockCategory").value==="Backstock") location.value="Backstock";
  else if(location.value==="Backstock") location.value="Unassigned";
  refreshInventoryPlacementBins(prefix);
}
function inventoryPlacementPatch(prefix){
  const location=document.getElementById(prefix+"Location").value;
  const bin=findInventoryBin(document.getElementById(prefix+"BinId").value);
  const cart=inventoryCarts.find(row=>row.cart_code===location);
  const existing=prefix==="inv"?currentInventoryItem:null;
  return {
    stock_category:location==="Backstock"?"Backstock":"Mobile",
    inventory_bin_id:bin?.id||null,
    cart_code:cart && (!bin||isLooseInventoryBin(bin))?cart.cart_code:null,
    location:bin?.bin_code || (existing && !existing.inventory_bin_id && inventoryItemLocationLabel(existing)===location ? existing.location : location)
  };
}

async function saveBinCartLocation(){
  const bin=currentInventoryBin;
  if(!bin || binCartSavePending || isLooseInventoryBin(bin)) return;
  const initials=inventoryInitials("binCartInitials");
  if(!initials) return;
  const cart=document.getElementById("binCartLocationSelect").value;
  if(!["","A","B"].includes(cart)) return;
  binCartSavePending=true;
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/inventory_bins?id=eq.${encodeURIComponent(bin.id)}`,{
      method:"PATCH",
      headers:{...inventoryEventHeaders(initials),"Prefer":"return=representation"},
      body:JSON.stringify({cart_location:cart||null})
    });
    if(!response.ok) throw new Error(`Cart assignment failed: ${response.status}`);
    const rows=await response.json();
    if(!rows?.[0]) throw new Error("No bin was updated");
    Object.assign(bin,rows[0]);
    renderInventoryResults();
    await openBinDetail(bin.bin_code,"replace");
  }catch(error){
    console.error(error);
    alert("Unable to save this bin's cart location. Please retry.");
  }finally{
    binCartSavePending=false;
  }
}

function labelSafeText(value){
  return String(value??"").trim();
}

function binToken(value,max=7){
  return labelSafeText(value)
    .toUpperCase()
    .replace(/&/g,"AND")
    .replace(/[^A-Z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"")
    .slice(0,max)||"GEN";
}

function modelCode(value){
  const known={
    "M235 / M235iR":"M235",
    "986 Boxster":"986",
    "Other BMW":"BMW",
    "Other Porsche":"POR",
    "Other support":"SUP",
    "Other Ford":"FORD",
    "Other Chevrolet":"CHEV"
  };
  return known[value]||binToken(value,7);
}

function subsystemCode(value){
  const known={
    "Long block":"LB",
    "Cylinder head":"HEAD",
    "Timing":"TIME",
    "Lubrication":"LUBE",
    "Mounts":"MNT",
    "Sensors":"SNSR",
    "Ancillary":"ANC",
    "Water pump":"WP",
    "Thermostat":"TSTAT",
    "Hoses / plumbing":"HOSE",
    "Oil cooling":"OILC",
    "Diff cooling":"DIFC",
    "Lines / fittings":"LINE",
    "Cell / tank":"TANK",
    "Filler / vent":"VENT",
    "Airbox / intake":"AIR",
    "Throttle":"THR",
    "Manifold":"MAN",
    "Headers":"HDR",
    "O2 / emissions":"O2",
    "Gearbox":"GBX",
    "Clutch":"CLT",
    "Flywheel":"FLY",
    "Shifter":"SHFT",
    "Hardware":"HW",
    "Differential":"DIFF",
    "Axles":"AXLE",
    "Driveshaft":"DS",
    "Hubs":"HUB",
    "Bearings":"BRG",
    "Control arms":"ARM",
    "Struts / shocks":"SHK",
    "Springs":"SPR",
    "Bushings":"BUSH",
    "Sway bars":"SWAY",
    "Rack":"RACK",
    "Tie rods":"TIE",
    "Pump / assist":"PUMP",
    "Column":"COL",
    "Pads":"PAD",
    "Rotors":"RTR",
    "Calipers":"CAL",
    "Master / booster":"MSTR",
    "ABS":"ABS",
    "Wheels":"WHL",
    "Tires":"TIRE",
    "Studs / lug hardware":"LUG",
    "Spacers":"SPCR",
    "Valves / sensors":"TPMS",
    "Harness":"HRNS",
    "Relays / fuses":"RLY",
    "Data / AIM":"DATA",
    "Radio":"RAD",
    "Cameras":"CAM",
    "Power distribution":"PWR",
    "Body panels":"BODY",
    "Lexan":"LEX",
    "Splitter":"SPLT",
    "Wing":"WING",
    "Undertray":"UNDER",
    "Ducting":"DUCT",
    "Belts":"BELT",
    "Seat":"SEAT",
    "Fire system":"FIRE",
    "Net":"NET",
    "Kill switch":"KILL",
    "PPE":"PPE",
    "Dash":"DASH",
    "Controls":"CTRL",
    "Pedals":"PED",
    "HVAC / ventilation":"VENT",
    "Trim":"TRIM",
    "Hand tools":"HAND",
    "Power tools":"PWR",
    "Special tools":"SPEC",
    "Consumables":"CONS",
    "Measuring":"MEAS",
    "Engine oil":"EOIL",
    "Gear oil":"GOIL",
    "Brake fluid":"BFLD",
    "Coolant":"COOL",
    "Fuel / additives":"FADD",
    "Cleaners":"CLN",
    "Metric":"MET",
    "SAE":"SAE",
    "Clips / retainers":"CLIP",
    "Washers / spacers":"WASH",
    "Special hardware":"SPHW",
    "Tie-downs":"TIE",
    "Loading":"LOAD",
    "Electrical":"ELEC",
    "Hitch":"HITCH",
    "Wheels / tires":"WHL",
    "Brakes":"BRK",
    "Recovery":"RCV",
    "General":"GEN"
  };
  return known[value]||binToken(value,5);
}

function binBaseCode(){
  const make=document.getElementById("binMake")?.value||"";
  const model=document.getElementById("binModel")?.value||"";
  const system=document.getElementById("binSystem")?.value||"";
  const subsystem=document.getElementById("binSubsystem")?.value||"";
  if(!make||!model||!system) return "";
  const prefix=BIN_MAKE_PREFIX[make]||"X";
  const parts=[prefix,modelCode(model),BIN_SYSTEM_CODES[system]||binToken(system,5)];
  if(subsystem) parts.push(subsystemCode(subsystem));
  return parts.join("-");
}

function nextBinCode(base){
  if(!base) return "";
  const used=inventoryBins
    .map(bin=>labelSafeText(bin.bin_code))
    .filter(code=>code.startsWith(`${base}-`))
    .map(code=>Number(code.slice(base.length+1)))
    .filter(Number.isFinite);
  const next=(used.length?Math.max(...used):0)+1;
  return `${base}-${String(next).padStart(2,"0")}`;
}

function refreshBinCodePreview(){
  const preview=document.getElementById("binCodePreview");
  if(!preview) return;
  const cartSelect=document.getElementById("binCartLocation");
  const model=document.getElementById("binModel")?.value;
  const prefix=CART_CHASSIS_CODES[model];
  const previous=cartSelect.value;
  cartSelect.innerHTML='<option value="">Unassigned</option>'+(prefix?`<option value="A">${prefix}-A</option><option value="B">${prefix}-B</option>`:"");
  cartSelect.value=prefix && ["A","B"].includes(previous)?previous:"";
  const base=binBaseCode();
  preview.textContent=base ? nextBinCode(base) : "Choose make, model, and system";
}

function refreshBinModelOptions(){
  const make=document.getElementById("binMake")?.value||"";
  const model=document.getElementById("binModel");
  if(!model) return;
  const previous=model.value;
  const options=BIN_MODEL_OPTIONS[make]||[];
  model.innerHTML='<option value="">Choose model / platform…</option>'+options
    .map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("");
  if(options.includes(previous)) model.value=previous;
  refreshBinCodePreview();
}

function refreshBinSubsystemOptions(){
  const system=document.getElementById("binSystem")?.value||"";
  const subsystem=document.getElementById("binSubsystem");
  if(!subsystem) return;
  const previous=subsystem.value;
  const options=BIN_SUBSYSTEM_OPTIONS[system]||[];
  subsystem.innerHTML='<option value="">General / no subsystem</option>'+options
    .map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
    .join("");
  if(options.includes(previous)) subsystem.value=previous;
  refreshBinCodePreview();
}

async function loadInventoryBins(){
  const status=document.getElementById("binBackendStatus");
  if(status) status.textContent="Loading bin registry…";
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/inventory_bins?select=*&order=bin_code.asc`,{
      headers:{"apikey":SUPABASE_KEY}
    });
    if(!response.ok){
      const message=await response.text();
      throw new Error(`Bin registry ${response.status}: ${message}`);
    }
    const rows=await response.json();
    inventoryBins=Array.isArray(rows)?rows:[];
    inventoryBinsReady=true;
    if(status) status.textContent=`${inventoryBins.length} registered bin${inventoryBins.length===1?"":"s"} • Supabase`;
    return true;
  }catch(error){
    console.error("Bin registry unavailable.",error);
    inventoryBins=[];
    inventoryBinsReady=false;
    if(status) status.textContent="Bin registry unavailable — please retry when the connection is restored";
    return false;
  }
}

async function openLabelAssistant(){
  showScreen("labelAssistantHome");
  await Promise.all([loadInventoryBins(),loadInventoryCarts()]);
}

function resetCreateBinForm(){
  ["binMake","binModel","binSystem","binSubsystem","binCartLocation"].forEach(id=>{
    const field=document.getElementById(id);
    if(field) field.selectedIndex=0;
  });
  ["binLocation","binDescription"].forEach(id=>{
    const field=document.getElementById(id);
    if(field) field.value="";
  });
  refreshBinModelOptions();
  refreshBinSubsystemOptions();
  refreshBinCodePreview();
}

async function openCreateBin(){
  if(!inventoryBinsReady) await loadInventoryBins();
  resetCreateBinForm();
  document.getElementById("binCreateInitials").value="";
  showScreen("binCreate");
}

async function insertInventoryBin(payload,initials,retry=true){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/inventory_bins`,{
    method:"POST",
    headers:{...inventoryEventHeaders(initials),"Prefer":"return=representation"},
    body:JSON.stringify(payload)
  });
  if(response.ok){
    const rows=await response.json();
    if(!rows?.[0]?.id) throw new Error("The bin save could not be confirmed. Refresh the registry.");
    return rows[0];
  }
  if(response.status===409 && retry){
    await loadInventoryBins();
    const base=[payload.make_prefix,modelCode(payload.model),BIN_SYSTEM_CODES[payload.system]||binToken(payload.system,5)]
      .concat(payload.subsystem?[subsystemCode(payload.subsystem)]:[])
      .join("-");
    const next=nextBinCode(base);
    return insertInventoryBin({...payload,bin_code:next,qr_value:`OTR:BIN:${next}`},initials,false);
  }
  const message=await response.text();
  throw new Error(`Bin insert failed: ${response.status} ${message}`);
}

async function createInventoryBin(){
  if(binCreatePending) return;
  const initials=inventoryInitials("binCreateInitials");
  if(!initials) return;
  if(!inventoryBinsReady){
    alert("Bin registry is unavailable. Please retry when the connection is restored.");
    return;
  }
  const make=document.getElementById("binMake").value;
  const model=document.getElementById("binModel").value;
  const system=document.getElementById("binSystem").value;
  const subsystem=document.getElementById("binSubsystem").value||null;
  const location=document.getElementById("binLocation").value.trim()||null;
  const description=document.getElementById("binDescription").value.trim()||null;
  if(!make||!model||!system){
    alert("Choose make, model, and system first.");
    return;
  }
  const base=binBaseCode();
  const code=nextBinCode(base);
  const payload={
    bin_code:code,
    make,
    make_prefix:BIN_MAKE_PREFIX[make]||"X",
    model,
    system,
    subsystem,
    location,
    cart_location:document.getElementById("binCartLocation").value||null,
    description,
    label_format:"4x6",
    qr_value:`OTR:BIN:${code}`,
    status:"Active"
  };
  binCreatePending=true;
  try{
    const saved=await insertInventoryBin(payload,initials);
    inventoryBins.push(saved);
    inventoryBins.sort((a,b)=>String(a.bin_code||"").localeCompare(String(b.bin_code||"")));
    currentInventoryBin=saved;
    await openBinDetail(saved.bin_code,"replace");
  }catch(error){
    console.error(error);
    alert("Unable to confirm the new bin. Refresh the bin registry before creating it again.");
  }finally{
    binCreatePending=false;
  }
}

function findInventoryBin(key){
  return inventoryBins.find(bin=>String(bin.id)===String(key)||String(bin.bin_code)===String(key));
}

async function openBinBrowser(model="ALL",cart="ALL"){
  const selectedCart=inventoryCarts.find(row=>row.cart_code===cart);
  if(selectedCart){model=selectedCart.platform;cart=selectedCart.cart_letter;}
  if(cart==="Unassigned") cart="UNASSIGNED";
  showScreen("binBrowse");
  await loadInventoryBins();
  const models=[...new Set([...Object.values(BIN_MODEL_OPTIONS).flat(),...inventoryBins.map(bin=>bin.model),...inventoryData.map(item=>item.platform).filter(Boolean)])].sort();
  const chassis=document.getElementById("binChassisFilter");
  chassis.innerHTML='<option value="ALL">All chassis</option>'+models.map(value=>`<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("");
  chassis.value=models.includes(model)?model:"ALL";
  document.getElementById("binCartFilter").value=["ALL","A","B","UNASSIGNED"].includes(cart)?cart:"ALL";
  const search=document.getElementById("binSearch");
  if(search) search.value="";
  renderBinResults();
}

function inventoryBinDisplayName(bin){
  if(isLooseInventoryBin(bin)) return "Loose / bulky items";
  return bin.name||bin.description||[bin.system,bin.subsystem].filter(Boolean).join(" / ")||"Unnamed bin";
}

function compareInventoryBins(left,right){
  const number=bin=>Number(bin.bin_code.match(/-(\d{3,})(?:-[A-Z]+)?$/i)?.[1]??Infinity);
  const difference=number(left)-number(right);
  return (Number.isNaN(difference)?0:difference)||left.bin_code.localeCompare(right.bin_code,undefined,{numeric:true});
}

function renderBinResults(){
  const wrap=document.getElementById("binResults");
  if(!wrap) return;
  const q=(document.getElementById("binSearch")?.value||"").trim().toLowerCase();
  const selectedModel=document.getElementById("binChassisFilter").value;
  document.getElementById("binBrowseTitle").textContent=`${selectedModel==="ALL"?"All Chassis":selectedModel} — Open Bins`;
  const rows=inventoryBins.filter(bin=>{
    const model=document.getElementById("binChassisFilter").value;
    const cart=document.getElementById("binCartFilter").value;
    if(model!=="ALL" && bin.model!==model) return false;
    if(cart!=="ALL" && (bin.cart_location||"UNASSIGNED")!==cart) return false;
    if(!q) return true;
    return [bin.bin_code,inventoryBinDisplayName(bin),bin.make,bin.model,bin.system,bin.subsystem,bin.location,bin.description,binCartLocationLabel(bin)]
      .filter(Boolean).join(" ").toLowerCase().includes(q);
  }).sort(compareInventoryBins);
  const count=document.getElementById("binCount");
  if(count) count.textContent=`${rows.length} bin${rows.length===1?"":"s"}`;
  if(!rows.length){
    wrap.innerHTML='<div class="card"><strong>No matching bins.</strong><p class="small">Create a new bin or try another search.</p></div>';
    return;
  }
  wrap.innerHTML=rows.map(bin=>`<button type="button" class="inventory-card" onclick="openBinDetail('${escapeHtml(String(bin.bin_code)).replace(/'/g,"&#39;")}')">
    <strong>${escapeHtml(bin.bin_code)}</strong>
    <div class="meta bin-card-name">${escapeHtml(inventoryBinDisplayName(bin))}</div>
    <div class="meta">${escapeHtml(bin.make)} • ${escapeHtml(bin.model)}</div>
    <div class="meta">Location: ${escapeHtml(binCartLocationLabel(bin))}</div>
    ${inventoryBackendReady?`<div class="meta">${itemsForBin(bin).length} direct item records${inventoryBins.some(child=>child.parent_bin_id===bin.id)?" • Has sub-bins":""}</div>`:""}
  </button>`).join("");
}

function itemsForBin(bin){
  if(!bin) return [];
  return inventoryData.filter(item=>String(item.inventory_bin_id||"")===String(bin.id));
}

async function openBinDetail(key,historyMode="push"){
  if(!inventoryBinsReady) await loadInventoryBins();
  const bin=findInventoryBin(key);
  if(!bin) return;
  currentInventoryBin=bin;
  if(!inventoryBackendReady) await loadInventory();
  const wrap=document.getElementById("binDetailWrap");
  const items=itemsForBin(bin);
  const parent=bin.parent_bin_id ? findInventoryBin(bin.parent_bin_id) : null;
  const children=inventoryBins.filter(child=>child.parent_bin_id===bin.id);
  wrap.innerHTML=`
    <div class="bin-heading-row">
      <div>
        <div class="eyebrow">BIN</div>
        <h2 class="sectiontitle" style="margin-bottom:5px">${escapeHtml(bin.bin_code)} — ${escapeHtml(inventoryBinDisplayName(bin))}</h2>
        <p class="subtitle">${escapeHtml(bin.make)} • ${escapeHtml(bin.model)} • ${escapeHtml(bin.system)}${bin.subsystem?` • ${escapeHtml(bin.subsystem)}`:""}</p>
      </div>
      <span class="inv-badge verified">${escapeHtml(bin.status||"Active").toUpperCase()}</span>
    </div>
    <div class="card">
      <div class="inventory-detail-grid">
        <div class="inventory-field"><div class="k">Location</div><div class="v">${escapeHtml(binCartLocationLabel(bin))}</div></div>
        <div class="inventory-field"><div class="k">Direct contents</div><div class="v">${items.length} record${items.length===1?"":"s"}</div></div>
        <div class="inventory-field"><div class="k">Label stock</div><div class="v">4 × 6 thermal</div></div>
        <div class="inventory-field"><div class="k">Scan ID</div><div class="v label-mono">${escapeHtml(bin.qr_value||`OTR:BIN:${bin.bin_code}`)}</div></div>
      </div>
      ${parent?`<p>Parent bin: <button class="secondary" type="button" onclick="openBinDetail('${escapeHtml(parent.bin_code)}')">${escapeHtml(parent.bin_code)}</button></p>`:""}
      ${bin.description?`<p><strong>Notes:</strong> ${escapeHtml(bin.description)}</p>`:""}
      <details id="binManagementControls"><summary>Bin Management</summary>
      <label for="binCartLocationSelect">Assign this ${escapeHtml(bin.model)} bin to a cart</label>
      <select id="binCartLocationSelect" ${isLooseInventoryBin(bin)?"disabled":""}><option value="">Unassigned</option><option value="A" ${bin.cart_location==="A"?"selected":""}>${escapeHtml(CART_CHASSIS_CODES[bin.model]||bin.model)}-A</option><option value="B" ${bin.cart_location==="B"?"selected":""}>${escapeHtml(CART_CHASSIS_CODES[bin.model]||bin.model)}-B</option></select>
      <p class="small">${isLooseInventoryBin(bin)?"Loose items use this Bin ID on either cart. Assign their locations on each part.":"Sub-bins keep their own locations when this bin is reassigned."}</p>
      <label for="binCartInitials">Initials</label>
      <input id="binCartInitials" class="inventory-initials" type="text" maxlength="8" autocapitalize="characters" autocomplete="off" required placeholder="Required to save a cart change" />
      <div class="actions">
        <button class="primary" type="button" onclick="saveBinCartLocation()" ${isLooseInventoryBin(bin)?"disabled":""}>Save Cart Location</button>
        <button class="primary" type="button" onclick="openBinLabel('${escapeHtml(String(bin.bin_code)).replace(/'/g,"&#39;")}')">Print 4×6 Bin Label</button>
        <button class="secondary" type="button" onclick="openAssignPartToBin('${escapeHtml(String(bin.bin_code)).replace(/'/g,"&#39;")}')">Fast Move / Placement Here</button>
      </div></details>
    </div>
    ${children.length?`<h3 style="margin:22px 0 10px">Sub-bins</h3><div class="inventory-results">${children.map(child=>`<button type="button" class="inventory-card" onclick="openBinDetail('${escapeHtml(child.bin_code)}')"><strong>${escapeHtml(child.bin_code)}</strong><div class="meta">${escapeHtml(child.description||child.system)} • ${itemsForBin(child).length} direct records • ${escapeHtml(binCartLocationLabel(child))}</div></button>`).join("")}</div>`:""}
    <h3 style="margin:22px 0 10px">Contents</h3>
    <div id="binContents" class="inventory-results">${items.length?items.map(item=>`<button type="button" class="inventory-card" onclick="openInventoryDetail('${escapeHtml(String(item.local_key)).replace(/'/g,"&#39;")}')">
      <strong>${escapeHtml(item.item_name||"Unnamed item")}</strong>
      <div class="meta"><span class="qty">Qty ${escapeHtml(inventoryQuantityLabel(item))}</span> • ${escapeHtml(item.condition||"Unspecified")}</div>
      <div class="meta inventory-card-bin">📍 ${escapeHtml(inventoryItemLocationLabel(item))} • BIN <span class="label-mono">${escapeHtml(inventoryItemBinDisplayLabel(item))}</span></div>
      <div class="meta">${escapeHtml(item.part_number||item.inventory_code||"")}</div>
      ${item.reorder_flag?'<div class="meta" style="margin-top:8px"><span class="inv-badge review">REORDER</span></div>':""}
    </button>`).join(""):'<div class="card"><strong>No individually tagged stock recorded directly in this bin.</strong><p class="small">This does not establish a physical count of zero. Review any sub-bins or count the contents.</p></div>'}</div>`;
  showScreen("binDetail",{historyMode});
}

function refreshFastMovePlacement(){
  const category=document.getElementById("assignInventoryType").value;
  const chassis=document.getElementById("assignChassis").value;
  const select=document.getElementById("assignPartCart");
  const previous=select.value;
  select.innerHTML='<option value="">'+(category==="Backstock"?"Backstock":"Unassigned")+'</option>'+
    (category==="Mobile"?inventoryCarts.filter(cart=>cart.platform===chassis).map(cart=>`<option value="${escapeHtml(cart.cart_code)}">${escapeHtml(cart.cart_code)}</option>`).join(""):"");
  select.disabled=category!=="Mobile";
  select.value=[...select.options].some(option=>option.value===previous)?previous:"";
  refreshFastMoveBins();
}
function refreshFastMoveBins(selected=null){
  const category=document.getElementById("assignInventoryType").value;
  const chassis=document.getElementById("assignChassis").value;
  const cart=document.getElementById("assignPartCart").value;
  const select=document.getElementById("assignBinSelect");
  const previous=selected??select.value;
  const bins=inventoryBins.filter(bin=>{
    // A blank Backstock chassis can keep the source platform without a bin.
    // Choosing a physical bin requires its chassis to be explicit too.
    if(!chassis || bin.model!==chassis) return false;
    if(isLooseInventoryBin(bin)) return true;
    return category==="Backstock"?!bin.cart_location:binCartCode(bin)===cart;
  }).sort(compareInventoryBins);
  select.innerHTML='<option value="">Unassigned bin</option>'+bins.map(bin=>`<option value="${escapeHtml(bin.id)}">${escapeHtml(bin.bin_code)} — ${escapeHtml(inventoryBinDisplayName(bin))}</option>`).join("");
  select.value=bins.some(bin=>bin.id===previous)?previous:"";
}
function refreshLooseCartAssignment(){
  const bin=findInventoryBin(document.getElementById("assignBinSelect").value);
  if(bin && !isLooseInventoryBin(bin) && document.getElementById("assignInventoryType").value==="Mobile"){
    document.getElementById("assignPartCart").value=binCartCode(bin);
  }
}
function populateFastMoveChassis(selected=""){
  const select=document.getElementById("assignChassis");
  const platforms=[...new Set([...Object.keys(CART_CHASSIS_CODES),...inventoryData.map(item=>item.platform),...inventoryBins.map(bin=>bin.model)].filter(Boolean))].sort();
  select.innerHTML='<option value="">Choose chassis…</option>'+platforms.map(platform=>`<option value="${escapeHtml(platform)}">${escapeHtml(platform)}</option>`).join("");
  select.value=platforms.includes(selected)?selected:"";
}
async function openAssignPartToBin(binKey="",itemKey=""){
  // Reload before a new move, including after an uncertain network response.
  await loadInventory();
  if(!inventoryBackendReady){
    alert("Shared inventory is unavailable. Please retry when the connection is restored.");
    return;
  }
  currentBinAssignmentItem=null;
  binMoveUnconfirmed=false;
  binMoveDestinationPreset=Boolean(binKey);
  const bin=findInventoryBin(binKey);
  document.getElementById("assignInventoryType").value="Mobile";
  populateFastMoveChassis(bin?.model||"");
  document.getElementById("assignPartCart").innerHTML='<option value="">Unassigned</option>';
  refreshFastMovePlacement();
  if(bin){
    document.getElementById("assignPartCart").value=binCartCode(bin);
    refreshFastMoveBins(bin.id);
  }
  document.getElementById("assignPartSearch").value="";
  document.getElementById("assignPartSelected").innerHTML='<p class="small">Choose an inventory record below.</p>';
  document.getElementById("assignPartQty").value="";
  document.getElementById("assignPartReorder").checked=false;
  document.getElementById("assignPartInitials").value="";
  renderAssignPartMatches();
  showScreen("binAssignPart");
  if(itemKey) selectPartForBin(itemKey);
}
function renderAssignPartMatches(){
  const wrap=document.getElementById("assignPartMatches");
  if(!wrap) return;
  const q=(document.getElementById("assignPartSearch")?.value||"").trim().toLowerCase();
  const rows=inventoryData.filter(item=>inventoryMatchesSearch(item,q)).slice(0,40);
  wrap.innerHTML=rows.map(item=>`<button type="button" class="inventory-card" onclick="selectPartForBin('${escapeHtml(String(item.local_key)).replace(/'/g,"&#39;")}')">
    <strong>${escapeHtml(item.item_name||"Unnamed item")}</strong>
    <div class="meta"><span class="qty">Qty ${escapeHtml(inventoryQuantityLabel(item))}</span> • ${escapeHtml(inventoryStockCategoryLabel(item))} • ${escapeHtml(item.platform||"Unassigned")}</div>
    <div class="meta inventory-card-bin">📍 ${escapeHtml(inventoryItemLocationLabel(item))} • BIN <span class="label-mono">${escapeHtml(inventoryItemBinDisplayLabel(item))}</span></div>
  </button>`).join("");
}
function selectPartForBin(key){
  const item=findInventoryItem(key);
  if(!item) return;
  currentBinAssignmentItem=item;
  if(!binMoveDestinationPreset){
    document.getElementById("assignInventoryType").value=inventoryStockCategoryLabel(item);
    populateFastMoveChassis(item.platform||"");
    refreshFastMovePlacement();
    const location=inventoryItemLocationLabel(item);
    if([...document.getElementById("assignPartCart").options].some(option=>option.value===location)) document.getElementById("assignPartCart").value=location;
    refreshFastMoveBins(item.inventory_bin_id||"");
  }
  document.getElementById("assignPartSelected").innerHTML=`<strong>${escapeHtml(item.item_name||"Unnamed item")}</strong><div class="meta">Qty ${escapeHtml(inventoryQuantityLabel(item))} • ${escapeHtml(item.platform||"Unassigned chassis")}</div><div class="meta inventory-card-bin">📍 ${escapeHtml(inventoryItemLocationLabel(item))} • BIN ${escapeHtml(inventoryItemBinDisplayLabel(item))}</div>`;
  document.getElementById("assignPartQty").value=item.quantity===null?"":Math.max(1,Number(item.quantity||1));
  document.getElementById("assignPartQty").max=Math.max(1,Number(item.quantity||1));
  document.getElementById("assignPartReorder").checked=Boolean(item.reorder_flag);
}
async function assignSelectedPartToBin(){
  if(binAssignmentPending) return;
  if(binMoveUnconfirmed){
    alert("The previous move could not be confirmed. Reopen Fast Move to reload current inventory before another move.");
    return;
  }
  const item=currentBinAssignmentItem;
  if(!item){alert("Choose a part first.");return;}
  const category=document.getElementById("assignInventoryType").value;
  const chassis=document.getElementById("assignChassis").value;
  if(!["Mobile","Backstock"].includes(category)) return;
  if(category==="Mobile" && !chassis){alert("Choose the destination chassis for Mobile inventory.");return;}
  const bin=findInventoryBin(document.getElementById("assignBinSelect").value);
  const cart=category==="Mobile"?document.getElementById("assignPartCart").value:null;
  if(bin && chassis && bin.model!==chassis){alert("Choose a bin from the selected chassis.");return;}
  if(bin && !isLooseInventoryBin(bin) && category==="Mobile" && binCartCode(bin)!==(cart||"")){
    alert("Choose a bin on the selected cart.");return;
  }
  const quantity=Number(document.getElementById("assignPartQty").value);
  if(item.quantity===null || item.quantity===undefined){alert("Count this inventory item before moving a quantity.");return;}
  if(!Number.isInteger(quantity)||quantity<1||quantity>Number(item.quantity||0)){
    alert(`Enter a quantity from 1 to ${Number(item.quantity||0)}.`);return;
  }
  const initials=inventoryInitials("assignPartInitials");
  if(!initials) return;
  binAssignmentPending=true;
  let confirmed=false;
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/move_inventory_part`,{
      method:"POST",
      headers:inventoryEventHeaders(initials),
      body:JSON.stringify({
        p_item_id:item.id,p_stock_category:category,p_chassis:chassis||null,
        p_cart_code:cart||null,p_bin_id:bin?.id||null,p_quantity:quantity,
        p_reorder_flag:Boolean(document.getElementById("assignPartReorder").checked),
        p_actor_initials:initials,p_request_id:inventoryOperationId()
      })
    });
    if(!response.ok){
      if(response.status>=500) binMoveUnconfirmed=true;
      throw new Error(`Move failed: ${response.status} ${await response.text()}`);
    }
    const result=await response.json();
    confirmed=true;
    await loadInventory();
    if(!inventoryBackendReady){
      alert("Move saved. The latest inventory could not be loaded; refresh before another change.");
      showScreen("inventoryManagement",{historyMode:"replace"});
      return;
    }
    const moved=inventoryData.find(row=>row.id===result.item_id);
    if(moved) currentInventoryItem=moved;
    if(bin) await openBinDetail(bin.bin_code,"replace");
    else if(moved) openInventoryDetail(moved.local_key,"replace");
    else showScreen("inventoryManagement",{historyMode:"replace"});
    showPortalNavNotice("Inventory move saved");
  }catch(error){
    console.error(error);
    if(!confirmed){
      if(!(error.message||"").startsWith("Move failed:")) binMoveUnconfirmed=true;
      alert(binMoveUnconfirmed?"Move result could not be confirmed. Reopen Fast Move to reload current inventory before retrying.":"Unable to move that inventory. Check the placement and try again.");
    }else alert("Move saved. Refresh inventory to see the updated placement.");
  }finally{
    binAssignmentPending=false;
  }
}

function inventoryItemBinLabel(item){
  if(!item?.inventory_bin_id) return "";
  return findInventoryBin(item.inventory_bin_id)?.bin_code||"";
}

function inventoryItemBinDisplayLabel(item){
  const code=inventoryItemBinLabel(item);
  if(code) return code;
  return item.inventory_bin_id ? item.location||"Assigned (details unavailable)" : "Unassigned";
}

function stablePartTagId(item){
  if(item.tag_id) return item.tag_id;
  const inventoryToken=binToken(item.inventory_code||"PART",20);
  const uniqueToken=String(item.id||cryptoId()).replace(/[^A-Za-z0-9]/g,"").slice(0,8).toUpperCase();
  return `TAG-${inventoryToken}-${uniqueToken}`;
}

async function ensurePartTagId(item,initials){
  if(item.tag_id) return item.tag_id;
  const tagId=stablePartTagId(item);
  const saved=await persistInventoryPatch(item,{tag_id:tagId},initials);
  if(!saved) throw new Error("Unable to save part tag ID");
  item.tag_id=tagId;
  return tagId;
}

async function openPartTag(key=""){
  if(!inventoryBackendReady) await loadInventory();
  if(!inventoryBinsReady) await loadInventoryBins();
  const item=key?findInventoryItem(key):currentInventoryItem;
  if(!item) return;
  currentInventoryItem=item;
  document.getElementById("partTagItemName").textContent=item.item_name||"Inventory item";
  document.getElementById("partTagMeta").textContent=[item.part_number,item.platform,item.location].filter(Boolean).join(" • ");
  document.getElementById("partTagAdjustCount").checked=false;
  document.getElementById("partTagCountWrap").classList.add("hidden");
  document.getElementById("partTagNewQty").value=item.quantity??"";
  document.getElementById("partTagQtyLabel").textContent=`New quantity (${item.quantity_unit||"pcs"})`;
  document.getElementById("partTagInitials").value="";
  showScreen("partTag");
}

function togglePartTagCountAdjustment(){
  const enabled=document.getElementById("partTagAdjustCount").checked;
  document.getElementById("partTagCountWrap").classList.toggle("hidden",!enabled);
}

async function preparePartTag(){
  const item=currentInventoryItem;
  if(!item) return;
  const changingCount=document.getElementById("partTagAdjustCount").checked;
  const initials=changingCount || !item.tag_id ? inventoryInitials("partTagInitials") : "";
  if((changingCount || !item.tag_id) && !initials) return;
  try{
    if(changingCount){
      const input=document.getElementById("partTagNewQty").value.trim();
      const quantity=Number(input);
      if(!input || !Number.isInteger(quantity) || quantity<0){
        alert("Enter a whole-number inventory count of zero or more.");
        return;
      }
      const countPatch={quantity,status:quantity===0 ? "Out of Stock" : "In Stock"};
      const saved=await persistInventoryPatch(item,countPatch,initials);
      if(!saved) return;
      Object.assign(item,countPatch);
    }
    await ensurePartTagId(item,initials);
    currentLabelPayload={type:"part",item};
    renderLabelPreview();
    showScreen("labelPrint");
  }catch(error){
    console.error(error);
    alert("Unable to prepare the part tag.");
  }
}

async function openBinLabel(key=""){
  if(!inventoryBinsReady) await loadInventoryBins();
  const bin=key?findInventoryBin(key):currentInventoryBin;
  if(!bin) return;
  currentInventoryBin=bin;
  currentLabelPayload={type:"bin",bin};
  renderLabelPreview();
  showScreen("labelPrint");
}

const CODE39_PATTERNS={
  "0":"101000111011101","1":"111010001010111","2":"101110001010111","3":"111011100010101",
  "4":"101000111010111","5":"111010001110101","6":"101110001110101","7":"101000101110111",
  "8":"111010001011101","9":"101110001011101","A":"111010100010111","B":"101110100010111",
  "C":"111011101000101","D":"101011100010111","E":"111010111000101","F":"101110111000101",
  "G":"101010001110111","H":"111010100011101","I":"101110100011101","J":"101011100011101",
  "K":"111010101000111","L":"101110101000111","M":"111011101010001","N":"101011101000111",
  "O":"111010111010001","P":"101110111010001","Q":"101010111000111","R":"111010101110001",
  "S":"101110101110001","T":"101011101110001","U":"111000101010111","V":"100011101010111",
  "W":"111000111010101","X":"100010111010111","Y":"111000101110101","Z":"100011101110101",
  "-":"100010101110111",".":"111000101011101"," ":"100011101011101","*":"100010111011101"
};

function code39Value(value){
  return labelSafeText(value).toUpperCase().replace(/[^A-Z0-9. -]/g,"-");
}

function code39Svg(value){
  const data=code39Value(value);
  const encoded=`*${data}*`;
  let bits="0000000000";
  for(const character of encoded){
    bits+=(CODE39_PATTERNS[character]||CODE39_PATTERNS["-"])+"0";
  }
  bits+="0000000000";
  const rects=[];
  let start=-1;
  for(let index=0;index<=bits.length;index+=1){
    const on=bits[index]==="1";
    if(on && start<0) start=index;
    if(!on && start>=0){
      rects.push(`<rect x="${start}" y="0" width="${index-start}" height="48" />`);
      start=-1;
    }
  }
  return `<svg class="label-code39" viewBox="0 0 ${bits.length} 48" preserveAspectRatio="none" role="img" aria-label="Code 39 barcode ${escapeHtml(data)}"><g fill="#000">${rects.join("")}</g></svg>`;
}

function labelScanBlock(value){
  const data=code39Value(value);
  return `<div class="label-scan-block">${code39Svg(data)}<div class="label-scan-id">${escapeHtml(data)}</div></div>`;
}

function partFaceHtml(item,rotate=false){
  const code=item.tag_id||stablePartTagId(item);
  const binCode=inventoryItemBinLabel(item)||"—";
  const placement=`${inventoryItemLocationLabel(item)} / ${binCode}`;
  return `<div class="part-tag-face${rotate?" rotate":""}">
    <div class="part-tag-brand">OTR • PART TAG</div>
    <div class="part-tag-name">${escapeHtml(item.item_name||"Inventory Item")}</div>
    <div class="part-tag-row"><strong>${escapeHtml(item.part_number||item.inventory_code||"NO P/N")}</strong><span>QTY ${escapeHtml(inventoryQuantityLabel(item))}</span></div>
    <div class="part-tag-location">${escapeHtml(placement)}</div>
    ${labelScanBlock(code)}
  </div>`;
}

function binLabelHtml(bin){
  const code=bin.bin_code;
  return `<div class="bin-label-sheet">
    <div class="bin-label-brand">OPEN THROTTLE RACING</div>
    <div class="bin-label-id">${escapeHtml(bin.bin_code)}</div>
    <div class="bin-label-class">${escapeHtml(bin.make)} • ${escapeHtml(bin.model)}</div>
    <div class="bin-label-system">${escapeHtml(bin.system)}${bin.subsystem?` / ${escapeHtml(bin.subsystem)}`:""}</div>
    <div class="bin-label-location">${escapeHtml(binCartLocationLabel(bin))}</div>
    ${bin.description?`<div class="bin-label-note">${escapeHtml(bin.description)}</div>`:""}
    ${labelScanBlock(code)}
  </div>`;
}

function renderLabelPreview(){
  const wrap=document.getElementById("labelPrintCanvas");
  const note=document.getElementById("labelPrintNote");
  if(!wrap||!currentLabelPayload) return;
  if(currentLabelPayload.type==="bin"){
    wrap.innerHTML=binLabelHtml(currentLabelPayload.bin);
    if(note) note.textContent="4×6 bin label • browser print path";
  }else{
    const item=currentLabelPayload.item;
    wrap.innerHTML=`<div class="part-fold-sheet">
      ${partFaceHtml(item,false)}
      ${partFaceHtml(item,false)}
      ${partFaceHtml(item,true)}
      ${partFaceHtml(item,true)}
    </div>`;
    if(note) note.textContent="4×6 fold-wrap prototype • four 2×3 faces around a 2×3 paper tag";
  }
}

function printCurrentLabel(){
  if(!currentLabelPayload) return;
  window.print();
}
