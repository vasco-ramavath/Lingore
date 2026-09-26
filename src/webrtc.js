import { supabase } from "./supabase.js";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  { urls: "stun:stun1.l.google.com:19302" }
];

export class VoiceCall {
  constructor(callId, userId, remoteUserId) {
    this.callId = callId;
    this.userId = userId;
    this.remoteUserId = remoteUserId;
    this.isInitiator = String(userId) < String(remoteUserId);
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.channel = null;
    this.localStream = null;
    this.remoteAudio = null;
    this.remoteStream = null;
    this.pendingIce = [];
    this.remoteDescriptionSet = false;
    this.ended = false;
    this.speakerEnabled = true;
    this.restartAttempted = false;
    this.onState = () => {};

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log("WEBRTC CONNECTION:", state);
      this.onState(state);
      if (state === "disconnected" && !this.ended) setTimeout(() => this.tryIceRestart(), 1200);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log("WEBRTC ICE:", state);
      if (state === "failed" && !this.ended) this.tryIceRestart();
    };

    this.pc.onicecandidateerror = e => console.warn("WEBRTC ICE CANDIDATE ERROR:", e);

    this.pc.ontrack = event => {
      console.log("REMOTE TRACK RECEIVED:", event.track?.kind);
      let stream = event.streams?.[0];
      if (!stream) {
        if (!this.remoteStream) this.remoteStream = new MediaStream();
        if (!this.remoteStream.getTracks().some(t => t.id === event.track.id)) {
          this.remoteStream.addTrack(event.track);
        }
        stream = this.remoteStream;
      } else {
        this.remoteStream = stream;
      }

      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement("audio");
        this.remoteAudio.id = `lingore-remote-${this.callId}`;
        this.remoteAudio.autoplay = true;
        this.remoteAudio.playsInline = true;
        this.remoteAudio.preload = "auto";
        this.remoteAudio.controls = false;
        this.remoteAudio.volume = 1;
        this.remoteAudio.muted = false;
        this.remoteAudio.setAttribute("aria-hidden", "true");
        // Do NOT use display:none: some mobile browsers are unreliable with
        // hidden media elements. Keep it effectively invisible but playable.
        Object.assign(this.remoteAudio.style, {
          position: "fixed", width: "2px", height: "2px", opacity: "0.01",
          left: "-10px", top: "-10px", pointerEvents: "none"
        });
        document.body.appendChild(this.remoteAudio);
      }

