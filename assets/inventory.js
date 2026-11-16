// ----- Inventory Assistant V1 — Supabase authoritative -----
let inventoryData = [];
let inventoryFilter = "ALL";
let inventoryStockCategory = "Mobile";
let inventoryCartFilter = "ALL";
let currentInventoryItem = null;
let inventoryBackendReady = false;
let inventoryPatchPending=false;
let inventoryAddPending=false;
let inventoryNotesPending=false;
let inventoryDetailRenderId=0;

// Unknown workbook counts remain unknown; units describe pieces, sets, or lots.
function inventoryQuantityLabel(item){
  if(item.quantity===null || item.quantity===undefined){
    return item.source_metadata?.quantity_raw==="VARIOUS" ? "VARIOUS (uncounted)" : "Uncounted";
  }
  return `${item.quantity} ${item.quantity_unit||"pcs"}`;
}

async function loadInventory(){
  const mode=document.getElementById("inventoryMode");
  const wrap=document.getElementById("inventoryResults");

  if(mode) mode.textContent="Loading shared inventory…";
  if(wrap) wrap.innerHTML='<div class="card"><strong>Loading shared inventory…</strong></div>';
  const loadingCount=document.getElementById("inventoryCount");
  if(loadingCount) loadingCount.textContent="";

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

  await Promise.all([loadInventoryBins(),loadInventoryCarts()]);
  populateInventoryCartFilter();
  const cartFilter=document.getElementById("inventoryCartSelect");
  cartFilter.disabled=!inventoryBinsReady||!inventoryCartsReady;
  if(!inventoryBinsReady||!inventoryCartsReady){
    inventoryCartFilter="ALL";
    cartFilter.value="ALL";
    if(mode) mode.textContent+=" • Cart locations unavailable";
  }
  renderInventoryResults();
}
function openInventoryAssistant(){
  showScreen("inventoryHome");
}
function inventoryStockCategoryLabel(item){
  return item.stock_category||"Mobile";
}
function openMobileInventory(){
  return browseInventory("ALL","Mobile").then(()=>document.getElementById("inventorySearch").focus());
}
function updateInventoryBrowseTitle(){
  const labels={"E92":"E92 M3","F22":"F22","986 Boxster":"986 Boxster","F30":"F30 3XX","M235 / M235iR":"M235iR","ALL":"All chassis"};
  const category=inventoryStockCategory==="ALL" ? "All Inventory" : inventoryStockCategory==="Mobile" ? "Mobile Inventory Search" : inventoryStockCategory;
  document.getElementById("inventoryBrowseTitle").textContent=`${category} • ${labels[inventoryFilter]||inventoryFilter}`;
  document.getElementById("chassisBinsHint").textContent=inventoryFilter==="ALL" ? "Browse registered bins by chassis, ID, and name." : `Browse ${labels[inventoryFilter]||inventoryFilter} bins by ID and name, including loose bin 000.`;
}
function browseInventory(platform,stockCategory="Mobile"){
  inventoryFilter=platform;
  inventoryStockCategory=stockCategory;
  inventoryCartFilter="ALL";
  document.getElementById("inventoryCartSelect").value="ALL";
  document.getElementById("inventoryStockCategoryFilter").value=stockCategory;
  document.getElementById("inventoryPlatformFilter").value=platform;
  document.getElementById("inventorySearch").value="";
  updateInventoryBrowseTitle();
  showScreen("inventoryBrowse");
  return loadInventory();
}
function openChassisBins(){
  return openBinBrowser(inventoryFilter,"ALL");
}
function openChassisPartsSearch(){
  document.getElementById("inventorySearch").focus();
}
function setInventoryFilters(){
  inventoryStockCategory=document.getElementById("inventoryStockCategoryFilter").value;
  inventoryFilter=document.getElementById("inventoryPlatformFilter").value;
  inventoryCartFilter=document.getElementById("inventoryCartSelect").value;
  updateInventoryBrowseTitle();
  renderInventoryResults();
}
function inventoryMatchesPlatform(item){
  return (inventoryFilter==="ALL" || item.platform===inventoryFilter) &&
    (inventoryStockCategory==="ALL" || inventoryStockCategoryLabel(item)===inventoryStockCategory) &&
    (inventoryCartFilter==="ALL" || inventoryItemLocationLabel(item)===inventoryCartFilter);
}
async function changeInventoryStockCategory(category){
  const item=currentInventoryItem;
  if(!item || !["Mobile","Backstock"].includes(category)) return;
  const initials=inventoryInitials("inventoryActionInitials");
  if(!initials) return;
  const patch={stock_category:category};
  if(category==="Backstock"){
    patch.cart_code=null;
    const bin=item.inventory_bin_id?findInventoryBin(item.inventory_bin_id):null;
    if(!bin || bin.cart_location){
      patch.inventory_bin_id=null;
      patch.location="Backstock";
    }
  }else if(!item.inventory_bin_id && !item.cart_code){
    patch.location="Unassigned";
  }
  const saved=await persistInventoryPatch(item,patch,initials);
  if(!saved) return;
  Object.assign(item,patch);
  renderInventoryResults();
  if(currentInventoryItem?.id===item.id && document.getElementById("inventoryItemManagement").classList.contains("active")) openInventoryItemManagement("replace");
}
function invBadge(status){
  const s=status||"Imported";
  const cls=s==="Verified"?"verified":s==="Needs Review"?"review":s==="Not Found"?"notfound":"imported";
  return `<span class="inv-badge ${cls}">${escapeHtml(s.toUpperCase())}</span>`;
}
function inventoryMatchesSearch(item,query){
  const bin=item.inventory_bin_id?findInventoryBin(item.inventory_bin_id):null;
  const hay=[item.item_name,item.platform,item.location,item.category,item.condition,item.status,
    item.part_number,item.assigned_vehicle,item.use_case,item.tag_id,item.inventory_code,
    inventoryStockCategoryLabel(item),inventoryItemLocationLabel(item),inventoryItemBinDisplayLabel(item),
    bin?.description,bin?.system,...(Array.isArray(item.compatibility)?item.compatibility:[])]
    .filter(Boolean).join(" ").toLowerCase();
  return String(query||"").trim().toLowerCase().split(/\s+/).filter(Boolean).every(term=>hay.includes(term));
}
function renderInventoryResults(){
  const wrap=document.getElementById("inventoryResults");
  if(!wrap) return;
  const q=(document.getElementById("inventorySearch")?.value||"").trim().toLowerCase();
  const rows=inventoryData.filter(inventoryMatchesPlatform).filter(item=>inventoryMatchesSearch(item,q));
  const count=document.getElementById("inventoryCount");
  if(count) count.textContent=`${rows.length} item record${rows.length===1?"":"s"}`;
  if(!rows.length){
    wrap.innerHTML='<div class="card"><strong>No matching inventory records.</strong><p class="small">Try another search or use Inventory Management to check stock.</p><button class="secondary" type="button" onclick="showScreen(&quot;inventoryManagement&quot;)">Inventory Management</button></div>';
    return;
  }
  wrap.innerHTML=rows.map(item=>{
    const direct=item.assignment_type==="Specific Vehicle"&&item.assigned_vehicle
      ? `<span class="inv-badge direct">DIRECT SPARE • ${escapeHtml(item.assigned_vehicle)}</span>`:"";
    return `<button type="button" class="inventory-card" onclick="openInventoryDetail('${escapeHtml(String(item.local_key)).replace(/'/g,"&#39;")}')">
      <strong>${escapeHtml(item.item_name||"Unnamed item")}</strong>
      <div class="meta">${escapeHtml(item.platform||"Unassigned platform")} • ${escapeHtml(item.category||"Uncategorized")}</div>
      <div class="meta"><span class="qty">Qty ${escapeHtml(inventoryQuantityLabel(item))}</span></div>
      <div class="meta inventory-card-bin">📍 ${escapeHtml(inventoryItemLocationLabel(item))} • BIN <span class="label-mono">${escapeHtml(inventoryItemBinDisplayLabel(item))}</span></div>
      <div class="meta" style="margin-top:9px">${invBadge(item.verification_status)} <span class="inv-badge direct">${escapeHtml(inventoryStockCategoryLabel(item))}</span> ${direct}</div>
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
  inventoryDetailRenderId+=1;
  const wrap=document.getElementById("inventoryDetailWrap");
  const assignment=item.assignment_type||"General Inventory";
  const direct=assignment==="Specific Vehicle"&&item.assigned_vehicle ? `<span class="inv-badge direct">DIRECT SPARE • ${escapeHtml(item.assigned_vehicle)}</span>`:"";
  const imported=(item.verification_status||"Imported")==="Imported";
  wrap.innerHTML=`
    <h2 class="sectiontitle">${escapeHtml(item.item_name||"Inventory Item")}</h2>
    <div id="inventoryDetailStatus" class="inventory-statusbar">${invBadge(item.verification_status)} <span class="inv-badge direct">${escapeHtml(inventoryStockCategoryLabel(item))}</span> ${direct}</div>
    <div class="card">
      <div class="inventory-detail-grid">
        <div class="inventory-field"><div class="k">Quantity</div><div class="v">${escapeHtml(inventoryQuantityLabel(item))}</div></div>
        <div class="inventory-field"><div class="k">Condition</div><div class="v">${escapeHtml(item.condition||"Unspecified")}</div></div>
        <div class="inventory-field" style="grid-column:1/-1"><div class="k">Location / Bin</div><div class="v inventory-physical-path">${inventoryLocationBinHtml(item,true)}</div></div>
        <div class="inventory-field"><div class="k">Platform</div><div class="v">${escapeHtml(item.platform||"Unassigned")}</div></div>
        <div class="inventory-field"><div class="k">Category</div><div class="v">${escapeHtml(item.category||"Uncategorized")}</div></div>
        <div class="inventory-field"><div class="k">Part Number</div><div class="v">${escapeHtml(item.part_number||"—")}</div></div>
        <div class="inventory-field"><div class="k">Reorder Flag</div><div class="v">${item.reorder_flag?"Yes":"No"}</div></div>
        <div class="inventory-field"><div class="k">Assignment</div><div class="v">${escapeHtml(inventoryStockCategoryLabel(item))} Inventory${assignment!=="General Inventory"?`<div class="small">${escapeHtml(assignment)}</div>`:""}</div></div>
        <div class="inventory-field"><div class="k">Use Case</div><div class="v">${escapeHtml(item.use_case||"—")}</div></div>
      </div>
      ${imported ? `<div class="seed-note"><strong>Imported record — not independently physically verified.</strong><br>Original: “${escapeHtml(item.original_item_text||item.item_name)}” • ${item.original_quantity===null ? "Uncounted" : escapeHtml(inventoryQuantityLabel({...item,quantity:item.original_quantity??item.quantity}))} • ${escapeHtml(item.original_location||item.location||"Unknown location")}</div>` : ""}
      ${item.source_metadata?.label_text ? `<div class="seed-note"><strong>Physical label:</strong> ${escapeHtml(item.source_metadata.label_text)}<br>Note: ${escapeHtml(item.source_metadata.label_note||"—")}<br>Photo: ${escapeHtml(item.source_metadata.source_photo||"—")} • Label date: ${escapeHtml(item.source_metadata.label_date||"—")}${item.source_metadata.review?`<br>${escapeHtml(item.source_metadata.review)}`:""}</div>` : ""}
      <div class="actions">
        <button class="primary" type="button" onclick="openUsePart()" ${item.quantity===0?"disabled":""}>Use Part</button>
        <button class="secondary" type="button" onclick="openInventoryItemManagement()">Inventory Management</button>
        <button id="inventoryDetailNotFound" class="danger" type="button" onclick="markInventoryNotFound('inventoryDetailInitials')">Not Found</button>
      </div>
      <label for="inventoryDetailNotes">Notes</label>
      <textarea id="inventoryDetailNotes" data-inventory-key="${escapeHtml(String(item.local_key))}" rows="4" placeholder="Part condition, fitment, or crew notes...">${escapeHtml(item.notes||"")}</textarea>
      <label for="inventoryDetailInitials">Initials</label>
      <input id="inventoryDetailInitials" class="inventory-initials" type="text" maxlength="8" autocapitalize="characters" autocomplete="off" required placeholder="Required for Notes or Not Found" />
      <div class="actions"><button id="inventoryDetailSaveNotes" class="secondary" type="button" onclick="saveInventoryNotes()">Save Notes</button></div>
      <p id="inventoryDetailNoteStatus" class="small" role="status" aria-live="polite"></p>
    </div>`;
  showScreen("inventoryDetail",{historyMode});
}
function inventoryDetailDisplayedItem(){
  const key=document.getElementById("inventoryDetailNotes")?.dataset.inventoryKey;
  return key?findInventoryItem(key):null;
}
function applyInventoryCachedPatch(item,patch){
  Object.assign(item,patch);
  const latest=inventoryData.find(row=>row.id===item.id);
  if(latest && latest!==item) Object.assign(latest,patch);
  if(currentInventoryItem?.id===item.id && currentInventoryItem!==item && currentInventoryItem!==latest) Object.assign(currentInventoryItem,patch);
}
async function saveInventoryNotes(){
  const screen=document.getElementById("inventoryDetail");
  if(!screen?.classList.contains("active") || inventoryNotesPending || inventoryPatchPending) return;
  const item=inventoryDetailDisplayedItem();
  if(!item) return;
  const initials=inventoryInitials("inventoryDetailInitials");
  if(!initials) return;
  const input=document.getElementById("inventoryDetailNotes");
  const initialsInput=document.getElementById("inventoryDetailInitials");
  const save=document.getElementById("inventoryDetailSaveNotes");
  const notFound=document.getElementById("inventoryDetailNotFound");
  const status=document.getElementById("inventoryDetailNoteStatus");
  const renderId=inventoryDetailRenderId;
  const patch={notes:input.value.trim()||null};
  if(patch.notes===(item.notes||null)){
    status.textContent="No note changes to save.";
    return;
  }
  inventoryNotesPending=true;
  for(const control of [input,initialsInput,save,notFound]) control.disabled=true;
  save.textContent="Saving Notes...";
  status.textContent="Saving notes...";
  try{
    const saved=await persistInventoryPatch(item,patch,initials);
    if(!saved){
      if(renderId===inventoryDetailRenderId) status.textContent="Notes could not be confirmed. Refresh before retrying.";
      return;
    }
    applyInventoryCachedPatch(item,patch);
    renderInventoryResults();
    if(renderId===inventoryDetailRenderId && screen.classList.contains("active")){
      input.value=patch.notes||"";
      input.defaultValue=input.value;
      status.textContent="Notes saved.";
      initialsInput.value="";
    }else{
      // A reload/reopen may have replaced this item's form while the write ran.
      // Refresh an untouched form, while preserving any newer unsaved note.
      const shown=inventoryDetailDisplayedItem();
      const freshInput=document.getElementById("inventoryDetailNotes");
      if(shown?.id===item.id && freshInput && freshInput.value===freshInput.defaultValue){
        freshInput.value=patch.notes||"";
        freshInput.defaultValue=freshInput.value;
      }
      showPortalNavNotice("Notes saved.");
    }
  }finally{
    inventoryNotesPending=false;
    // Restore only these captured controls; a newly opened part has its own form.
    for(const control of [input,initialsInput,save,notFound]) control.disabled=false;
    save.textContent="Save Notes";
  }
}
function inventoryLocationBinHtml(item,clickable=false){
  const location=escapeHtml(inventoryItemLocationLabel(item));
  const bin=escapeHtml(inventoryItemBinDisplayLabel(item));
  const reference=clickable && item.inventory_bin_id
    ? `<button class="bin-inline-link" type="button" onclick="openBinDetail('${escapeHtml(item.inventory_bin_id)}')">${bin}</button>` : `<span class="label-mono">${bin}</span>`;
  return `${location} • ${reference}`;
}
function openInventoryItemManagement(historyMode="push"){
  const item=currentInventoryItem;
  if(!item) return;
  document.getElementById("inventoryItemManagementWrap").innerHTML=`
    <h2 class="sectiontitle">${escapeHtml(item.item_name||"Inventory Item")}</h2>
    <div class="card">
      <p><strong>Qty ${escapeHtml(inventoryQuantityLabel(item))}</strong></p>
      <p class="inventory-physical-path">${inventoryLocationBinHtml(item,true)}</p>
      <p class="small">${escapeHtml(inventoryStockCategoryLabel(item))} Inventory • ${escapeHtml(item.platform||"Unassigned chassis")}</p>
      <label for="inventoryActionInitials">Initials</label>
      <input id="inventoryActionInitials" class="inventory-initials" type="text" maxlength="8" autocapitalize="characters" autocomplete="off" required placeholder="Required for changes" />
      <div class="actions">
        <button class="primary" type="button" onclick="openInventoryVerify()">Verify / Correct</button>
        <button class="secondary" type="button" onclick="openAssignPartToBin('', '${escapeHtml(String(item.local_key)).replace(/'/g,"&#39;")}')">Fast Move / Placement</button>
        <button class="secondary" type="button" onclick="changeInventoryStockCategory('${inventoryStockCategoryLabel(item)==="Mobile"?"Backstock":"Mobile"}')">Move to ${inventoryStockCategoryLabel(item)==="Mobile"?"Backstock":"Mobile"}</button>
        <button class="secondary" type="button" onclick="markInventoryNeedsReview()">Needs Review</button>
        <button class="danger" type="button" onclick="markInventoryNotFound()">Not Found</button>
        <button class="secondary" type="button" onclick="openPartTag('${escapeHtml(String(item.local_key)).replace(/'/g,"&#39;")}')">Print Part Tag</button>
      </div>
      <p class="small">Enter initials here for flag and stock-category changes. Placement, count, and tag changes ask for initials on their own screen.</p>
    </div>`;
  showScreen("inventoryItemManagement",{historyMode});
}
function openInventoryVerify(){
  const i=currentInventoryItem;if(!i)return;
  document.getElementById("inventoryEditTitle").textContent=(i.verification_status==="Verified"?"Update Inventory":"Verify Inventory");
  document.getElementById("invQty").value=i.quantity??"";
  document.getElementById("invQtyLabel").textContent=`Quantity found (${i.quantity_unit||"pcs"}; blank = uncounted)`;
  document.getElementById("invCondition").value=i.condition||"Unspecified";
  document.getElementById("invLocation").value=i.location||"";
  document.getElementById("invStockCategory").value=inventoryStockCategoryLabel(i);
  setupInventoryPlacement("inv",i);
  document.getElementById("invInitials").value="";
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
async function persistInventoryPatch(item,patch,initials){
  if(!inventoryBackendReady || !item.id){
    alert("Shared inventory is unavailable. No inventory change was saved.");
    return false;
  }
  if(inventoryPatchPending) return false;
  if(!initials) return false;
  inventoryPatchPending=true;
  try{
    const resp=await fetch(`${SUPABASE_URL}/rest/v1/inventory_items?id=eq.${encodeURIComponent(item.id)}`,{
      method:"PATCH",
      headers:{...inventoryEventHeaders(initials),"Prefer":"return=minimal"},
      body:JSON.stringify({...patch,updated_at:new Date().toISOString()})
    });
    if(!resp.ok) throw new Error(`Inventory update ${resp.status}: ${await resp.text()}`);
    return true;
  }catch(error){
    console.error("Inventory update could not be confirmed",error);
    alert("Inventory update could not be confirmed. Refresh the item before retrying.");
    return false;
  }finally{
    inventoryPatchPending=false;
  }
}
async function saveInventoryVerification(){
  const item=currentInventoryItem;
  if(!item)return;
  const initials=inventoryInitials("invInitials");
  if(!initials) return;
  const rawQuantity=document.getElementById("invQty").value.trim();
  const quantity=rawQuantity==="" ? null : Number(rawQuantity);
  if((quantity===null && item.quantity!==null) ||
     (quantity!==null && (!Number.isInteger(quantity) || quantity<0))){
    alert("Enter a whole-number count of zero or more. Leave an uncounted item blank until counted.");
    return;
  }
  const stockCategory=document.getElementById("invStockCategory").value;
  if(!["Mobile","Backstock"].includes(stockCategory)) return;
  const patch={
    ...inventoryPlacementPatch("inv"),
    quantity,
    condition:document.getElementById("invCondition").value,
    part_number:document.getElementById("invPartNumber").value.trim()||null,
    assignment_type:document.getElementById("invAssignment").value,
    assigned_vehicle:document.getElementById("invAssignment").value==="Specific Vehicle" ? (document.getElementById("invAssignedVehicle").value.trim()||null) : null,
    use_case:document.getElementById("invUseCase").value.trim()||null,
    verification_status:quantity===null ? "Needs Review" : "Verified",
    status:quantity===null ? "Uncounted" : quantity===0 ? "Out of Stock" : "In Stock",
    verified_at:new Date().toISOString()
  };
  const saved=await persistInventoryPatch(item,patch,initials);
  if(!saved) return;
  Object.assign(item,patch);
  renderInventoryResults();
  if(currentInventoryItem?.id===item.id){
    const active=document.getElementById("inventoryEdit").classList.contains("active");
    if(active || document.getElementById("inventoryDetail").classList.contains("active")) openInventoryDetail(item.local_key,active?"replace":"none");
  }
}
async function markInventoryNeedsReview(){
  const item=currentInventoryItem;
  if(!item)return;
  const initials=inventoryInitials("inventoryActionInitials");
  if(!initials) return;
  const patch={verification_status:"Needs Review"};
  const saved=await persistInventoryPatch(item,patch,initials);
  if(!saved) return;
  Object.assign(item,patch);
  renderInventoryResults();
  if(currentInventoryItem?.id===item.id && document.getElementById("inventoryItemManagement").classList.contains("active")) openInventoryItemManagement("replace");
}
async function markInventoryNotFound(fieldId="inventoryActionInitials"){
  const fromDetail=fieldId==="inventoryDetailInitials";
  const item=fromDetail?inventoryDetailDisplayedItem():currentInventoryItem;
  if(!item || inventoryPatchPending) return;
  const initials=inventoryInitials(fieldId);
  if(!initials) return;
  if(!confirm("Mark this imported/current record as Not Found? The history is preserved.")) return;
  const renderId=inventoryDetailRenderId;
  const patch={verification_status:"Not Found",status:"Missing"};
  const saved=await persistInventoryPatch(item,patch,initials);
  if(!saved) return;
  applyInventoryCachedPatch(item,patch);
  renderInventoryResults();
  if(fromDetail){
    if(renderId===inventoryDetailRenderId && document.getElementById("inventoryDetail").classList.contains("active")){
      const badge=document.getElementById("inventoryDetailStatus").firstElementChild;
      if(badge) badge.outerHTML=invBadge(item.verification_status);
      document.getElementById("inventoryDetailInitials").value="";
      document.getElementById("inventoryDetailNoteStatus").textContent="Marked Not Found.";
    }else showPortalNavNotice("Inventory marked Not Found.");
  }else if(currentInventoryItem?.id===item.id && document.getElementById("inventoryItemManagement").classList.contains("active")) openInventoryItemManagement("replace");
}
async function openAddInventory(){
  if(!inventoryBinsReady||!inventoryCartsReady) await Promise.all([loadInventoryBins(),loadInventoryCarts()]);
  ["addItemName","addCategory","addPartNumber","addAssignedVehicle","addNotes"].forEach(id=>{const el=document.getElementById(id);if(el)el.value="";});
  document.getElementById("addQty").value=1;
  document.getElementById("addInitials").value="";
  document.getElementById("addStockCategory").value=inventoryStockCategory==="Backstock"?"Backstock":"Mobile";
  document.getElementById("addAssignment").value="General Inventory";
  document.getElementById("addLocation").value="Unassigned";
  setupInventoryPlacement("add");
  toggleAddAssignedVehicle();
  showScreen("inventoryAdd");
}
function newInventoryCode(platform){
  const prefix=(platform||"GEN").toUpperCase().replace(/[^A-Z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,12)||"GEN";
  return `${prefix}-NEW-${Date.now().toString(36).toUpperCase()}`;
}
async function addInventoryItem(){
  const addScreen=document.getElementById("inventoryAdd");
  if(!addScreen || !addScreen.classList.contains("active") || inventoryAddPending) return;
  const initials=inventoryInitials("addInitials");
  if(!initials) return;

  const name=document.getElementById("addItemName").value.trim();

  if(!name){
    alert("Add a part or item name first.");
    return;
  }

  const rawQuantity=document.getElementById("addQty").value.trim();
  const quantity=Number(rawQuantity);
  if(!rawQuantity || !Number.isInteger(quantity) || quantity<0){
    alert("Enter a whole-number count of zero or more.");
    return;
  }
  const stockCategory=document.getElementById("addStockCategory").value;
  if(!["Mobile","Backstock"].includes(stockCategory)) return;
  const platform=document.getElementById("addPlatform").value;
  const item={
    inventory_code:newInventoryCode(platform),
    ...inventoryPlacementPatch("add"),
    platform,
    category:document.getElementById("addCategory").value.trim()||"Uncategorized",
    item_name:name,
    quantity,
    condition:document.getElementById("addCondition").value,
    status:quantity===0 ? "Out of Stock" : "In Stock",
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

  inventoryAddPending=true;
  try{
    const resp=await fetch(`${SUPABASE_URL}/rest/v1/inventory_items`,{
      method:"POST",
      headers:{...inventoryEventHeaders(initials),"Prefer":"return=representation"},
      body:JSON.stringify(item)
    });

    if(!resp.ok){
      const msg=await resp.text();
      throw new Error(`Inventory insert failed: ${resp.status} ${msg}`);
    }

    const saved=await resp.json();
    if(!saved?.[0]?.id) throw new Error("The new inventory record was not returned. Refresh inventory.");
    Object.assign(item,saved[0]);

    inventoryBackendReady=true;
    const liveItem={...item,local_key:item.inventory_code||item.id};
    inventoryData.push(liveItem);
    currentInventoryItem=liveItem;
    inventoryFilter="ALL";
    inventoryStockCategory=stockCategory;
    inventoryCartFilter="ALL";
    document.getElementById("inventoryCartSelect").value="ALL";
    document.getElementById("inventoryStockCategoryFilter").value=stockCategory;
    document.getElementById("inventoryPlatformFilter").value="ALL";
    updateInventoryBrowseTitle();
    renderInventoryResults();
    openInventoryDetail(liveItem.local_key,"replace");
  }catch(err){
    console.error(err);
    alert("Unable to confirm the new shared inventory record. Refresh inventory before adding it again.");
  }finally{
    inventoryAddPending=false;
  }
}
