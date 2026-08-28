const categories = [
  "Driver Experience",
  "Mechanical / Cars",
  "Pit Operations",
  "Paddock Operations",
  "Transportation & Logistics",
  "Hospitality & Crew Support",
  "Shop / HQ Operations",
  "Something Else"
];

const questions = [
  "What happened or changed?",
  "Did you have the resources and information you needed for the situation?",
  "Did anything slow you down or create extra work?",
  "What worked well here?",
  "What should we change, fix, or protect?"
];

const internalVehicleCategories = [
  "E92",
  "986 Boxster",
  "F30",
  "M235 / M235iR",
  "E46",
  "Non-Race",
  "Tow",
  "Trailer"
];

const fallbackVehicleRegistry = [
  {vehicle_code:"F30-GOLDIE",platform:"F30",vehicle_name:"Goldie",designation:"69",status:"Active",display_order:10},
  {vehicle_code:"F30-PHO30",platform:"F30",vehicle_name:"Pho30",designation:"65",status:"Active",display_order:20},
  {vehicle_code:"F30-68-CAR",platform:"F30",vehicle_name:"68 car",designation:"68",status:"Active",display_order:30},
  {vehicle_code:"F30-ESTHER",platform:"F30",vehicle_name:"Esther",designation:"Street",status:"Street",display_order:40},
  {vehicle_code:"F30-HALF-AND-HALF",platform:"F30",vehicle_name:"Half and Half 428i",designation:"70 / Street",status:"Street",display_order:50},
  {vehicle_code:"E92-CHERRY",platform:"E92",vehicle_name:"Cherry",designation:"64",status:"Active",display_order:10},
  {vehicle_code:"E92-ACID-TRIP",platform:"E92",vehicle_name:"Acid Trip",designation:"67",status:"Active",display_order:20},
  {vehicle_code:"E92-HULK",platform:"E92",vehicle_name:"Hulk",designation:"63",status:"Deceased",display_order:30},
  {vehicle_code:"E92-HIGH-BOI",platform:"E92",vehicle_name:"High Boi",designation:"Street",status:"Street",display_order:40},
  {vehicle_code:"E92-PRINCE",platform:"E92",vehicle_name:"Prince",designation:"69",status:"Active",display_order:50},
  {vehicle_code:"M235-RAPTOR",platform:"M235 / M235iR",vehicle_name:"Raptor",designation:"62",status:"Active",display_order:10},
  {vehicle_code:"M235-TRIXIE",platform:"M235 / M235iR",vehicle_name:"Trixie",designation:"61",status:"Active",display_order:20},
  {vehicle_code:"986-BRUNO",platform:"986 Boxster",vehicle_name:"Bruno",designation:"58",status:"Active",display_order:10},
  {vehicle_code:"986-RED-BOX",platform:"986 Boxster",vehicle_name:"Red Box",designation:"59",status:"Active",display_order:20},
  {vehicle_code:"E46-BLUE-BETTY",platform:"E46",vehicle_name:"Blue Betty",designation:"Street",status:"Street",display_order:10},
  {vehicle_code:"E46-CLOWN-SHOE-Z3",platform:"E46",vehicle_name:"Clown Shoe Z3",designation:"67",status:"Active",display_order:20},
  {vehicle_code:"TOW-RON-BURGUNDY",platform:"Tow",vehicle_name:"Ron Burgundy",designation:"F350",status:"Active",display_order:10},
  {vehicle_code:"TOW-VICKY",platform:"Tow",vehicle_name:"Vicky",designation:"F350",status:"Active",display_order:20},
  {vehicle_code:"TOW-CAYENNE",platform:"Tow",vehicle_name:"Cayenne",designation:"Tow",status:"Active",display_order:30},
  {vehicle_code:"TRAILER-WHITE-LIGHTNING",platform:"Trailer",vehicle_name:"White Lightning",designation:"Trailer",status:"Active",display_order:10},
  {vehicle_code:"TRAILER-WEDGE",platform:"Trailer",vehicle_name:"Wedge",designation:"Trailer",status:"Active",display_order:20},
  {vehicle_code:"TRAILER-TWO-CAR",platform:"Trailer",vehicle_name:"Two Car",designation:"Trailer",status:"Active",display_order:30},
  {vehicle_code:"TRAILER-SINGLE-CAR",platform:"Trailer",vehicle_name:"Single Car",designation:"Trailer",status:"Active",display_order:40}
];

