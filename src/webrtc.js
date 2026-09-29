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
    this.peerReady = false;
    this.offerSent = false;
    this.ended = false;
    this.readyRetry = null;

    this.onState = () => {};

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;
      console.log("WEBRTC CONNECTION:", state);
      this.onState(state);
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log("WEBRTC ICE:", state);

      if (state === "connected" || state === "completed") {
        this.onState("connected");
      } else if (state === "disconnected") {
        this.onState("disconnected");
      } else if (state === "failed") {
        this.onState("failed");
      }
    };

    this.pc.onicecandidateerror = e => {
      console.warn("WEBRTC ICE CANDIDATE ERROR:", e);
    };

    this.pc.onicecandidate = async e => {
      if (!e.candidate || this.ended) return;

      try {
        await this.sendSignal({
          type: "ice",
          candidate: e.candidate.toJSON
            ? e.candidate.toJSON()
            : e.candidate,
          from: this.userId
        });
      } catch (err) {
        console.warn("ICE SEND ERROR:", err);
      }
    };

    this.pc.ontrack = e => {
      const stream = e.streams?.[0];
      if (!stream) return;

      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement("audio");
        this.remoteAudio.id = `lingore-remote-${this.callId}`;
        this.remoteAudio.autoplay = true;
        this.remoteAudio.playsInline = true;
        this.remoteAudio.style.display = "none";

        document.body.appendChild(this.remoteAudio);
      }

      this.remoteAudio.srcObject = stream;

      const play = async () => {
        try {
          await this.remoteAudio.play();
          console.log("REMOTE AUDIO PLAYING");
        } catch (err) {
          console.warn("REMOTE AUDIO PLAY BLOCKED:", err);
        }
      };

      play();
      e.track.onunmute = play;
    };
  }

  async start() {
    if (this.ended) {
      throw new Error("Call already ended.");
    }

    const {
      data: { session }
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new Error("Authentication session expired.");
    }

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

    this.localStream.getAudioTracks().forEach(track => {
      track.enabled = true;
      this.pc.addTrack(track, this.localStream);
    });

    this.channel = supabase.channel(`call:${this.callId}`, {
      config: {
        private: true,
        broadcast: {
          ack: true,
          self: false
        }
      }
    });

    this.channel.on(
      "broadcast",
      { event: "signal" },
      async ({ payload }) => {
        if (!payload || payload.from === this.userId || this.ended) {
          return;
        }

        try {
          if (payload.type === "ready") {
            this.peerReady = true;

            await this.sendSignal({
              type: "ready-ack",
              from: this.userId
            });

            if (this.isInitiator) {
              await this.createAndSendOffer();
            }

            return;
          }

          if (payload.type === "ready-ack") {
            this.peerReady = true;

            if (this.isInitiator) {
              await this.createAndSendOffer();
            }

            return;
          }

          if (payload.type === "offer") {
            if (this.pc.remoteDescription) return;

            await this.pc.setRemoteDescription(payload.offer);

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

            return;
          }

          if (payload.type === "answer") {
            if (this.pc.remoteDescription) return;

            await this.pc.setRemoteDescription(payload.answer);

            this.remoteDescriptionSet = true;

            await this.flushPendingIce();

            return;
          }

          if (payload.type === "ice" && payload.candidate) {
            if (
              this.remoteDescriptionSet ||
              this.pc.remoteDescription
            ) {
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
          this.onState("failed");
        }
      }
    );

    await this.subscribe();

    // Send ready only after channel subscription.
    await this.sendSignal({
      type: "ready",
      from: this.userId
    });

    // Retry ready signal briefly.
    // This prevents the occasional Connecting... problem
    // when the other phone subscribes slightly later.
    this.readyRetry = setInterval(async () => {
      if (
        this.ended ||
        this.peerReady ||
        this.offerSent
      ) {
        clearInterval(this.readyRetry);
        this.readyRetry = null;
        return;
      }

      try {
        await this.sendSignal({
          type: "ready",
          from: this.userId
        });
      } catch (_) {}
    }, 500);

    setTimeout(() => {
      if (this.readyRetry) {
        clearInterval(this.readyRetry);
        this.readyRetry = null;
      }
    }, 10000);

    return this;
  }

  async subscribe() {
    await new Promise((resolve, reject) => {
      let done = false;

      this.channel.subscribe((status, error) => {
        console.log(
          "CALL CHANNEL:",
          status,
          error || ""
        );

        if (status === "SUBSCRIBED") {
          if (!done) {
            done = true;
            resolve();
          }

          return;
        }

        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          if (!done) {
            done = true;

            reject(
              error ||
              new Error(
                `Call signaling status: ${status}`
              )
            );
          }
        }
      });
    });
  }

  async createAndSendOffer() {
    if (
      !this.isInitiator ||
      this.ended ||
      this.offerSent ||
      !this.peerReady
    ) {
      return;
    }

    this.offerSent = true;

    try {
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

    } catch (error) {
      this.offerSent = false;
      throw error;
    }
  }

  async offer() {
    if (!this.isInitiator) return;

    if (!this.peerReady) {
      const started = Date.now();

      while (
        !this.peerReady &&
        !this.ended &&
        Date.now() - started < 10000
      ) {
        await new Promise(resolve =>
          setTimeout(resolve, 100)
        );
      }
    }

    if (!this.peerReady) {
      throw new Error(
        "Timed out waiting for the other person to connect."
      );
    }

    await this.createAndSendOffer();
  }

  async waitForOfferAndAnswer() {
    const started = Date.now();

    while (
      !this.ended &&
      Date.now() - started < 15000 &&
      !(
        this.pc.remoteDescription?.type === "offer" &&
        this.pc.localDescription?.type === "answer"
      )
    ) {
      await new Promise(resolve =>
        setTimeout(resolve, 100)
      );
    }

    if (this.ended) {
      throw new Error("Call ended.");
    }

    if (
      !(
        this.pc.remoteDescription?.type === "offer" &&
        this.pc.localDescription?.type === "answer"
      )
    ) {
      throw new Error(
        "Timed out waiting for the other person."
      );
    }
  }

  async flushPendingIce() {
    if (
      !this.remoteDescriptionSet &&
      !this.pc.remoteDescription
    ) {
      return;
    }

    const queued = this.pendingIce.splice(0);

    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (error) {
        console.warn(
          "QUEUED ICE ERROR:",
          error
        );
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
      console.warn(
        "SIGNAL SEND RESULT:",
        result
      );
    }
  }

  async mute(muted) {
    this.localStream
      ?.getAudioTracks()
      .forEach(track => {
        track.enabled = !muted;
      });
  }

  async end(notifyRemote = true) {
    if (this.ended) return;

    if (notifyRemote && this.channel) {
      try {
        await this.sendSignal({
          type: "hangup",
          from: this.userId
        });

        await new Promise(resolve =>
          setTimeout(resolve, 120)
        );

      } catch (_) {}
    }

    this.ended = true;

    if (this.readyRetry) {
      clearInterval(this.readyRetry);
    }

    this.readyRetry = null;

    this.localStream
      ?.getTracks()
      .forEach(track => track.stop());

    this.localStream = null;

    if (this.remoteAudio) {
      this.remoteAudio.pause();
      this.remoteAudio.srcObject = null;
      this.remoteAudio.remove();
      this.remoteAudio = null;
    }

    try {
      this.pc.close();
    } catch (_) {}

    if (this.channel) {
      try {
        await supabase.removeChannel(
          this.channel
        );
      } catch (_) {}

      this.channel = null;
    }
  }
}
