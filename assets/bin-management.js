// Delete a physical bin only after every stock record has a destination.
let binDeletion=null;
let binRenameRequest=null;
async function saveInventoryBinName(){
  if(binRenameRequest?.busy)return;
  const bin=currentInventoryBin;if(!bin)return;
  if(binRenameRequest&&binRenameRequest.binId!==bin.id){document.getElementById('binNameStatus').textContent='A previous bin name change is unconfirmed. Open that bin and retry before renaming another.';return;}
  const actor=binRenameRequest?.actor||inventoryInitials('binCartInitials');if(!actor)return;
  const name=document.getElementById('binDisplayName').value.trim();
  if(!name||name.length>120){document.getElementById('binNameStatus').textContent='Enter a name from 1 to 120 characters.';return;}
  const operation=binRenameRequest||{binId:bin.id,name,expectedName:bin.name??null,actor,requestId:inventoryOperationId()};
  binRenameRequest=operation;operation.busy=true;
  const controls=[document.getElementById('binDisplayName'),document.getElementById('binNameSave'),document.getElementById('binCartInitials')];controls.forEach(control=>control.disabled=true);
  try{
    const saved=await intakeRequest('rename_inventory_bin',{p_bin_id:operation.binId,p_name:operation.name,p_expected_name:operation.expectedName,p_request_id:operation.requestId,p_actor_initials:operation.actor},operation.actor);
    const index=inventoryBins.findIndex(row=>row.id===saved.id);if(index>=0)inventoryBins[index]=saved;
    binRenameRequest=null;
    if(currentInventoryBin?.id===saved.id&&document.getElementById('binDetail').classList.contains('active')){await openBinDetail(saved.id,'replace');document.getElementById('binManagementControls').open=true;document.getElementById('binNameStatus').textContent='Bin name saved.';}
    else showPortalNavNotice('Bin name saved.');
  }catch(error){if(error.status)binRenameRequest=null;document.getElementById('binNameStatus').textContent=error.message+(error.status?' Reload this bin before retrying.':' Retry confirms the same name change.');}
  finally{operation.busy=false;controls.forEach(control=>control.disabled=false);}
}
function binDeletionTree(root){
  const ids=new Set([root.id]);let changed=true;
  while(changed){changed=false;for(const bin of inventoryBins)if(bin.status!=='Archived'&&ids.has(bin.parent_bin_id)&&!ids.has(bin.id)){ids.add(bin.id);changed=true;}}
  return [...ids];
}
async function openDeleteInventoryBin(){
  const id=currentInventoryBin?.id;if(!id)return;
  showScreen('inventoryBinDelete');document.getElementById('inventoryBinDeleteWrap').textContent='Loading current contents…';
  await loadInventory();if(!document.getElementById('inventoryBinDelete').classList.contains('active'))return;
  const bin=findInventoryBin(id),wrap=document.getElementById('inventoryBinDeleteWrap');
  if(!bin||!inventoryBackendReady||!inventoryBinsReady){wrap.textContent='The bin or shared inventory is unavailable. Refresh before deleting.';return;}
  if(isLooseInventoryBin(bin)){wrap.textContent='Bin 000 is the reserved loose-stock location for this chassis.';return;}
  const ids=binDeletionTree(bin),items=inventoryData.filter(item=>ids.includes(item.inventory_bin_id));
  binDeletion={bin,ids,items,requestId:inventoryOperationId(),busy:false,choice:null};
  wrap.innerHTML=`<h2 class="sectiontitle">Delete ${escapeHtml(bin.bin_code)}</h2><p>Move <strong>${items.length} inventory record(s)</strong> before removing this bin from available choices.${ids.length>1?` This also removes its ${ids.length-1} sub-bin(s).`:''}</p>
    <p class="small">Quantities and part identities stay intact. Bin IDs and change history remain available for reference.</p>
    <label for="deleteBinDestination">Move contents to</label><select id="deleteBinDestination" onchange="renderDeleteBinDestination()"><option value="">Choose a destination…</option><option value="backstock">Backstock</option><option value="bin">Another bin</option></select>
    <div id="deleteBinTargetWrap" class="hidden"><label for="deleteBinTarget">Destination bin</label><select id="deleteBinTarget"><option value="">Choose a bin…</option>${inventoryBins.filter(target=>target.status!=='Archived'&&target.model===bin.model&&!ids.includes(target.id)).sort(compareInventoryBins).map(target=>`<option value="${escapeHtml(target.id)}">${escapeHtml(target.bin_code)} — ${escapeHtml(inventoryBinDisplayName(target))} — ${escapeHtml(binCartLocationLabel(target))}</option>`).join('')}</select></div>
    <label for="deleteBinInitials">Initials</label><input id="deleteBinInitials" class="inventory-initials" maxlength="8" autocomplete="off" autocapitalize="characters" />
    <p id="deleteBinStatus" class="small" role="status"></p><button id="deleteBinConfirm" class="danger" type="button" onclick="deleteInventoryBin()">Move Contents &amp; Delete Bin</button>`;
}
function renderDeleteBinDestination(){document.getElementById('deleteBinTargetWrap').classList.toggle('hidden',document.getElementById('deleteBinDestination').value!=='bin');}
async function deleteInventoryBin(){
  const operation=binDeletion;if(!operation||operation.busy)return;
  const actor=operation.choice?.actor||inventoryInitials('deleteBinInitials');if(!actor)return;
  const destination=document.getElementById('deleteBinDestination').value,target=destination==='bin'?document.getElementById('deleteBinTarget').value:null;
  if(!['backstock','bin'].includes(destination)||(destination==='bin'&&!target)){document.getElementById('deleteBinStatus').textContent='Choose Backstock or a destination bin.';return;}
  operation.choice=operation.choice||{actor,payload:{p_bin_id:operation.bin.id,p_destination:destination,p_target_bin_id:target,p_expected_bin_ids:operation.ids,p_expected_item_ids:operation.items.map(item=>item.id),p_request_id:operation.requestId,p_actor_initials:actor}};
  operation.busy=true;const controls=[...document.querySelectorAll('#inventoryBinDeleteWrap select,#inventoryBinDeleteWrap input,#inventoryBinDeleteWrap button')];controls.forEach(control=>control.disabled=true);
  const status=document.getElementById('deleteBinStatus');status.textContent='Moving contents and deleting bin…';
  try{
    const result=await intakeRequest('retire_inventory_bin',operation.choice.payload,actor);
    await loadInventory();
    if(document.getElementById('inventoryBinDelete').classList.contains('active'))document.getElementById('inventoryBinDeleteWrap').innerHTML=`<h2 class="sectiontitle">${escapeHtml(operation.bin.bin_code)} Deleted</h2><p>${result.item_count} record(s) moved to ${destination==='backstock'?'Backstock':escapeHtml(findInventoryBin(target)?.bin_code||'the chosen bin')}.</p><button class="primary" type="button" onclick="openBinBrowser()">Open Bins</button>`;
    else showPortalNavNotice(`${operation.bin.bin_code} deleted; contents moved.`);
    binDeletion=null;
  }catch(error){
    status.textContent=error.message+(error.status?' Reopen Delete Bin to review current contents.':' Retry checks the same operation without moving stock twice.');
    if(error.status){operation.choice=null;controls.forEach(control=>control.disabled=false);document.getElementById('deleteBinConfirm').disabled=true;}
    else document.getElementById('deleteBinConfirm').disabled=false;
  }finally{operation.busy=false;}
}
