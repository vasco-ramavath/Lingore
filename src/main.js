import { supabase } from "./supabase.js";
import { VoiceCall } from "./webrtc.js";
import "./style.css";

const app = document.querySelector("#app");
let session = null;
let profile = null;
let currentCall = null;
let timer = null;
let startedAt = null;
let matchingTimer = null;
let matchingChannel = null;
let matchingActive = false;
let finishing = false;

const languages = [
  "English", "Spanish", "French", "German", "Japanese", "Korean",
  "Hindi", "Telugu", "Chinese", "Italian", "Portuguese"
];

// All labels are plain UTF-8 text. No corrupted emoji/symbol characters are used.
const avatars = [
  { id: "avatar-1", label: "Avatar 1", src: "/avatars/avatar-1.svg" },
  { id: "avatar-2", label: "Avatar 2", src: "/avatars/avatar-2.svg" },
  { id: "avatar-3", label: "Avatar 3", src: "/avatars/avatar-3.svg" },
  { id: "avatar-4", label: "Avatar 4", src: "/avatars/avatar-4.svg" },
  { id: "avatar-5", label: "Avatar 5", src: "/avatars/avatar-5.svg" },
  { id: "avatar-6", label: "Avatar 6", src: "/avatars/avatar-6.svg" },
  { id: "avatar-7", label: "Avatar 7", src: "/avatars/avatar-7.svg" },
  { id: "avatar-8", label: "Avatar 8", src: "/avatars/avatar-8.svg" }
];

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

function layout(body) {
  app.innerHTML = `<div class="shell">${body}</div>`;
  window.scrollTo(0, 0);
}

function btn(label, cls = "primary", id = "") {
  return `<button id="${id}" class="${cls}">${esc(label)}</button>`;
}

function avatarMarkup(id, cls = "avatar-image") {
  const a = avatars.find(x => x.id === id) || avatars[0];
  return `<img class="${cls}" src="${a.src}" alt="${esc(a.label)}" onerror="this.onerror=null;this.src='/avatars/avatar-1.svg'">`;
}

function avatarPicker(selected = "avatar-1") {
  return `<div class="avatar-grid" id="avatars">${avatars.map(a => `
    <button type="button" class="avatar-choice ${a.id === selected ? "selected" : ""}" data-avatar="${a.id}" aria-label="${esc(a.label)}">
      ${avatarMarkup(a.id)}
    </button>`).join("")}</div>`;
}

function selectedAvatar(current) {
  return avatars.find(a => a.id === current)?.id || "avatar-1";
}

async function boot() {
  const { data: { session: s } } = await supabase.auth.getSession();
  session = s;

  supabase.auth.onAuthStateChange((_event, s) => {
    session = s;
    if (!s) {
      profile = null;
      cleanupMatch();
      renderLogin();
    }
  });

  if (!session) return renderLogin();
  await loadProfile();

  // If the database has onboarding_completed, respect it. Otherwise fall back
  // to the presence of a usable name/language/level profile.
  if (!profile || profile.onboarding_completed === false) return renderOnboarding();
  renderHome();
}

async function loadProfile() {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .maybeSingle();
  if (error) console.error(error);
  profile = data;
}

function renderLogin() {
  layout(`<section class="center-card">
    <div class="brand">Ling<span>ore</span></div>
    <p class="tag">Talk beyond borders.</p>
    <div class="globe">LINGORE</div>
    <h1>Meet real people.<br>Practice real languages.</h1>
    <p class="muted">Voice-only conversations. No AI. No video calls.</p>
    ${btn("Continue with Google", "primary", "google")}
    <small>Your Google account is only used to create your Lingore account.</small>
  </section>`);

  document.querySelector("#google").onclick = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: location.origin }
    });
    if (error) alert(error.message);
  };
}

