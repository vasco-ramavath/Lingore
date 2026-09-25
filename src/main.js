import { supabase } from "./supabase.js";
import { VoiceCall } from "./webrtc.js";
import "./style.css";

const app = document.querySelector("#app");
let session = null, profile = null, currentCall = null, timer = null, startedAt = null;

const languages = ["English","Spanish","French","German","Japanese","Korean","Hindi","Telugu","Chinese","Italian","Portuguese"];
const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function layout(body){ app.innerHTML = `<div class="shell">${body}</div>`; }
function btn(label, cls="primary", id=""){ return `<button id="${id}" class="${cls}">${label}</button>`; }

async function boot(){
  const {data:{session:s}} = await supabase.auth.getSession();
  session=s;
  supabase.auth.onAuthStateChange((_e,s)=>{ session=s; if(!s) renderLogin(); });
  if(!session) return renderLogin();
  await loadProfile();
  profile ? renderHome() : renderOnboarding();
}

async function loadProfile(){
  const {data,error}=await supabase.from("profiles").select("*").eq("id",session.user.id).maybeSingle();
  if(error) console.error(error); profile=data;
}

function renderLogin(){
  layout(`<section class="center-card">
    <div class="brand">Ling<span>ore</span></div><p class="tag">Talk beyond borders.</p>
    <div class="globe">🌎</div><h1>Meet real people.<br>Practice real languages.</h1>
    <p class="muted">Voice-only conversations. No AI. No video calls.</p>
    ${btn("Continue with Google →","","google")}
    <small>Your Google account is only used to create your Lingore account.</small>
  </section>`);
  document.querySelector("#google").onclick=async()=>{
    const {error}=await supabase.auth.signInWithOAuth({provider:"google",options:{redirectTo:location.origin}});
    if(error) alert(error.message);
  };
}

function renderOnboarding(){
  layout(`<section class="page"><div class="brand sm">Ling<span>ore</span></div><h1>Create your profile</h1>
    <p class="muted">These details help Lingore find compatible conversation partners.</p>
    <label>Display name<input id="name" maxlength="40" value="${esc(session.user.user_metadata?.name||"")}"></label>
    <label>Native language<select id="native">${languages.map(x=>`<option>${x}</option>`).join("")}</select></label>
    <label>Language to practice<select id="target">${languages.map(x=>`<option ${x==="English"?"selected":""}>${x}</option>`).join("")}</select></label>
    <label>Level<select id="level"><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select></label>
    ${btn("Continue →","primary","save")}</section>`);
  document.querySelector("#save").onclick=async()=>{
    const payload={id:session.user.id,name:document.querySelector("#name").value.trim()||"Lingore User",native_language:document.querySelector("#native").value,target_language:document.querySelector("#target").value,level:document.querySelector("#level").value};
    const {error}=await supabase.from("profiles").upsert(payload);
    if(error) return alert(error.message); profile=payload; renderHome();
  };
}

function renderHome(){
  layout(`<section class="page">
    <header><div><div class="brand sm">Ling<span>ore</span></div><p class="muted">Talk to the world.</p></div><button class="avatar" id="profileBtn">${esc(profile.name?.[0]||"L")}</button></header>
    <div class="goal">🔥 <b>${profile.current_streak||0} day streak</b><span>Keep going!</span></div>
    <div class="hero"><div class="globe">🌎</div><h1>Talk beyond borders.</h1><p>Find a real person who wants to practice too.</p>${btn("🎙 TALK NOW","primary big","talk")}</div>
    <div class="stats"><div><b>${profile.total_conversations||0}</b><span>Conversations</span></div><div><b>${Math.round((profile.total_seconds||0)/60)}</b><span>Minutes</span></div><div><b>${esc(profile.level)}</b><span>Level</span></div></div>
    <div class="privacy-note">🔒 Real people • Real voices • No AI • No video</div>
    <button id="signout" class="secondary">Sign out</button>
  </section>`);
  document.querySelector("#talk").onclick=startMatching;
  document.querySelector("#profileBtn").onclick=renderProfile;
  document.querySelector("#signout").onclick=()=>supabase.auth.signOut();
}

