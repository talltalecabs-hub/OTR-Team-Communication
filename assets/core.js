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

function showScreen(id){
  const target=document.getElementById(id);
  if(!target){
    console.error(`Unknown portal screen: ${id}`);
    return;
  }

  document.querySelectorAll(".screen").forEach(x=>x.classList.remove("active"));
  target.classList.add("active");

  const homeBtn=document.getElementById("globalHomeButton");
  if(homeBtn) homeBtn.classList.toggle("hidden",id==="home");

  window.scrollTo(0,0);
  if(id==="admin") renderAdmin();
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

  showScreen("home");
}


function escapeHtml(s){
  return String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}