function renderOnboarding() {
  const p = profile || {};
  const defaultName = session.user.user_metadata?.full_name || session.user.user_metadata?.name || "";
  const currentAvatar = selectedAvatar(p.avatar_id);

  layout(`<section class="page onboarding">
    <div class="brand sm">Ling<span>ore</span></div>
    <h1>Create your profile</h1>
    <p class="muted">Choose how you want people to see you and who you want to practice with.</p>

    <label>Choose an avatar${avatarPicker(currentAvatar)}</label>
    <label>Display name<input id="name" maxlength="40" value="${esc(p.name || defaultName)}"></label>
    <label>Native language<select id="native">${languages.map(x => `<option ${x === (p.native_language || "English") ? "selected" : ""}>${x}</option>`).join("")}</select></label>
    <label>Language to practice<select id="target">${languages.map(x => `<option ${x === (p.target_language || "English") ? "selected" : ""}>${x}</option>`).join("")}</select></label>
    <label>English level<select id="level">${["Beginner", "Intermediate", "Advanced"].map(x => `<option ${x === (p.level || "Beginner") ? "selected" : ""}>${x}</option>`).join("")}</select></label>
    ${btn("Continue", "primary", "save")}
  </section>`);

  let selected = currentAvatar;
  document.querySelectorAll("[data-avatar]").forEach(b => b.onclick = () => {
    selected = b.dataset.avatar;
    document.querySelectorAll(".avatar-choice").forEach(x => x.classList.toggle("selected", x === b));
  });

  document.querySelector("#save").onclick = async () => {
    const payload = {
      id: session.user.id,
      name: document.querySelector("#name").value.trim() || "Lingore User",
      avatar_id: selected,
      native_language: document.querySelector("#native").value,
      target_language: document.querySelector("#target").value,
      level: document.querySelector("#level").value,
      onboarding_completed: true
    };

    const { error } = await supabase.from("profiles").upsert(payload);
    if (error) return alert(error.message);
    profile = { ...profile, ...payload };
    renderHome();
  };
}

function renderHome() {
  const avatar = selectedAvatar(profile.avatar_id);
  layout(`<section class="page">
    <header>
      <div><div class="brand sm">Ling<span>ore</span></div><p class="muted">Talk to the world.</p></div>
      <button class="avatar" id="profileBtn">${avatarMarkup(avatar, "avatar-image")}</button>
    </header>

    <div class="goal"><b>${profile.current_streak || 0} day streak</b><span>Keep going!</span></div>
    <div class="hero">
      <div class="globe">LINGORE</div>
      <h1>Talk beyond borders.</h1>
      <p>Find a real person who wants to practice too.</p>
      ${btn("TALK NOW", "primary big", "talk")}
    </div>
    <div class="stats">
      <div><b>${profile.total_conversations || 0}</b><span>Conversations</span></div>
      <div><b>${Math.round((profile.total_seconds || 0) / 60)}</b><span>Minutes</span></div>
      <div><b>${esc(profile.level || "Beginner")}</b><span>Level</span></div>
    </div>
    <div class="privacy-note">Real people. Real voices. No AI. No video.</div>
    <button id="signout" class="secondary">Sign out</button>
  </section>`);

  document.querySelector("#talk").onclick = startMatching;
  document.querySelector("#profileBtn").onclick = renderProfile;
  document.querySelector("#signout").onclick = () => supabase.auth.signOut();
}

function cleanupMatch() {
  if (matchingTimer) clearInterval(matchingTimer);
  matchingTimer = null;
  matchingActive = false;
  if (matchingChannel) {
    supabase.removeChannel(matchingChannel).catch(() => {});
    matchingChannel = null;
  }
}

async function leaveQueue() {
  try { await supabase.rpc("leave_match_queue"); } catch (_) {}
}