      this.remoteAudio.srcObject = stream;
      event.track.enabled = true;
      event.track.onunmute = () => this.playRemoteAudio();
      event.track.onended = () => console.log("REMOTE TRACK ENDED");
      this.playRemoteAudio();
    };

    this.pc.onicecandidate = async event => {
      if (!event.candidate || this.ended) return;
      try {
        await this.sendSignal({ type: "ice", candidate: event.candidate, from: this.userId });
      } catch (e) {
        console.warn("ICE SEND ERROR:", e);
      }
    };
  }

  async start() {
    if (this.ended) throw new Error("Call already ended.");
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("Authentication session expired.");
    await supabase.realtime.setAuth(session.access_token);

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false
    });

    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = true;
      this.pc.addTrack(track, this.localStream);
    });

    this.channel = supabase.channel(`call:${this.callId}`, {
      config: { private: true, broadcast: { ack: true, self: false } }
    });

    this.channel.on("broadcast", { event: "signal" }, async ({ payload }) => {
      if (!payload || payload.from === this.userId || this.ended) return;
      try {
        if (payload.type === "ready") {
          if (this.isInitiator && !this.pc.localDescription) await this.createAndSendOffer();
          return;
        }

        if (payload.type === "offer") {
          await this.pc.setRemoteDescription(payload.offer);
          this.remoteDescriptionSet = true;
          await this.flushPendingIce();
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          await this.sendSignal({ type: "answer", answer: this.pc.localDescription, from: this.userId });
          return;
        }

        if (payload.type === "answer") {
          if (!this.pc.remoteDescription) {
            await this.pc.setRemoteDescription(payload.answer);
            this.remoteDescriptionSet = true;
            await this.flushPendingIce();
          }
          return;
        }

        if (payload.type === "ice" && payload.candidate) {
          if (this.remoteDescriptionSet || this.pc.remoteDescription) {
            await this.pc.addIceCandidate(payload.candidate);
          } else {
            this.pendingIce.push(payload.candidate);
          }
          return;
        }

        if (payload.type === "hangup") this.onState("remote-hangup");
      } catch (error) {
        console.error("SIGNAL HANDLER ERROR:", error);
        this.onState("signaling-error");
      }
    });

    await this.subscribe();
    await this.sendSignal({ type: "ready", from: this.userId });
    return this;
  }

  async subscribe() {
    await new Promise((resolve, reject) => {
      let done = false;
      this.channel.subscribe((status, error) => {
        console.log("CALL CHANNEL:", status, error || "");
        if (status === "SUBSCRIBED") { done = true; resolve(); }
        else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status) && !done) {
          done = true;
          reject(error || new Error(`Call signaling status: ${status}`));
        }
      });
    });
  }

  async createAndSendOffer(iceRestart = false) {
    if (this.ended) return;
    const offer = await this.pc.createOffer({ offerToReceiveAudio: true, iceRestart });
    await this.pc.setLocalDescription(offer);
    await this.sendSignal({ type: "offer", offer: this.pc.localDescription, from: this.userId, iceRestart });
  }

  async flushPendingIce() {
    if (!this.remoteDescriptionSet && !this.pc.remoteDescription) return;
    const queued = this.pendingIce.splice(0);
    for (const candidate of queued) {
      try { await this.pc.addIceCandidate(candidate); } catch (e) { console.warn("QUEUED ICE ERROR:", e); }
    }
  }

  async sendSignal(payload) {
    if (!this.channel || this.ended) return;
    const result = await this.channel.send({ type: "broadcast", event: "signal", payload });
    if (result && result !== "ok") throw new Error(`Signal send failed: ${result}`);
  }

  async mute(muted) {
    this.localStream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }

  async playRemoteAudio() {
    if (!this.remoteAudio || !this.speakerEnabled) return false;
    this.remoteAudio.muted = false;
    this.remoteAudio.volume = 1;
    try {
      await this.remoteAudio.play();
      console.log("REMOTE AUDIO PLAYING", {
        paused: this.remoteAudio.paused,
        readyState: this.remoteAudio.readyState,
        muted: this.remoteAudio.muted,
        volume: this.remoteAudio.volume
      });
      this.onState("remote-audio");
      return true;
    } catch (error) {
      console.warn("REMOTE AUDIO PLAY BLOCKED:", error);
      this.onState("audio-blocked");
      return false;
    }
  }

  async unlockAudio() {
    // Called from the user's Speaker button, which is a real gesture on mobile.
    return this.playRemoteAudio();
  }

  async toggleSpeaker() {
    this.speakerEnabled = !this.speakerEnabled;
    if (this.remoteAudio) {
      this.remoteAudio.muted = !this.speakerEnabled;
      if (this.speakerEnabled) await this.playRemoteAudio();
    }
    return this.speakerEnabled;
  }

  async tryIceRestart() {
    if (this.ended || this.restartAttempted || !this.channel) return;
    if (!['failed', 'disconnected'].includes(this.pc.iceConnectionState)) return;
    this.restartAttempted = true;
    try {
      await this.createAndSendOffer(true);
      console.log("ICE RESTART OFFER SENT");
    } catch (e) {
      console.warn("ICE RESTART FAILED:", e);
    }
  }

  async end(notifyRemote = true) {
    if (this.ended) return;
    if (notifyRemote && this.channel) {
      try {
        await this.sendSignal({ type: "hangup", from: this.userId });
        await new Promise(r => setTimeout(r, 120));
      } catch (e) { console.warn("HANGUP SEND ERROR:", e); }
    }
    this.ended = true;
    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = null;
    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }
    this.remoteStream = null;
    this.pc.ontrack = null;
    this.pc.close();
    if (this.channel) {
      try { await supabase.removeChannel(this.channel); } catch {}
      this.channel = null;
    }
  }
}
