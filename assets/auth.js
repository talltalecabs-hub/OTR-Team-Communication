// Supabase Auth owns credentials and refresh tokens. Only the tab session is
// retained; inventory drafts stay on the server. Roles are verified by the API.
const portalAuth={client:null,session:null,role:'public',passwordChangeRequired:false,ready:false,pending:null,resuming:false,busy:false,generation:0,refresh:null};
const portalProtectedScreens={adminAssistant:'admin',adminSubmissions:'admin',admin:'admin',adminVehicles:'admin',adminVehicleEdit:'admin',inventoryManagement:'staff',inventoryItemManagement:'staff',inventoryEdit:'staff',inventoryAdd:'staff',inventoryWorkspace:'staff',inventoryIntakeReview:'staff',inventoryBinDelete:'staff',inventoryEventHistory:'staff',labelAssistantHome:'staff',binCreate:'staff',binAssignPart:'staff',partTag:'staff'};
const portalProtectedEntries={
  admin:['openAdminAssistant','openFormSubmissions','loadAdminSubmissions','exportData','clearData','openVehicleAdmin','editVehicleAdmin'],
  staff:['openAddInventory','openLegacyAddInventory','openInventoryItemManagement','openInventoryVerify','openInventoryWorkspace','copyInventoryToWorkspace','openInventoryEventHistory','openLabelAssistant','openCreateBin','openAssignPartToBin','openPartTag','openDeleteInventoryBin','openBinManagement']
};
const portalProtectedMutations={
  admin:['saveVehicleAdmin','toggleVehicleAdmin'],
  staff:['saveInventoryCompatibility','changeInventoryStockCategory','saveInventoryNotes','persistInventoryPatch','saveInventoryVerification','markInventoryNeedsReview','markInventoryNotFound','addInventoryItem','retryLegacyInventoryAddition','completeLegacyInventoryAddition','saveBinCartLocation','insertInventoryBin','createInventoryBin','assignSelectedPartToBin','ensurePartTagId','preparePartTag','workspaceQueue','workspaceFlush','workspaceCreateCard','workspaceCopyPendingInventory','workspaceDuplicateCard','workspaceCommitCard','workspaceFinishCommit','workspaceArchiveCard','workspaceRestoreCard','workspaceUploadPhotos','workspaceAttachFiles','workspaceIntakeFiles','confirmInventoryAddition','saveInventoryPartName','saveInventoryBinName','deleteInventoryBin']
};
function portalHasRole(required='staff'){
  return portalAuth.ready&&!portalAuth.passwordChangeRequired&&portalAuth.session?.access_token&&portalAuth.session.expires_at*1000>Date.now()&&(portalAuth.role==='admin'||required==='staff'&&portalAuth.role==='staff');
}
function portalRoleLabel(){return portalAuth.passwordChangeRequired?'Set your password':portalAuth.role==='admin'?'Admin':portalAuth.role==='staff'?'Staff / Manager':'No management access';}
function portalBackendHeaders(extra={}){
  const headers={apikey:SUPABASE_KEY,...extra};
  if(portalAuth.session?.access_token&&portalAuth.session.expires_at*1000>Date.now())headers.Authorization=`Bearer ${portalAuth.session.access_token}`;
  return headers;
}
function portalRequestRole(url,method){
  const path=url.pathname.split('/rest/v1/')[1];
  if(path!==undefined){
    if(path==='submissions')return method==='POST'?'public':'admin';
    if(['rpc/use_inventory_part','rpc/portal_access','rpc/inventory_tag_links'].includes(path))return 'public';
    if(method==='GET'&&['inventory_items','inventory_bins','inventory_carts','vehicles'].includes(path))return 'public';
    return path==='rpc/save_vehicle_registry'||path==='vehicles'||path==='vehicle_registry_events'?'admin':'staff';
  }
  if(url.pathname.startsWith('/storage/v1/')&&url.pathname.includes('otr-inventory-workspace'))return 'staff';
  return 'public';
}
async function portalFetch(resource,options={}){
  const url=new URL(resource,location.href);
  if(url.origin!==new URL(SUPABASE_URL).origin)return fetch(resource,options);
  const required=portalRequestRole(url,(options.method||'GET').toUpperCase());
  if(required!=='public'&&!portalHasRole(required)){
    requestPortalSignIn({screen:document.querySelector('.screen.active')?.id||'inventoryManagement',required});
    const error=new Error('Sign in with an authorized team account to continue.');error.status=403;throw error;
  }
  const headers=new Headers(options.headers||{});
  for(const [key,value] of Object.entries(portalBackendHeaders()))headers.set(key,value);
  const userId=portalAuth.session?.user?.id;
  const response=await fetch(resource,{...options,headers});
  if(required!=='public'&&(portalAuth.session?.user?.id!==userId||!portalHasRole(required))){const error=new Error('The account changed before this action was confirmed.');error.status=403;throw error;}
  return response;
}
function portalIntentContext(){return {itemKey:currentInventoryItem?.local_key||null,binKey:currentInventoryBin?.id||null};}
function requestPortalSignIn(intent=null,{historyMode='push'}={}){
  if(intent)portalAuth.pending={...intent,...portalIntentContext()};
  if(portalAuth.session&&portalAuth.passwordChangeRequired){openPortalPasswordChange({historyMode});return;}
  const required=portalAuth.pending?.required||'staff';
  const label=required==='admin'?'Administrative':'Inventory Management';
  document.getElementById('signInTitle').textContent=required==='admin'?'Admin Sign In':'Team Sign In';
  document.getElementById('signInReason').textContent=portalAuth.session?`${label} requires ${required==='admin'?'Admin':'Staff / Manager'} access. Use an authorized account or request access below.`:`Sign in to access ${label}. Inventory search, Use Part, and team forms stay public.`;
  document.getElementById('signInStatus').textContent=portalAuth.client?'':'Sign-in is temporarily unavailable. Reload the portal to retry. Public portal features are still available.';
  document.getElementById('signInPassword').value='';
  showScreen('signIn',{historyMode});
  document.getElementById('signInEmail').focus();
}
function cancelPortalSignIn(){portalAuth.pending=null;portalBack('home');}
function portalGuardScreen(id,historyMode='push'){
  if(id==='changePassword'&&!portalAuth.session){requestPortalSignIn(null,{historyMode:'replace'});return false;}
  const required=portalProtectedScreens[id];
  if(!required||portalHasRole(required))return true;
  requestPortalSignIn({screen:id,required},{historyMode:historyMode==='none'?'replace':historyMode});return false;
}
function registerPortalAuthGuards(){
  for(const [required,names] of Object.entries(portalProtectedEntries))for(const name of names){
    const original=window[name];if(typeof original!=='function')throw new Error(`Missing protected action ${name}`);
    window[name]=function(...args){
      if(!portalHasRole(required)){requestPortalSignIn({action:name,args,required});return;}
      return original.apply(this,args);
    };
  }
  for(const [required,names] of Object.entries(portalProtectedMutations))for(const name of names){
    const original=window[name];if(typeof original!=='function')throw new Error(`Missing protected mutation ${name}`);
    window[name]=function(...args){
      if(!portalHasRole(required)){
        const current=document.querySelector('.screen.active')?.id;
        requestPortalSignIn({screen:portalProtectedScreens[current]?current:'inventoryManagement',required});return;
      }
      return original.apply(this,args);
    };
  }
}
function renderPortalAuth(){
  document.body.dataset.portalRole=portalAuth.role;
  const signed=Boolean(portalAuth.session);
  document.body.dataset.portalSignedIn=String(signed);
  document.getElementById('portalSignIn').classList.toggle('hidden',signed);
  document.getElementById('portalAccount').classList.toggle('hidden',!signed);
  document.getElementById('portalAccountLabel').textContent=portalRoleLabel();
  document.getElementById('portalAccountEmail').textContent=portalAuth.session?.user?.email||'';
}
function clearPortalPasswordFields(){
  ['signInPassword','passwordCurrent','passwordNew','passwordConfirm'].forEach(id=>{document.getElementById(id).value='';});
}
function openPortalPasswordChange({historyMode='push'}={}){
  if(!portalAuth.session){requestPortalSignIn();return;}
  clearPortalPasswordFields();
  document.getElementById('passwordChangeReason').textContent=portalAuth.passwordChangeRequired?'Choose your own password before opening management tools. Your original destination will open after it is saved.':'Update the password for your team account.';
  document.getElementById('passwordChangeStatus').textContent='';
  showScreen('changePassword',{historyMode});
  document.getElementById('passwordCurrent').focus();
}
async function submitPortalPasswordChange(event){
  event?.preventDefault();if(portalAuth.busy||!portalAuth.client||!portalAuth.session)return;
  const form=document.getElementById('portalPasswordForm');if(!form.reportValidity())return;
  const current=document.getElementById('passwordCurrent'),password=document.getElementById('passwordNew'),confirm=document.getElementById('passwordConfirm');
  const status=document.getElementById('passwordChangeStatus'),button=document.getElementById('passwordChangeSubmit');
  if(password.value!==confirm.value){status.textContent='The new passwords do not match.';confirm.focus();return;}
  if(password.value===current.value){status.textContent='Choose a different password from your temporary or current password.';password.focus();return;}
  portalAuth.busy=true;button.disabled=true;status.textContent='Saving your password…';
  try{
    const {error}=await portalAuth.client.auth.updateUser({current_password:current.value,password:password.value});
    if(error){
      const messages={same_password:'Choose a password different from your current password.',weak_password:'Choose a stronger password with at least 12 characters.',invalid_credentials:'The current password was not recognized. Please try again.',reauthentication_needed:'Sign out and sign in again, then set your password.',reauthentication_not_valid:'Sign out and sign in again, then set your password.'};
      status.textContent=messages[error.code]||'The password could not be saved. Check your current password and connection, then retry.';return;
    }
    clearPortalPasswordFields();
    const {data,error:sessionError}=await portalAuth.client.auth.getSession();if(sessionError)throw sessionError;
    await refreshPortalAccess(data.session);
    if(portalAuth.passwordChangeRequired){status.textContent='The password update is not confirmed yet. Refresh account access to check again.';return;}
    if(document.getElementById('changePassword').classList.contains('active'))showScreen('home',{historyMode:'replace'});
    showPortalNavNotice('Your password has been updated.');
  }catch(error){status.textContent='The update could not be confirmed. Sign out and try your new password before retrying.';}
  finally{portalAuth.busy=false;button.disabled=false;}
}
function clearProtectedPortalState(){
  if(typeof workspace!=='undefined'){
    for(const timer of workspace.timers.values())clearTimeout(timer);
    workspace.pending.clear();workspace.timers.clear();workspace.errors.clear();workspace.rows.clear();workspace.photos.clear();workspace.selected=null;workspace.ready=false;
    workspace.createRequest=null;workspace.duplicateRequest=null;workspace.pendingInventoryCopy=null;
  }
  if(typeof sharedSubmissions!=='undefined')sharedSubmissions=[];
  ['adminSubmissionsList','adminList','vehicleAdminList','workspaceCanvas','workspaceInspector'].forEach(id=>{const node=document.getElementById(id);if(node)node.replaceChildren();});
  if(typeof inventoryIntakeReview!=='undefined')inventoryIntakeReview=null;
  if(typeof inventoryLegacyPending!=='undefined')inventoryLegacyPending=null;
}
async function refreshPortalAccess(session){
  const generation=++portalAuth.generation;
  const changedUser=portalAuth.session?.user?.id&&portalAuth.session.user.id!==session?.user?.id;
  const retainVerifiedRole=portalAuth.ready&&portalAuth.session?.user?.id&&portalAuth.session.user.id===session?.user?.id;
  if(changedUser)clearProtectedPortalState();
  portalAuth.session=session;
  if(!retainVerifiedRole){portalAuth.role='public';portalAuth.passwordChangeRequired=false;portalAuth.ready=false;renderPortalAuth();}
  if(session){
    try{
      // Auth verifies the JWT, then the database checks server-controlled roles.
      const {error}=await portalAuth.client.auth.getUser(session.access_token);if(error)throw error;
      const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/portal_access`,{headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${session.access_token}`},cache:'no-store'});
      if(!response.ok)throw new Error('Access is not configured yet.');
      const access=await response.json();
      if(generation!==portalAuth.generation)return;
      if(access.user_id!==session.user.id)throw new Error('Account access could not be verified.');
      portalAuth.passwordChangeRequired=access.password_change_required===true;
      portalAuth.role=['staff','admin'].includes(access.role)?access.role:'public';
    }catch(error){
      if(generation===portalAuth.generation){
        portalAuth.role='public';document.getElementById('signInStatus').textContent='Account access could not be verified. Please retry or contact your team administrator.';
        if(error.status===401||error.status===403){portalAuth.session=null;try{await portalAuth.client.auth.signOut({scope:'local'});}catch{}}
      }
    }
  }
  if(generation!==portalAuth.generation)return;
  portalAuth.ready=true;renderPortalAuth();
  if(!session){clearProtectedPortalState();const active=document.querySelector('.screen.active')?.id;if(portalProtectedScreens[active]||active==='changePassword')showScreen('home',{historyMode:'replace'});return;}
  if(portalAuth.passwordChangeRequired){
    clearProtectedPortalState();
    if(!document.getElementById('changePassword').classList.contains('active'))openPortalPasswordChange({historyMode:'replace'});
    return;
  }
  const active=document.querySelector('.screen.active')?.id;
  if(portalProtectedScreens[active]&&!portalHasRole(portalProtectedScreens[active])){
    clearProtectedPortalState();requestPortalSignIn({screen:active,required:portalProtectedScreens[active]},{historyMode:'replace'});return;
  }
  await resumePortalIntent();
}
async function resumePortalIntent(){
  const intent=portalAuth.pending;if(!intent||!portalHasRole(intent.required))return;
  portalAuth.pending=null;portalAuth.resuming=true;
  try{
    if(intent.itemKey)currentInventoryItem=findInventoryItem(intent.itemKey)||currentInventoryItem;
    if(intent.binKey)currentInventoryBin=findInventoryBin(intent.binKey)||currentInventoryBin;
    if(intent.action)await window[intent.action](...(intent.args||[]));
    else showScreen(intent.screen||'inventoryManagement',{historyMode:'replace'});
  }finally{portalAuth.resuming=false;}
}
async function initializePortalAuth(){
  const memory=new Map();
  const storage={getItem(key){try{return sessionStorage.getItem(key)||memory.get(key)||null;}catch{return memory.get(key)||null;}},setItem(key,value){memory.set(key,value);try{sessionStorage.setItem(key,value);}catch{}},removeItem(key){memory.delete(key);try{sessionStorage.removeItem(key);}catch{}}};
  try{
    portalAuth.client=supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{auth:{storage,storageKey:'otr_portal_auth_v2',persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
    portalAuth.client.auth.onAuthStateChange((event,session)=>{
      // Schedule outside the SDK's auth lock; never await SDK calls here.
      if(event==='SIGNED_OUT'||event==='TOKEN_REFRESHED'||event==='USER_UPDATED')setTimeout(()=>refreshPortalAccess(session),0);
    });
    const {data,error}=await portalAuth.client.auth.getSession();if(error)throw error;
    await refreshPortalAccess(data.session);
  }catch(error){portalAuth.ready=true;renderPortalAuth();document.getElementById('signInStatus').textContent='Sign-in is temporarily unavailable. Public portal features are still available.';}
  window.addEventListener('focus',()=>{if(portalAuth.session&&!portalAuth.busy)portalAuth.client.auth.getSession().then(({data})=>refreshPortalAccess(data.session));});
}
async function submitPortalSignIn(event){
  event?.preventDefault();if(portalAuth.busy)return;
  if(!portalAuth.client){document.getElementById('signInStatus').textContent='Sign-in is temporarily unavailable. Reload the portal to retry. Public portal features are still available.';return;}
  const form=document.getElementById('portalSignInForm');if(!form.reportValidity())return;
  const button=document.getElementById('signInSubmit'),status=document.getElementById('signInStatus');
  portalAuth.busy=true;button.disabled=true;status.textContent='Signing in…';
  try{
    const {data,error}=await portalAuth.client.auth.signInWithPassword({email:document.getElementById('signInEmail').value.trim(),password:document.getElementById('signInPassword').value});
    document.getElementById('signInPassword').value='';
    if(error){status.textContent=error.status===400?'The email or password was not recognized. Please try again.':'Unable to sign in. Check your connection and try again.';return;}
    await refreshPortalAccess(data.session);
    if(document.getElementById('signIn').classList.contains('active')){
      if(portalAuth.role==='public')status.textContent='You are signed in, but this account has no management access. Request access below.';
      else if(portalAuth.pending)status.textContent='This destination requires Admin access. Request access below or use an Admin account.';
      else showScreen('home',{historyMode:'replace'});
    }
  }catch(error){status.textContent='Unable to sign in. Check your connection and try again.';}
  finally{portalAuth.busy=false;button.disabled=false;}
}
async function signOutPortal(){
  if(portalAuth.busy)return;portalAuth.busy=true;
  portalAuth.pending=null;++portalAuth.generation;portalAuth.role='public';portalAuth.passwordChangeRequired=false;portalAuth.session=null;portalAuth.ready=true;renderPortalAuth();clearProtectedPortalState();clearPortalPasswordFields();
  showScreen('home',{historyMode:'replace'});
  try{await portalAuth.client?.auth.signOut({scope:'local'});}finally{try{sessionStorage.removeItem('otr_portal_auth_v2');}catch{}portalAuth.busy=false;}
}
async function refreshPortalAccount(){
  if(!portalAuth.client)return;
  const {data}=await portalAuth.client.auth.getSession();await refreshPortalAccess(data.session);
}
async function submitAdminAccessRequest(event){
  event?.preventDefault();const form=document.getElementById('adminAccessForm');if(!form.reportValidity())return;
  const button=document.getElementById('adminAccessSubmit');if(button.disabled)return;
  button.disabled=true;const status=document.getElementById('adminAccessStatus');status.textContent='Sending request…';
  try{
    await sendToSupabase({type:'admin_access_request',category:'Administrative access',name:document.getElementById('adminAccessName').value.trim(),anonymous:false,text:'Admin access request',answers:{email:document.getElementById('adminAccessEmail').value.trim(),requested_role:'admin',reason:document.getElementById('adminAccessReason').value.trim()}});
    form.reset();status.textContent='Request sent to the team administrator. Access will stay unchanged until it is reviewed.';
  }catch(error){status.textContent='The request could not be sent. Please retry when connected.';}
  finally{button.disabled=false;}
}
async function openBinManagement(key=''){
  await openBinDetail(key||currentInventoryBin?.id);
  const panel=document.getElementById('binManagementControls');if(panel)panel.open=true;
}
