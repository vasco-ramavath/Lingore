import { supabase } from "./supabase.js";
import { VoiceCall } from "./webrtc.js";
import "./style.css";

const app = document.querySelector("#app");
let session = null;
let profile = null;
let currentCall = null;
let timer = null;
let matchingTimer = null;
let matchingChannel = null;
let matchingPoll = null;
let startedAt = null;
let finishing = false;
let lastPeerId = null;

const languages = ["English","Spanish","French","German","Japanese","Korean","Hindi","Telugu","Chinese","Italian","Portuguese","Russian","Arabic","Bengali","Tamil","Malayalam","Kannada","Marathi"];
const avatars = ["🌎","🦊","🐼","🐯","🐨","🦁","🐸","🐵","🦄","🐙","🦋","🐺"];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function layout(body){ app.innerHTML = `<div class="shell">${body}</div>`; window.scrollTo(0,0); }
function btn(label,id,cls="primary"){ return `<button class="btn ${cls}" id="${id}">${label}</button>`; }
function avatar(id, cls="avatar"){ return `<div class="${cls}">${esc(id || "🌎")}</div>`; }
function minutes(){ return Math.round((profile?.total_seconds || 0) / 60); }
function googleName(){ return session?.user?.user_metadata?.full_name || session?.user?.user_metadata?.name || ""; }

async function boot(){
  const { data:{session:s} } = await supabase.auth.getSession();
  session = s;
  supabase.auth.onAuthStateChange((_event, s) => {
    session = s;
    if (!s) { profile = null; cleanupMatch(); renderLogin(); }
  });
  if (!session) return renderLogin();
  await loadProfile();
  if (!profile || !profile.onboarding_completed) return renderOnboarding();
  renderHome();
}

async function loadProfile(){
  const { data, error } = await supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) console.error("PROFILE LOAD:", error);
  profile = data;
}

function renderLogin(){
  layout(`<section class="center-card"><div class="brand">Ling<span>ore</span></div><p class="tag">Talk beyond borders.</p><div class="globe">🌎</div><h1>Meet real people.<br>Practice real languages.</h1><p class="muted">Voice-only conversations. No AI. No video calls.</p>${btn("Continue with Google →","google","google")}<small>Your Google account is only used to create your Lingore account.</small></section>`);
  document.querySelector("#google").onclick = async () => {
    const { error } = await supabase.auth.signInWithOAuth({ provider:"google", options:{ redirectTo:location.origin } });
    if (error) alert(error.message);
  };
}

function renderOnboarding(){
  const p = profile || {};
  layout(`<section class="page onboarding"><div class="brand sm">Ling<span>ore</span></div><h1>Create your profile</h1><p class="muted">Choose your avatar, name and the language you want to practice.</p><div class="avatar-preview">${avatar(p.avatar_id || "🌎","big-avatar")}</div><label>Choose an avatar<div class="avatar-grid">${avatars.map(a=>`<button type="button" class="avatar-choice ${(p.avatar_id||"🌎")===a?"selected":""}" data-avatar="${a}">${a}</button>`).join("")}</div></label><label>Display name<input id="name" maxlength="40" value="${esc(p.name && p.name!=="Lingore User" ? p.name : googleName())}" placeholder="Your name"></label><label>Language to practice<select id="target">${languages.map(x=>`<option ${x===(p.target_language||"English")?"selected":""}>${x}</option>`).join("")}</select></label><label>Level<select id="level">${["Beginner","Intermediate","Advanced"].map(x=>`<option ${x===(p.level||"Beginner")?"selected":""}>${x}</option>`).join("")}</select></label>${btn("Continue →","save","primary")}</section>`);
  let selected = p.avatar_id || "🌎";
  document.querySelectorAll("[data-avatar]").forEach(b => b.onclick = () => { selected=b.dataset.avatar; document.querySelectorAll("[data-avatar]").forEach(x=>x.classList.toggle("selected",x===b)); document.querySelector(".avatar-preview .big-avatar").textContent=selected; });
  document.querySelector("#save").onclick = async () => {
    const payload = { id:session.user.id, name:document.querySelector("#name").value.trim()||"Lingore User", avatar_id:selected, target_language:document.querySelector("#target").value, level:document.querySelector("#level").value, onboarding_completed:true };
    const { error } = await supabase.from("profiles").update(payload).eq("id",session.user.id);
    if (error) return alert(error.message);
    await loadProfile(); renderHome();
  };
}