let vehicleRegistry = [...fallbackVehicleRegistry];
let vehicleRegistryReady = false;

const operationalFormDefinitions = {
  driverPre: {
    parent: "driversLounge",
    eyebrow: "DRIVER'S LOUNGE",
    title: "Pre-Stint Check-In",
    subtitle: "A quick handoff before you get in the car. Share only what the team needs to know.",
    type: "driver_pre_stint",
    category: "Driver's Lounge",
    submitLabel: "Save Pre-Stint Check-In",
    identityField: "driver",
    summaryField: "vehicle_name",
    vehicleField: "vehicle",
    fields: [
      {id:"driver",label:"Driver / initials",type:"text",placeholder:"e.g. JB",required:true},
      {id:"vehicle_category",label:"Chassis category",type:"vehicleCategory",required:true},
      {id:"vehicle",label:"Exact vehicle",type:"vehicleExact",required:true,wide:true},
      {id:"session",label:"Session",type:"select",options:["Practice","Qualifying","Race","Testing","Other"]},
      {id:"readiness",label:"Physical / mental readiness",type:"select",options:["Ready","Mostly ready","Need support before driving"]},
      {id:"confidence",label:"Car confidence",type:"select",options:["High","Good","Needs attention"]},
      {id:"focus",label:"What is your focus for this stint?",type:"textarea",placeholder:"What are you trying to learn, execute, or protect?",wide:true},
      {id:"improve",label:"What do you want to improve or understand?",type:"textarea",placeholder:"What skill, decision, or part of the process are you working on?",wide:true},
      {id:"experiment",label:"What experiment or small test are you running?",type:"textarea",placeholder:"What are you trying differently, and what will tell you whether it helped?",wide:true},
      {id:"concerns",label:"Concerns before the stint",type:"textarea",placeholder:"Anything affecting focus, confidence, or readiness.",wide:true},
      {id:"team_need",label:"What should the team know or do?",type:"textarea",placeholder:"A setup question, request, or thing to watch.",wide:true}
    ]
  },
  driverPost: {
    parent: "driversLounge",
    eyebrow: "DRIVER'S LOUNGE",
    title: "Post-Stint Debrief",
    subtitle: "Capture the useful details while they are still fresh for the next driver and crew.",
    type: "driver_post_stint",
    category: "Driver's Lounge",
    submitLabel: "Save Post-Stint Debrief",
    identityField: "driver",
    summaryField: "vehicle_name",
    vehicleField: "vehicle",
    fields: [
      {id:"driver",label:"Driver / initials",type:"text",placeholder:"e.g. JB",required:true},
      {id:"vehicle_category",label:"Chassis category",type:"vehicleCategory",required:true},
      {id:"vehicle",label:"Exact vehicle",type:"vehicleExact",required:true,wide:true},
      {id:"session",label:"Session",type:"select",options:["Practice","Qualifying","Race","Testing","Other"]},
      {id:"overall",label:"Overall stint",type:"select",options:["Good","Mixed","Needs follow-up"]},
      {id:"focus_result",label:"Looking back at your pre-stint focus, what did you notice?",type:"textarea",placeholder:"Did you execute, learn, or protect what you set out to?",wide:true},
      {id:"improve_result",label:"What did you improve or understand?",type:"textarea",placeholder:"What changed in the skill, decision, or process you were working on?",wide:true},
      {id:"experiment_result",label:"What did your experiment or small test show?",type:"textarea",placeholder:"What did you try, and what should we keep, change, or test next?",wide:true},
      {id:"car_behavior",label:"Car behavior and performance",type:"textarea",placeholder:"Balance, grip, traffic, temperatures, tires, brakes, reliability...",wide:true},
      {id:"communication",label:"Communication and pit experience",type:"textarea",placeholder:"What worked, what was unclear, or what slowed the stint.",wide:true},
      {id:"issues",label:"Issues or concerns to follow up",type:"textarea",placeholder:"Anything the next driver or crew should know.",wide:true},
      {id:"next_notes",label:"Next-driver / next-session notes",type:"textarea",placeholder:"The most useful handoff for what comes next.",wide:true}
    ]
  },
  driverFeedback: {
    parent: "driversLounge",
    eyebrow: "DRIVER'S LOUNGE",
    title: "Driver Feedback",
    subtitle: "A deeper driver perspective on the car, preparation, communication, and team experience.",
    type: "driver_feedback",
    category: "Driver's Lounge",
    submitLabel: "Submit Driver Feedback",
    identityField: "driver",
    summaryField: "focus",
    fields: [
      {id:"driver",label:"Driver / initials",type:"text",placeholder:"Optional",wide:true},
      {id:"focus",label:"Main area",type:"select",options:["Car / setup","Preparation","Pit / radio communication","Team workflow","Driver experience","Other"]},
      {id:"feedback",label:"What should the team know?",type:"textarea",placeholder:"Specific observations, examples, or suggestions.",required:true,wide:true},
      {id:"follow_up",label:"Is it okay for us to follow up with you?",type:"checkbox"}
    ]
  },
  technicalReport: {
    parent: "shopTalk",
    eyebrow: "SHOP TALK",
    title: "Technical / Car Report",
    subtitle: "Record a finding, setup concern, repair, failure, or post-session technical note.",
    type: "technical_car_report",
    category: "Shop Talk",
    submitLabel: "Submit Technical Report",
    identityField: "reporter",
    summaryField: "vehicle_name",
    vehicleField: "vehicle",
    fields: [
      {id:"reporter",label:"Reporter / initials",type:"text",placeholder:"Optional"},
      {id:"vehicle_category",label:"Chassis category",type:"vehicleCategory",required:true},
      {id:"vehicle",label:"Exact vehicle",type:"vehicleExact",required:true,wide:true},
      {id:"session",label:"When noticed",type:"select",options:["Before session","During session","After session","In shop","Other"]},
      {id:"urgency",label:"Urgency",type:"select",options:["Routine","Before next session","Stop and inspect"]},
      {id:"finding",label:"Finding or observation",type:"textarea",placeholder:"What happened, what you saw, or what changed.",required:true,wide:true},
      {id:"action",label:"Action taken or needed",type:"textarea",placeholder:"Repair, inspection, setup change, parts, or decision needed.",wide:true}
    ]
  },
  incidentReport: {
    parent: "shopTalk",
    eyebrow: "SHOP TALK",
    title: "Incident / Damage Report",
    subtitle: "Document contact, damage, failures, or anything that needs immediate follow-up.",
    type: "incident_damage_report",
    category: "Shop Talk",
    submitLabel: "Submit Incident Report",
    identityField: "reporter",
    summaryField: "vehicle_name",
    vehicleField: "vehicle",
    fields: [
      {id:"reporter",label:"Reporter / initials",type:"text",placeholder:"Optional"},
      {id:"vehicle_category",label:"Chassis category",type:"vehicleCategory",required:true},
      {id:"vehicle",label:"Exact vehicle",type:"vehicleExact",required:true,wide:true},
      {id:"when",label:"When / session",type:"text",placeholder:"e.g. Race 2, lap 14"},
      {id:"safe_to_run",label:"Safe to run?",type:"select",options:["Unknown - inspect first","Yes - no apparent safety issue","No - hold vehicle"]},
      {id:"incident",label:"What happened?",type:"textarea",placeholder:"Describe the incident or failure factually.",required:true,wide:true},
      {id:"damage",label:"Damage or affected area",type:"textarea",placeholder:"Visible damage, symptoms, or parts involved.",wide:true},
      {id:"immediate_action",label:"Immediate action / follow-up needed",type:"textarea",placeholder:"Who needs to know, what should happen next, and by when.",wide:true}
    ]
  },
  crewOperations: {
    parent: "shopTalk",
    eyebrow: "SHOP TALK",
    title: "Crew Operations",
    subtitle: "Capture the shop, paddock, pit, tool, loading, logistics, and workflow issues that keep the team moving.",
    type: "crew_operations",
    category: "Shop Talk",
    submitLabel: "Submit Crew Operations Note",
    identityField: "reporter",
    summaryField: "area",
    fields: [
      {id:"reporter",label:"Reporter / initials",type:"text",placeholder:"Optional"},
      {id:"area",label:"Team area",type:"select",options:["Shop","Paddock","Pit","Tools / equipment","Loading / transport","Parts / inventory","Hospitality","Other"],required:true},
      {id:"request",label:"What needs attention?",type:"textarea",placeholder:"The problem, request, or opportunity.",required:true,wide:true},
      {id:"blocker",label:"What is blocked or creating extra work?",type:"textarea",placeholder:"People, time, information, equipment, access, or workflow.",wide:true},
      {id:"next_step",label:"Suggested next step",type:"textarea",placeholder:"What would make this easier or prevent it next time.",wide:true}
    ]
  }
};

