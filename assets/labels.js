// ----- Inventory Label & Bin Assistant V1 -----
// Part and bin labels support three explicit media presets.

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
let binCodeAutomatic=true;
let binCodeSeries="";
let binCreateRequestId=null;
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
  const bins=inventoryBins.filter(bin=>bin.status!=="Archived"&&bin.model===platform && ((selectedBin && bin.id===selectedBin) || isLooseInventoryBin(bin) || (location==="Backstock" ? !bin.cart_location : binCartLocationLabel(bin)===location)));
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
  if(!bin || binCartSavePending || isLooseInventoryBin(bin) || bin.parent_bin_id) return;
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
    await loadInventoryBins();renderInventoryResults();
    if(currentInventoryBin?.id===bin.id&&document.getElementById("binDetail").classList.contains("active"))await openBinDetail(bin.bin_code,"replace");
    else showPortalNavNotice("Bin and sub-bin cart assignments saved.");
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

function binSeriesPrefix(model){
  return CART_CHASSIS_CODES[model]||(model==="M235 / M235iR"?"F22":modelCode(model));
}
function binBaseCode(){
  const make=document.getElementById("binMake")?.value;
  const model=document.getElementById("binModel")?.value;
  return make&&model?binSeriesPrefix(model):"";
}
function nextBinCode(base){
  if(!base)return "";
  const used=inventoryBins.map(bin=>String(bin.bin_code||"")).filter(code=>code.startsWith(`${base}-`))
    .map(code=>code.slice(base.length+1).match(/^(\d{3,})(?:-[A-Z]+)?$/)?.[1])
    .map(Number).filter(value=>Number.isSafeInteger(value)&&value>=0);
  return `${base}-${String((used.length?Math.max(...used):0)+1).padStart(3,"0")}`;
}
function editProposedBinCode(){
  binCodeAutomatic=false;
  const input=document.getElementById("binCodePreview");input.value=input.value.toUpperCase();
}
async function useNextBinCode(){if(await loadInventoryBins()){binCodeAutomatic=true;refreshBinCodePreview();}}
function refreshBinCodePreview(){
  const input=document.getElementById("binCodePreview");if(!input)return;
  const cartSelect=document.getElementById("binCartLocation");
  const model=document.getElementById("binModel")?.value;
  const prefix=CART_CHASSIS_CODES[model]||(model==="M235 / M235iR"?"F22":null);
  const previous=cartSelect.value;
  cartSelect.innerHTML='<option value="">Unassigned</option>'+(prefix?`<option value="A">${prefix}-A</option><option value="B">${prefix}-B</option>`:"");
  cartSelect.value=prefix&&["A","B"].includes(previous)?previous:"";
  const base=binBaseCode();
  if(base!==binCodeSeries){binCodeAutomatic=true;binCodeSeries=base;}
  if(binCodeAutomatic)input.value=base&&inventoryBinsReady?nextBinCode(base):"";
  input.placeholder="Choose make and chassis first";
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
  binCodeAutomatic=true;binCodeSeries="";binCreateRequestId=inventoryOperationId();
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
  await loadInventoryBins();
  resetCreateBinForm();
  document.getElementById("binCreateInitials").value="";
  showScreen("binCreate");
}

async function insertInventoryBin(payload,initials,retry=true,allowRenumber=true){
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
  if(response.status===409){
    if(!await loadInventoryBins())throw new Error("Refresh the bin registry before retrying.");
    const previous=inventoryBins.find(bin=>bin.id===payload.id);
    if(previous)return previous;
    if(retry&&allowRenumber){
      const next=nextBinCode(binSeriesPrefix(payload.model));
      return insertInventoryBin({...payload,bin_code:next,qr_value:`OTR:BIN:${next}`},initials,false,true);
    }
    throw new Error("That Bin ID is already registered. Choose another ID or use the next available number.");
  }
  const message=await response.text();
  throw new Error(`Bin insert failed: ${response.status} ${message}`);
}

