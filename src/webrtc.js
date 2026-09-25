import { supabase } from "./supabase.js";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" }
  // Production: add a TURN server here for users behind restrictive NATs.
];

export class VoiceCall {
  constructor(callId, userId, remoteUserId) {
    this.callId = callId; this.userId = userId; this.remoteUserId = remoteUserId;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.channel = null; this.localStream = null; this.onState = () => {};
    this.pc.onconnectionstatechange = () => this.onState(this.pc.connectionState);
  }

  async start() {
    this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this.localStream.getTracks().forEach(t => this.pc.addTrack(t, this.localStream));
    this.pc.ontrack = e => { this.remoteAudio = new Audio(); this.remoteAudio.autoplay = true; this.remoteAudio.srcObject = e.streams[0]; };
    this.channel = supabase.channel(`call:${this.callId}`, { config: { private: true } });
    this.channel.on("broadcast", { event: "signal" }, async ({ payload }) => {
      if (payload.from === this.userId) return;
      if (payload.type === "offer") await this.pc.setRemoteDescription(payload.offer);
      if (payload.type === "answer") await this.pc.setRemoteDescription(payload.answer);
      if (payload.type === "ice" && payload.candidate) await this.pc.addIceCandidate(payload.candidate);
      if (payload.type === "hangup") this.onState("remote-hangup");
    });
    this.pc.onicecandidate = e => {
      if (e.candidate) this.channel.send({ type:"broadcast", event:"signal", payload:{type:"ice", candidate:e.candidate, from:this.userId} });
    };
    await this.channel.subscribe();
    return this;
  }

  async offer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.channel.send({ type:"broadcast", event:"signal", payload:{type:"offer", offer, from:this.userId} });
  }

  async answer() {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.channel.send({ type:"broadcast", event:"signal", payload:{type:"answer", answer, from:this.userId} });
  }

  async mute(muted) { this.localStream?.getAudioTracks().forEach(t => t.enabled = !muted); }

  async end() {
    try { await this.channel?.send({type:"broadcast",event:"signal",payload:{type:"hangup",from:this.userId}}); } catch {}
    this.localStream?.getTracks().forEach(t => t.stop());
    this.pc.close();
    if (this.channel) await supabase.removeChannel(this.channel);
  }
}