let activeCategory = "";
let answers = {};
let portalHistoryDepth = 0;
let pendingPortalResetScreen = null;
let portalHistoryReady = false;
let portalNoticeTimer = null;
let activeOperationalFormKey = "";

function renderPortalScreen(id){
  const target=document.getElementById(id);
  if(!target){
    console.error(`Unknown portal screen: ${id}`);
    return false;
  }

  document.querySelectorAll(".screen").forEach(x=>x.classList.remove("active"));
  target.classList.add("active");

  const homeBtn=document.getElementById("globalHomeButton");
  if(homeBtn) homeBtn.classList.toggle("hidden",id==="home");

  window.scrollTo(0,0);
  if(id==="admin") renderAdmin();
  return true;
}

function portalHistoryUrl(id){
  return `${window.location.pathname}${window.location.search}#${id}`;
}

function showPortalNavNotice(message){
  let notice=document.getElementById("portalNavNotice");
  if(!notice){
    notice=document.createElement("div");
    notice.id="portalNavNotice";
    notice.className="portal-nav-notice";
    notice.setAttribute("role","status");
    notice.setAttribute("aria-live","polite");
    document.body.appendChild(notice);
  }

  notice.textContent=message;
  notice.classList.add("show");
  clearTimeout(portalNoticeTimer);
  portalNoticeTimer=setTimeout(()=>notice.classList.remove("show"),1600);
}