async function startMatching() {
  cleanupMatch();
  matchingActive = true;
  let secondsLeft = 45;

  layout(`<section class="page center">
    <div class="brand sm">Ling<span>ore</span></div>
    <div class="radar">SEARCH</div>
    <h1>Finding your conversation</h1>
    <p class="muted">Looking for someone who matches your language and level.</p>
    <div class="countdown" id="countdown">45</div>
    <div class="loader"></div>
    ${btn("Cancel", "secondary", "cancel")}
  </section>`);

  document.querySelector("#cancel").onclick = async () => {
    cleanupMatch();
    await leaveQueue();
    renderHome();
  };

  // Subscribe before queueing so the waiting user cannot miss a fast match event.
  await supabase.realtime.setAuth(session.access_token); matchingChannel = supabase.channel(`match:${session.user.id}`, { config: { private: true } });
  matchingChannel.on("broadcast", { event: "matched" }, async ({ payload }) => {
    if (!matchingActive) return;
    matchingActive = false;
    const ch = matchingChannel;
    matchingChannel = null;
    if (matchingTimer) clearInterval(matchingTimer);
    matchingTimer = null;
    if (ch) await supabase.removeChannel(ch);
    await enterCall(payload.call_id, payload.peer_id, payload.initiator);
  });

  await matchingChannel.subscribe((status, err) => {
  console.log("MATCH REALTIME:", status, err);
});

const sub = matchingChannel.state;

if (sub !== "joined") {
  cleanupMatch();
  await leaveQueue();
  alert("Could not connect to matchmaking. Please try again.");
  return renderHome();
}

  const { data, error } = await supabase.rpc("find_or_queue_match", {
    p_native_language: profile.native_language,
    p_target_language: profile.target_language,
    p_level: profile.level
  });

  if (!matchingActive) return;
  if (error) {
    cleanupMatch();
    await leaveQueue();
    alert(error.message);
    return renderHome();
  }

  if (data?.matched) {
    cleanupMatch();
    await enterCall(data.call_id, data.peer_id, data.initiator);
    return;
  }

  matchingTimer = setInterval(async () => {
    secondsLeft -= 1;
    const el = document.querySelector("#countdown");
    if (el) el.textContent = String(secondsLeft);
    if (secondsLeft <= 0) {
      cleanupMatch();
      await leaveQueue();
      renderMatchTimeout();
    }
  }, 1000);
}

function renderMatchTimeout() {
  layout(`<section class="page center">
    <div class="brand sm">Ling<span>ore</span></div>
    <div class="timeout-icon">!</div>
    <h1>No one is available right now</h1>
    <p class="muted">Try again and Lingore will search the pool again.</p>
    ${btn("Try Again", "primary", "retry")}
    ${btn("Back to Home", "secondary", "home")}
  </section>`);
  document.querySelector("#retry").onclick = startMatching;
  document.querySelector("#home").onclick = renderHome;
}

