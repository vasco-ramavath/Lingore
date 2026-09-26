import { supabase } from "./supabase.js";
import { VoiceCall } from "./webrtc.js";
import "./style.css";

const app = document.querySelector("#app");
let session = null, profile = null, currentCall = null;
let timer = null, matchingTimer = null, matchingChannel = null, startedAt = null;
let finishing = false, lastPeerId = null;

const languages = ["English","Spanish","French","German","Japanese","Korean","Hindi","Telugu","Chinese","Italian","Portuguese","Russian","Arabic","Bengali","Tamil","Malayalam","Kannada","Marathi"];
const avatars = ["馃寧","馃","馃惣","馃惎","馃惃","馃","馃惛","馃惖","馃惎","馃","馃悪","馃"];
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function layout(body){ app.innerHTML = body; window.scrollTo(0,0); }
function btn(label,id="",cls=""){ return `<button class="btn ${cls}" id="${id}">${label}</button>`; }
function avatar(id, cls="avatar"){ return `<div class="${cls}">${esc(id || "馃寧")}</div>`; }
function minutes(){ return Math.round((profile?.total_seconds||0)/60); }
function googleName(){ return session?.user?.user_metadata?.full_name || session?.user?.user_metadata?.name || ""; }

async function boot(){
  const {data:{session:s}} = await supabase.auth.getSession();
  session=s;
  supabase.auth.onAuthStateChange((_e,s)=>{
    session=s;
    if(!s){ profile=null; cleanupMatch(); renderLogin(); }
  });
  if(!session) return renderLogin();
  await loadProfile();
  if(!profile || !profile.onboarding_completed) return renderOnboarding();
  renderHome();
}

async function loadProfile(){
  const {data,error}=await supabase.from("profiles").select("*").eq("id",session.user.id).maybeSingle();
  if(error) console.error(error);
  profile=data;
}

function renderLogin(){
  layout(`<section class="center-card">
    <div class="brand">Ling<span>ore</span></div><p class="tag">Talk beyond borders.</p>
    <div class="globe">馃寧</div><h1>Meet real people.<br>Practice real languages.</h1>
    <p class="muted">Voice-only conversations. No AI. No video calls.</p>
    ${btn("Continue with Google 鈫�","google","google")}
    <small>Your Google account is only used to create your Lingore account.</small>
  </section>`);
  document.querySelector("#google").onclick=async()=>{
    const {error}=await supabase.auth.signInWithOAuth({provider:"google",options:{redirectTo:location.origin}});
    if(error) alert(error.message);
  };
}

function renderOnboarding(){
  const p=profile||{};
  layout(`<section class="page onboarding">
    <div class="brand sm">Ling<span>ore</span></div><h1>Create your profile</h1>
    <p class="muted">Choose how you want people to see you and who you want to practice with.</p>
    <div class="avatar-preview">${avatar(p.avatar_id||"馃寧","big-avatar")}</div>
    <label>Choose an avatar<div class="avatar-grid" id="avatars">${avatars.map(a=>`<button type="button" class="avatar-choice ${(p.avatar_id||"馃寧")===a?"selected":""}" data-avatar="${a}">${a}</button>`).join("")}</div></label>
    <label>Display name<input id="name" maxlength="40" value="${esc(p.name && p.name!=="Lingore User" ? p.name : googleName())}" placeholder="Your nickname"></label>
    <label>Native language<select id="native">${languages.map(x=>`<option ${x===(p.native_language||"English")?"selected":""}>${x}</option>`).join("")}</select></label>
    <label>Language to practice<select id="target">${languages.map(x=>`<option ${x===(p.target_language||"English")?"selected":""}>${x}</option>`).join("")}</select></label>
    <label>English level<select id="level"><option ${p.level==="Beginner"||!p.level?"selected":""}>Beginner</option><option ${p.level==="Intermediate"?"selected":""}>Intermediate</option><option ${p.level==="Advanced"?"selected":""}>Advanced</option></select></label>
    ${btn("Continue 鈫�","save","primary")}
  </section>`);
  let selected=p.avatar_id||"馃寧";
  document.querySelectorAll("[data-avatar]").forEach(b=>b.onclick=()=>{selected=b.dataset.avatar;document.querySelectorAll("[data-avatar]").forEach(x=>x.classList.toggle("selected",x===b));document.querySelector(".avatar-preview .big-avatar").textContent=selected;});
  document.querySelector("#save").onclick=async()=>{
    const payload={id:session.user.id,name:document.querySelector("#name").value.trim()||"Lingore User",avatar_id:selected,native_language:document.querySelector("#native").value,target_language:document.querySelector("#target").value,level:document.querySelector("#level").value,onboarding_completed:true};
    const {error}=await supabase.from("profiles").upsert(payload);
    if(error) return alert(error.message);
    profile={...profile,...payload}; renderHome();
  };
}

