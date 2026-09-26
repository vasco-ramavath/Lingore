import { supabase } from "./supabase.js";
import { VoiceCall } from "./webrtc.js";
import "./style.css";

const app = document.querySelector("#app");
let session = null, profile = null, currentCall = null, timer = null, startedAt = null;
let matchingChannel = null, matchingTimer = null, matchActive = false, finishing = false;

const languages = ["English","Spanish","French","German","Japanese","Korean","Hindi","Telugu","Chinese","Italian","Portuguese"];
const avatars = ["🙂","😎","🧑","👨","👩","🧔","👨‍💻","🌎"];
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function layout(body){ app.innerHTML = `<div class="shell">${body}</div>`; }
function btn(label, cls="primary", id=""){ return `<button id="${id}" class="${cls}">${label}</button>`; }
function avatar(value, cls="big-avatar"){ const v=avatars.includes(value)?value:(value||"🙂"); return `<div class="${cls}">${esc(v)}</div>`; }
function clearMatchTimer(){ if(matchingTimer){clearInterval(matchingTimer);matchingTimer=null;} }
async function cleanupMatching(){ clearMatchTimer(); matchActive=false; if(matchingChannel){try{await supabase.removeChannel(matchingChannel);}catch{} matchingChannel=null;} }

async function boot(){
  const {data:{session:s}}=await supabase.auth.getSession();
  session=s;
  supabase.auth.onAuthStateChange((_e,s)=>{session=s;if(!s)renderLogin();});
  if(!session)return renderLogin();
  await loadProfile();
  profile?renderHome():renderOnboarding();
}
async function loadProfile(){
  const {data,error}=await supabase.from("profiles").select("*").eq("id",session.user.id).maybeSingle();
  if(error)console.error(error);
  profile=data;
}

function renderLogin(){
  layout(`<section class="center-card"><div class="brand">Ling<span>ore</span></div><p class="tag">Talk beyond borders.</p><div class="globe">🌎</div><h1>Meet real people.<br>Practice real languages.</h1><p class="muted">Voice-only conversations. No AI. No video calls.</p>${btn("Continue with Google →","","google")}<small>Your Google account is only used to create your Lingore account.</small></section>`);
  document.querySelector("#google").onclick=async()=>{const {error}=await supabase.auth.signInWithOAuth({provider:"google",options:{redirectTo:location.origin}});if(error)alert(error.message);};
}

function renderOnboarding(){
  const defaultAvatar=avatars[0];
  layout(`<section class="page"><div class="brand sm">Ling<span>ore</span></div><h1>Create your profile</h1><p class="muted">Choose your display name, language to practice and level.</p><label>Display name<input id="name" maxlength="40" value="${esc(session.user.user_metadata?.name||"")}"></label><label>Language to practice<select id="target">${languages.map(x=>`<option ${x==="English"?"selected":""}>${x}</option>`).join("")}</select></label><label>Level<select id="level"><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select></label><label>Avatar<div id="avatarPicker" class="avatar-picker">${avatars.map((x,i)=>`<button type="button" class="avatar-choice ${i===0?"selected":""}" data-avatar="${esc(x)}">${esc(x)}</button>`).join("")}</div></label>${btn("Continue →","primary","save")}</section>`);
  let chosen=defaultAvatar;
  document.querySelectorAll(".avatar-choice").forEach(b=>b.onclick=()=>{chosen=b.dataset.avatar;document.querySelectorAll(".avatar-choice").forEach(x=>x.classList.remove("selected"));b.classList.add("selected");});
  document.querySelector("#save").onclick=async()=>{
    const payload={id:session.user.id,name:document.querySelector("#name").value.trim()||"Lingore User",target_language:document.querySelector("#target").value,level:document.querySelector("#level").value,avatar_id:chosen,native_language:profile?.native_language||"English",onboarding_completed:true};
    const {error}=await supabase.from("profiles").upsert(payload);
    if(error)return alert(error.message);profile={...profile,...payload};renderHome();
  };
}