async function enterCall(callId, peerId, initiator) {
  layout(`<section class="call">
    <div class="callbar"><span>Lingore call</span><span id="clock">00:00</span></div>
    <div class="person">
      ${avatarMarkup(selectedAvatar(profile.avatar_id), "big-avatar-image")}
      <h1 id="callState">Connecting</h1>
      <p>Real voice conversation</p>
      <span class="connected" id="connectionBadge">Connecting</span>
    </div>
    <div class="call-actions">
      <button id="mute" class="round">Mute</button>
      <button id="end" class="round end">End</button>
    </div>
  </section>`);

  try {
    finishing = false;
    currentCall = new VoiceCall(callId, session.user.id, peerId);
    currentCall.onState = state => {
      const title = document.querySelector("#callState");
      const badge = document.querySelector("#connectionBadge");
      if (state === "connected") {
        if (title) title.textContent = "Connected";
        if (badge) badge.textContent = "Connected";
      } else if (state === "disconnected" || state === "failed") {
        if (title) title.textContent = state === "failed" ? "Connection failed" : "Disconnected";
        if (badge) badge.textContent = state === "failed" ? "Connection failed" : "Disconnected";
        if (state === "failed") finishCall(true);
      } else if (state === "remote-hangup") {
        finishCall(true);
      } else if (title) {
        title.textContent = "Connecting";
        if (badge) badge.textContent = "Connecting";
      }
    };

    await currentCall.start();
    if (initiator) {
      await currentCall.offer();
    } else {
      await currentCall.waitForOfferAndAnswer();
    }

    startedAt = Date.now();
    timer = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      const clock = document.querySelector("#clock");
      if (clock) clock.textContent = `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
    }, 1000);

    document.querySelector("#mute").onclick = async e => {
      const muted = e.currentTarget.classList.toggle("active");
      e.currentTarget.textContent = muted ? "Unmute" : "Mute";
      await currentCall?.mute(muted);
    };
    document.querySelector("#end").onclick = () => finishCall(false);
  } catch (e) {
    console.error(e);
    alert(e?.name === "NotAllowedError" ? "Microphone access is required for a voice call." : (e?.message || "Could not connect the voice call."));
    await finishCall(true);
  }
}

async function finishCall(remote = false) {
  if (finishing) return;
  finishing = true;
  clearInterval(timer);
  timer = null;

  const seconds = startedAt ? Math.max(1, Math.floor((Date.now() - startedAt) / 1000)) : 1;
  const callId = currentCall?.callId || null;
  startedAt = null;

  if (currentCall) {
    await currentCall.end(!remote);
    currentCall = null;
  }

  if (callId) await supabase.rpc("finish_call", { p_call_id: callId, p_seconds: seconds });
  await loadProfile();
  finishing = false;
  renderHome();
}

function renderProfile() {
  layout(`<section class="page">
    <button class="back" id="back">Back</button>
    <div class="profile-head">
      ${avatarMarkup(selectedAvatar(profile.avatar_id), "big-avatar-image")}
      <h1>${esc(profile.name || "Lingore User")}</h1>
      <p>${esc(profile.native_language || "English")} to ${esc(profile.target_language || "English")} - ${esc(profile.level || "Beginner")}</p>
    </div>
    <div class="stats">
      <div><b>${profile.total_conversations || 0}</b><span>Conversations</span></div>
      <div><b>${Math.round((profile.total_seconds || 0) / 60)}</b><span>Total minutes</span></div>
      <div><b>${profile.current_streak || 0}</b><span>Day streak</span></div>
    </div>
    <div class="list">
      <button id="edit" class="list-button">Edit profile</button>
      <button id="backHome" class="list-button">Back to home</button>
    </div>
  </section>`);
  document.querySelector("#back").onclick = renderHome;
  document.querySelector("#backHome").onclick = renderHome;
  document.querySelector("#edit").onclick = renderEditProfile;
}

function renderEditProfile() {
  const currentAvatar = selectedAvatar(profile.avatar_id);
  layout(`<section class="page">
    <button class="back" id="back">Back</button>
    <div class="brand sm">Ling<span>ore</span></div>
    <h1>Edit profile</h1>
    <label>Avatar${avatarPicker(currentAvatar)}</label>
    <label>Display name<input id="name" maxlength="40" value="${esc(profile.name || "")}"></label>
    <label>Native language<select id="native">${languages.map(x => `<option ${x === profile.native_language ? "selected" : ""}>${x}</option>`).join("")}</select></label>
    <label>Language to practice<select id="target">${languages.map(x => `<option ${x === profile.target_language ? "selected" : ""}>${x}</option>`).join("")}</select></label>
    <label>English level<select id="level">${["Beginner", "Intermediate", "Advanced"].map(x => `<option ${x === profile.level ? "selected" : ""}>${x}</option>`).join("")}</select></label>
    ${btn("Save changes", "primary", "save")}
  </section>`);

  let selected = currentAvatar;
  document.querySelectorAll("[data-avatar]").forEach(b => b.onclick = () => {
    selected = b.dataset.avatar;
    document.querySelectorAll(".avatar-choice").forEach(x => x.classList.toggle("selected", x === b));
  });
  document.querySelector("#back").onclick = renderProfile;
  document.querySelector("#save").onclick = async () => {
    const payload = {
      name: document.querySelector("#name").value.trim() || "Lingore User",
      avatar_id: selected,
      native_language: document.querySelector("#native").value,
      target_language: document.querySelector("#target").value,
      level: document.querySelector("#level").value
    };
    const { error } = await supabase.from("profiles").update(payload).eq("id", session.user.id);
    if (error) return alert(error.message);
    profile = { ...profile, ...payload };
    renderProfile();
  };
}

boot();
    