async function startMatching(){
  layout(`<section class="page center"><div class="brand sm">Ling<span>ore</span></div><div class="radar">🌎</div><h1>Finding your conversation…</h1><p class="muted">Matching language, level and preferences.</p><div class="loader"></div>${btn("Cancel","secondary","cancel")}</section>`);
  let active=true; document.querySelector("#cancel").onclick=async()=>{active=false;await supabase.rpc("leave_match_queue");renderHome();};
  const {data,error}=await supabase.rpc("find_or_queue_match",{p_native_language:profile.native_language,p_target_language:profile.target_language,p_level:profile.level});
  if(error){active=false;alert(error.message);return renderHome();}
  if(data?.matched){
    await enterCall(data.call_id,data.peer_id,data.initiator);
    return;
  }
  const ch=supabase.channel(`match:${session.user.id}`,{config:{private:true}});
  ch.on("broadcast",{event:"matched"},async({payload})=>{
    if(!active)return; active=false; await supabase.removeChannel(ch); await enterCall(payload.call_id,payload.peer_id,payload.initiator);
  });
  await ch.subscribe();
}

async function enterCall(callId,peerId,initiator){
  layout(`<section class="call"><div class="callbar"><span>Lingore call</span><span id="clock">00:00</span></div>
    <div class="person"><div class="big-avatar">${esc((profile.name||"L")[0])}</div><h1>Connected</h1><p>Real voice conversation</p><span class="connected">● Connected</span></div>
    <div class="call-actions"><button id="mute" class="round">🎙</button><button id="end" class="round end">☎</button></div>
  </section>`);
  try{
    currentCall=new VoiceCall(callId,session.user.id,peerId); currentCall.onState=s=>{if(s==="remote-hangup")finishCall();};
    await currentCall.start();
    if(initiator) await currentCall.offer(); else {
      // Wait for offer; answer when remote description is available.
      const oldHandler=currentCall.pc.onsignalingstatechange;
      const check=setInterval(async()=>{if(currentCall?.pc.remoteDescription?.type==="offer"){clearInterval(check);await currentCall.answer();}},200);
    }
    startedAt=Date.now(); timer=setInterval(()=>{const sec=Math.floor((Date.now()-startedAt)/1000);document.querySelector("#clock").textContent=`${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`},1000);
    document.querySelector("#mute").onclick=async e=>{e.currentTarget.classList.toggle("active");await currentCall.mute(e.currentTarget.classList.contains("active"));};
    document.querySelector("#end").onclick=finishCall;
  }catch(e){console.error(e);alert("Microphone access is required for a voice call.");finishCall();}
}

async function finishCall(){
  clearInterval(timer); const seconds=Math.max(1,Math.floor((Date.now()-startedAt)/1000));
  const callId=currentCall?.callId || null;
  if(currentCall){await currentCall.end();currentCall=null;}
  await supabase.rpc("finish_call",{p_call_id:callId,p_seconds:seconds});
  await loadProfile(); renderHome();
}

function renderProfile(){
  layout(`<section class="page"><button class="back" id="back">‹</button><div class="profile-head"><div class="big-avatar">${esc((profile.name||"L")[0])}</div><h1>${esc(profile.name)}</h1><p>${esc(profile.native_language)} • ${esc(profile.target_language)} • ${esc(profile.level)}</p></div>
  <div class="stats"><div><b>${profile.total_conversations||0}</b><span>Conversations</span></div><div><b>${Math.round((profile.total_seconds||0)/60)}</b><span>Total minutes</span></div><div><b>${profile.current_streak||0}</b><span>Day streak</span></div></div>
  <div class="list"><div>🛡️ Safety & Privacy <span>›</span></div><div>🚫 Blocked users <span>›</span></div><div>🗑️ Delete account <span>›</span></div></div></section>`);
  document.querySelector("#back").onclick=renderHome;
}
boot();