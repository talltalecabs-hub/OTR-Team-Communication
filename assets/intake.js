// Incoming stock requires an explicit choice when an existing part may match.
let inventoryIntakeReview=null;
const inventoryNameRequests=new Map();
function prepareInventoryNameEditor(item){
  const request=inventoryNameRequests.get(item.id);if(!request)return;
  document.getElementById('inventoryDetailName').value=request.name;
  document.getElementById('inventoryDetailInitials').value=request.actor;
  document.getElementById('inventoryDetailName').disabled=true;
  document.getElementById('inventoryDetailInitials').disabled=true;
  document.getElementById('inventoryNameStatus').textContent='Previous name change is unconfirmed. Save Part Name retries that same change.';
}
async function saveInventoryPartName(){
  if(inventoryPatchPending||!document.getElementById('inventoryDetail').classList.contains('active'))return;
  const item=inventoryDetailDisplayedItem();if(!item)return;
  const previous=inventoryNameRequests.get(item.id),actor=previous?.actor||inventoryInitials('inventoryDetailInitials');if(!actor)return;
  const name=document.getElementById('inventoryDetailName').value.trim(),status=document.getElementById('inventoryNameStatus');
  if(!name||name.length>200){status.textContent='Enter a part name from 1 to 200 characters.';return;}
  const operation=previous||{name,actor,expectedName:item.item_name,requestId:inventoryOperationId()};
  const renderId=inventoryDetailRenderId;inventoryNameRequests.set(item.id,operation);inventoryPatchPending=true;
  const controls=['inventoryDetailName','inventoryDetailInitials','inventoryNameSave'].map(id=>document.getElementById(id));controls.forEach(control=>control.disabled=true);
  try{
    const saved=await intakeRequest('rename_inventory_part',{p_item_id:item.id,p_name:operation.name,p_expected_name:operation.expectedName,p_request_id:operation.requestId,p_actor_initials:operation.actor},operation.actor);
    applyInventoryCachedPatch(item,{item_name:saved.item_name,updated_at:saved.updated_at});inventoryNameRequests.delete(item.id);renderInventoryResults();
    if(renderId===inventoryDetailRenderId){document.querySelector('#inventoryDetailWrap h2').textContent=saved.item_name;document.getElementById('inventoryDetailName').value=saved.item_name;document.getElementById('inventoryDetailInitials').value='';status.textContent='Part name saved.';}
  }catch(error){
    if(error.status)inventoryNameRequests.delete(item.id);
    status.textContent=error.message+(error.status?' Reload the part before retrying.':' Save Part Name retries the same change.');
  }finally{
    inventoryPatchPending=false;
    controls.forEach(control=>control.disabled=false);
    if(inventoryNameRequests.has(item.id)){controls[0].disabled=true;controls[1].disabled=true;}
  }
}
function inventoryMatchText(value){return String(value||'').trim().replace(/\s+/g,' ').toLowerCase();}
function inventoryAdditionMatches(candidate){
  const chassis=inventoryCompatibleChassis(candidate);
  return inventoryData.filter(item=>item.status!=='Merged'&&inventoryCompatibleChassis(item).some(code=>chassis.includes(code))&&(
    inventoryMatchText(item.item_name)===inventoryMatchText(candidate.item_name)||
    (inventoryMatchText(candidate.part_number)&&inventoryMatchText(candidate.part_number)===inventoryMatchText(item.part_number))
  )).sort((a,b)=>Number(b.inventory_bin_id===candidate.inventory_bin_id)-Number(a.inventory_bin_id===candidate.inventory_bin_id)||a.inventory_code.localeCompare(b.inventory_code));
}
async function reviewInventoryAddition(candidate,actor,commit){
  if(inventoryIntakeReview?.uncertain){showScreen('inventoryIntakeReview');return true;}
  const origin=document.querySelector('.screen.active')?.id;
  await loadInventory();
  if(document.querySelector('.screen.active')?.id!==origin){showPortalNavNotice('The addition was paused before saving. Return to the part to continue.');return true;}
  if(!inventoryBackendReady){showPortalNavNotice('Shared inventory is unavailable. Refresh before adding stock.');return true;}
  const matches=inventoryAdditionMatches(candidate);if(!matches.length)return false;
  inventoryIntakeReview={candidate:{...candidate},actor,commit,matches,requestId:inventoryOperationId(),busy:false,uncertain:false,choice:null};
  const wrap=document.getElementById('inventoryIntakeReviewWrap');
  wrap.innerHTML=`<h2 class="sectiontitle">Possible Existing Part</h2><p><strong>${escapeHtml(candidate.item_name)}</strong> • Incoming quantity: ${escapeHtml(inventoryQuantityLabel(candidate))}</p>
    <p>Choose the existing record carefully. New and used parts can share a name.</p>
    <label for="intakeExistingItem">Existing record</label><select id="intakeExistingItem" onchange="renderInventoryIntakeChoice()"><option value="">Choose a record…</option>${matches.map(item=>`<option value="${escapeHtml(item.id)}">${escapeHtml(item.item_name)} — ${escapeHtml(item.condition||'Unspecified')} — ${escapeHtml(inventoryQuantityLabel(item))} — ${escapeHtml(inventoryItemBinDisplayLabel(item))} — ${escapeHtml(item.inventory_code)}</option>`).join('')}</select>
    <label for="intakeMode">How should this be recorded?</label><select id="intakeMode" onchange="renderInventoryIntakeChoice()"><option value="">Choose an action…</option><option value="add">Add incoming quantity to an existing count</option><option value="replace">Replace an existing count with the entered total</option><option value="separate">Create a separate inventory record</option></select>
    <div id="intakeChoicePreview" class="card" role="status"></div>
    <label for="intakeInitials">Initials</label><input id="intakeInitials" class="inventory-initials" maxlength="8" autocomplete="off" autocapitalize="characters" />
    <p id="intakeSaveStatus" class="small" role="status"></p><div class="actions"><button id="intakeConfirm" class="primary" type="button" onclick="confirmInventoryAddition()" disabled>Confirm Inventory Change</button><button id="intakeRefresh" class="secondary" type="button" onclick="refreshInventoryIntakeReview()">Refresh Matches</button></div>`;
  document.getElementById('intakeInitials').value=actor;
  renderInventoryIntakeChoice();showScreen('inventoryIntakeReview');return true;
}
function renderInventoryIntakeChoice(){
  const review=inventoryIntakeReview;if(!review)return;
  const mode=document.getElementById('intakeMode').value;
  const item=review.matches.find(row=>row.id===document.getElementById('intakeExistingItem').value);
  const quantity=review.candidate.quantity;
  let valid=false,message='Choose Add, Replace, or Separate before saving.';
  if(mode==='separate'){valid=true;message='Create one new record. Existing counts stay unchanged.';}
  else if(item&&mode){
    const sameUnit=(item.quantity_unit||'pcs')===(review.candidate.quantity_unit||'pcs');
    valid=Number.isInteger(quantity)&&quantity>=0&&sameUnit&&(mode==='replace'||item.quantity!==null);
    message=!sameUnit?'The units differ. Use a separate record.':!Number.isInteger(quantity)?'The incoming quantity is uncounted. Keep a separate record, or enter a physically confirmed count.':mode==='add'?(item.quantity===null?'The existing count is unknown. Replace it with a physically confirmed total, or keep a separate record.':`Add: ${item.quantity} + ${quantity} = ${item.quantity+quantity} ${item.quantity_unit||'pcs'}.`):`Replace the existing total: ${item.quantity??'Uncounted'} → ${quantity} ${item.quantity_unit||'pcs'}. The entered quantity must be the complete observed total.`;
    message+=' Existing name, condition, photos, chassis, cart and bin stay with that record.';
  }
  document.getElementById('intakeChoicePreview').textContent=message;
  document.getElementById('intakeConfirm').disabled=!valid;
}
async function refreshInventoryIntakeReview(){
  const review=inventoryIntakeReview;if(!review||review.busy||review.uncertain)return;
  inventoryIntakeReview=null;
  if(!await reviewInventoryAddition(review.candidate,review.actor,review.commit)){
    inventoryIntakeReview=review;document.getElementById('intakeSaveStatus').textContent='No current matches. Choose Separate to create a new record.';
    document.getElementById('intakeMode').value='separate';renderInventoryIntakeChoice();
  }
}
async function confirmInventoryAddition(){
  const review=inventoryIntakeReview;if(!review||review.busy||!document.getElementById('inventoryIntakeReview').classList.contains('active'))return;
  const actor=review.uncertain?review.actor:inventoryInitials('intakeInitials');if(!actor)return;
  const item=review.matches.find(row=>row.id===document.getElementById('intakeExistingItem').value);
  const choice=review.choice||{mode:document.getElementById('intakeMode').value,existing_id:item?.id||null,expected_quantity:item?.quantity??null,request_id:review.requestId};
  if(choice.mode!=='separate'&&!item)return;
  review.actor=actor;review.choice=choice;review.busy=true;
  const controls=[...document.querySelectorAll('#inventoryIntakeReviewWrap select,#inventoryIntakeReviewWrap input,#inventoryIntakeReviewWrap button')];controls.forEach(control=>control.disabled=true);
  document.getElementById('intakeSaveStatus').textContent='Saving inventory…';
  try{await review.commit(choice,actor);inventoryIntakeReview=null;}
  catch(error){
    review.uncertain=!error.status; // Lost responses retry exactly the same operation.
    if(!review.uncertain){review.choice=null;review.requestId=inventoryOperationId();}
    document.getElementById('intakeSaveStatus').textContent=error.message+(review.uncertain?' Retry confirms the same request without adding twice.':' Refresh matches before retrying.');
    controls.forEach(control=>control.disabled=review.uncertain);
    document.getElementById('intakeConfirm').disabled=false;
  }finally{review.busy=false;}
}
async function intakeRequest(name,data,actor){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers:inventoryEventHeaders(actor),body:JSON.stringify(data)});
  const result=await response.json();if(!response.ok){const error=new Error(result.message||'Inventory change was rejected.');error.status=response.status;error.code=result.code;throw error;}return result;
}

async function loadInventoryTagAliases(){
  try{
    const response=await fetch(`${SUPABASE_URL}/rest/v1/inventory_workspace_drafts?select=tag_id,inventory_item_id&inventory_item_id=not.is.null`,{headers:{apikey:SUPABASE_KEY},cache:'no-store'});
    if(!response.ok)return;
    const rows=await response.json();if(!Array.isArray(rows))return;
    const aliases=new Map();for(const row of rows)if(row.inventory_item_id){if(!aliases.has(row.inventory_item_id))aliases.set(row.inventory_item_id,[]);aliases.get(row.inventory_item_id).push(row.tag_id);}
    inventoryTagAliases=aliases;
  }catch(error){/* Existing inventory remains usable if alias lookup is unavailable. */}
}
