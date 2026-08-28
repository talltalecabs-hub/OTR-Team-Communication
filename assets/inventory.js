// ----- Inventory Assistant V1 — Supabase authoritative -----
let inventoryData = [];
let inventoryFilter = "ALL";
let currentInventoryItem = null;
let inventoryBackendReady = false;

async function loadInventory(){
  const mode=document.getElementById("inventoryMode");
  const wrap=document.getElementById("inventoryResults");

  if(mode) mode.textContent="Loading shared inventory…";

  try{
    const resp=await fetch(`${SUPABASE_URL}/rest/v1/inventory_items?select=*&order=item_name.asc`,{
      headers:{"apikey":SUPABASE_KEY}
    });

    if(!resp.ok){
      const msg=await resp.text();
      throw new Error(`Inventory backend ${resp.status}: ${msg}`);
    }

    const rows=await resp.json();
    inventoryData=Array.isArray(rows) ? rows.map(x=>({...x,local_key:x.inventory_code||x.id})) : [];
    inventoryBackendReady=true;

    if(mode){
      mode.textContent=inventoryData.length
        ? "Shared OTR inventory • Supabase"
        : "Shared OTR inventory • database ready • no records loaded";
    }
  }catch(err){
    console.error("Shared inventory unavailable.",err);
    inventoryData=[];
    inventoryBackendReady=false;

    if(mode) mode.textContent="Shared inventory unavailable";
    if(wrap){
      wrap.innerHTML='<div class="card"><strong>Inventory database unavailable.</strong><p class="small">Inventory Assistant now uses Supabase as the authoritative source. Check the connection/database and try again.</p></div>';
    }
    const count=document.getElementById("inventoryCount");
    if(count) count.textContent="";
    return;
  }

  renderInventoryResults();
}
function openInventoryAssistant(){
  showScreen("inventoryHome");
}
function browseInventory(platform){
  inventoryFilter=platform;
  const title=document.getElementById("inventoryBrowseTitle");
  if(title){
    const labels={
      "E92":"E92 M3 Inventory",
      "986 Boxster":"986 Boxster Inventory",
      "F30":"F30 3XX Inventory",
      "M235 / M235iR":"M235iR Inventory",
      "Non-Race":"Non-Race Inventory",
      "Tow":"Tow Inventory",
      "Trailer":"Trailer Inventory",
      "ALL":"Entire OTR Inventory"
    };
    title.textContent=labels[platform]||"Inventory";
  }
  const s=document.getElementById("inventorySearch");
  if(s) s.value="";
  showScreen("inventoryBrowse");
  loadInventory();
}
function inventoryMatchesPlatform(item){
  if(inventoryFilter==="ALL") return true;
  return item.platform===inventoryFilter;
}
function invBadge(status){
  const s=status||"Imported";
  const cls=s==="Verified"?"verified":s==="Needs Review"?"review":s==="Not Found"?"notfound":"imported";
  return `<span class="inv-badge ${cls}">${escapeHtml(s.toUpperCase())}</span>`;
}
function renderInventoryResults(){
  const wrap=document.getElementById("inventoryResults");
  if(!wrap) return;
  const q=(document.getElementById("inventorySearch")?.value||"").trim().toLowerCase();
  const rows=inventoryData.filter(inventoryMatchesPlatform).filter(item=>{
    if(!q) return true;
    const hay=[item.item_name,item.platform,item.location,item.category,item.condition,item.status,item.part_number,item.assigned_vehicle,item.use_case].filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
  const count=document.getElementById("inventoryCount");
  if(count) count.textContent=`${rows.length} item record${rows.length===1?"":"s"}`;
  if(!rows.length){
    wrap.innerHTML='<div class="card"><strong>No matching inventory records.</strong><p class="small">Try another search, search the entire inventory, or add what you found.</p></div>';
    return;
  }
  wrap.innerHTML=rows.map(item=>{
    const direct=item.assignment_type==="Specific Vehicle"&&item.assigned_vehicle
      ? `<span class="inv-badge direct">DIRECT SPARE • ${escapeHtml(item.assigned_vehicle)}</span>`:"";
    return `<button type="button" class="inventory-card" onclick="openInventoryDetail('${escapeHtml(String(item.local_key)).replace(/'/g,"&#39;")}')">
      <strong>${escapeHtml(item.item_name||"Unnamed item")}</strong>
      <div class="meta">${escapeHtml(item.platform||"Unassigned platform")} • ${escapeHtml(item.category||"Uncategorized")}</div>
      <div class="meta"><span class="qty">Qty ${Number(item.quantity||0)}</span> • 📍 ${escapeHtml(item.location||"Location unknown")}</div>
      <div class="meta" style="margin-top:9px">${invBadge(item.verification_status)} ${direct}</div>
    </button>`;
  }).join("");
}
function findInventoryItem(key){
  return inventoryData.find(x=>String(x.local_key)===String(key));
}
function openInventoryDetail(key,historyMode="push"){
  const item=findInventoryItem(key);
  if(!item) return;
  currentInventoryItem=item;
  const wrap=document.getElementById("inventoryDetailWrap");
  const assignment=item.assignment_type||"General Inventory";
  const direct=assignment==="Specific Vehicle"&&item.assigned_vehicle ? `<span class="inv-badge direct">DIRECT SPARE • ${escapeHtml(item.assigned_vehicle)}</span>`:"";
  const imported=(item.verification_status||"Imported")==="Imported";
  wrap.innerHTML=`
    <h2 class="sectiontitle">${escapeHtml(item.item_name||"Inventory Item")}</h2>
    <div class="inventory-statusbar">${invBadge(item.verification_status)} ${direct}</div>
    <div class="card">
      <div class="inventory-detail-grid">
        <div class="inventory-field"><div class="k">Quantity</div><div class="v">${Number(item.quantity||0)}</div></div>
        <div class="inventory-field"><div class="k">Condition</div><div class="v">${escapeHtml(item.condition||"Unspecified")}</div></div>
        <div class="inventory-field"><div class="k">Location</div><div class="v">${escapeHtml(item.location||"Unknown")}</div></div>
        <div class="inventory-field"><div class="k">Platform</div><div class="v">${escapeHtml(item.platform||"Unassigned")}</div></div>
        <div class="inventory-field"><div class="k">Category</div><div class="v">${escapeHtml(item.category||"Uncategorized")}</div></div>
        <div class="inventory-field"><div class="k">Part Number</div><div class="v">${escapeHtml(item.part_number||"—")}</div></div>
        <div class="inventory-field"><div class="k">Assignment</div><div class="v">${escapeHtml(assignment)}</div></div>
        <div class="inventory-field"><div class="k">Use Case</div><div class="v">${escapeHtml(item.use_case||"—")}</div></div>
      </div>
      ${imported ? `<div class="seed-note"><strong>Imported seed record — not physically verified.</strong><br>Original: “${escapeHtml(item.original_item_text||item.item_name)}” • Qty ${Number(item.original_quantity??item.quantity??0)} • ${escapeHtml(item.original_location||item.location||"Unknown location")}</div>` : ""}
      ${item.notes ? `<p><strong>Notes:</strong> ${escapeHtml(item.notes)}</p>`:""}
      <div class="actions">
        <button class="primary" type="button" onclick="openInventoryVerify()">✓ Verify / Correct</button>
        <button class="secondary" type="button" onclick="markInventoryNeedsReview()">Needs Review</button>
        <button class="danger" type="button" onclick="markInventoryNotFound()">Not Found</button>
      </div>
    </div>`;
  showScreen("inventoryDetail",{historyMode});
}
function openInventoryVerify(){
  const i=currentInventoryItem;if(!i)return;
  document.getElementById("inventoryEditTitle").textContent=(i.verification_status==="Verified"?"Update Inventory":"Verify Inventory");
  document.getElementById("invQty").value=Number(i.quantity||0);
  document.getElementById("invCondition").value=i.condition||"Unspecified";
  document.getElementById("invLocation").value=i.location||"";
  document.getElementById("invPartNumber").value=i.part_number||"";
  document.getElementById("invAssignment").value=i.assignment_type||"General Inventory";
  document.getElementById("invAssignedVehicle").value=i.assigned_vehicle||"";
  document.getElementById("invUseCase").value=i.use_case||i.notes||"";
  toggleAssignedVehicle();
  showScreen("inventoryEdit");
}
function toggleAssignedVehicle(){
  const show=document.getElementById("invAssignment").value==="Specific Vehicle";
  document.getElementById("assignedVehicleWrap").classList.toggle("hidden",!show);
}
function toggleAddAssignedVehicle(){
  const show=document.getElementById("addAssignment").value==="Specific Vehicle";
  document.getElementById("addAssignedVehicleWrap").classList.toggle("hidden",!show);
}
async function persistInventoryPatch(item,patch){
  if(!inventoryBackendReady || !item.id){
    alert("Shared inventory is unavailable. No inventory change was saved.");
    return false;
  }

  const resp=await fetch(`${SUPABASE_URL}/rest/v1/inventory_items?id=eq.${encodeURIComponent(item.id)}`,{
    method:"PATCH",
    headers:{"apikey":SUPABASE_KEY,"Content-Type":"application/json","Prefer":"return=minimal"},
    body:JSON.stringify({...patch,updated_at:new Date().toISOString()})
  });

  if(!resp.ok){
    const msg=await resp.text();
    console.error("Inventory update failed:",resp.status,msg);
    alert("Inventory update failed. Nothing was changed.");
    return false;
  }

  return true;
}
async function saveInventoryVerification(){
  if(!currentInventoryItem)return;
  const patch={
    quantity:Math.max(0,parseInt(document.getElementById("invQty").value||"0",10)),
    condition:document.getElementById("invCondition").value,
    location:document.getElementById("invLocation").value.trim(),
    part_number:document.getElementById("invPartNumber").value.trim()||null,
    assignment_type:document.getElementById("invAssignment").value,
    assigned_vehicle:document.getElementById("invAssignment").value==="Specific Vehicle" ? (document.getElementById("invAssignedVehicle").value.trim()||null) : null,
    use_case:document.getElementById("invUseCase").value.trim()||null,
    verification_status:"Verified",
    verified_at:new Date().toISOString()
  };
  const saved=await persistInventoryPatch(currentInventoryItem,patch);
  if(!saved) return;
  Object.assign(currentInventoryItem,patch);
  openInventoryDetail(currentInventoryItem.local_key,"replace");
}
async function markInventoryNeedsReview(){
  if(!currentInventoryItem)return;
  const patch={verification_status:"Needs Review"};
  const saved=await persistInventoryPatch(currentInventoryItem,patch);
  if(!saved) return;
  Object.assign(currentInventoryItem,patch);
  openInventoryDetail(currentInventoryItem.local_key,"replace");
}
async function markInventoryNotFound(){
  if(!currentInventoryItem)return;
  if(!confirm("Mark this imported/current record as Not Found? The history is preserved."))return;
  const patch={verification_status:"Not Found",status:"Missing"};
  const saved=await persistInventoryPatch(currentInventoryItem,patch);
  if(!saved) return;
  Object.assign(currentInventoryItem,patch);
  openInventoryDetail(currentInventoryItem.local_key,"replace");
}
function openAddInventory(){
  ["addItemName","addLocation","addCategory","addPartNumber","addAssignedVehicle","addNotes"].forEach(id=>{const el=document.getElementById(id);if(el)el.value="";});
  document.getElementById("addQty").value=1;
  document.getElementById("addAssignment").value="General Inventory";
  toggleAddAssignedVehicle();
  showScreen("inventoryAdd");
}
function newInventoryCode(platform){
  const prefix=(platform||"GEN").toUpperCase().replace(/[^A-Z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,12)||"GEN";
  return `${prefix}-NEW-${Date.now().toString(36).toUpperCase()}`;
}
async function addInventoryItem(){
  const addScreen=document.getElementById("inventoryAdd");
  if(!addScreen || !addScreen.classList.contains("active")) return;

  const name=document.getElementById("addItemName").value.trim();
  const location=document.getElementById("addLocation").value.trim();

  if(!name){
    alert("Add a part or item name first.");
    return;
  }

  const platform=document.getElementById("addPlatform").value;
  const item={
    inventory_code:newInventoryCode(platform),
    platform,
    location:location||"Location unknown",
    category:document.getElementById("addCategory").value.trim()||"Uncategorized",
    item_name:name,
    quantity:Math.max(0,parseInt(document.getElementById("addQty").value||"0",10)),
    condition:document.getElementById("addCondition").value,
    status:"In Stock",
    notes:null,
    source:"Inventory Assistant V1",
    verification_status:"Verified",
    original_quantity:null,
    original_item_text:null,
    original_location:null,
    part_number:document.getElementById("addPartNumber").value.trim()||null,
    assignment_type:document.getElementById("addAssignment").value,
    assigned_vehicle:document.getElementById("addAssignment").value==="Specific Vehicle"
      ? (document.getElementById("addAssignedVehicle").value.trim()||null)
      : null,
    use_case:document.getElementById("addNotes").value.trim()||null,
    tag_id:null,
    compatibility:[platform],
    verified_at:new Date().toISOString(),
    created_at:new Date().toISOString()
  };

  try{
    const resp=await fetch(`${SUPABASE_URL}/rest/v1/inventory_items`,{
      method:"POST",
      headers:{"apikey":SUPABASE_KEY,"Content-Type":"application/json","Prefer":"return=representation"},
      body:JSON.stringify(item)
    });

    if(!resp.ok){
      const msg=await resp.text();
      throw new Error(`Inventory insert failed: ${resp.status} ${msg}`);
    }

    const saved=await resp.json();
    if(saved&&saved[0]) Object.assign(item,saved[0]);

    inventoryBackendReady=true;
    const liveItem={...item,local_key:item.inventory_code||item.id};
    inventoryData.push(liveItem);
    currentInventoryItem=liveItem;
    inventoryFilter="ALL";
    openInventoryDetail(liveItem.local_key,"replace");
  }catch(err){
    console.error(err);
    alert("Unable to add inventory to the shared database. Nothing was saved.");
  }
}
