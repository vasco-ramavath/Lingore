import { supabase } from "./supabase.js";

const ICE_SERVERS = [
  { urls:"stun:stun.l.google.com:19302" },
  { urls:"stun:stun.cloudflare.com:3478" }
];

export class VoiceCall {
  constructor(callId,userId,remoteUserId){
    this.callId=callId; this.userId=userId; this.remoteUserId=remoteUserId;
    this.pc=new RTCPeerConnection({iceServers:ICE_SERVERS});
    this.localStream=null; this.channel=null; this.remoteAudio=null;
    this.remoteDescriptionSet=false; this.pendingCandidates=[]; this.ended=false;
    this.answerReceived=false; this.restartAttempts=0; this.restartInProgress=false; this.lastRestartAt=0;
    this.speakerOn=true; this.onState=()=>{};
    this.pc.ontrack=(event)=>this.attachRemoteAudio(event);
  }
  setState(s){try{this.onState(s);}catch(e){console.warn(e);}}
  async start(){
    const {data:{session}}=await supabase.auth.getSession();
    if(!session?.access_token) throw new Error("Authentication session expired.");
    await supabase.realtime.setAuth(session.access_token);
    this.localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1},video:false});
    this.localStream.getAudioTracks().forEach(t=>{t.enabled=true;this.pc.addTrack(t,this.localStream);});
    this.pc.onconnectionstatechange=()=>{
      const s=this.pc.connectionState; console.log("WEBRTC CONNECTION:",s);
      if(s==="connected"){this.restartAttempts=0;this.setState("connected");}
      else if(s==="disconnected"){this.setState("reconnecting");this.tryIceRestart();}
      else if(s==="failed"){this.setState("reconnecting");this.tryIceRestart();}
    };
    this.pc.oniceconnectionstatechange=()=>{
      const s=this.pc.iceConnectionState; console.log("WEBRTC ICE:",s);
      if(s==="connected"||s==="completed"){this.restartAttempts=0;this.setState("connected");}
      else if(s==="disconnected"){this.setState("reconnecting");this.tryIceRestart();}
      else if(s==="failed"){this.setState("reconnecting");this.tryIceRestart();}
    };
    this.pc.onicecandidate=async e=>{if(e.candidate&&!this.ended)try{await this.sendSignal({type:"ice",candidate:e.candidate.toJSON?e.candidate.toJSON():e.candidate,from:this.userId});}catch(err){console.warn("ICE SEND:",err);}};
    this.channel=supabase.channel(`call:${this.callId}`,{config:{private:true,broadcast:{ack:true,self:false}}});
    this.channel.on("broadcast",{event:"signal"},async({payload})=>{
      if(this.ended||!payload||payload.from===this.userId)return;
      try{
        if(payload.type==="offer") await this.handleOffer(payload.offer);
        else if(payload.type==="answer") await this.handleAnswer(payload.answer);
        else if(payload.type==="ice"&&payload.candidate) await this.handleIce(payload.candidate);
        else if(payload.type==="hangup") this.setState("remote-hangup");
      }catch(err){console.error("SIGNAL ERROR:",err);this.setState("failed");}
    });
    await this.subscribe();
    // Deterministic initiator: lower UUID creates the first offer.
    if(String(this.userId)<String(this.remoteUserId)) await this.createOffer(false);
    this.setState("connecting");
  }
  async subscribe(){
    await new Promise((resolve,reject)=>{
      let done=false;
      this.channel.subscribe((status,error)=>{
        console.log("CALL CHANNEL:",status,error||"");
        if(status==="SUBSCRIBED"){done=true;resolve();}
        else if(["CHANNEL_ERROR","TIMED_OUT","CLOSED"].includes(status)&&!done){done=true;reject(error||new Error(`Call signaling: ${status}`));}
      });
    });
  }
  async sendSignal(payload){
    if(!this.channel||this.ended)return;
    const result=await this.channel.send({type:"broadcast",event:"signal",payload});
    if(result&&result!=="ok")console.warn("SIGNAL SEND RESULT:",result);
  }
  async createOffer(iceRestart=false){
    if(this.ended)return;
    const offer=await this.pc.createOffer(iceRestart?{iceRestart:true}:{offerToReceiveAudio:true});
    await this.pc.setLocalDescription(offer);
    await this.sendSignal({type:"offer",offer:this.pc.localDescription,from:this.userId});
    console.log("OFFER SENT");
  }
  async offer(){return this.createOffer(false);}
  async handleOffer(offer){
    if(this.ended||!offer)return;
    await this.pc.setRemoteDescription(offer); this.remoteDescriptionSet=true; await this.flushCandidates();
    const answer=await this.pc.createAnswer(); await this.pc.setLocalDescription(answer);
    await this.sendSignal({type:"answer",answer:this.pc.localDescription,from:this.userId});
    console.log("ANSWER SENT");
  }
  async handleAnswer(answer){
    if(this.ended||!answer||this.pc.remoteDescription)return;
    await this.pc.setRemoteDescription(answer); this.remoteDescriptionSet=true; await this.flushCandidates();
  }
  async handleIce(candidate){
    if(this.ended)return;
    if(!this.remoteDescriptionSet&&!this.pc.remoteDescription){this.pendingCandidates.push(candidate);return;}
    try{await this.pc.addIceCandidate(candidate);}catch(e){console.warn("ICE ADD:",e);}
  }
  async flushCandidates(){const list=this.pendingCandidates.splice(0);for(const c of list)try{await this.pc.addIceCandidate(c);}catch(e){console.warn("QUEUED ICE:",e);}}
  attachRemoteAudio(event){
    console.log("REMOTE TRACK RECEIVED");
    const stream=event.streams?.[0]; if(!stream)return;
    if(!this.remoteAudio){
      this.remoteAudio=document.createElement("audio");
      this.remoteAudio.id=`lingore-audio-${this.callId}`;
      this.remoteAudio.autoplay=true; this.remoteAudio.playsInline=true; this.remoteAudio.controls=false;
      this.remoteAudio.volume=1; this.remoteAudio.muted=false;
      Object.assign(this.remoteAudio.style,{position:"fixed",width:"1px",height:"1px",opacity:"0.01",left:"-10px",bottom:"0",pointerEvents:"none"});
      document.body.appendChild(this.remoteAudio);
      ["play","playing","error","volumechange"].forEach(e=>this.remoteAudio.addEventListener(e,()=>console.log("REMOTE AUDIO",e)));
    }
    this.remoteAudio.srcObject=stream;
    event.track.enabled=true;
    const play=async()=>{try{this.remoteAudio.volume=this.speakerOn?1:0;await this.remoteAudio.play();console.log("REMOTE AUDIO PLAYING");this.setState("audio-ready");}catch(e){console.warn("REMOTE AUDIO PLAY BLOCKED:",e);}};
    play(); event.track.onunmute=play;
  }
  async toggleSpeaker(){
    if(!this.remoteAudio){return this.speakerOn;}
    this.speakerOn=!this.speakerOn; this.remoteAudio.muted=!this.speakerOn; this.remoteAudio.volume=this.speakerOn?1:0;
    if(this.speakerOn)try{await this.remoteAudio.play();}catch(e){console.warn("SPEAKER PLAY:",e);}
    return this.speakerOn;
  }
  mute(muted){this.localStream?.getAudioTracks().forEach(t=>t.enabled=!muted);}
  async tryIceRestart(){
    if(this.ended||this.restartInProgress)return;
    const now=Date.now(); if(now-this.lastRestartAt<5000)return; if(this.restartAttempts>=3){this.setState("failed");return;}
    this.restartInProgress=true;this.lastRestartAt=now;this.restartAttempts++;
    try{if(this.pc.restartIce)this.pc.restartIce();await this.createOffer(true);}catch(e){console.warn("ICE RESTART:",e);if(this.restartAttempts>=3)this.setState("failed");}finally{this.restartInProgress=false;}
  }
  async end(notifyRemote=true){
    if(this.ended)return;
    // IMPORTANT: send hangup while channel is still alive and before ended=true.
    if(notifyRemote&&this.channel){try{await this.sendSignal({type:"hangup",from:this.userId});await new Promise(r=>setTimeout(r,120));}catch(e){console.warn("HANGUP:",e);}}
    this.ended=true;
    this.localStream?.getTracks().forEach(t=>t.stop()); this.localStream=null;
    if(this.remoteAudio){this.remoteAudio.pause();this.remoteAudio.srcObject=null;this.remoteAudio.remove();this.remoteAudio=null;}
    this.pc.ontrack=null;this.pc.onconnectionstatechange=null;this.pc.oniceconnectionstatechange=null;this.pc.onicecandidate=null;
    try{this.pc.close();}catch(e){}
    if(this.channel){try{await supabase.removeChannel(this.channel);}catch(e){}this.channel=null;}
  }
}