function renderHome(){
  layout(`<section class="page"><header><div><div class="brand sm">Ling<span>ore</span></div><p class="muted">Talk to the world.</p></div><button class="avatar" id="profileBtn">${esc(profile.avatar_id||"🌎")}</button></header><div class="goal">🔥 <b>${profile.current_streak||0} day streak</b><span>Keep going!</span></div><div class="hero"><div class="globe">🌎</div><h1>Talk beyond borders.</h1><p>Find a real person who wants to practice too.</p>${btn("🎙 TALK NOW","talk","primary big")}</div><div class="stats"><div><b>${profile.total_conversations||0}</b><span>Conversations</span></div><div><b>${minutes()}</b><span>Minutes</span></div><div><b>${esc(profile.level||"Beginner")}</b><span>Level</span></div></div><div class="privacy-note">🔒 Real people • Real voices • No AI • No video</div></section>`);
  document.querySelector("#talk").onclick = startMatching;
  document.querySelector("#profileBtn").onclick = renderProfile;
}

function cleanupMatch(){
  if (matchingTimer) clearInterval(matchingTimer);
  matchingTimer = null;
  if (matchingPoll) clearInterval(matchingPoll);
  matchingPoll = null;
  if (matchingChannel) { supabase.removeChannel(matchingChannel).catch(()=>{}); matchingChannel=null; }
}
async function leaveQueue(){ try { await supabase.rpc("leave_match_queue"); } catch(e) { console.warn("QUEUE CLEANUP:",e); } }

async function findActiveCall(){
  const { data, error } = await supabase.from("calls").select("id,user_a,user_b,status,started_at").eq("status","active").or(`user_a.eq.${session.user.id},user_b.eq.${session.user.id}`).order("started_at",{ascending:false}).limit(1).maybeSingle();
  if (error) { console.warn("ACTIVE CALL CHECK:",error); return null; }
  return data || null;
}

async function startMatching(){
  cleanupMatch();
  let active = true;
  let secondsLeft = 45;
  layout(`<section class="page center"><div class="brand sm">Ling<span>ore</span></div><div class="radar">🌎</div><h1>Finding your conversation…</h1><p class="muted">Looking for someone practicing the same language.</p><div class="loader"></div><div class="countdown"><b id="countdown">45</b><span>seconds remaining</span></div>${btn("Cancel","cancel","secondary")}</section>`);
  document.querySelector("#cancel").onclick = async () => { active=false; cleanupMatch(); await leaveQueue(); renderHome(); };

  const existing = await findActiveCall();
  if (existing) { active=false; alert("You already have an active call. End that call first."); return renderHome(); }

  const { data:{session:fresh} } = await supabase.auth.getSession();
  if (!fresh?.access_token) { active=false; return renderLogin(); }
  await supabase.realtime.setAuth(fresh.access_token);

  // Subscribe BEFORE queueing, then use a DB polling fallback so a missed Realtime
  // broadcast cannot leave the waiting user stuck on the matching screen.
  matchingChannel = supabase.channel(`match:${session.user.id}`, {config:{private:true}});
  matchingChannel.on("broadcast", {event:"matched"}, async ({payload}) => {
    if (!active || !payload?.call_id) return;
    active=false; cleanupMatch(); await enterCall(payload.call_id,payload.peer_id,payload.initiator);
  });
  await new Promise((resolve,reject) => {
    matchingChannel.subscribe((status,error) => {
      console.log("MATCH CHANNEL:",status,error||"");
      if (status === "SUBSCRIBED") resolve();
      else if (["CHANNEL_ERROR","TIMED_OUT","CLOSED"].includes(status)) reject(error||new Error(status));
    });
  }).catch(async e => { console.error(e); active=false; cleanupMatch(); await leaveQueue(); alert("Matching service could not connect. Please try again."); renderHome(); });
  if (!active) return;

  const result = await supabase.rpc("find_or_queue_match", {p_native_language:profile.target_language,p_target_language:profile.target_language,p_level:profile.level});
  if (!active) return;
  if (result.error) { active=false; cleanupMatch(); if(result.error.message.includes("already in a call")) alert("You already have an active call. End it first."); else alert(result.error.message); return renderHome(); }
  if (result.data?.matched) { active=false; cleanupMatch(); return enterCall(result.data.call_id,result.data.peer_id,result.data.initiator); }

  matchingPoll = setInterval(async () => {
    if (!active) return;
    const call = await findActiveCall();
    if (call) {
      active=false; cleanupMatch();
      const peerId = call.user_a === session.user.id ? call.user_b : call.user_a;
      return enterCall(call.id,peerId,false);
    }
  },1500);

  matchingTimer = setInterval(async () => {
    secondsLeft--; const el=document.querySelector("#countdown"); if(el) el.textContent=secondsLeft;
    if(secondsLeft<=0){ active=false; cleanupMatch(); await leaveQueue(); renderMatchTimeout(); }
  },1000);
}