async function createInventoryBin(){
  if(binCreatePending)return;
  const initials=inventoryInitials("binCreateInitials");if(!initials)return;
  const make=document.getElementById("binMake").value;
  const chosenModel=document.getElementById("binModel").value;
  const model=chosenModel==="M235 / M235iR"?"F22":chosenModel;
  const system=document.getElementById("binSystem").value;
  if(!make||!model||!system){alert("Choose make, chassis and system first.");return;}
  const base=binSeriesPrefix(model);
  const automatic=binCodeAutomatic;
  let code=document.getElementById("binCodePreview").value.trim().toUpperCase();
  const payload={id:binCreateRequestId||(binCreateRequestId=inventoryOperationId()),make,make_prefix:BIN_MAKE_PREFIX[make]||"X",model,system,
    subsystem:document.getElementById("binSubsystem").value||null,
    location:document.getElementById("binLocation").value.trim()||null,
    cart_location:document.getElementById("binCartLocation").value||null,
    description:document.getElementById("binDescription").value.trim()||null,
    label_format:"4x6",status:"Active"};
  const controls=[...document.querySelectorAll("#binCreate input,#binCreate select,#binCreate textarea,#binCreate button")];
  binCreatePending=true;controls.forEach(control=>control.disabled=true);
  try{
    if(!await loadInventoryBins())throw new Error("The shared bin registry is unavailable. Refresh before creating a bin.");
    const alreadySaved=inventoryBins.find(bin=>bin.id===payload.id);
    if(alreadySaved){if(document.getElementById("binCreate").classList.contains("active"))await openBinDetail(alreadySaved.id,"replace");else showPortalNavNotice(`Bin ${alreadySaved.bin_code} was already created.`);return;}
    if(automatic)code=nextBinCode(base);
    const suffix=code.startsWith(`${base}-`)?code.slice(base.length+1):"";
    const match=suffix.match(/^(\d+)(?:-([A-Z]+))?$/);
    if(!match||!Number.isSafeInteger(Number(match[1]))||Number(match[1])<1)throw new Error(`Use the established format, such as ${base}-023. Bin 000 is reserved for loose stock.`);
    const canonicalNumber=String(Number(match[1])).padStart(3,"0");
    code=`${base}-${canonicalNumber}${match[2]?"-"+match[2]:""}`;
    if(inventoryBins.some(bin=>bin.bin_code.toUpperCase()===code))throw new Error("That Bin ID is already registered. Choose another ID or use the next available number.");
    if(match[2]){
      const parent=inventoryBins.find(bin=>bin.bin_code===`${base}-${canonicalNumber}`);
      if(!parent)throw new Error("Create the numbered parent bin before adding a lettered sub-bin.");
      payload.parent_bin_id=parent.id;
    }
    document.getElementById("binCodePreview").value=code;
    const saved=await insertInventoryBin({...payload,bin_code:code,qr_value:`OTR:BIN:${code}`},initials,true,automatic);
    const index=inventoryBins.findIndex(bin=>bin.id===saved.id);if(index>=0)inventoryBins[index]=saved;else inventoryBins.push(saved);
    inventoryBins.sort(compareInventoryBins);currentInventoryBin=saved;
    if(document.getElementById("binCreate").classList.contains("active"))await openBinDetail(saved.bin_code,"replace");
    else showPortalNavNotice(`Bin ${saved.bin_code} created.`);
  }catch(error){console.error(error);alert(error.message||"The bin save could not be confirmed. Refresh before retrying.");}
  finally{binCreatePending=false;controls.forEach(control=>control.disabled=false);}
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
    if(bin.status==="Archived")return false;
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
  if(bin.status==="Archived"){
    document.getElementById("binDetailWrap").innerHTML=`<h2 class="sectiontitle">${escapeHtml(bin.bin_code)} — Deleted</h2><p>This physical bin is no longer available. Its stock was moved when the bin was removed.</p><button class="secondary" type="button" onclick="openInventoryEventHistory()">Inventory Activity</button>`;
    showScreen("binDetail",{historyMode});return;
  }
  if(!inventoryBackendReady) await loadInventory();
  const wrap=document.getElementById("binDetailWrap");
  const items=itemsForBin(bin);
  const parent=bin.parent_bin_id ? findInventoryBin(bin.parent_bin_id) : null;
  const children=inventoryBins.filter(child=>child.status!=="Archived"&&child.parent_bin_id===bin.id);
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
      <label for="binDisplayName">Bin Name</label><input id="binDisplayName" maxlength="120" value="${escapeHtml(inventoryBinDisplayName(bin))}" />
      <button id="binNameSave" class="secondary" type="button" onclick="saveInventoryBinName()">Save Bin Name</button><p id="binNameStatus" class="small" role="status"></p>
      <label for="binCartLocationSelect">Assign this ${escapeHtml(bin.model)} bin to a cart</label>
      <select id="binCartLocationSelect" ${isLooseInventoryBin(bin)||bin.parent_bin_id?"disabled":""}><option value="">Unassigned</option><option value="A" ${bin.cart_location==="A"?"selected":""}>${escapeHtml(CART_CHASSIS_CODES[bin.model]||bin.model)}-A</option><option value="B" ${bin.cart_location==="B"?"selected":""}>${escapeHtml(CART_CHASSIS_CODES[bin.model]||bin.model)}-B</option></select>
      <p class="small">${isLooseInventoryBin(bin)?"Loose items use this Bin ID on either cart. Assign their locations on each part.":bin.parent_bin_id?"This sub-bin follows its parent cart. Open the parent bin to change its cart.":"All sub-bins follow this bin when its cart changes."}</p>
      <label for="binCartInitials">Initials</label>
      <input id="binCartInitials" class="inventory-initials" type="text" maxlength="8" autocapitalize="characters" autocomplete="off" required placeholder="Required to save bin changes" />
      <div class="actions">
        ${!isLooseInventoryBin(bin)?'<button class="danger" type="button" onclick="openDeleteInventoryBin()">Delete Bin…</button>':""}
        <button class="primary" type="button" onclick="saveBinCartLocation()" ${isLooseInventoryBin(bin)||bin.parent_bin_id?"disabled":""}>Save Cart Location</button>
        <button class="primary" type="button" onclick="openBinLabel('${escapeHtml(String(bin.bin_code)).replace(/'/g,"&#39;")}')">Print 4×6 Bin Label</button>
        <button class="secondary" type="button" onclick="openAssignPartToBin('${escapeHtml(String(bin.bin_code)).replace(/'/g,"&#39;")}')">Fast Move / Placement Here</button>
      </div></details>
    </div>
    ${children.length?`<h3 style="margin:22px 0 10px">Sub-bins</h3><div class="inventory-results">${children.map(child=>`<button type="button" class="inventory-card" onclick="openBinDetail('${escapeHtml(child.bin_code)}')"><strong>${escapeHtml(child.bin_code)}</strong><div class="meta">${escapeHtml(child.description||child.system)} • ${itemsForBin(child).length} direct records • ${escapeHtml(binCartLocationLabel(child))}</div></button>`).join("")}</div>`:""}
    <h3 style="margin:22px 0 10px">Contents</h3>
    <label for="binContentsSearch">Search this bin</label>
    <input id="binContentsSearch" class="inventory-search" type="search" placeholder="Search this bin's parts, part numbers, notes…" oninput="renderBinContents()" />
    <p id="binContentsCount" class="small" role="status" aria-live="polite"></p>
    <div id="binContents" class="inventory-results bin-contents-list"></div>`;
  renderBinContents();
  showScreen("binDetail",{historyMode});
}

function renderBinContents(){
  const wrap=document.getElementById("binContents");
  if(!wrap || !currentInventoryBin) return;
  const all=itemsForBin(currentInventoryBin);
  const terms=String(document.getElementById("binContentsSearch")?.value||"").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const rows=all.filter(item=>{
    const hay=[item.item_name,item.part_number,item.inventory_code,item.condition,item.category,item.notes,item.use_case,
      item.source_metadata?.label_text,item.source_metadata?.label_note].filter(Boolean).join(" ").toLowerCase();
    return terms.every(term=>hay.includes(term));
  });
  document.getElementById("binContentsCount").textContent=`${rows.length} of ${all.length} direct item record${all.length===1?"":"s"}`;
  wrap.innerHTML=rows.length?rows.map(item=>`<button type="button" class="inventory-card" onclick="openInventoryDetail('${escapeHtml(String(item.local_key)).replace(/'/g,"&#39;")}')">
    <strong>${escapeHtml(item.item_name||"Unnamed item")}</strong>
    <div class="meta"><span class="qty">Qty ${escapeHtml(inventoryQuantityLabel(item))}</span> • ${escapeHtml(item.condition||"Unspecified")}</div>
    <div class="meta inventory-card-bin">📍 ${escapeHtml(inventoryItemLocationLabel(item))} • BIN <span class="label-mono">${escapeHtml(inventoryItemBinDisplayLabel(item))}</span></div>
    <div class="meta">${escapeHtml(item.part_number||item.inventory_code||"")}</div>
    ${item.reorder_flag?'<div class="meta" style="margin-top:8px"><span class="inv-badge review">REORDER</span></div>':""}
  </button>`).join(""):all.length
    ? '<div class="card"><strong>No matching parts in this bin.</strong><p class="small">Clear the search to see all of this bin’s contents.</p></div>'
    : '<div class="card"><strong>No individually tagged stock recorded directly in this bin.</strong><p class="small">This does not establish a physical count of zero. Review any sub-bins or count the contents.</p></div>';
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
    if(bin.status==="Archived")return false;
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

const LABEL_MEDIA={
  inch4x6:{name:"4×6 in",width:"4in",height:"6in",page:"otr-bin",small:false},
  metric25x50:{name:"25×50 mm",width:"50mm",height:"25mm",page:"otr-small",small:true},
  metric150x100:{name:"150×100 mm",width:"150mm",height:"100mm",page:"otr-metric",small:false}
};
function labelMediaFor(payload){
  if(LABEL_MEDIA[payload.media_id]) return payload.media_id;
  return payload.type==="bin"?"inch4x6":"metric25x50";
}
function changeLabelMedia(value){
  if(!currentLabelPayload || !LABEL_MEDIA[value]) return;
  currentLabelPayload.media_id=value;
  renderLabelPreview();
}

function partFaceHtml(item,large=false){
  // Uppercase presentation only. Stored inventory/tag/source identity is untouched.
  const upper=value=>labelSafeText(value).toUpperCase();
  const code=item.tag_id||stablePartTagId(item);
  const bin=inventoryItemBinDisplayLabel(item);
  const placement=`${inventoryItemLocationLabel(item)} • ${bin}`;
  const name=upper(item.item_name||"Inventory Item");
  const size=large?(name.length>50?"22pt":name.length>32?"26pt":"32pt"):(name.length>50?"7pt":name.length>32?"8pt":"9pt");
  const compactQr=!large&&code.length>18;
  let scan;
  if(compactQr){
    const qr=qrcode(0,'M');qr.addData(code);qr.make();
    scan=`<div class="part-tag-qr" data-scan-value="${escapeHtml(code)}">${qr.createSvgTag({cellSize:1,margin:4,scalable:true})}<div class="label-scan-id">${escapeHtml(code.slice(-8))}</div></div>`;
  }else scan=`<div class="label-scan-block">${code39Svg(code)}${code.length<=24?`<div class="label-scan-id">${escapeHtml(upper(code))}</div>`:""}</div>`;
  return `<div class="part-tag-face ${compactQr?'has-qr':''}" data-tag-id="${escapeHtml(code)}">
    <div class="part-tag-brand">${item.workspace_draft?"DRAFT • OTR PART":"OTR PART"}</div>
    <div class="part-tag-name" style="font-size:${size}">${escapeHtml(name)}</div>
    <div class="part-tag-location">${escapeHtml(upper(placement))}</div>
    <div class="part-tag-quantity">QTY ${escapeHtml(upper(inventoryQuantityLabel(item)))}</div>
    ${scan}
  </div>`;
}

function binLabelHtml(bin){
  const code=bin.bin_code;
  return `<div class="bin-label-sheet">
    <div class="bin-label-brand">OPEN THROTTLE RACING</div>
    <div class="bin-label-id">${escapeHtml(bin.bin_code)}</div>
    <div class="bin-label-class">${escapeHtml(bin.make)} • ${escapeHtml(bin.model)}</div>
    <div class="bin-label-system">${escapeHtml(bin.name||bin.system)}${!bin.name&&bin.subsystem?` / ${escapeHtml(bin.subsystem)}`:""}</div>
    <div class="bin-label-location">${escapeHtml(binCartLocationLabel(bin))}</div>
    ${bin.description?`<div class="bin-label-note">${escapeHtml(bin.description)}</div>`:""}
    ${labelScanBlock(code)}
  </div>`;
}

function renderLabelPreview(){
  const wrap=document.getElementById("labelPrintCanvas");
  const note=document.getElementById("labelPrintNote");
  const button=document.getElementById("labelPrintButton");
  const select=document.getElementById("labelMediaSelect");
  if(!wrap||!currentLabelPayload) return;
  const part=currentLabelPayload.type==="part";
  const mediaId=labelMediaFor(currentLabelPayload);
  const media=LABEL_MEDIA[mediaId];
  currentLabelPayload.media_id=mediaId;
  document.body.dataset.labelMedia=mediaId;
  document.body.style.setProperty("--label-width",media.width);
  document.body.style.setProperty("--label-height",media.height);
  document.body.classList.toggle("print-part-label",part);
  wrap.classList.toggle("part-label-canvas",part);
  wrap.classList.toggle("small-label-canvas",media.small);
  wrap.classList.toggle("large-label-canvas",!media.small);
  wrap.classList.toggle("metric-label-canvas",mediaId==="metric150x100");
  if(select){
    select.innerHTML=Object.entries(LABEL_MEDIA).map(([id,profile])=>`<option value="${id}">${profile.name}${id==="metric25x50"?" — 50 mm wide × 25 mm high":""}</option>`).join("");
    select.value=mediaId;
  }
  wrap.innerHTML=part?partFaceHtml(currentLabelPayload.item,!media.small):binLabelHtml(currentLabelPayload.bin);
  if(note) note.textContent=`${media.name} ${part?"part":"bin"} label • ${media.width} wide × ${media.height} high`;
  if(button) button.textContent=`Print ${media.name} Label`;
}

function printCurrentLabel(){
  if(!currentLabelPayload) return;
  window.print();
}