function showScreen(id,{historyMode="push"}={}){
  if(!renderPortalScreen(id)) return;
  if(!portalHistoryReady || historyMode==="none") return;

  const current=window.history.state;
  if(historyMode==="replace"){
    window.history.replaceState(
      {otrPortal:true,screen:id,depth:portalHistoryDepth},
      "",
      portalHistoryUrl(id)
    );
    return;
  }

  if(current?.otrPortal && current.screen===id) return;

  portalHistoryDepth+=1;
  window.history.pushState(
    {otrPortal:true,screen:id,depth:portalHistoryDepth},
    "",
    portalHistoryUrl(id)
  );
}

function portalBack(fallback="home"){
  if(portalHistoryReady && portalHistoryDepth>0){
    window.history.back();
    return;
  }

  if(fallback==="home"){
    resetAndHome();
  }else{
    showScreen(fallback,{historyMode:"replace"});
  }
}

function resetPortalNavigation(target="home"){
  pendingPortalResetScreen=target;
  renderPortalScreen("home");

  if(portalHistoryReady && portalHistoryDepth>0){
    window.history.go(-portalHistoryDepth);
    return;
  }

  pendingPortalResetScreen=null;
  if(target!=="home") showScreen(target);
}

function initializePortalHistory(){
  window.history.replaceState(
    {otrPortalGuard:true,screen:"home",depth:-1},
    "",
    portalHistoryUrl("home")
  );
  window.history.pushState(
    {otrPortal:true,screen:"home",depth:0},
    "",
    portalHistoryUrl("home")
  );

  portalHistoryDepth=0;
  portalHistoryReady=true;

  window.addEventListener("popstate",event=>{
    const state=event.state;

    if(state?.otrPortalGuard){
      showPortalNavNotice("Already at Home");
      window.history.forward();
      return;
    }

    if(!state?.otrPortal){
      window.history.forward();
      return;
    }

    portalHistoryDepth=Math.max(0,Number(state.depth)||0);
    renderPortalScreen(state.screen||"home");

    if(portalHistoryDepth===0 && pendingPortalResetScreen){
      const target=pendingPortalResetScreen;
      pendingPortalResetScreen=null;
      if(target!=="home") showScreen(target);
    }
  });
}

