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

let activeCategory = "";
let answers = {};
let portalHistoryDepth = 0;
let pendingPortalResetScreen = null;
let portalHistoryReady = false;
let portalNoticeTimer = null;

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

  ["feedback", "postevent", "problem", "idea", "wishlist"].forEach(resetFormSection);

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


