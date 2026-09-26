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

    this.channel = null;
    this.localStream = null;
    this.remoteAudio = null;

    this.onState = () => {};

    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.ended = false;
    this.offerReceived = false;
    this.answerReceived = false;
  }

  setState(state) {
    try {
      this.onState(state);
    } catch (_) {}
  }

  async start() {
    if (this.ended) {
      throw new Error("Call already ended.");
    }

    // 1. Microphone
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    this.localStream.getTracks().forEach(track => {
      this.pc.addTrack(track, this.localStream);
    });

    // 2. Remote audio
    this.pc.ontrack = event => {
      if (!this.remoteAudio) {
        this.remoteAudio = new Audio();
        this.remoteAudio.autoplay = true;
        this.remoteAudio.playsInline = true;
      }

      this.remoteAudio.srcObject = event.streams[0];

      this.remoteAudio.play().catch(() => {});
    };

    // 3. Connection state
    this.pc.onconnectionstatechange = () => {
      const state = this.pc.connectionState;

      console.log("WEBRTC CONNECTION:", state);

      if (state === "connected") {
        this.setState("connected");
      }

      if (state === "connecting") {
        this.setState("connecting");
      }

      if (state === "disconnected") {
        this.setState("disconnected");
      }

      if (state === "failed") {
        this.setState("failed");
      }

      if (state === "closed" && !this.ended) {
        this.setState("remote-hangup");
      }
    };

    // 4. ICE state
    this.pc.oniceconnectionstatechange = () => {
      console.log(
        "WEBRTC ICE:",
        this.pc.iceConnectionState
      );
    };

    // 5. ICE candidates
    this.pc.onicecandidate = async event => {
      if (!event.candidate || this.ended) return;

      try {
        await this.sendSignal({
          type: "ice",
          candidate: event.candidate.toJSON
            ? event.candidate.toJSON()
            : event.candidate,
          from: this.userId
        });
      } catch (error) {
        console.error("ICE send error:", error);
      }
    };

    // 6. Get current authenticated session
    const {
      data: { session }
    } = await supabase.auth.getSession();

    if (!session?.access_token) {
      throw new Error("Authentication session expired.");
    }

    // 7. IMPORTANT:
    // Authenticate Supabase Realtime BEFORE private channel subscribe.
    await supabase.realtime.setAuth(session.access_token);

    // 8. Create private call channel
    this.channel = supabase.channel(
      `call:${this.callId}`,
      {
        config: {
          private: true,
          broadcast: {
            ack: true
          }
        }
      }
    );

    // 9. Receive WebRTC signals
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

        console.log(
          "CALL SIGNAL RECEIVED:",
          payload.type
        );

        try {
          if (payload.type === "ready") {
            // Remote user is ready.
            // Initiator will create the offer.
            if (
              this.userId < this.remoteUserId &&
              !this.offerReceived &&
              !this.answerReceived
            ) {
              await this.createOffer();
            }
          }

          else if (payload.type === "offer") {
            await this.handleOffer(payload.offer);
          }

          else if (payload.type === "answer") {
            await this.handleAnswer(payload.answer);
          }

          else if (
            payload.type === "ice" &&
            payload.candidate
          ) {
            await this.handleIceCandidate(
              payload.candidate
            );
          }

          else if (payload.type === "hangup") {
            this.setState("remote-hangup");
          }

        } catch (error) {
          console.error(
            "WEBRTC SIGNAL ERROR:",
            error
          );

          this.setState("failed");
        }
      }
    );

    // 10. Subscribe correctly
    await new Promise((resolve, reject) => {
      let finished = false;

      const timeout = setTimeout(() => {
        if (finished) return;

        finished = true;

        reject(
          new Error(
            "Call signaling timed out."
          )
        );
      }, 15000);

      this.channel.subscribe((status, err) => {
        console.log(
          "CALL REALTIME:",
          status,
          err
        );

        if (status === "SUBSCRIBED") {
          if (finished) return;

          finished = true;
          clearTimeout(timeout);

          resolve();
          return;
        }

        if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          if (finished) return;

          finished = true;
          clearTimeout(timeout);

          console.error(
            "CALL CHANNEL ERROR:",
            status,
            err
          );

          reject(
            new Error(
              `Call signaling ${status}`
            )
          );
        }
      });
    });

    console.log(
      "CALL CHANNEL CONNECTED:",
      this.callId
    );

    this.setState("connecting");

    // 11. Tell the other user we are ready.
    await this.sendSignal({
      type: "ready",
      from: this.userId
    });
  }

  async sendSignal(payload) {
    if (
      !this.channel ||
      this.ended
    ) {
      return;
    }

    const result = await this.channel.send({
      type: "broadcast",
      event: "signal",
      payload
    });

    console.log(
      "CALL SIGNAL SENT:",
      payload.type,
      result
    );
  }

  async createOffer() {
    if (this.ended) return;

    if (
      this.pc.signalingState !== "stable"
    ) {
      return;
    }

    console.log("CREATING OFFER");

    const offer =
      await this.pc.createOffer();

    await this.pc.setLocalDescription(
      offer
    );

    await this.sendSignal({
      type: "offer",
      offer: this.pc.localDescription,
      from: this.userId
    });
  }

  async handleOffer(offer) {
    if (
      this.ended ||
      !offer
    ) {
      return;
    }

    console.log("RECEIVED OFFER");

    this.offerReceived = true;

    await this.pc.setRemoteDescription(
      offer
    );

    this.remoteDescriptionSet = true;

    await this.flushPendingCandidates();

    const answer =
      await this.pc.createAnswer();

    await this.pc.setLocalDescription(
      answer
    );

    console.log("SENDING ANSWER");

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

    console.log("RECEIVED ANSWER");

    this.answerReceived = true;

    await this.pc.setRemoteDescription(
      answer
    );

    this.remoteDescriptionSet = true;

    await this.flushPendingCandidates();
  }

  async handleIceCandidate(candidate) {
    if (
      this.ended ||
      !candidate
    ) {
      return;
    }

    if (!this.remoteDescriptionSet) {
      this.pendingCandidates.push(
        candidate
      );
      return;
    }

    try {
      await this.pc.addIceCandidate(
        candidate
      );
    } catch (error) {
      console.warn(
        "ICE candidate error:",
        error
      );
    }
  }

  async flushPendingCandidates() {
    if (
      !this.remoteDescriptionSet ||
      !this.pendingCandidates.length
    ) {
      return;
    }

    const candidates =
      this.pendingCandidates.splice(0);

    for (const candidate of candidates) {
      try {
        await this.pc.addIceCandidate(
          candidate
        );
      } catch (error) {
        console.warn(
          "Queued ICE error:",
          error
        );
      }
    }
  }

  async mute(muted) {
    if (!this.localStream) return;

    this.localStream
      .getAudioTracks()
      .forEach(track => {
        track.enabled = !muted;
      });
  }

  async end(notifyRemote = true) {
    if (this.ended) return;

    this.ended = true;

    if (
      notifyRemote &&
      this.channel
    ) {
      try {
        await this.sendSignal({
          type: "hangup",
          from: this.userId
        });
      } catch (_) {}
    }

    if (this.localStream) {
      this.localStream
        .getTracks()
        .forEach(track => track.stop());

      this.localStream = null;
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

    this.remoteAudio = null;
  }
    }
