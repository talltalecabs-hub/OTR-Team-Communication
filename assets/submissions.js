function getStore(){
  try{return JSON.parse(localStorage.getItem("otr_submissions")||"[]")}catch(e){return[]}
}
function setStore(arr){localStorage.setItem("otr_submissions",JSON.stringify(arr));}
function queueSubmission(data){const arr=getStore();arr.unshift(data);setStore(arr);}

function toDatabaseRow(data){return {submission_type:data.type||"feedback",category:data.category||null,quick_feedback:data.text||data.quick||null,answers:data.answers||null,additional_details:data.detail||null,submitted_name:data.name||null,anonymous:data.anonymous!==false,app_version:APP_VERSION,source:"web"};}
async function sendToSupabase(data){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/submissions`,{method:"POST",headers:{"apikey":SUPABASE_KEY,"Content-Type":"application/json","Prefer":"return=minimal"},body:JSON.stringify(toDatabaseRow(data))});
  if(!response.ok){let msg="";try{msg=await response.text();}catch(e){};throw new Error(`Supabase insert failed: ${response.status} ${msg}`);}
  return true;
}
function setSubmitStatus(message,queued=false){const el=document.getElementById("submitStatus");if(!el)return;el.textContent=message;el.style.color=queued?"#8a5b00":"var(--ok)";}
async function submitData(data){try{await sendToSupabase(data);setSubmitStatus("Submitted to the shared OTR database.");return "remote";}catch(err){console.warn(err);queueSubmission(data);setSubmitStatus("Connection unavailable. Saved safely on this device and will retry automatically.",true);return "queued";}}
async function syncQueue(){const arr=getStore();if(!arr.length)return;const remaining=[];for(const item of arr){try{await sendToSupabase(item);}catch(err){remaining.push(item);}}setStore(remaining);if(document.getElementById("admin").classList.contains("active"))renderAdmin();}
async function submitQuick(){
  const quick=document.getElementById("quickText").value.trim();
  if(!quick){
    alert("Add a short note first.");
    document.getElementById("quickText").focus();
    return;
  }

  const data={
    id:cryptoId(),
    type:"feedback_quick",
    category:activeCategory,
    quick,
    answers:null,
    detail:null,
    name:null,
    anonymous:true,
    timestamp:new Date().toISOString(),
    version:APP_VERSION
  };

  showScreen("thanks",{historyMode:"replace"});
  setSubmitStatus("Submitting…");
  await submitData(data);
}

async function submitDetailed(){
  const quick=document.getElementById("quickText").value.trim();
  const detail=document.getElementById("detailText").value.trim();
  const name=document.getElementById("nameText").value.trim();
  const followUpOk=document.getElementById("followUpOk").checked;

  const cleanAnswers={...answers,_follow_up_ok:followUpOk};
  const hasAnswer=Object.entries(cleanAnswers).some(([k,v])=>k!=="_follow_up_ok" && String(v||"").trim());

  if(!quick && !detail && !hasAnswer){
    alert("Add some feedback before submitting.");
    document.getElementById("quickText").focus();
    return;
  }

  const data={
    id:cryptoId(),
    type:"feedback_detailed",
    category:activeCategory,
    quick,
    answers:cleanAnswers,
    detail,
    name:name||null,
    anonymous:!name,
    timestamp:new Date().toISOString(),
    version:APP_VERSION
  };

  showScreen("thanks",{historyMode:"replace"});
  setSubmitStatus("Submitting…");
  await submitData(data);
}

async function submitOperationalForm(){
  const def=operationalFormDefinitions[activeOperationalFormKey];
  if(!def) return;

  const values={};
  let missingField=null;
  for(const field of def.fields){
    const el=document.getElementById(`op-${field.id}`);
    if(!el) continue;
    const value=field.type==="checkbox" ? el.checked : el.value.trim();
    values[field.id]=value;
    if(field.required && !String(value||"").trim()){
      missingField=field;
      break;
    }
  }

  if(missingField){
    alert(`Add ${missingField.label.toLowerCase()} first.`);
    document.getElementById(`op-${missingField.id}`)?.focus();
    return;
  }

  const identity=def.identityField ? String(values[def.identityField]||"").trim() : "";
  const summary=def.summaryField ? String(values[def.summaryField]||"").trim() : "";
  const data={
    id:cryptoId(),
    type:def.type,
    category:def.category,
    quick:`${def.title}${summary?` • ${summary}`:""}`,
    answers:values,
    detail:null,
    name:identity||null,
    anonymous:!identity,
    timestamp:new Date().toISOString(),
    version:APP_VERSION
  };

  const btn=document.getElementById("operationalFormSubmitBtn");
  if(btn){btn.disabled=true;btn.textContent="Submitting…";}
  showScreen("thanks",{historyMode:"replace"});
  setSubmitStatus("Submitting…");
  await submitData(data);
  if(btn){btn.disabled=false;btn.textContent=def.submitLabel;}
}






async function submitPostEvent(){
  const eventName=document.getElementById("peEvent").value.trim();
  const role=document.getElementById("peRole").value;
  const areas=document.getElementById("peAreas").value.trim();
  const name=document.getElementById("peName").value.trim();
  const followUpOk=document.getElementById("peFollowUp").checked;

  if(!eventName){
    alert("Add the event name first.");
    document.getElementById("peEvent").focus();
    return;
  }

  if(!role){
    alert("Choose your primary role for the event.");
    document.getElementById("peRole").focus();
    return;
  }

  const report={
    event:eventName,
    role,
    areas,
    worked_well:document.getElementById("pe4").value.trim(),
    friction:document.getElementById("pe5").value.trim(),
    missing_unclear:document.getElementById("pe6").value.trim(),
    recurring_problem:document.getElementById("pe7").value.trim(),
    near_miss:document.getElementById("peNearMiss").value.trim(),
    issues_before_next_event:document.getElementById("pe8").value.trim(),
    supplies_inventory:document.getElementById("pe9").value.trim(),
    technical_observations:document.getElementById("pe10").value.trim(),
    lost_time_effort:document.getElementById("pe11").value.trim(),
    made_job_easier:document.getElementById("pe12").value.trim(),
    one_change:document.getElementById("pe13").value.trim(),
    buy_repair_fabricate_prepare:document.getElementById("pe14").value.trim(),
    hindsight:document.getElementById("pe15").value.trim(),
    other:document.getElementById("peOther").value.trim(),
    _follow_up_ok:followUpOk
  };

  const hasContent=Object.entries(report).some(([k,v])=>
    !["event","role","areas","_follow_up_ok"].includes(k) && String(v||"").trim()
  );

  if(!hasContent){
    alert("Add at least one observation before submitting.");
    return;
  }

  const data={
    id:cryptoId(),
    type:"post_event_report",
    category:"Post-Event",
    quick:`${eventName} • ${role}`,
    answers:report,
    detail:null,
    name:name||null,
    anonymous:!name,
    timestamp:new Date().toISOString(),
    version:APP_VERSION
  };

  const btn=document.getElementById("postEventSubmitBtn");
  if(btn){btn.disabled=true;btn.textContent="Submitting…";}

  showScreen("thanks",{historyMode:"replace"});
  setSubmitStatus("Submitting…");
  await submitData(data);

  if(btn){btn.disabled=false;btn.textContent="Submit Post-Event Report";}
}

async function genericSubmit(field,type){
  const el=document.getElementById(field);
  const text=el.value.trim();
  if(!text){ alert("Add a short note first."); return; }
  const data={
    id:cryptoId(), type, text,
    timestamp:new Date().toISOString(), anonymous:true, version:APP_VERSION
  };

  el.value="";
  showScreen("thanks",{historyMode:"replace"});

  setSubmitStatus("Submitting…");
  await submitData(data);
}



function exportData(){
  const data=JSON.stringify(getStore(),null,2);
  const blob=new Blob([data],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;a.download="otr-portal-v0.1-data.json";a.click();
  setTimeout(()=>URL.revokeObjectURL(url),500);
}

function clearData(){
  if(confirm("Clear all submissions waiting to sync from this device? This cannot be undone.")){
    localStorage.removeItem("otr_submissions");
    renderAdmin();
  }
}


let sharedSubmissions=[];

function openAdminAssistant(){
  showScreen("adminAssistant");
}

function openFormSubmissions(){
  showScreen("adminSubmissions");
  loadAdminSubmissions();
}

async function loadAdminSubmissions(){
  const status=document.getElementById("adminSubmissionsStatus");
  const list=document.getElementById("adminSubmissionsList");

  if(status){
    status.textContent="Loading shared submissions…";
    status.style.borderLeftColor="var(--accent-dark)";
  }
  if(list) list.innerHTML="";

  try{
    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/submissions?select=*&order=created_at.desc&limit=500`,
      {headers:{"apikey":SUPABASE_KEY}}
    );

    if(!response.ok){
      const msg=await response.text();
      throw new Error(`Supabase read failed: ${response.status} ${msg}`);
    }

    sharedSubmissions=await response.json();

    if(status){
      status.textContent=`Loaded ${sharedSubmissions.length} shared submission${sharedSubmissions.length===1?"":"s"}.`;
      status.style.borderLeftColor="var(--ok)";
    }
    renderSharedSubmissions();
  }catch(err){
    console.error(err);
    if(status){
      status.textContent=`Unable to read shared submissions. Check the V${APP_VERSION} admin-read policy in Supabase, then refresh.`;
      status.style.borderLeftColor="var(--danger)";
    }
    if(list) list.innerHTML="";
  }
}