function renderHome(){
  layout(`<section class="page">
    <header><div><div class="brand sm">Ling<span>ore</span></div><p class="muted">Talk to the world.</p></div><div class="header-actions"><button class="icon-btn" id="notifications" aria-label="Notifications">馃敂</button><button class="avatar" id="profileBtn">${esc(profile.avatar_id||"馃寧")}</button></div></header>
    <div class="goal">馃敟 <b>${profile.current_streak||0} day streak</b><span>Keep going!</span></div>
    <div class="hero"><div class="globe">馃寧</div><h1>Talk beyond borders.</h1><p>Find a real person who wants to practice too.</p>${btn("馃帣 TALK NOW","talk","primary big")}</div>
    <div class="stats"><div><b>${profile.total_conversations||0}</b><span>Conversations</span></div><div><b>${minutes()}</b><span>Minutes</span></div><div><b>${esc(profile.level||"Beginner")}</b><span>Level</span></div></div>
    <div class="privacy-note">馃敀 Real people 鈥� Real voices 鈥� No AI 鈥� No video</div>
    <button id="signout" class="secondary">Sign out</button>
  </section>`);
  document.querySelector("#talk").onclick=startMatching;
  document.querySelector("#profileBtn").onclick=renderProfile;
  document.querySelector("#notifications").onclick=renderNotifications;
  document.querySelector("#signout").onclick=()=>supabase.auth.signOut();
}

function cleanupMatch(){
  if(matchingTimer) clearInterval(matchingTimer); matchingTimer=null;
  if(matchingChannel){ supabase.removeChannel(matchingChannel).catch(()=>{}); matchingChannel=null; }
}

async function leaveQueue(){ try{await supabase.rpc("leave_match_queue");}catch{} }

async function startMatching(){
  cleanupMatch();
  let secondsLeft=45;
  let active=true;
  layout(`<section class="page center"><div class="brand sm">Ling<span>ore</span></div><div class="radar">馃寧</div><h1>Finding your conversation鈥�</h1><p class="muted">Looking for a real person who matches your language and level.</p><div class="loader"></div><div class="countdown"><b id="countdown">45</b><span>seconds remaining</span></div>${btn("Cancel","cancel","secondary")}</section>`);
  document.querySelector("#cancel").onclick=async()=>{active=false;cleanupMatch();await leaveQueue();renderHome();};
  // Subscribe to the private match channel BEFORE entering the queue so a fast
  // match cannot be missed between the RPC and Realtime subscription.
  matchingChannel=supabase.channel(`match:${session.user.id}`,{config:{private:true}});
  matchingChannel.on("broadcast",{event:"matched"},async({payload})=>{
    if(!active)return;
    active=false; cleanupMatch(); await enterCall(payload.call_id,payload.peer_id,payload.initiator);
  });
  const sub=await matchingChannel.subscribe();
  if(sub !== "SUBSCRIBED"){
    active=false; cleanupMatch(); await leaveQueue();
    alert("Could not connect to the matching service. Please try again.");
    return renderHome();
  }

  const result=await supabase.rpc("find_or_queue_match",{p_native_language:profile.native_language,p_target_language:profile.target_language,p_level:profile.level});
  if(!active)return;
  if(result.error){active=false;cleanupMatch();alert(result.error.message);return renderHome();}
  if(result.data?.matched){active=false;cleanupMatch();return enterCall(result.data.call_id,result.data.peer_id,result.data.initiator);}

  matchingTimer=setInterval(async()=>{
    secondsLeft--;
    const el=document.querySelector("#countdown"); if(el) el.textContent=secondsLeft;
    if(secondsLeft<=0){
      active=false; cleanupMatch(); await leaveQueue();
      renderMatchTimeout();
    }
  },1000);
}

