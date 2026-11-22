// Vehicle administration uses shared rows and stable keys; removal is reversible.
let vehicleAdminCurrent=null;
let vehicleAdminPending=false;
let vehicleAdminReady=false;
async function openVehicleAdmin(){
  showScreen('adminVehicles');
  document.getElementById('vehicleAdminStatus').textContent='Loading shared vehicle registry…';
  vehicleAdminReady=await loadVehicleRegistry();
  document.getElementById('vehicleAdminNew').disabled=!vehicleAdminReady;
  renderVehicleAdminList();
}
function renderVehicleAdminList(){
  const wrap=document.getElementById('vehicleAdminList');
  if(!vehicleAdminReady){wrap.textContent='The shared registry is unavailable. Refresh before making changes.';document.getElementById('vehicleAdminStatus').textContent='Registry unavailable';return;}
  const query=document.getElementById('vehicleAdminSearch').value.trim().toLowerCase();
  const removed=document.getElementById('vehicleAdminShowRemoved').checked;
  const rows=vehicleRegistry.filter(row=>removed||row.is_active!==false).filter(row=>[row.vehicle_name,row.designation,row.platform,row.status].filter(Boolean).join(' ').toLowerCase().includes(query));
  document.getElementById('vehicleAdminStatus').textContent=`${rows.length} vehicle${rows.length===1?'':'s'} • Shared registry`;
  wrap.innerHTML=rows.length?rows.map(row=>`<button class="inventory-card" type="button" onclick="editVehicleAdmin('${escapeHtml(row.vehicle_code)}')"><strong>${escapeHtml(vehicleDisplayLabel(row))}</strong><div class="meta">${escapeHtml(row.platform)} • ${escapeHtml(row.status)}</div><div class="meta">${row.is_active===false?'Removed from active choices':'Available in vehicle choices'}</div></button>`).join(''):'<div class="card">No matching vehicles.</div>';
}
function editVehicleAdmin(code=''){
  if(vehicleAdminPending||!vehicleAdminReady)return;
  const row=code?vehicleRegistry.find(vehicle=>vehicle.vehicle_code===code):null;
  if(code&&!row)return;
  vehicleAdminCurrent=row?{...row}:{vehicle_code:'VEH-'+inventoryOperationId().toUpperCase(),revision:0,vehicle_name:'',designation:'',platform:'E92',status:'Active',display_order:0,is_active:true};
  document.getElementById('vehicleAdminEditTitle').textContent=row?'Edit Vehicle':'Add Vehicle';
  document.getElementById('vehicleAdminName').value=vehicleAdminCurrent.vehicle_name;
  document.getElementById('vehicleAdminDesignation').value=vehicleAdminCurrent.designation||'';
  const platforms=[...new Set([...internalVehicleCategories,...vehicleRegistry.map(v=>v.platform)])];
  document.getElementById('vehicleAdminPlatform').innerHTML=platforms.map(platform=>`<option value="${escapeHtml(platform)}">${escapeHtml(platform==='M235 / M235iR'?'F22 / M235 / M235iR':platform)}</option>`).join('');
  document.getElementById('vehicleAdminPlatform').value=vehicleAdminCurrent.platform;
  document.getElementById('vehicleAdminVehicleStatus').value=vehicleAdminCurrent.status;
  document.getElementById('vehicleAdminOrder').value=vehicleAdminCurrent.display_order||0;
  document.getElementById('vehicleAdminInitials').value='';
  const toggle=document.getElementById('vehicleAdminToggle');
  toggle.classList.toggle('hidden',!row);
  toggle.textContent=vehicleAdminCurrent.is_active===false?'Save & Restore to Choices':'Save & Remove from Choices';
  document.getElementById('vehicleAdminEditStatus').textContent=row?.is_active===false?'This vehicle is removed from active choices.':'';
  showScreen('adminVehicleEdit');
}
function toggleVehicleAdmin(){if(vehicleAdminCurrent)return saveVehicleAdmin(vehicleAdminCurrent.is_active===false);}
async function saveVehicleAdmin(activeOverride=null){
  if(vehicleAdminPending||!vehicleAdminCurrent||!document.getElementById('adminVehicleEdit').classList.contains('active'))return;
  const actor=inventoryInitials('vehicleAdminInitials');if(!actor)return;
  const current={...vehicleAdminCurrent};
  const changes={vehicle_name:document.getElementById('vehicleAdminName').value.trim(),designation:document.getElementById('vehicleAdminDesignation').value.trim().replace(/^#\s*/,''),platform:document.getElementById('vehicleAdminPlatform').value,status:document.getElementById('vehicleAdminVehicleStatus').value.trim(),display_order:Number(document.getElementById('vehicleAdminOrder').value),is_active:activeOverride===null?current.is_active!==false:activeOverride};
  const status=document.getElementById('vehicleAdminEditStatus');
  if(!changes.vehicle_name||!changes.platform||!changes.status||!Number.isInteger(changes.display_order)||changes.display_order<0||changes.display_order>10000){status.textContent='Enter a name, chassis, status and whole display order from 0 to 10000.';return;}
  const controls=[...document.querySelectorAll('#adminVehicleEdit input,#adminVehicleEdit select,#adminVehicleEdit .actions button')];
  vehicleAdminPending=true;controls.forEach(control=>control.disabled=true);status.textContent='Saving vehicle…';
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/save_vehicle_registry`,{method:'POST',headers:inventoryEventHeaders(actor),body:JSON.stringify({p_vehicle_code:current.vehicle_code,p_revision:current.revision||0,p_changes:changes,p_actor_initials:actor})});
    const result=await response.json();if(!response.ok)throw new Error(result.code==='23505'?'A vehicle with this name already exists in this chassis.':result.message||'Vehicle update was rejected.');
    if(result.vehicle_code!==current.vehicle_code)throw new Error('The saved vehicle could not be confirmed.');
    if(Object.entries(changes).some(([key,value])=>key==='designation'?(result[key]||'')!==value:result[key]!==value)){vehicleAdminCurrent=result;throw new Error('The vehicle already exists with different details. These edits have not been saved; review them and save again.');}
    const index=vehicleRegistry.findIndex(vehicle=>vehicle.vehicle_code===result.vehicle_code);
    if(index>=0)vehicleRegistry[index]=result;else vehicleRegistry.push(result);
    refreshOperationalVehicleOptions();
    vehicleAdminCurrent=result;
    if(result.is_active===false)document.getElementById('vehicleAdminShowRemoved').checked=true;
    renderVehicleAdminList();
    if(document.getElementById('adminVehicleEdit').classList.contains('active')){
      document.getElementById('vehicleAdminInitials').value='';
      const toggle=document.getElementById('vehicleAdminToggle');toggle.classList.remove('hidden');toggle.textContent=result.is_active===false?'Save & Restore to Choices':'Save & Remove from Choices';
      document.getElementById('vehicleAdminEditTitle').textContent='Edit Vehicle';
      status.textContent=result.is_active===false?'Saved. Removed from active choices; history is retained.':'Saved to the shared vehicle registry.';
    }else showPortalNavNotice('Vehicle registry updated.');
  }catch(error){status.textContent=error.message+' Reload the registry before retrying if the response was lost.';}
  finally{vehicleAdminPending=false;controls.forEach(control=>control.disabled=false);}
}
