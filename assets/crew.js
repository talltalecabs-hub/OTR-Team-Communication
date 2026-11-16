// Crew consumption and shared accountability helpers. The database commits stock
// changes and ledger events together; the browser never inserts ledger rows.
let inventoryUseItem=null;
let inventoryUseRequest=null;
let inventoryUsePending=false;
let inventoryUseOperationId=null;

function inventoryInitials(fieldId){
  const input=document.getElementById(fieldId);
  const initials=String(input?.value||"").trim().toUpperCase();
  if(!input || !input.getClientRects().length || !initials || initials.length>8 || /[\x00-\x1f\x7f]/.test(initials)){
    alert("Enter your initials in the visible Initials box (1–8 characters).");
    input?.focus();
    return "";
  }
  input.value=initials;
  return initials;
}

function inventoryEventHeaders(initials){
  const actor=String(initials||"").trim().toUpperCase();
  if(!actor || actor.length>8 || /[\x00-\x1f\x7f]/.test(actor)) throw new Error("Initials are required.");
  return {"apikey":SUPABASE_KEY,"Content-Type":"application/json","x-otr-initials":actor};
}

function inventoryOperationId(){
  if(typeof crypto.randomUUID==="function") return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;
  bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(value=>value.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function crewVehicleLabel(vehicle){
  const designation=String(vehicle.designation||"").trim();
  const number=/^\d+$/.test(designation)?`#${designation} `:"";
  return `${number}${vehicle.vehicle_name}${designation && !number?` — ${designation}`:""} • ${vehicle.platform}`;
}

function compatibleUseVehicle(vehicle,item){
  const aliases={F22:"M235 / M235iR","M235 / M235iR":"M235 / M235iR"};
  const platforms=[item.platform,...(Array.isArray(item.compatibility)?item.compatibility:[])].map(platform=>aliases[platform]||platform);
  return platforms.includes(vehicle.platform)||vehicle.vehicle_code===item.assigned_vehicle_code;
}

function renderUsePartVehicleOptions(){
  if(!inventoryUseItem) return;
  const select=document.getElementById("usePartVehicle");
  const previous=select.value;
  const showAll=document.getElementById("showAllUseVehicles").checked;
  const rows=vehicleRegistry.filter(vehicle=>showAll||compatibleUseVehicle(vehicle,inventoryUseItem));
  select.innerHTML='<option value="">Choose car # / exact vehicle…</option>'+rows.map(vehicle=>`<option value="${escapeHtml(vehicle.vehicle_code)}">${escapeHtml(crewVehicleLabel(vehicle))}</option>`).join("");
  select.value=rows.some(vehicle=>vehicle.vehicle_code===previous)?previous:"";
  document.getElementById("useVehicleHint").textContent=showAll?"All vehicles in the shared registry.":rows.length?"Vehicles matching this part's platform and compatibility.":"No matching vehicles. Select Show all vehicles to choose from the shared registry.";
}

function setUsePartPending(pending,keepInputsLocked=false){
  for(const id of ["usePartVehicle","usePartQty","usePartInitials","showAllUseVehicles"]){
    document.getElementById(id).disabled=pending||keepInputsLocked;
  }
  document.getElementById("usePartFinish").disabled=pending;
  document.getElementById("usePartBack").disabled=pending;
  document.getElementById("usePartFinish").textContent=pending?"Saving…":keepInputsLocked?"Retry Finish":"Finish";
}

async function openUsePart(key=""){
  if(inventoryUsePending) return;
  const selected=key?findInventoryItem(key):currentInventoryItem;
  if(!selected) return;
  const localKey=selected.local_key;
  await loadInventory();
  const item=findInventoryItem(localKey);
  if(!inventoryBackendReady || !item){alert("Shared inventory is unavailable. Please retry.");return;}
  if(item.quantity===0){alert("This item has no counted stock remaining.");return;}
  if(!vehicleRegistryReady) await loadVehicleRegistry();
  if(!vehicleRegistryReady){alert("The shared vehicle registry is unavailable. Please retry before using stock.");return;}
  inventoryUseItem=item;
  currentInventoryItem=item;
  inventoryUseRequest=null;
  inventoryUseOperationId=inventoryOperationId();
  document.getElementById("usePartSummary").innerHTML=`<h2 class="sectiontitle">${escapeHtml(item.item_name)}</h2><p><strong>Qty ${escapeHtml(inventoryQuantityLabel(item))}</strong></p><p class="inventory-physical-path">${inventoryLocationBinHtml(item)}</p>`;
  const quantity=document.getElementById("usePartQty");
  quantity.value=1;
  if(item.quantity===null) quantity.removeAttribute("max");else quantity.max=item.quantity;
  document.getElementById("usePartInitials").value="";
  document.getElementById("showAllUseVehicles").checked=false;
  document.getElementById("usePartVehicle").value="";
  document.getElementById("usePartStatus").textContent="";
  setUsePartPending(false);
  renderUsePartVehicleOptions();
  showScreen("inventoryUsePart");
  document.getElementById("usePartVehicle").focus();
}

async function cancelUsePart(){
  if(inventoryUsePending) return;
  const key=inventoryUseItem?.local_key;
  await loadInventory();
  if(key && findInventoryItem(key)) openInventoryDetail(key,"none");
  portalBack("inventoryDetail");
}

async function finishUsePart(){
  if(inventoryUsePending || !inventoryUseItem || !document.getElementById("inventoryUsePart").classList.contains("active")) return;
  const status=document.getElementById("usePartStatus");
  if(!inventoryUseRequest){
    const initials=inventoryInitials("usePartInitials");
    if(!initials) return;
    const vehicle=vehicleRegistry.find(row=>row.vehicle_code===document.getElementById("usePartVehicle").value);
    if(!vehicle){status.textContent="Select a car # / exact vehicle.";document.getElementById("usePartVehicle").focus();return;}
    const rawQuantity=document.getElementById("usePartQty").value.trim();
    const quantity=Number(rawQuantity);
    if(!rawQuantity || !Number.isInteger(quantity) || quantity<1 || (inventoryUseItem.quantity!==null && quantity>inventoryUseItem.quantity)){
      status.textContent="Enter a whole quantity of at least 1, within the counted stock available.";
      document.getElementById("usePartQty").focus();
      return;
    }
    inventoryUseRequest={p_item_id:inventoryUseItem.id,p_vehicle_code:vehicle.vehicle_code,p_quantity:quantity,p_actor_initials:initials,p_request_id:inventoryUseOperationId};
  }
  const request={...inventoryUseRequest};
  const usedItem={...inventoryUseItem};
  inventoryUsePending=true;
  setUsePartPending(true);
  status.textContent="Recording part use…";
  let confirmed=false;
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/use_inventory_part`,{method:"POST",headers:inventoryEventHeaders(request.p_actor_initials),body:JSON.stringify(request)});
    const result=await response.json();
    if(!response.ok){
      const knownRejection=response.status>=400&&response.status<500;
      if(knownRejection){inventoryUseRequest=null;inventoryUseOperationId=inventoryOperationId();}
      const error=new Error(result.code==="PGRST202"?"The new inventory workflow is not available yet. Please ask the team to finish the portal update.":result.message||"Part use was rejected. No stock change was committed.");
      error.knownRejection=knownRejection;
      throw error;
    }
    if(!result?.event_id || result.item_id!==request.p_item_id) throw new Error("The use result could not be confirmed.");
    confirmed=true;
    const vehicle=vehicleRegistry.find(row=>row.vehicle_code===request.p_vehicle_code);
    const label=vehicle?crewVehicleLabel(vehicle):request.p_vehicle_code;
    const message=result.quantity_after===null
      ? `Recorded ${request.p_quantity} × ${usedItem.item_name} used on ${label}. Remaining inventory is still uncounted.`
      : `Used ${request.p_quantity} × ${usedItem.item_name} on ${label}. Remaining: ${result.quantity_after}.`;
    document.getElementById("usePartConfirmation").textContent=message;
    inventoryUseRequest=null;
    await loadInventory();
    const stillUsing=document.getElementById("inventoryUsePart").classList.contains("active");
    if(stillUsing || currentInventoryItem?.id===usedItem.id){
      currentInventoryItem=findInventoryItem(usedItem.local_key)||{...usedItem,quantity:result.quantity_after,status:result.quantity_after===0?"Out of Stock":usedItem.status};
    }
    if(stillUsing) showScreen("inventoryUseSuccess",{historyMode:"replace"});
    else showPortalNavNotice("Part use recorded.");
  }catch(error){
    console.error("Part use could not be confirmed",error);
    status.textContent=error.knownRejection?error.message:"Unable to confirm the response. Retry Finish checks this same request without using the part twice.";
  }finally{
    inventoryUsePending=false;
    setUsePartPending(false,!confirmed&&Boolean(inventoryUseRequest));
  }
}

function useAnotherPart(){
  return browseInventory(inventoryFilter,"Mobile");
}

async function openInventoryEventHistory(){
  showScreen("inventoryEventHistory");
  const wrap=document.getElementById("inventoryEventList");
  wrap.textContent="Loading inventory activity…";
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/inventory_events?select=*&order=created_at.desc&limit=100`,{headers:{apikey:SUPABASE_KEY}});
    if(!response.ok) throw new Error("Inventory activity is not available yet.");
    const events=await response.json();
    wrap.innerHTML=events.length?events.map(event=>{
      const vehicle=vehicleRegistry.find(row=>row.vehicle_code===event.vehicle_code);
      const context=[event.inventory_code,event.bin_code,event.cart_code,vehicle?crewVehicleLabel(vehicle):event.vehicle_code].filter(Boolean).join(" • ");
      const before=event.quantity_before===null?"Uncounted":event.quantity_before;
      const after=event.quantity_after===null?"Uncounted":event.quantity_after;
      return `<div class="card"><strong>${escapeHtml(event.event_type.replaceAll("_"," "))}</strong><p>${escapeHtml(context)}</p><p class="small">${escapeHtml(event.actor_initials)} • ${escapeHtml(new Date(event.created_at).toLocaleString())}</p>${event.inventory_item_id?`<p>Quantity: ${escapeHtml(before)} → ${escapeHtml(after)}${event.quantity_delta!==null?` • Change ${Number(event.quantity_delta)>0?"+":""}${Number(event.quantity_delta)}`:""}</p>`:""}</div>`;
    }).join(""):'<div class="card">No inventory activity recorded yet.</div>';
  }catch(error){wrap.textContent=error.message;}
}
