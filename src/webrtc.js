import { supabase } from "./supabase.js";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" }
];

export class VoiceCall {
  constructor(callId, userId, remoteUserId) {
    this.callId = callId;
    this.userId = userId;
    this.remoteUserId = remoteUserId;

    this.pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS
    });

    this.localStream = null;
    this.channel = null;
    this.onState = () => {};

    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.offerReceived = false;
    this.answerReceived = false;
    this.ended = false;
    this.remoteAudio = null;
    this.waitTimer = null;
  }

  setState(state) {
    try {
      this.onState(state);
    } catch (_) {}
  }

  async start() {
    if (this.ended) {
      throw new Error("Call has already ended.");
    }

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    this.localStream.getTracks().forEach((track) => {
      this.pc.addTrack(track, this.localStream);
    });

    // Receive the other person's voice.
    this.pc.ontrack = (event) => {
      if (!event.streams || !event.streams[0]) return;

      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement("audio");
        this.remoteAudio.autoplay = true;
        this.remoteAudio.playsInline = true;
        this.remoteAudio.style.display = "none";
        document.body.appendChild(this.remoteAudio);
      }

      this.remoteAudio.srcObject = event.streams[0];

      this.remoteAudio.play().catch(() => {
        // Browser may require a user interaction before playback.
      });
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;

      if (state === "connected") {
        this.setState("connected");
      } else if (state === "connecting") {
        this.setState("connecting");
      } else if (state === "disconnected") {
        this.setState("reconnecting");
      } else if (state === "failed") {
        this.setState("failed");
      } else if (state === "closed") {
        this.setState("remote-hangup");
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;

      if (state === "connected" || state === "completed") {
        this.setState("connected");
      } else if (state === "checking") {
        this.setState("connecting");
      } else if (state === "disconnected") {
        this.setState("reconnecting");
      } else if (state === "failed") {
        this.setState("failed");
      }
    };

    this.pc.onicecandidate = async (event) => {
      if (!event.candidate || this.ended) return;

      try {
        await this.sendSignal({
          type: "ice",
          candidate: event.candidate,
          from: this.userId
        });
      } catch (_) {}
    };

    const { data: { session } } = await supabase.auth.getSession();

if (!session?.access_token) {
  throw new Error("Authentication session expired.");
}

await supabase.realtime.setAuth(session.access_token);

this.channel = supabase.channel(`call:${this.callId}`, {
  config: {
    private: true
  }
});

this.channel.on(
  "broadcast",
  { event: "signal" },
  async ({ payload }) => {
    if (
      this.ended ||
      !payload ||
      payload.from === this.userId
    ) {
      return;
    }

    try {
      if (payload.type === "offer") {
        await this.handleOffer(payload.offer);
      }

      if (payload.type === "answer") {
        await this.handleAnswer(payload.answer);
      }

      if (payload.type === "ice" && payload.candidate) {
        await this.handleIceCandidate(payload.candidate);
      }

      if (payload.type === "hangup") {
        this.setState("remote-hangup");
      }
    } catch (error) {
      console.error("WebRTC signal error:", error);
      this.setState("failed");
    }
  }
);

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error("Call signaling timed out."));
  }, 10000);

  this.channel.subscribe((status, err) => {
    console.log("CALL REALTIME:", status, err);

    if (status === "SUBSCRIBED") {
      clearTimeout(timeout);
      resolve();
      return;
    }

    if (
      status === "CHANNEL_ERROR" ||
      status === "TIMED_OUT" ||
      status === "CLOSED"
    ) {
      clearTimeout(timeout);

      reject(
        err instanceof Error
          ? err
          : new Error(`Call signaling ${status}`)
      );
    }
  });
});