function renderMatchTimeout(){
  layout(`<section class="page center"><div class="brand sm">Ling<span>ore</span></div><div class="radar">🌎</div><h1>No one is available right now</h1><p class="muted">Your search ended after 45 seconds.</p>${btn("Try Again","retry","primary big")}${btn("Back to Home","home","secondary")}</section>`);
  document.querySelector("#retry").onclick=startMatching; document.querySelector("#home").onclick=renderHome;
}

async function getPeerProfile(peerId){
  const {data,error}=await supabase.rpc("get_public_profile",{p_user_id:peerId});
  if(error) console.warn("PEER PROFILE:",error);
  return data || {name:"Conversation partner",avatar_id:"🌎"};
}

async function enterCall(callId,peerId){
  cleanupMatch(); lastPeerId=peerId;
  const peer=await getPeerProfile(peerId);
  layout(`<section class="call"><div class="callbar"><span>Lingore call</span><span id="clock">00:00</span></div><div class="person">${avatar(peer.avatar_id||"🌎","big-avatar")}<h1 id="callTitle">Connecting…</h1><h2 class="peer-name">${esc(peer.name||"Conversation partner")}</h2><p>Real voice conversation</p><span id="callState" class="connecting">● Connecting</span></div><div class="call-actions"><button id="mute" class="round" aria-label="Mute">🎙️</button><button id="speaker" class="round" aria-label="Speaker">🔊</button><button id="end" class="round end" aria-label="End call">☎</button></div></section>`);
  try{
    currentCall=new VoiceCall(callId,session.user.id,peerId);
    currentCall.onState=async state=>{
      const title=document.querySelector("#callTitle"), badge=document.querySelector("#callState");
      if(state==="connected" || state==="audio-ready"){ if(title) title.textContent="Connected"; if(badge){badge.textContent="● Connected";badge.className="connected";} }
      else if(state==="reconnecting"){ if(title) title.textContent="Reconnecting…"; if(badge){badge.textContent="● Reconnecting";badge.className="connecting";} }
      else if(state==="failed"){ if(title) title.textContent="Connection failed"; if(badge){badge.textContent="● Connection failed";badge.className="disconnected";} setTimeout(()=>finishCall(true),900); }
      else if(state==="remote-hangup") await finishCall(true);
    };
    await currentCall.start();
    startedAt=Date.now();
    timer=setInterval(()=>{const sec=Math.floor((Date.now()-startedAt)/1000);const el=document.querySelector("#clock");if(el)el.textContent=`${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;},1000);
    document.querySelector("#mute").onclick=async e=>{e.currentTarget.classList.toggle("active");await currentCall?.mute(e.currentTarget.classList.contains("active"));};
    document.querySelector("#speaker").onclick=async e=>{const on=await currentCall?.toggleSpeaker();e.currentTarget.classList.toggle("active",on!==false);};
    document.querySelector("#end").onclick=()=>finishCall(false);
  }catch(e){ console.error("ENTER CALL:",e); await finishCall(true); alert(e?.message||"Could not connect the voice call."); }
}

async function finishCall(remote=false){
  if(finishing)return; finishing=true; clearInterval(timer); timer=null;
  const seconds=startedAt?Math.max(1,Math.floor((Date.now()-startedAt)/1000)):0; const callId=currentCall?.callId||null; startedAt=null;
  if(currentCall){await currentCall.end(!remote);currentCall=null;}
  if(callId) await supabase.rpc("finish_call",{p_call_id:callId,p_seconds:seconds});
  await loadProfile(); finishing=false; renderPostCall(seconds,lastPeerId); lastPeerId=null;
}

function renderPostCall(seconds,peerId){
  layout(`<section class="page center"><div class="brand sm">Ling<span>ore</span></div><div class="success-icon">✓</div><h1>Conversation ended</h1><p class="muted">You talked for <b>${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}</b>.</p>${peerId?btn("🚫 Block / Report","report","secondary"):""}${btn("🎙 Talk to someone new","again","primary big")}${btn("Back to Home","home","secondary")}</section>`);
  if(peerId) document.querySelector("#report").onclick=()=>renderReport(peerId);
  document.querySelector("#again").onclick=startMatching; document.querySelector("#home").onclick=renderHome;
}

async function renderReport(peerId){
  layout(`<section class="page"><button class="back" id="back">‹</button><h1>Block / Report</h1><label>Reason<select id="reason"><option>Harassment</option><option>Spam</option><option>Inappropriate behaviour</option><option>Other</option></select></label><label>Details<textarea id="details" rows="5"></textarea></label>${btn("🚫 Block user","block","secondary")}${btn("Report user","send","primary")}</section>`);
  document.querySelector("#back").onclick=renderHome;
  document.querySelector("#block").onclick=async()=>{const {error}=await supabase.from("blocks").upsert({blocker_id:session.user.id,blocked_id:peerId});if(error)return alert(error.message);renderHome();};
  document.querySelector("#send").onclick=async()=>{const {error}=await supabase.from("reports").insert({reporter_id:session.user.id,reported_id:peerId,reason:document.querySelector("#reason").value,details:document.querySelector("#details").value.trim()});if(error)return alert(error.message);await supabase.from("blocks").upsert({blocker_id:session.user.id,blocked_id:peerId});alert("Report submitted and user blocked.");renderHome();};
}

function renderProfile(){
  layout(`<section class="page profile-page"><button class="back" id="back">‹</button><div class="profile-head">${avatar(profile.avatar_id,"big-avatar")}<h1>${esc(profile.name||"Lingore User")}</h1><p>${esc(profile.target_language||"English")} • ${esc(profile.level||"Beginner")}</p></div><div class="stats"><div><b>${profile.total_conversations||0}</b><span>Conversations</span></div><div><b>${minutes()}</b><span>Total minutes</span></div><div><b>${profile.current_streak||0}</b><span>Day streak</span></div></div><div class="profile-actions">${btn("✏️ Edit profile","edit","profile-action")}${btn("🗑️ Delete account","delete","profile-action danger")}${btn("↪️ Sign out","signout","profile-action")}</div><div class="developer-watermark">Developed by <b>Vasco</b></div></section>`);
  document.querySelector("#back").onclick=renderHome; document.querySelector("#edit").onclick=renderEditProfile; document.querySelector("#delete").onclick=deleteAccount; document.querySelector("#signout").onclick=async()=>{await leaveQueue();await supabase.auth.signOut();};
}

function renderEditProfile(){
  let selected=profile.avatar_id||"🌎";
  layout(`<section class="page"><button class="back" id="back">‹</button><h1>Edit profile</h1><p class="muted">Update your name, avatar, language and level.</p><div class="avatar-preview">${avatar(selected,"big-avatar")}</div><div class="avatar-grid">${avatars.map(a=>`<button type="button" class="avatar-choice ${a===selected?"selected":""}" data-avatar="${a}">${a}</button>`).join("")}</div><label>Display name<input id="name" maxlength="40" value="${esc(profile.name||"")}"></label><label>Language to practice<select id="target">${languages.map(x=>`<option ${x===profile.target_language?"selected":""}>${x}</option>`).join("")}</select></label><label>Level<select id="level">${["Beginner","Intermediate","Advanced"].map(x=>`<option ${x===profile.level?"selected":""}>${x}</option>`).join("")}</select></label>${btn("Save changes","save","primary big")}</section>`);
  document.querySelectorAll("[data-avatar]").forEach(b=>b.onclick=()=>{selected=b.dataset.avatar;document.querySelectorAll("[data-avatar]").forEach(x=>x.classList.toggle("selected",x===b));document.querySelector(".avatar-preview .big-avatar").textContent=selected;});
  document.querySelector("#back").onclick=renderProfile;
  document.querySelector("#save").onclick=async()=>{const payload={name:document.querySelector("#name").value.trim()||"Lingore User",avatar_id:selected,target_language:document.querySelector("#target").value,level:document.querySelector("#level").value};const {error}=await supabase.from("profiles").update(payload).eq("id",session.user.id);if(error)return alert(error.message);await loadProfile();renderProfile();};
}

async function deleteAccount(){
  if(!confirm("Delete your Lingore account permanently? This cannot be undone."))return;
  const {error}=await supabase.functions.invoke("delete-account",{body:{}});
  if(error){console.error("DELETE ACCOUNT:",error);alert(error.message||"Account deletion failed.");return;}
  await supabase.auth.signOut();
}

boot();