function renderHome(){
  layout(`<section class="page"><header><div><div class="brand sm">Ling<span>ore</span></div><p class="muted">Talk to the world.</p></div><button class="avatar" id="profileBtn">${esc(profile.avatar_id||profile.name?.[0]||"🙂")}</button></header><div class="goal">🔥 <b>${profile.current_streak||0} day streak</b><span>Keep going!</span></div><div class="hero"><div class="globe">🌎</div><h1>Talk beyond borders.</h1><p>Find a real person who wants to practice too.</p>${btn("🎙 TALK NOW","primary big","talk")}</div><div class="stats"><div><b>${profile.total_conversations||0}</b><span>Conversations</span></div><div><b>${Math.round((profile.total_seconds||0)/60)}</b><span>Minutes</span></div><div><b>${esc(profile.level)}</b><span>Level</span></div></div><div class="privacy-note">🔒 Real people • Real voices • No AI • No video</div></section>`);
  document.querySelector("#talk").onclick=startMatching;
  document.querySelector("#profileBtn").onclick=renderProfile;
}

async function leaveQueue(){try{await supabase.rpc("leave_match_queue");}catch(e){console.warn("leave queue:",e);}}

async function startMatching(){
  await cleanupMatching();
  layout(`<section class="page center"><div class="brand sm">Ling<span>ore</span></div><div class="radar">🌎</div><h1>Finding your conversation…</h1><p class="muted">Matching people practicing the same language.</p><div class="loader"></div><p id="countdown" class="muted">45</p>${btn("Cancel","secondary","cancel")}</section>`);
  matchActive=true;let secondsLeft=45;
  document.querySelector("#cancel").onclick=async()=>{matchActive=false;await cleanupMatching();await leaveQueue();renderHome();};
  const {data:{session:freshSession}}=await supabase.auth.getSession();
  if(!freshSession?.access_token){await cleanupMatching();return renderLogin();}
  await supabase.realtime.setAuth(freshSession.access_token);
  matchingChannel=supabase.channel(`match:${freshSession.user.id}`,{config:{private:true,broadcast:{ack:true,self:false}}});
  matchingChannel.on("broadcast",{event:"matched"},async({payload})=>{if(!matchActive||!payload?.call_id)return;matchActive=false;await cleanupMatching();await enterCall(payload.call_id,payload.peer_id,payload.initiator);});
  try{await subscribeChannel(matchingChannel,"MATCH CHANNEL");}catch(e){console.error(e);await cleanupMatching();await leaveQueue();alert("Matching connection failed. Please try again.");return renderHome();}
  if(!matchActive)return;
  const {data,error}=await supabase.rpc("find_or_queue_match",{p_native_language:profile.native_language||"English",p_target_language:profile.target_language,p_level:profile.level});
  if(error){matchActive=false;await cleanupMatching();await leaveQueue();alert(error.message);return renderHome();}
  if(data?.matched){matchActive=false;await cleanupMatching();return enterCall(data.call_id,data.peer_id,data.initiator);}
  matchingTimer=setInterval(async()=>{secondsLeft--;const el=document.querySelector("#countdown");if(el)el.textContent=String(secondsLeft);if(secondsLeft<=0){matchActive=false;await cleanupMatching();await leaveQueue();renderMatchTimeout();}},1000);
}

async function subscribeChannel(channel,label){
  await new Promise((resolve,reject)=>{let done=false;channel.subscribe((status,error)=>{console.log(label,status,error||"");if(status==="SUBSCRIBED"){done=true;resolve();}else if(["CHANNEL_ERROR","TIMED_OUT","CLOSED"].includes(status)&&!done){done=true;reject(error||new Error(`${label}: ${status}`));}});});
}
function renderMatchTimeout(){layout(`<section class="page center"><div class="brand sm">Ling<span>ore</span></div><div class="radar">🌎</div><h1>No one is available right now</h1><p class="muted">Your search ended after 45 seconds.</p>${btn("Try Again","primary big","retry")}${btn("Back to Home","secondary","home")}</section>`);document.querySelector("#retry").onclick=startMatching;document.querySelector("#home").onclick=renderHome;}