function renderCategories(){
  const wrap=document.getElementById("categoryButtons");
  wrap.innerHTML="";
  categories.forEach(c=>{
    const b=document.createElement("button");
    b.className="catbtn";
    b.textContent=c;
    b.onclick=()=>openFeedback(c);
    wrap.appendChild(b);
  });
}

function openFeedback(category){
  activeCategory=category;
  answers={};
  document.getElementById("feedbackTitle").textContent=category;
  document.getElementById("quickText").value="";
  document.getElementById("detailText").value="";
  document.getElementById("nameText").value="";
  document.getElementById("followUpOk").checked=false;
  renderQuestions();
  showScreen("feedback");
}

function renderQuestions(){
  const wrap=document.getElementById("questionWrap");
  wrap.innerHTML="";
  questions.forEach((q,idx)=>{
    const div=document.createElement("div");
    div.className="question";
    div.innerHTML=`
      <label for="q-${idx}">${idx+1}. ${q}</label>
      <textarea id="q-${idx}" maxlength="1200"
        placeholder="Optional — add what you know, noticed, needed, or want preserved."
        oninput="answers[${idx}]=this.value"></textarea>
    `;
    wrap.appendChild(div);
  });
}


function cryptoId(){
  return "otr-"+Date.now().toString(36)+"-"+Math.random().toString(36).slice(2,8);
}

function vehicleDisplayLabel(vehicle){
  if(!vehicle) return "";
  const name=String(vehicle.vehicle_name||"").trim();
  const designation=String(vehicle.designation||"").trim();
  return designation ? `${name} — ${designation}` : name;
}

function vehicleOptionsForCategory(category){
  return vehicleRegistry
    .filter(vehicle=>vehicle.platform===category)
    .sort((a,b)=>Number(a.display_order||0)-Number(b.display_order||0)
      || String(a.vehicle_name||"").localeCompare(String(b.vehicle_name||"")));
}

function refreshOperationalVehicleOptions(){
  const categoryEl=document.getElementById("op-vehicle_category");
  const vehicleEl=document.getElementById("op-vehicle");
  if(!vehicleEl) return;

  const category=categoryEl?.value||"";
  const previous=vehicleEl.value;
  const options=vehicleOptionsForCategory(category);
  const prompt=category
    ? (options.length ? "Choose exact vehicle…" : "No vehicles listed for this category")
    : "Choose chassis category first";

  vehicleEl.innerHTML=`<option value="">${escapeHtml(prompt)}</option>`+
    options.map(vehicle=>{
      const status=String(vehicle.status||"Active").trim();
      const designation=String(vehicle.designation||"").trim();
      const designationTokens=designation.toLowerCase().split(/[\s/]+/).filter(Boolean);
      const suffix=status && status!=="Active" && !designationTokens.includes(status.toLowerCase())
        ? ` (${status})` : "";
      return `<option value="${escapeHtml(vehicle.vehicle_code)}">${escapeHtml(vehicleDisplayLabel(vehicle))}${escapeHtml(suffix)}</option>`;
    }).join("");
  vehicleEl.disabled=!category || !options.length;

  if(options.some(vehicle=>vehicle.vehicle_code===previous)) vehicleEl.value=previous;
}