function renderMatchTimeout(){
  layout(`<section class="page center"><div class="brand sm">Ling<span>ore</span></div><div class="radar">馃寧</div><h1>No one is available right now</h1><p class="muted">Your search ended after 45 seconds. Try again to enter the matching pool again.</p>${btn("Try Again","retry","primary big")}${btn("Back to Home","home","secondary")}</section>`);
  document.querySelector("#retry").onclick=startMatching;
  document.querySelector("#home").onclick=renderHome;
}

async function enterCall(callId,peerId,initiator){
  cleanupMatch();
  lastPeerId=peerId;
  layout(`<section class="call"><div class="callbar"><span>Lingore call</span><span id="clock">00:00</span></div>
    <div class="person">${avatar(profile.avatar_id,"big-avatar")}<h1 id="callTitle">Connecting鈥�</h1><p>Real voice conversation</p><span id="callState" class="connecting">鈼� Connecting</span></div>
    <div class="call-actions"><button id="mute" class="round">馃帣</button><button id="end" class="round end">鈽�</button></div>
  </section>`);
  try{
    currentCall=new VoiceCall(callId,session.user.id,peerId);
    currentCall.onState=async s=>{
      const title=document.querySelector("#callTitle"), state=document.querySelector("#callState");
      if(s==="connected"){ if(title) title.textContent="Connected"; if(state){state.textContent="鈼� Connected";state.className="connected";} }
      if(s==="disconnected"){ if(title) title.textContent="Connection interrupted"; if(state){state.textContent="鈼� Reconnecting鈥�";state.className="connecting";} }
      if(s==="failed"){ if(title) title.textContent="Connection failed"; if(state){state.textContent="鈼� Disconnected";state.className="disconnected";} setTimeout(()=>finishCall(),1200); }
      if(s==="remote-hangup") await finishCall(true);
    };
    await currentCall.start();
    if(initiator) await currentCall.offer(); else currentCall.waitForOfferAndAnswer();
    startedAt=Date.now();
    timer=setInterval(()=>{const sec=Math.floor((Date.now()-startedAt)/1000);const el=document.querySelector("#clock");if(el)el.textContent=`${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;},1000);
    document.querySelector("#mute").onclick=async e=>{e.currentTarget.classList.toggle("active");await currentCall?.mute(e.currentTarget.classList.contains("active"));};
    document.querySelector("#end").onclick=()=>finishCall(false);
  }catch(e){
    console.error(e); alert(e?.name==="NotAllowedError"?"Microphone access is required for a voice call.":"Could not connect the voice call."); await finishCall(true);
  }
}

async function finishCall(remote=false){
  if(finishing)return; finishing=true;
  clearInterval(timer); timer=null;
  const seconds=startedAt?Math.max(1,Math.floor((Date.now()-startedAt)/1000)):0;
  const callId=currentCall?.callId || null;
  if(currentCall){await currentCall.end(remote);currentCall=null;}
  startedAt=null;
  if(callId) await supabase.rpc("finish_call",{p_call_id:callId,p_seconds:seconds});
  await loadProfile(); finishing=false;
  renderPostCall(seconds,lastPeerId);
  lastPeerId=null;
}

function renderPostCall(seconds,peerId){
  layout(`<section class="page center"><div class="brand sm">Ling<span>ore</span></div><div class="success-icon">鉁�</div><h1>Conversation ended</h1><p class="muted">You talked for <b>${Math.max(0,Math.floor(seconds/60))}:${String(seconds%60).padStart(2,"0")}</b>.</p><div class="stats compact"><div><b>${profile.total_conversations||0}</b><span>Conversations</span></div><div><b>${minutes()}</b><span>Minutes</span></div><div><b>${profile.current_streak||0}</b><span>Streak</span></div></div>${btn("馃帣 Talk to someone new","again","primary big")}${peerId?btn("馃毇 Block / Report","report","secondary"):""}${btn("Back to Home","home","secondary")}</section>`);
  document.querySelector("#again").onclick=startMatching;
  if(peerId) document.querySelector("#report").onclick=()=>renderReport(peerId);
  document.querySelector("#home").onclick=renderHome;
}

function renderReport(peerId){
  layout(`<section class="page"><button class="back" id="back">鈥�</button><h1>Safety report</h1><p class="muted">If something went wrong, you can block this person and optionally send a report.</p><label>Reason<select id="reason"><option>Harassment</option><option>Spam</option><option>Inappropriate behaviour</option><option>Other</option></select></label><label>Details<textarea id="details" rows="5" placeholder="Tell us what happened"></textarea></label>${btn("馃毇 Block user","block","secondary")}${btn("Report user","send","primary")}</section>`);
  document.querySelector("#back").onclick=renderHome;
  document.querySelector("#block").onclick=async()=>{const {error}=await supabase.from("blocks").upsert({blocker_id:session.user.id,blocked_id:peerId});if(error)return alert(error.message);await supabase.from("notifications").insert({user_id:session.user.id,type:"safety",title:"User blocked",body:"This user will not be matched with you again."}).catch(()=>{});renderHome();};
  document.querySelector("#send").onclick=async()=>{const {error}=await supabase.from("reports").insert({reporter_id:session.user.id,reported_id:peerId,reason:document.querySelector("#reason").value,details:document.querySelector("#details").value.trim()});if(error)return alert(error.message);await supabase.from("blocks").upsert({blocker_id:session.user.id,blocked_id:peerId});alert("Report submitted. The user is also blocked from future matches.");renderHome();};
}

function renderProfile(){
  layout(`<section class="page"><button class="back" id="back">鈥�</button><div class="profile-head">${avatar(profile.avatar_id,"big-avatar")}<h1>${esc(profile.name)}</h1><p>${esc(profile.native_language)} 鈫� ${esc(profile.target_language)} 鈥� ${esc(profile.level)}</p></div>
  <div class="stats"><div><b>${profile.total_conversations||0}</b><span>Conversations</span></div><div><b>${minutes()}</b><span>Total minutes</span></div><div><b>${profile.current_streak||0}</b><span>Day streak</span></div></div>
  <div class="list"><button id="edit">鉁忥笍 Edit profile <span>鈥�</span></button><button id="notify">馃敂 Notifications <span>鈥�</span></button><button id="safety">馃洝锔� Safety & Privacy <span>鈥�</span></button><button id="blocked">馃毇 Blocked users <span>鈥�</span></button><button id="delete" class="danger">馃棏锔� Delete account <span>鈥�</span></button></div></section>`);
  document.querySelector("#back").onclick=renderHome;
  document.querySelector("#edit").onclick=renderEditProfile;
  document.querySelector("#notify").onclick=renderNotifications;
  document.querySelector("#safety").onclick=renderSafety;
  document.querySelector("#blocked").onclick=renderBlocked;
  document.querySelector("#delete").onclick=deleteAccount;
}

function renderEditProfile(){
  let selected=profile.avatar_id||"馃寧";
  layout(`<section class="page"><button class="back" id="back">鈥�</button><h1>Edit profile</h1><p class="muted">Your nickname and avatar can be changed anytime.</p><div class="avatar-preview">${avatar(selected,"big-avatar")}</div><div class="avatar-grid" id="avatars">${avatars.map(a=>`<button type="button" class="avatar-choice ${a===selected?"selected":""}" data-avatar="${a}">${a}</button>`).join("")}</div><label>Nickname<input id="name" maxlength="40" value="${esc(profile.name)}"></label><label>Native language<select id="native">${languages.map(x=>`<option ${x===profile.native_language?"selected":""}>${x}</option>`).join("")}</select></label><label>Language to practice<select id="target">${languages.map(x=>`<option ${x===profile.target_language?"selected":""}>${x}</option>`).join("")}</select></label><label>English level<select id="level"><option ${profile.level==="Beginner"?"selected":""}>Beginner</option><option ${profile.level==="Intermediate"?"selected":""}>Intermediate</option><option ${profile.level==="Advanced"?"selected":""}>Advanced</option></select></label>${btn("Save changes","save","primary")}</section>`);
  document.querySelectorAll("[data-avatar]").forEach(b=>b.onclick=()=>{selected=b.dataset.avatar;document.querySelectorAll("[data-avatar]").forEach(x=>x.classList.toggle("selected",x===b));document.querySelector(".avatar-preview .big-avatar").textContent=selected;});
  document.querySelector("#back").onclick=renderProfile;
  document.querySelector("#save").onclick=async()=>{const payload={name:document.querySelector("#name").value.trim()||"Lingore User",avatar_id:selected,native_language:document.querySelector("#native").value,target_language:document.querySelector("#target").value,level:document.querySelector("#level").value};const {error}=await supabase.from("profiles").update(payload).eq("id",session.user.id);if(error)return alert(error.message);await loadProfile();renderProfile();};
}

async function renderNotifications(){
  const enabled=profile.notifications_enabled!==false;
  let items=[];
  try{const r=await supabase.from("notifications").select("id,title,body,read_at,created_at").eq("user_id",session.user.id).order("created_at",{ascending:false}).limit(30);if(!r.error)items=r.data||[];}catch{}
  layout(`<section class="page"><button class="back" id="back">鈥�</button><h1>Notifications</h1><div class="setting"><div><b>Notifications</b><p class="muted">Allow Lingore to show in-app notifications.</p></div><button id="toggle" class="switch ${enabled?"on":""}"><span></span></button></div><div class="notification-list">${items.length?items.map(n=>`<div class="notification ${n.read_at?"read":""}"><b>${esc(n.title)}</b><p>${esc(n.body||"")}</p><small>${new Date(n.created_at).toLocaleString()}</small></div>`).join(""):"<div class='empty'>You're all caught up.</div>"}</div></section>`);
  document.querySelector("#back").onclick=renderProfile;
  document.querySelector("#toggle").onclick=async()=>{const next=!enabled;const {error}=await supabase.from("profiles").update({notifications_enabled:next}).eq("id",session.user.id);if(error)return alert(error.message);profile.notifications_enabled=next;renderNotifications();};
  if(items.some(n=>!n.read_at)) await supabase.from("notifications").update({read_at:new Date().toISOString()}).eq("user_id",session.user.id).is("read_at",null);
}

function renderSafety(){
  layout(`<section class="page"><button class="back" id="back">鈥�</button><h1>Safety & Privacy</h1><div class="info-card"><b>Voice only</b><p>Your Lingore calls use microphone audio. Video is not requested by the app.</p></div><div class="info-card"><b>Block</b><p>Blocked users cannot be matched with you.</p></div><div class="info-card"><b>Report</b><p>Use the report flow after a conversation if someone violates the rules.</p></div></section>`);
  document.querySelector("#back").onclick=renderProfile;
}

async function renderBlocked(){
  const {data}=await supabase.from("blocks").select("blocked_id,created_at").eq("blocker_id",session.user.id).order("created_at",{ascending:false});
  layout(`<section class="page"><button class="back" id="back">鈥�</button><h1>Blocked users</h1><p class="muted">These accounts will not be matched with you.</p>${data?.length?data.map(b=>`<div class="row"><span>${esc(b.blocked_id.slice(0,8))}鈥�</span></div>`).join(""):"<div class='empty'>No blocked users.</div>"}</section>`);
  document.querySelector("#back").onclick=renderProfile;
}

async function deleteAccount(){
  if(!confirm("Delete your Lingore account permanently? This cannot be undone."))return;
  const {error}=await supabase.rpc("delete_my_account");
  if(error)return alert(error.message);
  await supabase.auth.signOut();
}

boot();