async function getPeerProfile(peerId){const {data,error}=await supabase.rpc("get_public_profile",{p_user_id:peerId});if(error){console.warn("Peer profile lookup failed:",error);return{name:"Lingore User",avatar_id:"🙂"};}return data||{name:"Lingore User",avatar_id:"🙂"};}

async function enterCall(callId,peerId,initiator){
  await cleanupMatching();
  const peer=await getPeerProfile(peerId);const peerName=peer.name||"Lingore User";const peerAvatar=peer.avatar_id||"🙂";
  layout(`<section class="call"><div class="callbar"><span>Lingore call</span><span id="clock">00:00</span></div><div class="person">${avatar(peerAvatar)}<h1 id="callTitle">Connecting…</h1><h2 id="peerName">${esc(peerName)}</h2><p>Real voice conversation</p><span id="callState" class="connecting">● Connecting</span><p id="audioHint" class="muted" style="min-height:22px"></p></div><div class="call-actions"><button id="mute" class="round" aria-label="Mute microphone">🎙</button><button id="speaker" class="round" aria-label="Speaker on">🔊</button><button id="end" class="round end" aria-label="End call">☎</button></div></section>`);
  finishing=false;
  try{
    currentCall=new VoiceCall(callId,session.user.id,peerId);
    currentCall.onState=async state=>{
      const title=document.querySelector("#callTitle"),badge=document.querySelector("#callState"),hint=document.querySelector("#audioHint");
      if(state==="connected"){if(title)title.textContent="Connected";if(badge){badge.textContent="● Connected";badge.className="connected";}}
      else if(state==="disconnected"){if(title)title.textContent="Reconnecting…";if(badge){badge.textContent="● Reconnecting";badge.className="connecting";}}
      else if(state==="failed"||state==="ice-failed"){if(title)title.textContent="Connection failed";if(badge){badge.textContent="● Connection failed";badge.className="disconnected";}if(hint)hint.textContent="This network may need a TURN relay.";setTimeout(()=>finishCall(false),1800);}
      else if(state==="audio-blocked"){if(hint)hint.textContent="Tap 🔊 to enable the other person's voice.";}
      else if(state==="remote-audio"){if(hint)hint.textContent="";}
      else if(state==="remote-hangup"){await finishCall(true);}
    };
    await currentCall.start();
    startedAt=Date.now();
    timer=setInterval(()=>{const sec=Math.floor((Date.now()-startedAt)/1000);const el=document.querySelector("#clock");if(el)el.textContent=`${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;},1000);
    document.querySelector("#mute").onclick=async e=>{const muted=e.currentTarget.classList.toggle("active");await currentCall?.mute(muted);e.currentTarget.textContent=muted?"🔇":"🎙";};
    document.querySelector("#speaker").onclick=async e=>{const on=await currentCall?.toggleSpeaker();if(on){await currentCall?.unlockAudio();e.currentTarget.textContent="🔊";}else e.currentTarget.textContent="🔇";};
    // A tap anywhere on the call screen can unlock mobile audio if autoplay was blocked.
    document.querySelector(".call").addEventListener("click",()=>{currentCall?.unlockAudio();},{once:false});
    document.querySelector("#end").onclick=()=>finishCall(false);
  }catch(e){console.error("CALL START ERROR:",e);alert(e?.message||"Microphone access or call signaling failed.");await finishCall(false);}
}

async function finishCall(remote=false){
  if(finishing)return;finishing=true;clearInterval(timer);timer=null;
  const seconds=startedAt?Math.max(1,Math.floor((Date.now()-startedAt)/1000)):1;const callId=currentCall?.callId||null;const call=currentCall;currentCall=null;startedAt=null;
  try{if(call)await call.end(!remote);}catch(e){console.warn("CALL END:",e);}
  if(callId){const {error}=await supabase.rpc("finish_call",{p_call_id:callId,p_seconds:seconds});if(error)console.warn("finish_call:",error);}
  await loadProfile();renderHome();finishing=false;
}

function renderProfile(){
  layout(`<section class="page"><button class="back" id="back">‹</button><div class="profile-head">${avatar(profile.avatar_id||"🙂")}<h1>${esc(profile.name)}</h1><p>${esc(profile.target_language)} • ${esc(profile.level)}</p></div><div class="stats"><div><b>${profile.total_conversations||0}</b><span>Conversations</span></div><div><b>${Math.round((profile.total_seconds||0)/60)}</b><span>Total minutes</span></div><div><b>${profile.current_streak||0}</b><span>Day streak</span></div></div><div class="list"><button id="editProfile" class="list-row">✏️ Edit profile <span>›</span></button><div>🛡️ Safety & Privacy <span>›</span></div><div>🚫 Blocked users <span>›</span></div><button id="deleteAccount" class="list-row danger">🗑️ Delete account <span>›</span></button><button id="signout" class="list-row">↪️ Sign out <span>›</span></button></div></section>`);
  document.querySelector("#back").onclick=renderHome;
  document.querySelector("#editProfile").onclick=renderEditProfile;
  document.querySelector("#signout").onclick=async()=>{await cleanupMatching();await leaveQueue();await supabase.auth.signOut();};
  document.querySelector("#deleteAccount").onclick=deleteAccount;
}

function renderEditProfile(){
  const current=profile.avatar_id||"🙂";
  layout(`<section class="page"><button class="back" id="back">‹</button><div class="brand sm">Ling<span>ore</span></div><h1>Edit profile</h1><label>Display name<input id="editName" maxlength="40" value="${esc(profile.name)}"></label><label>Language to practice<select id="editTarget">${languages.map(x=>`<option ${x===profile.target_language?"selected":""}>${x}</option>`).join("")}</select></label><label>Level<select id="editLevel">${["Beginner","Intermediate","Advanced"].map(x=>`<option ${x===profile.level?"selected":""}>${x}</option>`).join("")}</select></label><label>Avatar<div class="avatar-picker">${avatars.map(x=>`<button type="button" class="avatar-choice ${x===current?"selected":""}" data-avatar="${esc(x)}">${esc(x)}</button>`).join("")}</div></label>${btn("Save changes","primary","saveProfile")}</section>`);
  let chosen=current;document.querySelectorAll(".avatar-choice").forEach(b=>b.onclick=()=>{chosen=b.dataset.avatar;document.querySelectorAll(".avatar-choice").forEach(x=>x.classList.remove("selected"));b.classList.add("selected");});
  document.querySelector("#back").onclick=renderProfile;
  document.querySelector("#saveProfile").onclick=async()=>{const patch={name:document.querySelector("#editName").value.trim()||"Lingore User",target_language:document.querySelector("#editTarget").value,level:document.querySelector("#editLevel").value,avatar_id:chosen};const {error}=await supabase.from("profiles").update(patch).eq("id",session.user.id);if(error)return alert(error.message);profile={...profile,...patch};renderProfile();};
}

async function deleteAccount(){
  const ok=confirm("Delete your Lingore account permanently? Your profile, calls, queue data and account will be deleted. This cannot be undone.");
  if(!ok)return;
  await cleanupMatching();await leaveQueue();
  const {data:{session:freshSession}}=await supabase.auth.getSession();
  if(!freshSession?.access_token)return renderLogin();
  const response=await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/delete-account`,{method:"POST",headers:{Authorization:`Bearer ${freshSession.access_token}`}});
  const body=await response.json().catch(()=>({}));
  if(!response.ok){alert(body.error||"Account deletion failed. Please try again.");return;}
  session=null;profile=null;await supabase.auth.signOut();renderLogin();
}

boot();