async function loadVehicleRegistry(){
  try{
    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/vehicles?select=vehicle_code,platform,vehicle_name,designation,status,display_order&order=platform,display_order,vehicle_name`,
      {headers:{"apikey":SUPABASE_KEY}}
    );
    if(!response.ok) throw new Error(`Vehicle registry read failed: ${response.status}`);
    const rows=await response.json();
    if(Array.isArray(rows) && rows.length){
      vehicleRegistry=rows;
      vehicleRegistryReady=true;
    }
  }catch(err){
    console.warn("Vehicle registry unavailable; using bundled registry.",err);
  }
  refreshOperationalVehicleOptions();
}

function operationalFieldHtml(field){
  const id=`op-${field.id}`;
  const wide=field.wide?" wide":"";
  if(field.type==="textarea"){
    return `<div class="question${wide}"><label for="${id}">${escapeHtml(field.label)}</label><textarea id="${id}" data-operational-field="${escapeHtml(field.id)}" maxlength="2000" placeholder="${escapeHtml(field.placeholder||"")}"></textarea></div>`;
  }
  if(field.type==="checkbox"){
    return `<div class="question${wide}"><label class="checkrow" style="margin:0"><input id="${id}" data-operational-field="${escapeHtml(field.id)}" type="checkbox" /><span>${escapeHtml(field.label)}</span></label></div>`;
  }
  if(field.type==="select"){
    const options=(field.options||[]).map(option=>`<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("");
    return `<div class="question${wide}"><label for="${id}">${escapeHtml(field.label)}</label><select id="${id}" data-operational-field="${escapeHtml(field.id)}"><option value="">Choose one…</option>${options}</select></div>`;
  }
  if(field.type==="vehicleCategory"){
    const options=internalVehicleCategories
      .map(category=>`<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`)
      .join("");
    return `<div class="question${wide}"><label for="${id}">${escapeHtml(field.label)}</label><select id="${id}" data-operational-field="${escapeHtml(field.id)}" onchange="refreshOperationalVehicleOptions()"><option value="">Choose chassis category…</option>${options}</select></div>`;
  }
  if(field.type==="vehicleExact"){
    return `<div class="question${wide}"><label for="${id}">${escapeHtml(field.label)}</label><select id="${id}" data-operational-field="${escapeHtml(field.id)}" disabled onchange="refreshOperationalVehicleOptions()"><option value="">Choose chassis category first</option></select></div>`;
  }
  return `<div class="question${wide}"><label for="${id}">${escapeHtml(field.label)}</label><input id="${id}" data-operational-field="${escapeHtml(field.id)}" maxlength="160" placeholder="${escapeHtml(field.placeholder||"")}" /></div>`;
}

function openOperationalForm(key){
  const def=operationalFormDefinitions[key];
  if(!def) return;
  activeOperationalFormKey=key;
  document.getElementById("operationalFormEyebrow").textContent=def.eyebrow;
  document.getElementById("operationalFormTitle").textContent=def.title;
  document.getElementById("operationalFormSubtitle").textContent=def.subtitle;
  document.getElementById("operationalFormFields").innerHTML=def.fields.map(operationalFieldHtml).join("");
  document.getElementById("operationalFormSubmitBtn").textContent=def.submitLabel;
  refreshOperationalVehicleOptions();
  showScreen("operationalForm");
}

function leaveOperationalForm(){
  const def=operationalFormDefinitions[activeOperationalFormKey];
  portalBack(def?.parent||"home");
}

function resetFormSection(id){
  const section=document.getElementById(id);
  if(!section) return;

  section.querySelectorAll("input, textarea, select").forEach(field=>{
    if(field.type==="checkbox" || field.type==="radio"){
      field.checked=false;
    }else if(field.tagName==="SELECT"){
      field.selectedIndex=0;
    }else{
      field.value="";
    }
  });
}

function resetAndHome(){
  activeCategory="";
  answers={};

  ["feedback", "postevent", "problem", "idea", "wishlist", "operationalForm"].forEach(resetFormSection);

  resetPortalNavigation("home");
}

function startMoreFeedback(){
  activeCategory="";
  answers={};
  resetFormSection("feedback");
  resetPortalNavigation("categories");
}


function escapeHtml(s){
  return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}


