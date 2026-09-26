import { supabase } from "./supabase.js";

// STUN helps discover direct routes. TURN is still required for some
// carrier/NAT combinations; see the notes after deployment if ICE fails.
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
      if(state === "disconnected" && !this.ended){
        setTimeout(()=>this.tryIceRestart(),1500);
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      console.log("WEBRTC ICE:", state);
      if(state === "failed" && !this.ended){
        this.tryIceRestart();
      }
    };

    this.pc.onicecandidateerror = event => console.warn("WEBRTC ICE CANDIDATE ERROR:",event);

    this.pc.ontrack = event => {
      console.log("REMOTE TRACK RECEIVED", event.track?.kind);
      let stream = event.streams?.[0];
      if(!stream){
        if(!this.remoteStream) this.remoteStream=new MediaStream();
        this.remoteStream.addTrack(event.track);
        stream=this.remoteStream;
      }else{
        this.remoteStream=stream;
      }

      if(!this.remoteAudio){
        this.remoteAudio=document.createElement("audio");
        this.remoteAudio.id=`lingore-remote-${this.callId}`;
        this.remoteAudio.autoplay=true;
        this.remoteAudio.playsInline=true;
        this.remoteAudio.preload="auto";
        this.remoteAudio.controls=false;
        this.remoteAudio.volume=1;
        this.remoteAudio.muted=false;
        this.remoteAudio.setAttribute("aria-hidden","true");
        this.remoteAudio.style.position="fixed";
        this.remoteAudio.style.width="1px";
        this.remoteAudio.style.height="1px";
        this.remoteAudio.style.opacity="0.01";
        this.remoteAudio.style.pointerEvents="none";
        document.body.appendChild(this.remoteAudio);
      }

      this.remoteAudio.srcObject=stream;
      event.track.onunmute=()=>this.playRemoteAudio();
      this.playRemoteAudio();
    };

    this.pc.onicecandidate=async event=>{
      if(!event.candidate || this.ended) return;
      try{
        await this.sendSignal({type:"ice",candidate:event.candidate,from:this.userId});
      }catch(e){ console.warn("ICE SEND ERROR:",e); }
    };
  }

  async start(){
    if(this.ended) throw new Error("Call already ended.");

    const {data:{session}}=await supabase.auth.getSession();
    if(!session?.access_token) throw new Error("Authentication session expired.");
    await supabase.realtime.setAuth(session.access_token);

    this.localStream=await navigator.mediaDevices.getUserMedia({
      audio:{
        echoCancellation:true,
        noiseSuppression:true,
        autoGainControl:true,
        channelCount:1
      },
      video:false
    });

    this.localStream.getAudioTracks().forEach(track=>{
      track.enabled=true;
      this.pc.addTrack(track,this.localStream);
    });

    this.channel=supabase.channel(`call:${this.callId}`,{
      config:{private:true,broadcast:{ack:true,self:false}}
    });

    this.channel.on("broadcast",{event:"signal"},async({payload})=>{
      if(!payload || payload.from===this.userId || this.ended) return;
      try{
        if(payload.type==="ready"){
          console.log("SIGNAL READY RECEIVED");
          if(this.isInitiator && !this.pc.localDescription) await this.createAndSendOffer();
          return;
        }

        if(payload.type==="offer"){
          console.log("SIGNAL OFFER RECEIVED");
          await this.pc.setRemoteDescription(payload.offer);
          this.remoteDescriptionSet=true;
          await this.flushPendingIce();
          const answer=await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          await this.sendSignal({type:"answer",answer:this.pc.localDescription,from:this.userId});
          console.log("SIGNAL ANSWER SENT");
          return;
        }

        if(payload.type==="answer"){
          console.log("SIGNAL ANSWER RECEIVED");
          if(!this.pc.remoteDescription){
            await this.pc.setRemoteDescription(payload.answer);
            this.remoteDescriptionSet=true;
            await this.flushPendingIce();
          }
          return;
        }

        if(payload.type==="ice" && payload.candidate){
          if(this.remoteDescriptionSet || this.pc.remoteDescription){
            await this.pc.addIceCandidate(payload.candidate);
          }else{
            this.pendingIce.push(payload.candidate);
          }
          return;
        }

        if(payload.type==="hangup"){
          console.log("REMOTE HANGUP RECEIVED");
          this.onState("remote-hangup");
        }
      }catch(error){
        console.error("SIGNAL HANDLER ERROR:",error);
        this.onState("signaling-error");
      }
    });

    await this.subscribe();
    await this.sendSignal({type:"ready",from:this.userId});
    return this;
  }

  async subscribe(){
    await new Promise((resolve,reject)=>{
      let finished=false;
      this.channel.subscribe((status,error)=>{
        console.log("CALL CHANNEL:",status,error||"");
        if(status==="SUBSCRIBED"){
          finished=true;
          resolve();
        }else if((status==="CHANNEL_ERROR"||status==="TIMED_OUT"||status==="CLOSED")&&!finished){
          finished=true;
          reject(error||new Error(`Call signaling status: ${status}`));
        }
      });
    });
  }

  async createAndSendOffer(){
    if(this.ended || this.pc.localDescription) return;
    const offer=await this.pc.createOffer({offerToReceiveAudio:true});
    await this.pc.setLocalDescription(offer);
    await this.sendSignal({type:"offer",offer:this.pc.localDescription,from:this.userId});
    console.log("SIGNAL OFFER SENT");
  }

  async flushPendingIce(){
    if(!this.remoteDescriptionSet && !this.pc.remoteDescription) return;
    const queued=this.pendingIce.splice(0);
    for(const candidate of queued){
      try{ await this.pc.addIceCandidate(candidate); }catch(e){ console.warn("QUEUED ICE ERROR:",e); }
    }
  }

  async sendSignal(payload){
    if(!this.channel || this.ended) return;
    const result=await this.channel.send({type:"broadcast",event:"signal",payload});
    if(result && result!=="ok") throw new Error(`Signal send failed: ${result}`);
  }

  async mute(muted){
    this.localStream?.getAudioTracks().forEach(track=>track.enabled=!muted);
  }

  async playRemoteAudio(){
    if(!this.remoteAudio) return false;
    this.remoteAudio.muted=!this.speakerEnabled;
    try{
      await this.remoteAudio.play();
      console.log("REMOTE AUDIO PLAYING");
      this.onState("remote-audio");
      return true;
    }catch(error){
      console.warn("REMOTE AUDIO PLAY BLOCKED:",error);
      this.onState("audio-blocked");
      return false;
    }
  }

  async toggleSpeaker(){
    this.speakerEnabled=!this.speakerEnabled;
    if(this.remoteAudio){
      this.remoteAudio.muted=!this.speakerEnabled;
      if(this.speakerEnabled) await this.playRemoteAudio();
    }
    return this.speakerEnabled;
  }

  async tryIceRestart(){
    if(this.ended || this.restartAttempted || !this.channel) return;
    if(!["failed","disconnected"].includes(this.pc.iceConnectionState)) return;
    this.restartAttempted=true;
    try{
      console.log("TRYING ICE RESTART");
      const offer=await this.pc.createOffer({iceRestart:true,offerToReceiveAudio:true});
      await this.pc.setLocalDescription(offer);
      await this.sendSignal({type:"offer",offer:this.pc.localDescription,from:this.userId,iceRestart:true});
    }catch(e){
      console.warn("ICE RESTART FAILED:",e);
    }
  }

  async end(notifyRemote=true){
    if(this.ended) return;
    console.log("ENDING CALL",{notifyRemote});

    if(notifyRemote && this.channel){
      try{
        await this.sendSignal({type:"hangup",from:this.userId});
        await new Promise(r=>setTimeout(r,120));
      }catch(e){ console.warn("HANGUP SEND ERROR:",e); }
    }

    this.ended=true;
    this.localStream?.getTracks().forEach(track=>track.stop());
    this.localStream=null;

    if(this.remoteAudio){
      this.remoteAudio.pause();
      this.remoteAudio.srcObject=null;
      this.remoteAudio.remove();
      this.remoteAudio=null;
    }

    this.pc.ontrack=null;
    this.pc.close();

    if(this.channel){
      try{await supabase.removeChannel(this.channel);}catch{}
      this.channel=null;
    }
  }
}
