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

    this.onState = () => {};

    this.pc.onconnectionstatechange = () => {
      console.log("WEBRTC CONNECTION:", this.pc.connectionState);
      this.onState(this.pc.connectionState);
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log("WEBRTC ICE:", this.pc.iceConnectionState);
      if (this.pc.iceConnectionState === "failed") {
        this.onState("ice-failed");
      }
    };

    this.pc.onicecandidateerror = (event) => {
      console.warn("WEBRTC ICE CANDIDATE ERROR:", event);
    };

    this.pc.ontrack = (event) => {
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

    this.pc.onicecandidate = async (event) => {
      if (!event.candidate) return;

      await this.sendSignal({
        type: "ice",
        candidate: event.candidate,
        from: this.userId
      });
    };
  }

  async start() {
    if (this.ended) throw new Error("Call already ended.");

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      throw new Error("Authentication session expired.");
    }

    // Required for private Supabase Realtime authorization.
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

    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = true;
      this.pc.addTrack(track, this.localStream);
    });

    this.channel = supabase.channel(`call:${this.callId}`, {
      config: {
        private: true,
        broadcast: { ack: true, self: false }
      }
    });

    this.channel.on(
      "broadcast",
      { event: "signal" },
      async ({ payload }) => {
        if (!payload || payload.from === this.userId || this.ended) return;

        try {
          if (payload.type === "ready") {
            console.log("SIGNAL READY RECEIVED");

            // Only one side creates the offer.
            if (this.isInitiator && !this.pc.localDescription) {
              await this.createAndSendOffer();
            }
            return;
          }

          if (payload.type === "offer") {
            console.log("SIGNAL OFFER RECEIVED");

            if (!this.pc.remoteDescription) {
              await this.pc.setRemoteDescription(payload.offer);
              this.remoteDescriptionSet = true;
              await this.flushPendingIce();
            }

            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);

            await this.sendSignal({
              type: "answer",
              answer: this.pc.localDescription,
              from: this.userId
            });

            console.log("SIGNAL ANSWER SENT");
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
              // ICE can arrive before the SDP.
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
      }
    );

    await this.subscribe();

    // This is deliberately sent AFTER subscribing. The initiator waits for
    // this signal before creating the offer, preventing a lost first offer.
    await this.sendSignal({
      type: "ready",
      from: this.userId
    });

    return this;
  }

  async subscribe() {
    await new Promise((resolve, reject) => {
      let finished = false;

      this.channel.subscribe((status, error) => {
        console.log("CALL CHANNEL:", status, error || "");

        if (status === "SUBSCRIBED") {
          finished = true;
          resolve();
          return;
        }

        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          if (!finished) {
            finished = true;
            reject(error || new Error(`Call signaling status: ${status}`));
          }
        }
      });
    });
  }

  async createAndSendOffer() {
    if (this.ended || this.pc.localDescription) return;

    const offer = await this.pc.createOffer({
      offerToReceiveAudio: true
    });

    await this.pc.setLocalDescription(offer);

    await this.sendSignal({
      type: "offer",
      offer: this.pc.localDescription,
      from: this.userId
    });

    console.log("SIGNAL OFFER SENT");
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

  async sendSignal(payload) {
    if (!this.channel || this.ended) return;

    const result = await this.channel.send({
      type: "broadcast",
      event: "signal",
      payload
    });

    if (result && result !== "ok") {
      console.warn("SIGNAL SEND RESULT:", result);
    }
  }

  // Compatibility with older main.js. The new negotiation is automatic.
  async offer() {
    if (!this.pc.localDescription) {
      await this.createAndSendOffer();
    }
  }

  // Compatibility with older main.js. The offer handler normally answers.
  async answer() {
    if (!this.pc.remoteDescription || this.pc.localDescription) return;

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    await this.sendSignal({
      type: "answer",
      answer: this.pc.localDescription,
      from: this.userId
    });
  }

  async mute(muted) {
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
  }

  async end(notifyRemote = true) {
    if (this.ended) return;

    console.log("ENDING CALL", { notifyRemote });

    // IMPORTANT: send hangup BEFORE setting ended=true.
    if (notifyRemote && this.channel) {
      try {
        await this.sendSignal({
          type: "hangup",
          from: this.userId
        });
        console.log("HANGUP SENT");

        // Give the broadcast a moment to leave the socket before cleanup.
        await new Promise((resolve) => setTimeout(resolve, 120));
      } catch (error) {
        console.warn("HANGUP SEND ERROR:", error);
      }
    }

    this.ended = true;

    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;

    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }

    this.pc.ontrack = null;
    this.pc.close();

    if (this.channel) {
      try {
        await supabase.removeChannel(this.channel);
      } catch {}
      this.channel = null;
    }
  }
}
