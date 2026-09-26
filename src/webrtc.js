import { supabase } from "./supabase.js";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" }
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
    this.pendingIce = [];
    this.remoteDescriptionSet = false;
    this.ended = false;
    this.restartTimer = null;
    this.restartAttempts = 0;
    this.restartInProgress = false;

    this.onState = () => {};

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log("WEBRTC CONNECTION:", state);
      this.onState(state);

      if (state === "connected") {
        this.restartAttempts = 0;
        this.restartInProgress = false;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = null;
      } else if (state === "disconnected") {
        this.scheduleIceRestart();
      } else if (state === "failed") {
        this.scheduleIceRestart();
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log("WEBRTC ICE:", state);
      if (state === "connected" || state === "completed") {
        this.restartAttempts = 0;
        this.restartInProgress = false;
      } else if (state === "disconnected" || state === "failed") {
        this.scheduleIceRestart();
      }
    };

    this.pc.onicecandidateerror = event => {
      console.warn("WEBRTC ICE CANDIDATE ERROR:", event);
    };

    this.pc.ontrack = event => {
      console.log("REMOTE TRACK RECEIVED");
      const stream = event.streams?.[0];
      if (!stream) return;

      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement("audio");
        this.remoteAudio.id = `lingore-remote-${this.callId}`;
        this.remoteAudio.autoplay = true;
        this.remoteAudio.playsInline = true;
        this.remoteAudio.controls = false;
        this.remoteAudio.volume = 1;
        this.remoteAudio.style.display = "none";
        document.body.appendChild(this.remoteAudio);
      }

      this.remoteAudio.srcObject = stream;

      const playRemote = async () => {
        if (!this.remoteAudio || this.ended) return;
        try {
          await this.remoteAudio.play();
          console.log("REMOTE AUDIO PLAYING");
        } catch (error) {
          console.warn("REMOTE AUDIO PLAY BLOCKED:", error);
        }
      };

      playRemote();
      event.track.onunmute = playRemote;
    };

    this.pc.onicecandidate = async event => {
      if (!event.candidate || this.ended) return;
      try {
        await this.sendSignal({
          type: "ice",
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
          from: this.userId
        });
      } catch (error) {
        console.warn("ICE SEND ERROR:", error);
      }
    };
  }

  async start() {
    if (this.ended) throw new Error("Call already ended.");

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("Authentication session expired.");

    await supabase.realtime.setAuth(session.access_token);

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    });

    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = true;
      this.pc.addTrack(track, this.localStream);
    }

    this.channel = supabase.channel(`call:${this.callId}`, {
      config: {
        private: true,
        broadcast: { ack: true, self: false }
      }
    });

    this.channel.on("broadcast", { event: "signal" }, async ({ payload }) => {
      if (!payload || payload.from === this.userId || this.ended) return;

      try {
        if (payload.type === "ready") {
          console.log("SIGNAL READY RECEIVED");
          if (this.isInitiator && !this.pc.localDescription) {
            await this.createAndSendOffer(false);
          }
          return;
        }

        if (payload.type === "offer") {
          console.log("SIGNAL OFFER RECEIVED");
          await this.handleOffer(payload.offer);
          return;
        }

        if (payload.type === "answer") {
          console.log("SIGNAL ANSWER RECEIVED");
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

        if (payload.type === "hangup") {
          console.log("REMOTE HANGUP RECEIVED");
          this.onState("remote-hangup");
        }
      } catch (error) {
        console.error("SIGNAL HANDLER ERROR:", error);
        this.onState("signaling-error");
      }
    });

    await this.subscribe();

    // Both phones send ready only after their own private channel is subscribed.
    // Either ready can arrive first; the elected initiator creates the offer
    // only when it receives the peer's ready, eliminating the lost-offer race.
    await this.sendSignal({ type: "ready", from: this.userId });
    return this;
  }

  async subscribe() {
    await new Promise((resolve, reject) => {
      let done = false;
      this.channel.subscribe((status, error) => {
        console.log("CALL CHANNEL:", status, error || "");
        if (status === "SUBSCRIBED") {
          done = true;
          resolve();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          if (!done) {
            done = true;
            reject(error || new Error(`Call signaling status: ${status}`));
          }
        }
      });
    });
  }

  async createAndSendOffer(iceRestart = false) {
    if (this.ended || this.pc.signalingState !== "stable") return;

    const offer = await this.pc.createOffer(
      iceRestart ? { iceRestart: true, offerToReceiveAudio: true } : { offerToReceiveAudio: true }
    );
    await this.pc.setLocalDescription(offer);

    await this.sendSignal({
      type: "offer",
      offer: this.pc.localDescription,
      from: this.userId
    });
    console.log(iceRestart ? "SIGNAL ICE RESTART OFFER SENT" : "SIGNAL OFFER SENT");
  }

  async handleOffer(offer) {
    if (this.ended || !offer) return;

    // An ICE-restart offer is a normal new offer. The callee answers it.
    await this.pc.setRemoteDescription(offer);
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.sendSignal({
      type: "answer",
      answer: this.pc.localDescription,
      from: this.userId
    });
    console.log("SIGNAL ANSWER SENT");
  }

  async flushPendingIce() {
    if (!this.remoteDescriptionSet && !this.pc.remoteDescription) return;
    const queued = this.pendingIce.splice(0);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn("QUEUED ICE ERROR:", error);
      }
    }
  }

  scheduleIceRestart() {
    if (this.ended || !this.isInitiator || this.restartAttempts >= 3 || this.restartTimer) return;

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      if (this.ended || this.pc.connectionState === "connected") return;
      if (this.pc.signalingState !== "stable") {
        this.scheduleIceRestart();
        return;
      }

      this.restartAttempts += 1;
      this.restartInProgress = true;
      try {
        if (typeof this.pc.restartIce === "function") this.pc.restartIce();
        await this.createAndSendOffer(true);
      } catch (error) {
        console.warn("ICE RESTART ERROR:", error);
      } finally {
        this.restartInProgress = false;
      }
    }, 1500);
  }

  // Kept only for compatibility with older code. New main.js does not call these.
  async offer() {
    await this.createAndSendOffer(false);
  }

  async answer() {
    if (!this.pc.remoteDescription || this.pc.localDescription) return;
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.sendSignal({ type: "answer", answer: this.pc.localDescription, from: this.userId });
  }

  async mute(muted) {
    this.localStream?.getAudioTracks().forEach(track => {
      track.enabled = !muted;
    });
  }

  async end(notifyRemote = true) {
    if (this.ended) return;

    console.log("ENDING CALL", { notifyRemote });

    // Hangup MUST be sent before ended=true, otherwise sendSignal() refuses it.
    if (notifyRemote && this.channel) {
      try {
        await this.sendSignal({ type: "hangup", from: this.userId });
        console.log("HANGUP SENT");
        await new Promise(resolve => setTimeout(resolve, 120));
      } catch (error) {
        console.warn("HANGUP SEND ERROR:", error);
      }
    }

    this.ended = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;

    this.localStream?.getTracks().forEach(track => track.stop());
    this.localStream = null;

    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }

    this.pc.ontrack = null;
    try { this.pc.close(); } catch (_) {}

    if (this.channel) {
      try { await supabase.removeChannel(this.channel); } catch (_) {}
      this.channel = null;
    }
  }

  async sendSignal(payload) {
    if (!this.channel || this.ended) return;
    const result = await this.channel.send({
      type: "broadcast",
      event: "signal",
      payload
    });
    if (result && result !== "ok") console.warn("SIGNAL SEND RESULT:", result);
  }
}