this.setState("connecting");
  }

  async sendSignal(payload) {
    if (!this.channel || this.ended) return;

    await this.channel.send({
      type: "broadcast",
      event: "signal",
      payload
    });
  }

  async offer() {
    if (this.ended) return;

    const offer = await this.pc.createOffer();

    await this.pc.setLocalDescription(offer);

    await this.sendSignal({
      type: "offer",
      offer: this.pc.localDescription,
      from: this.userId
    });
  }

  async handleOffer(offer) {
    if (this.ended || !offer) return;

    this.offerReceived = true;

    await this.pc.setRemoteDescription(
      new RTCSessionDescription(offer)
    );

    this.remoteDescriptionSet = true;

    await this.flushPendingCandidates();

    const answer = await this.pc.createAnswer();

    await this.pc.setLocalDescription(answer);

    await this.sendSignal({
      type: "answer",
      answer: this.pc.localDescription,
      from: this.userId
    });
  }

  async handleAnswer(answer) {
    if (
      this.ended ||
      !answer ||
      this.answerReceived
    ) {
      return;
    }

    this.answerReceived = true;

    await this.pc.setRemoteDescription(
      new RTCSessionDescription(answer)
    );

    this.remoteDescriptionSet = true;

    await this.flushPendingCandidates();
  }

  async handleIceCandidate(candidate) {
    if (this.ended || !candidate) return;

    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(candidate);
      return;
    }

    try {
      await this.pc.addIceCandidate(
        new RTCIceCandidate(candidate)
      );
    } catch (error) {
      console.warn("ICE candidate error:", error);
    }
  }

  async flushPendingCandidates() {
    if (
      !this.remoteDescriptionSet ||
      !this.pendingCandidates.length
    ) {
      return;
    }

    const candidates = this.pendingCandidates.splice(0);

    for (const candidate of candidates) {
      try {
        await this.pc.addIceCandidate(
          new RTCIceCandidate(candidate)
        );
      } catch (error) {
        console.warn("Queued ICE candidate error:", error);
      }
    }
  }

  waitForOfferAndAnswer() {
    return new Promise((resolve, reject) => {
      if (this.ended) {
        reject(new Error("Call has already ended."));
        return;
      }

      if (this.pc.connectionState === "connected") {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();

        reject(
          new Error(
            "Timed out waiting for the other person."
          )
        );
      }, 30000);

      const check = () => {
        if (this.ended) {
          cleanup();

          reject(new Error("Call ended."));
          return;
        }

        if (this.pc.connectionState === "connected") {
          cleanup();
          resolve();
          return;
        }

        if (this.pc.connectionState === "failed") {
          cleanup();

          reject(
            new Error("Voice connection failed.")
          );
          return;
        }

        if (this.pc.connectionState === "closed") {
          cleanup();

          reject(new Error("Call ended."));
        }
      };

      const oldHandler = this.onState;

      this.onState = (state) => {
        try {
          oldHandler(state);
        } catch (_) {}

        if (state === "connected") {
          cleanup();
          resolve();
        }

        if (state === "failed") {
          cleanup();

          reject(
            new Error("Voice connection failed.")
          );
        }

        if (state === "remote-hangup") {
          cleanup();

          reject(new Error("Call ended."));
        }
      };

      const interval = setInterval(check, 300);

      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(interval);
        this.onState = oldHandler;
      };

      check();
    });
  }

  mute(muted) {
    if (!this.localStream) return;

    this.localStream
      .getAudioTracks()
      .forEach((track) => {
        track.enabled = !muted;
      });
  }

  async end(notifyRemote = true) {
    if (this.ended) return;

    this.ended = true;

    if (notifyRemote && this.channel) {
      try {
        await this.sendSignal({
          type: "hangup",
          from: this.userId
        });
      } catch (_) {}
    }

    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }

    if (this.localStream) {
      this.localStream
        .getTracks()
        .forEach((track) => track.stop());

      this.localStream = null;
    }

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
        await supabase.removeChannel(this.channel);
      } catch (_) {}

      this.channel = null;
    }
  }
            }