function renderSharedSubmissions(){
  const list=document.getElementById("adminSubmissionsList");
  if(!list) return;

  const filter=document.getElementById("adminSubmissionFilter")?.value||"ALL";

  const rows=sharedSubmissions.filter(item=>{
    if(filter==="ALL") return true;
    if(filter==="feedback") return String(item.submission_type||"").startsWith("feedback");
    return item.submission_type===filter;
  });

  if(!rows.length){
    list.innerHTML='<div class="card"><strong>No matching submissions.</strong></div>';
    return;
  }

  list.innerHTML=rows.map(item=>{
    const type=escapeHtml(item.submission_type||"Submission");
    const category=escapeHtml(item.category||"");
    const quick=escapeHtml(item.quick_feedback||"");
    const details=escapeHtml(item.additional_details||"");
    const name=escapeHtml(item.submitted_name||"Anonymous");
    const when=item.created_at?new Date(item.created_at).toLocaleString():"";
    const answers=item.answers && typeof item.answers==="object"
      ? Object.entries(item.answers)
          .filter(([k,v])=>k!=="_follow_up_ok" && String(v??"").trim()!=="")
          .map(([k,v])=>{
            const labels={
              event:"Event",role:"Role",areas:"Cars / Areas",
              driver:"Driver / initials",reporter:"Reporter / initials",
              car:"Car / vehicle category",unit:"Car / unit identifier",session:"Session",focus:"Focus",
              improve:"Improve / understand",experiment:"Experiment / small test",
              readiness:"Readiness",confidence:"Car confidence",
              concerns:"Concerns before stint",team_need:"Team need",
              overall:"Overall stint",car_behavior:"Car behavior / performance",
              focus_result:"Pre-stint focus reflection",improve_result:"Improvement / understanding reflection",
              experiment_result:"Experiment / small-test result",
              communication:"Communication / pit experience",issues:"Issues to follow up",
              next_notes:"Next-driver / next-session notes",
              when:"When / session",urgency:"Urgency",finding:"Finding / observation",
              action:"Action taken / needed",safe_to_run:"Safe to run",
              incident:"What happened",damage:"Damage / affected area",
              immediate_action:"Immediate action / follow-up",area:"Team area",
              request:"Request / issue",blocker:"Blocker / extra work",next_step:"Suggested next step",
              worked_well:"Worked well / repeat",
              friction:"Difficulty / delay / workload",
              missing_unclear:"Missing / difficult / unavailable / unclear",
              recurring_problem:"Recurring problem",
              near_miss:"Near miss",
              issues_before_next_event:"Issues before next event",
              supplies_inventory:"Supplies / inventory",
              technical_observations:"Driver / technical observations",
              lost_time_effort:"Lost time / effort",
              made_job_easier:"Made job easier",
              one_change:"One change before next event",
              buy_repair_fabricate_prepare:"Buy / repair / fabricate / prepare",
              hindsight:"Wish we knew before arrival",
              other:"Other"
            };
            const label=labels[k] || (/^\d+$/.test(k)?`Q${k}`:k);
            return `<div class="small" style="margin:6px 0"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(v)}</div>`;
          })
          .join("")
      : "";
    const follow=item.answers && item.answers._follow_up_ok===true;

    return `<div class="card">
      <div class="inventory-statusbar">
        <span class="inv-badge verified">${type}</span>
        ${category?`<span class="inv-badge">${category}</span>`:""}
      </div>
      ${quick?`<p style="font-size:18px"><strong>${quick}</strong></p>`:""}
      ${answers}
      ${details?`<p><strong>Additional details:</strong> ${details}</p>`:""}
      <div class="small" style="margin-top:12px">
        ${name}${follow?" • OK to follow up":""} • ${escapeHtml(when)}
      </div>
    </div>`;
  }).join("");
}

function renderAdmin(){
  const list=document.getElementById("adminList");
  if(!list) return;
  const arr=getStore();
  if(!arr.length){
    list.innerHTML=`<p class="small">Nothing queued — everything has synced to the shared database.</p>`;
    return;
  }
  list.innerHTML=arr.map(item=>{
    const label=escapeHtml(item.type||item.category||"Submission");
    const body=escapeHtml(item.text||item.quick||item.detail||"(no text)");
    const when=item.timestamp?new Date(item.timestamp).toLocaleString():"";
    return `<div class="adminrow">
      <div>
        <strong>${label}</strong>
        <div class="small">${body}</div>
        <div class="small">${escapeHtml(when)}</div>
      </div>
      <span class="pill">Queued</span>
    </div>`;
  }).join("");
}


