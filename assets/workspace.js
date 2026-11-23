// Shared inventory creation board. Drafts, photos and positions are server-owned.
// Only transient view state, pending requests and signed URLs live in memory.
const workspace={rows:new Map(),pending:new Map(),saving:new Map(),timers:new Map(),errors:new Map(),photos:new Map(),photoRequests:new Map(),selected:null,ready:false,zoom:1,drag:null,poll:null,setup:false,createRequest:null,creating:false,uploading:0};
function workspaceActive(){return document.getElementById('inventoryWorkspace')?.classList.contains('active');}
function workspaceActor(required=true){
  const input=document.getElementById('workspaceInitials');
  const value=String(input?.value||'').trim().toUpperCase();
  if(!input?.getClientRects().length || !value || value.length>8 || /[\x00-\x1f\x7f]/.test(value))return required?inventoryInitials('workspaceInitials'):'';
  input.value=value;return value;
}
function workspaceActorChanged(){workspaceStatus();}
function workspaceStatus(message=''){
  const status=document.getElementById('workspaceStatus');if(!status)return;
  if(message){status.textContent=message;return;}
  const pending=workspace.pending.size+workspace.saving.size;
  status.textContent=!workspace.ready?'Shared workspace unavailable. Refresh to retry.':workspace.errors.size?'A card needs attention. Select it to review the save error.':workspace.uploadError?workspace.uploadError:workspace.createRequest&&!workspace.creating?'New card not confirmed. Choose New Card to retry the same request.':workspace.uploading?`Uploading ${workspace.uploading} photo(s)…`:pending?'Saving shared work…':`${[...workspace.rows.values()].filter(row=>row.state==='draft').length} shared draft(s) • ${workspaceActor(false)?'All changes saved':'Enter initials to create or change cards'}`;
}
async function workspaceRequest(name,data,actor){
  const response=await portalFetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers:inventoryEventHeaders(actor),body:JSON.stringify(data)});
  const result=await response.json();
  if(!response.ok){const error=new Error(result.message||'Unable to save shared work.');error.code=result.code;error.status=response.status;throw error;}
  return result;
}
function workspaceView(id){
  const row=workspace.rows.get(id);if(!row)return null;
  const patch=workspace.pending.get(id)?.changes||{};
  const data={...row.data,...patch.data};
  const live=row.inventory_item_id&&inventoryData.find(item=>item.id===row.inventory_item_id);
  if(live)for(const field of ['item_name','quantity','quantity_unit','platform','compatibility','stock_category','cart_code','inventory_bin_id','condition','category','part_number','notes'])data[field]=live[field];
  return {...row,...patch,data};
}
function workspaceMergeChanges(before={},after={}){
  const merged={...before,...after};
  if(before.data||after.data)merged.data={...before.data,...after.data};
  return merged;
}
function workspaceQueue(id,changes,actor=''){
  if(workspace.committing===id)return false;
  actor=actor||workspaceActor();if(!actor)return false;
  const previous=workspace.pending.get(id);
  workspace.pending.set(id,{changes:workspaceMergeChanges(previous?.changes,changes),actor});
  clearTimeout(workspace.timers.get(id));
  if(!workspace.errors.has(id))workspace.timers.set(id,setTimeout(()=>workspaceFlush(id),550));
  workspaceRenderBoard();workspaceStatus();return true;
}
async function workspaceFlush(id){
  clearTimeout(workspace.timers.get(id));
  if(workspace.saving.has(id)){await workspace.saving.get(id);if(workspace.pending.has(id)&&!workspace.errors.has(id))return workspaceFlush(id);return !workspace.errors.has(id);}
  const pending=workspace.pending.get(id);if(!pending)return !workspace.errors.has(id);
  if(workspace.errors.has(id))return false;
  const row=workspace.rows.get(id);if(!row)return false;
  workspace.pending.delete(id);
  const task=(async()=>{
    try{
      const saved=await workspaceRequest('save_inventory_workspace_draft',{p_id:id,p_revision:row.revision,p_changes:pending.changes,p_actor_initials:pending.actor},pending.actor);
      workspace.rows.set(id,saved);
      return true;
    }catch(error){
      if(!portalHasRole('staff')){workspace.pending.delete(id);workspace.errors.delete(id);return false;}
      // Keep unsaved edits in this tab, without persisting a device copy or
      // overwriting a newer shared revision. The operator can reload/review.
      const newer=workspace.pending.get(id);
      workspace.pending.set(id,{changes:workspaceMergeChanges(pending.changes,newer?.changes),actor:newer?.actor||pending.actor});
      workspace.errors.set(id,error.message);
      if(workspace.selected===id)workspaceRenderSaveError();
      workspaceStatus(error.code==='40001'?'This card changed on another device. Reload it before continuing.':'Save not confirmed. Your unsaved edits remain visible in this tab.');
      return false;
    }finally{
      workspace.saving.delete(id);workspaceRenderBoard();workspaceStatus();
    }
  })();
  workspace.saving.set(id,task);workspaceStatus();
  const success=await task;
  if(success&&workspace.pending.has(id))return workspaceFlush(id);
  return success;
}
async function workspaceReload(){
  if(workspace.drag)return;
  try{
    const response=await portalFetch(`${SUPABASE_URL}/rest/v1/inventory_workspace_drafts?select=*${workspace.showArchived?'':'&state=neq.archived'}&order=created_at.asc`,{headers:{apikey:SUPABASE_KEY},cache:'no-store'});
    if(!response.ok)throw new Error('Shared creation space is unavailable. The workspace update may not be installed yet.');
    const rows=await response.json();if(!Array.isArray(rows))throw new Error('Invalid shared draft response.');
    for(const row of rows){
      if(workspace.pending.has(row.id)||workspace.saving.has(row.id)||workspace.committing===row.id)continue;
      const previous=workspace.rows.get(row.id);
      workspace.rows.set(row.id,row);
      if(workspace.selected===row.id&&workspace.inspectorRevision!==row.revision&&(previous?.state!==row.state||!document.getElementById('workspaceInspector')?.contains(document.activeElement)))workspaceRenderInspector();
    }
    const ids=new Set(rows.map(row=>row.id));
    for(const id of workspace.rows.keys())if(!ids.has(id)&&!workspace.pending.has(id)&&!workspace.saving.has(id))workspace.rows.delete(id);
    if(workspace.selected&&!workspace.rows.has(workspace.selected)){
      workspace.selected=null;
      document.getElementById('workspaceInspector').innerHTML='<h3>Select a card</h3><p>This card was archived elsewhere. Show archived cards to find it.</p>';
    }
    workspace.ready=true;workspaceRenderBoard();workspaceStatus();
  }catch(error){workspace.ready=false;workspaceStatus(error.message);}
}
async function openInventoryWorkspace(options={}){
  showScreen('inventoryWorkspace');workspaceSetup();
  document.getElementById('workspaceInitials').value='';
  await Promise.all([workspaceReload(),loadInventory()]);
  if(workspace.selected&&workspaceActive())workspaceRenderInspector();
  if(!workspace.viewPositioned&&workspace.rows.size){workspaceFindCards();workspace.viewPositioned=true;}
  if(!workspace.poll)workspace.poll=setInterval(()=>{if(workspaceActive()&&!document.hidden)workspaceReload();},5000);
  if(options.newCard)workspaceStatus('Enter initials, then choose New Card or Add Photos. You can fill in everything else later.');
  document.getElementById('workspaceInitials').focus();
}
function workspaceSetup(){
  if(workspace.setup)return;workspace.setup=true;
  const viewport=document.getElementById('workspaceViewport');
  viewport.scrollLeft=1080;viewport.scrollTop=1080;
  viewport.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    const card=event.target.closest('[data-workspace-card]');
    if(card){
      const id=card.dataset.workspaceCard;
      workspaceSelect(id);
      if(!event.target.closest('.workspace-card-handle'))return;
      const row=workspaceView(id);
      workspace.drag={kind:'card',id,pointer:event.pointerId,startX:event.clientX,startY:event.clientY,x:row.x,y:row.y,nextX:row.x,nextY:row.y};
    }else{
      workspace.drag={kind:'pan',pointer:event.pointerId,startX:event.clientX,startY:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};
    }
    viewport.setPointerCapture(event.pointerId);event.preventDefault();
  });
  viewport.addEventListener('pointermove',event=>{
    const drag=workspace.drag;if(!drag||drag.pointer!==event.pointerId)return;
    const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
    if(drag.kind==='pan'){viewport.scrollLeft=drag.left-dx;viewport.scrollTop=drag.top-dy;return;}
    drag.nextX=Math.round(Math.max(0,Math.min(11700,drag.x+dx/workspace.zoom)));
    drag.nextY=Math.round(Math.max(0,Math.min(11700,drag.y+dy/workspace.zoom)));
    const card=document.querySelector(`[data-workspace-card="${drag.id}"]`);
    if(card){card.style.left=`${drag.nextX*workspace.zoom}px`;card.style.top=`${drag.nextY*workspace.zoom}px`;}
  });
  const finish=event=>{
    const drag=workspace.drag;if(!drag||drag.pointer!==event.pointerId)return;
    workspace.drag=null;
    if(viewport.hasPointerCapture(event.pointerId))viewport.releasePointerCapture(event.pointerId);
    if(event.type!=='pointercancel'&&drag.kind==='card'&&(drag.nextX!==drag.x||drag.nextY!==drag.y))workspaceQueue(drag.id,{x:drag.nextX,y:drag.nextY});
    workspaceRenderBoard();
  };
  viewport.addEventListener('pointerup',finish);viewport.addEventListener('pointercancel',finish);
  viewport.addEventListener('keydown',event=>{
    const header=event.target.closest('.workspace-card-handle');if(!header)return;
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;
    event.preventDefault();const row=workspaceView(header.dataset.cardId);if(!row)return;
    const step=event.shiftKey?100:20;
    workspaceQueue(row.id,{x:Math.max(0,Math.min(11700,row.x+delta[0]*step)),y:Math.max(0,Math.min(11700,row.y+delta[1]*step))});
    document.querySelector(`.workspace-card-handle[data-card-id="${row.id}"]`)?.focus();
  });
}
function workspaceZoom(delta){
  const viewport=document.getElementById('workspaceViewport');
  const before=workspace.zoom;workspace.zoom=Math.round(Math.max(.5,Math.min(1.6,before+delta))*10)/10;
  const centerX=(viewport.scrollLeft+viewport.clientWidth/2)/before,centerY=(viewport.scrollTop+viewport.clientHeight/2)/before;
  workspaceRenderBoard();viewport.scrollLeft=centerX*workspace.zoom-viewport.clientWidth/2;viewport.scrollTop=centerY*workspace.zoom-viewport.clientHeight/2;
  document.getElementById('workspaceZoomValue').textContent=`${Math.round(workspace.zoom*100)}%`;
}
function workspaceFindCards(){
  const row=workspaceView(workspace.selected)||[...workspace.rows.values()].find(card=>card.state==='draft')||[...workspace.rows.values()].find(card=>card.state!=='archived');
  if(!row)return;
  const viewport=document.getElementById('workspaceViewport');
  viewport.scrollLeft=Math.max(0,(row.x+120)*workspace.zoom-viewport.clientWidth/2);
  viewport.scrollTop=Math.max(0,row.y*workspace.zoom-20);
}
function workspaceSelect(id){workspace.selected=id;workspaceRenderBoard();workspaceRenderInspector();}
function workspaceRenderBoard(){
  if(workspace.drag)return;
  const canvas=document.getElementById('workspaceCanvas');if(!canvas)return;
  canvas.style.width=`${12000*workspace.zoom}px`;canvas.style.height=`${12000*workspace.zoom}px`;
  const visible=new Set();
  for(const row of [...workspace.rows.keys()].map(id=>workspaceView(id)).filter(row=>row.state!=='archived'||workspace.showArchived)){
    visible.add(row.id);
    const photo=row.data.photo_paths?.[0];const url=photo&&workspace.photos.get(photo)?.url;
    if(photo)workspaceEnsurePhoto(photo);
    const quantity=row.data.quantity===null||row.data.quantity===undefined?'Uncounted':`${row.data.quantity} ${row.data.quantity_unit||'pcs'}`;
    const markup=`<article data-workspace-card="${row.id}" class="workspace-card ${workspace.selected===row.id?'selected':''} ${row.state==='committed'?'committed':''} ${row.state==='archived'?'archived':''}" style="left:${row.x*workspace.zoom}px;top:${row.y*workspace.zoom}px;transform:scale(${workspace.zoom})">
      <button class="workspace-card-handle" type="button" data-card-id="${row.id}" aria-pressed="${workspace.selected===row.id}" onclick="workspaceSelect('${row.id}')"><span>${row.state==='archived'?'ARCHIVED':row.state==='committed'?'ADDED TO INVENTORY':'DRAFT'}</span><span aria-hidden="true">⠿</span></button>
      ${url?`<img class="workspace-card-photo" src="${escapeHtml(url)}" alt="Part reference photo" draggable="false" loading="lazy" />`:''}
      <div class="workspace-card-body"><strong>${escapeHtml(row.data.item_name||'Untitled part')}</strong><p>${escapeHtml(quantity)}</p><p class="small">${escapeHtml(row.data.platform||'Chassis unassigned')} • ${escapeHtml(row.data.stock_category||'Mobile')}</p><p class="small">${escapeHtml(workspace.errors.get(row.id)||((workspace.pending.has(row.id)||workspace.saving.has(row.id))?'Saving…':`Saved • ${row.actor_initials}`))}</p></div>
    </article>`;
    const existing=canvas.querySelector(`[data-workspace-card="${row.id}"]`);
    if(existing?._workspaceMarkup===markup)continue;
    const template=document.createElement('template');template.innerHTML=markup;
    const element=template.content.firstElementChild;element._workspaceMarkup=markup;
    const previousPhoto=existing?.querySelector('img'),nextPhoto=element.querySelector('img');
    if(previousPhoto&&nextPhoto&&previousPhoto.src===nextPhoto.src)nextPhoto.replaceWith(previousPhoto);
    if(existing)existing.replaceWith(element);else canvas.append(element);
  }
  for(const element of [...canvas.children])if(!visible.has(element.dataset.workspaceCard))element.remove();
  document.getElementById('workspaceDuplicateButton').disabled=!workspace.selected||!workspace.rows.has(workspace.selected);
}
function workspaceRenderSaveError(){
  const element=document.getElementById('workspaceCardSaveStatus');
  if(element)element.textContent=workspace.errors.get(workspace.selected)||'Changes save automatically to shared drafts.';
  document.getElementById('workspaceReloadCard')?.classList.toggle('hidden',!workspace.errors.has(workspace.selected));
}
function workspaceSelectOptions(values,current,placeholder='Choose…'){
  return `<option value="">${escapeHtml(placeholder)}</option>`+values.map(value=>`<option value="${escapeHtml(value.value??value)}" ${(value.value??value)===current?'selected':''}>${escapeHtml(value.label??value)}</option>`).join('');
}
function workspaceRenderInspector(){
  const wrap=document.getElementById('workspaceInspector');const row=workspaceView(workspace.selected);if(!wrap||!row)return;
  workspace.inspectorRevision=row.revision;
  const data=row.data,locked=row.state!=='draft'||workspace.committing===row.id;
  const chassis=[...new Set([...Object.keys(CART_CHASSIS_CODES),...inventoryData.map(item=>item.platform)].filter(Boolean))].sort();
  const carts=inventoryCarts.filter(cart=>cart.platform===data.platform&&data.stock_category!=='Backstock');
  const bins=inventoryBins.filter(bin=>bin.status!=='Archived'&&bin.model===data.platform&&(isLooseInventoryBin(bin)||(data.stock_category==='Backstock'?!bin.cart_location:binCartCode(bin)===(data.cart_code||'')))).sort(compareInventoryBins);
  wrap.innerHTML=`<div class="workspace-editor-heading"><h3>${row.state==='archived'?'Archived card':locked?'Added inventory':'Part card'}</h3><span class="small">${escapeHtml(row.tag_id.slice(-8))}</span></div>
    <p id="workspaceCardSaveStatus" class="small" role="status">Changes save automatically to shared drafts.</p>
    <button id="workspaceReloadCard" class="secondary hidden" type="button" onclick="workspaceReloadSelected()">Reload Shared Card</button>
    <div id="workspacePhotos" class="workspace-photos"></div>
    ${!locked?'<label class="workspace-photo-add">＋ Attach Photos<input id="workspacePhotoInput" type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple onchange="workspaceAttachFiles(this)" /></label>':''}
    <fieldset ${locked?'disabled':''}>
      <label for="workspacePartName">Part name</label><input id="workspacePartName" value="${escapeHtml(data.item_name||'')}" placeholder="Name it when you know" oninput="workspaceEdit('item_name',this.value)" />
      <div class="workspace-field-pair"><div><label for="workspaceQuantity">Quantity</label><input id="workspaceQuantity" type="number" min="0" step="1" value="${data.quantity??''}" placeholder="Uncounted" oninput="workspaceEditQuantity(this)" /></div><div><label for="workspaceUnit">Unit</label><input id="workspaceUnit" value="${escapeHtml(data.quantity_unit||'pcs')}" oninput="workspaceEdit('quantity_unit',this.value)" /></div></div>
      <label for="workspacePartNumber">Part number</label><input id="workspacePartNumber" value="${escapeHtml(data.part_number||'')}" placeholder="Optional" oninput="workspaceEdit('part_number',this.value)" />
      <label for="workspaceCondition">Condition</label><input id="workspaceCondition" value="${escapeHtml(data.condition||'')}" placeholder="New, used, needs inspection…" oninput="workspaceEdit('condition',this.value)" />
      <label for="workspaceStockCategory">Inventory type</label><select id="workspaceStockCategory" onchange="workspacePlacementChanged('stock_category',this.value)"><option ${data.stock_category!=='Backstock'?'selected':''}>Mobile</option><option ${data.stock_category==='Backstock'?'selected':''}>Backstock</option></select>
      <label for="workspaceChassis">Chassis</label><select id="workspaceChassis" onchange="workspacePlacementChanged('platform',this.value)">${workspaceSelectOptions(chassis,data.platform,'Unassigned')}</select>
      <label>Compatible chassis</label><div id="workspaceCompatibleChassis" class="compatibility-options"></div><p class="small">One stock count, visible under every checked chassis.</p>
      <label for="workspaceCart">Cart / location</label><select id="workspaceCart" onchange="workspacePlacementChanged('cart_code',this.value)" ${data.stock_category==='Backstock'?'disabled':''}>${workspaceSelectOptions(carts.map(cart=>({value:cart.cart_code,label:cart.cart_code})),data.cart_code,data.stock_category==='Backstock'?'Backstock':'Unassigned')}</select>
      <label for="workspaceBin">Bin</label><select id="workspaceBin" onchange="workspaceEdit('inventory_bin_id',this.value||null)">${workspaceSelectOptions(bins.map(bin=>({value:bin.id,label:`${bin.bin_code} — ${inventoryBinDisplayName(bin)}`})),data.inventory_bin_id,'Unassigned')}</select>
      <label for="workspaceNotes">Notes</label><textarea id="workspaceNotes" rows="3" placeholder="Anything you want to remember" oninput="workspaceEdit('notes',this.value)">${escapeHtml(data.notes||'')}</textarea>
      <label for="workspaceLabelMedia">Label stock</label><select id="workspaceLabelMedia" onchange="workspaceEdit('label_media_id',this.value)">${Object.entries(LABEL_MEDIA).map(([id,media])=>`<option value="${id}" ${(data.label_media_id||'metric25x50')===id?'selected':''}>${escapeHtml(media.name)}</option>`).join('')}</select>
    </fieldset>
    <div class="actions"><button id="workspacePrintButton" class="secondary" type="button" onclick="workspacePrintCard()">Print Label</button><button class="secondary" type="button" onclick="workspaceDuplicateCard()">Duplicate</button></div>
    <div class="actions">${row.state==='archived'?'<button class="primary" type="button" onclick="workspaceRestoreCard()">Restore Card</button>':row.state==='draft'?'<button id="workspaceCommitButton" class="primary" type="button" onclick="workspaceCommitCard()">Save to Inventory</button>':'<button class="primary" type="button" onclick="workspaceOpenInventory()">Open Inventory Record</button><button id="workspaceAddAnotherPart" class="primary" type="button" onclick="workspaceCreateCard()">Add Another Part</button>'}${row.state!=='archived'?'<button class="secondary" type="button" onclick="workspaceArchiveCard()">Archive Card</button>':''}</div>
    <p class="small">${locked?'Use the inventory record for changes to counted stock. Duplicate makes a new draft.':'Drafts do not add to inventory counts. A blank quantity stays uncounted.'}</p>`;
  renderInventoryCompatibility('workspace',data.platform,data.compatibility||[]);
  document.querySelectorAll('#workspaceCompatibleChassis input').forEach(input=>input.addEventListener('change',()=>workspaceEdit('compatibility',selectedInventoryCompatibility('workspace',data.platform))));
  if(workspace.committing===row.id)wrap.querySelectorAll('input,select,textarea,button').forEach(control=>control.disabled=true);
  workspaceRenderPhotos();workspaceRenderSaveError();
}
function workspaceEdit(field,value){
  const id=workspace.selected;const row=workspaceView(id);if(!row||row.state!=='draft')return;
  workspaceQueue(id,{data:{[field]:value}});
}
function workspaceEditQuantity(input){
  const value=input.value.trim();const quantity=value===''?null:Number(value);
  if(quantity!==null&&(!Number.isInteger(quantity)||quantity<0)){input.setCustomValidity('Use a whole count of zero or more, or leave blank.');input.reportValidity();return;}
  input.setCustomValidity('');workspaceEdit('quantity',quantity);
}
function workspacePlacementChanged(field,value){
  const patch={[field]:value||null,inventory_bin_id:null};
  if(field!=='cart_code')patch.cart_code=null;
  if(field==='platform'){
    const previous=workspaceView(workspace.selected)?.data;
    patch.compatibility=[...new Set([canonicalInventoryChassis(value),...(previous?.compatibility||[]).filter(code=>canonicalInventoryChassis(code)!==canonicalInventoryChassis(previous.platform))].filter(Boolean))];
  }
  if(workspaceQueue(workspace.selected,{data:patch}))workspaceRenderInspector();
}
async function workspaceReloadSelected(){
  const id=workspace.selected;if(!id)return;
  if(workspace.saving.has(id))await workspace.saving.get(id);
  clearTimeout(workspace.timers.get(id));workspace.pending.delete(id);workspace.errors.delete(id);
  await workspaceReload();workspaceRenderInspector();
}
async function workspaceCreateCard(seed={},select=true){
  if(!workspace.ready||workspace.creating)return null;const actor=workspaceActor();if(!actor)return null;
  const viewport=document.getElementById('workspaceViewport');
  const request=workspace.createRequest||{id:inventoryOperationId(),changes:{x:Math.max(0,Math.min(11700,Math.round((viewport.scrollLeft+viewport.clientWidth/2)/workspace.zoom-120))),y:Math.max(0,Math.min(11700,Math.round((viewport.scrollTop+viewport.clientHeight/2)/workspace.zoom-80))),data:{stock_category:'Mobile',quantity:null,quantity_unit:'pcs',label_media_id:'metric25x50',photo_paths:[],...seed}}};
  if(!workspace.createRequest)for(let attempt=0;attempt<24&&[...workspace.rows.values()].some(row=>row.state!=='archived'&&Math.abs(row.x-request.changes.x)<24&&Math.abs(row.y-request.changes.y)<24);attempt++){
    request.changes.x=Math.min(11700,request.changes.x+36);request.changes.y=Math.min(11700,request.changes.y+36);
  }
  workspace.createRequest=request;workspace.creating=true;workspaceStatus('Creating a shared card…');
  try{
    const saved=await workspaceRequest('save_inventory_workspace_draft',{p_id:request.id,p_revision:0,p_changes:request.changes,p_actor_initials:actor},actor);
    workspace.rows.set(saved.id,saved);workspace.createRequest=null;
    if(workspaceActive()&&(select||!workspace.selected)){workspaceSelect(saved.id);if(select)document.getElementById('workspacePartName')?.focus();}else workspaceRenderBoard();
    return saved;
  }catch(error){workspaceStatus('New card not confirmed. Choose New Card to retry the same request without duplicating it.');return null;}
  finally{workspace.creating=false;}
}
async function copyInventoryToWorkspace(){
  const item=currentInventoryItem;if(!item)return;
  await openInventoryWorkspace();
  workspace.pendingInventoryCopy={item_name:item.item_name,quantity:item.quantity,quantity_unit:item.quantity_unit,platform:canonicalInventoryChassis(item.platform),compatibility:inventoryCompatibleChassis(item),stock_category:item.stock_category,cart_code:inventoryItemLocationLabel(item).match(/-[AB]$/)?inventoryItemLocationLabel(item):null,inventory_bin_id:item.inventory_bin_id,condition:item.condition,category:item.category,part_number:item.part_number,notes:item.notes,source_inventory_item_id:item.id,photo_paths:Array.isArray(item.source_metadata?.photo_paths)?item.source_metadata.photo_paths:[]};
  workspaceStatus('Enter initials, then choose Copy Part to make a new draft. No stock will be added.');
  const wrap=document.getElementById('workspaceInspector');wrap.innerHTML='<h3>Duplicate an inventory part</h3><p id="workspaceCopyName"></p><button class="primary" type="button" onclick="workspaceCopyPendingInventory()">Copy Part to Workspace</button>';
  document.getElementById('workspaceCopyName').textContent=item.item_name;
}
async function workspaceCopyPendingInventory(){
  if(!workspace.pendingInventoryCopy)return;
  const result=await workspaceCreateCard(workspace.pendingInventoryCopy);
  if(result)workspace.pendingInventoryCopy=null;
}
async function workspaceDuplicateCard(){
  if(workspace.committing||workspace.uploading)return;
  const id=workspace.selected;if(!id)return;const actor=workspaceActor();if(!actor||!await workspaceFlush(id))return;
  if(workspace.duplicating)return;workspace.duplicating=true;
  const newId=workspace.duplicateRequest?.source===id?workspace.duplicateRequest.id:inventoryOperationId();
  workspace.duplicateRequest={source:id,id:newId};
  try{
    const saved=await workspaceRequest('duplicate_inventory_workspace_draft',{p_source_id:id,p_new_id:newId,p_actor_initials:actor},actor);
    workspace.rows.set(saved.id,saved);workspace.duplicateRequest=null;workspaceSelect(saved.id);workspaceStatus();
  }catch(error){workspaceStatus('Duplicate not confirmed. Retry Duplicate checks the same new card identity.');}
  finally{workspace.duplicating=false;}
}
async function workspaceCommitCard(){
  const id=workspace.selected;const actor=workspaceActor();if(!id||!actor||workspace.committing)return;
  if(workspace.uploading){workspaceStatus('Wait for photos to finish uploading before saving to inventory.');return;}
  const quantity=document.getElementById('workspaceQuantity');if(quantity&&!quantity.checkValidity()){quantity.reportValidity();return;}
  workspace.committing=id;
  if(!await workspaceFlush(id)){workspace.committing=false;return;}
  const row=workspace.rows.get(id);if(!row){workspace.committing=false;return;}
  if(!String(row.data.item_name||'').trim()){workspace.committing=false;workspaceStatus('Give this part a name before saving it to inventory.');document.getElementById('workspacePartName')?.focus();return;}
  const candidate={...row.data,quantity:row.data.quantity??null,quantity_unit:row.data.quantity_unit||'pcs'};
  workspaceRenderInspector();
  if(await reviewInventoryAddition(candidate,actor,(choice,confirmedActor)=>workspaceFinishCommit(id,confirmedActor,choice))){workspace.committing=false;workspaceRenderInspector();return;}
  return workspaceFinishCommit(id,actor,{mode:'separate'});
}
async function workspaceFinishCommit(id,actor,choice){
  const row=workspace.rows.get(id);if(!row)throw new Error('Reload this card before saving.');
  workspace.committing=id;
  if(workspaceActive())workspaceRenderInspector();
  try{
    const saved=await workspaceRequest('commit_inventory_workspace_draft',{p_id:id,p_revision:row.revision,p_actor_initials:actor,p_mode:choice.mode,p_existing_item_id:choice.mode==='separate'?null:choice.existing_id,p_expected_quantity:choice.expected_quantity??null},actor);
    workspace.rows.set(saved.id,saved);await loadInventory();workspaceRenderBoard();if(workspace.selected===id)workspaceRenderInspector();workspaceStatus('Added to shared inventory. The same tag ID is retained.');
    if(document.getElementById('inventoryIntakeReview').classList.contains('active')){showScreen('inventoryWorkspace');workspaceSelect(id);}
  }catch(error){
    workspace.committing=false;await workspaceReload();
    if(workspace.rows.get(id)?.state==='committed'){
      await loadInventory();
      if(document.getElementById('inventoryIntakeReview').classList.contains('active'))showScreen('inventoryWorkspace');
      workspaceStatus('Saved to inventory. The lost response was confirmed from the shared card.');return;
    }
    workspaceStatus(error.message+' Refresh this card before retrying if the response was lost.');
    if(document.getElementById('inventoryIntakeReview').classList.contains('active'))throw error;
  }
  finally{workspace.committing=false;if(workspaceActive()&&workspace.selected===id)workspaceRenderInspector();}
}
async function workspaceArchiveCard(){
  if(workspace.committing||workspace.uploading){workspaceStatus('Wait for the current save or photo upload to finish.');return;}
  const id=workspace.selected;if(!id||!workspaceActor()||!await workspaceFlush(id))return;
  if(!workspaceQueue(id,{state:'archived'}))return;
  if(await workspaceFlush(id)){workspace.selected=null;workspaceRenderBoard();document.getElementById('workspaceInspector').innerHTML='<h3>Card archived</h3><p>Its history and photos remain in the shared workspace.</p>';}
}
async function workspacePrintCard(){
  if(workspace.committing)return;
  const id=workspace.selected;if(!id)return;
  if(!await workspaceFlush(id))return;
  const row=workspace.rows.get(id);if(!row)return;
  let item;
  if(row.inventory_item_id){await loadInventory();item=inventoryData.find(stock=>stock.id===row.inventory_item_id);if(!item){workspaceStatus('Shared inventory is unavailable. Refresh before printing.');return;}item={...item,tag_id:row.tag_id};}
  else{
    const data=row.data,bin=data.inventory_bin_id?findInventoryBin(data.inventory_bin_id):null;
    item={...data,item_name:data.item_name||'Untitled part',tag_id:row.tag_id,inventory_code:row.tag_id,quantity:data.quantity??null,quantity_unit:data.quantity_unit||'pcs',cart_code:data.cart_code||null,location:bin?.bin_code||data.cart_code||'Unassigned',stock_category:data.stock_category||'Mobile',workspace_draft:true};
  }
  currentLabelPayload={type:'part',item,media_id:row.data.label_media_id||'metric25x50',workspace_draft_id:id};renderLabelPreview();showScreen('labelPrint');
}
function workspaceOpenInventory(){const row=workspace.rows.get(workspace.selected);if(!row?.inventory_item_id)return;const item=inventoryData.find(stock=>stock.id===row.inventory_item_id);if(item)openInventoryDetail(item.local_key);}
function workspaceStorageHeaders(contentType='application/json'){return {apikey:SUPABASE_KEY,'Content-Type':contentType};}
async function workspaceEnsurePhoto(path){
  const cached=workspace.photos.get(path);if(cached&&cached.expires>Date.now())return cached.url;
  if(workspace.photoRequests.has(path))return workspace.photoRequests.get(path);
  const task=(async()=>{
    try{
      const response=await portalFetch(`${SUPABASE_URL}/storage/v1/object/sign/otr-inventory-workspace/${path.split('/').map(encodeURIComponent).join('/')}`,{method:'POST',headers:workspaceStorageHeaders(),body:JSON.stringify({expiresIn:3600})});
      const result=await response.json();if(!response.ok)throw new Error('Photo unavailable');
      const signed=result.signedURL||result.signedUrl;
      const url=signed?.startsWith('/object/')?`${SUPABASE_URL}/storage/v1${signed}`:new URL(signed,SUPABASE_URL).href;
      if(new URL(url).origin!==new URL(SUPABASE_URL).origin)throw new Error('Invalid photo URL');
      workspace.photos.set(path,{url,expires:Date.now()+3300000});
      if(workspaceActive()){workspaceRenderBoard();workspaceRenderPhotos();}return url;
    }catch(error){return '';}
    finally{workspace.photoRequests.delete(path);}
  })();workspace.photoRequests.set(path,task);return task;
}
function workspaceRenderPhotos(){
  const wrap=document.getElementById('workspacePhotos'),row=workspaceView(workspace.selected);if(!wrap||!row)return;
  const paths=row.data.photo_paths||[];
  wrap.innerHTML=paths.map((path,index)=>{
    const url=workspace.photos.get(path)?.url;if(!url)workspaceEnsurePhoto(path);
    return `<div class="workspace-photo">${url?`<img src="${escapeHtml(url)}" alt="Part reference photo ${index+1}" />`:'<span>Loading photo…</span>'}${row.state==='draft'?`<button type="button" class="secondary" onclick="workspaceRemovePhoto(${index})" aria-label="Remove photo ${index+1} from this card">×</button>`:''}</div>`;
  }).join('');
}
function workspaceRemovePhoto(index){
  const row=workspaceView(workspace.selected);if(!row||row.state!=='draft')return;
  if(workspaceQueue(row.id,{data:{photo_paths:(row.data.photo_paths||[]).filter((_,i)=>i!==index)}}))workspaceRenderPhotos();
}
async function workspaceAttachFiles(input){const files=[...input.files];input.value='';await workspaceUploadPhotos(files,workspace.selected);}
async function workspaceIntakeFiles(input){
  const files=[...input.files];input.value='';if(!workspaceActor())return;
  for(const file of files){if(!workspaceValidPhoto(file))continue;const row=await workspaceCreateCard({},false);if(!row)break;await workspaceUploadPhotos([file],row.id);}
}
function workspaceValidPhoto(file){
  if(!['image/jpeg','image/png','image/webp','image/heic','image/heif'].includes(file.type)){workspace.uploadError='Choose a JPEG, PNG, WebP or HEIC photo.';workspaceStatus(workspace.uploadError);return false;}
  if(file.size>10485760){workspace.uploadError='Choose a photo smaller than 10 MB.';workspaceStatus(workspace.uploadError);return false;}return true;
}
async function workspaceUploadPhotos(files,id){
  const actor=workspaceActor();if(!actor||!id||!await workspaceFlush(id))return;
  const row=workspaceView(id);if(!row||row.state!=='draft')return;
  for(const file of files){
    if(!workspaceValidPhoto(file))continue;
    if((workspaceView(id).data.photo_paths||[]).length>=8){workspaceStatus('This card already has eight photos. Create another card or remove a reference.');break;}
    const extension={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif'}[file.type];
    const path=`${id}/${inventoryOperationId()}.${extension}`;workspace.uploadError='';workspace.uploading++;workspaceStatus();
    try{
      const response=await portalFetch(`${SUPABASE_URL}/storage/v1/object/otr-inventory-workspace/${path}`,{method:'POST',headers:{...workspaceStorageHeaders(file.type),'x-upsert':'false','cache-control':'no-store'},body:file});
      if(!response.ok)throw new Error('Photo upload did not complete. Retry attaching the photo.');
      const paths=workspaceView(id).data.photo_paths||[];
      workspaceQueue(id,{data:{photo_paths:[...paths,path]}},actor);
      await workspaceFlush(id);
      workspaceEnsurePhoto(path);if(workspace.selected===id)workspaceRenderPhotos();
    }catch(error){workspace.uploadError=error.message;workspaceStatus(error.message);}
    finally{workspace.uploading--;}
  }
  workspaceStatus();
}

function workspaceToggleArchived(checked){workspace.showArchived=checked;workspaceReload();}
async function workspaceRestoreCard(){
  const id=workspace.selected,row=workspace.rows.get(id);if(!row||!workspaceActor())return;
  if(workspaceQueue(id,{state:row.inventory_item_id?'committed':'draft'})&&await workspaceFlush(id)){workspaceRenderInspector();workspaceStatus('Card restored.');}
}
