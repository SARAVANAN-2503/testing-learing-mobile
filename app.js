const API = 'https://api.zoujup.com/api/v1';
const WS = 'https://realtime.zoujup.com';
const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries(['role','token','myUserId','myNativeLanguage','myLearnLanguage','email','otp','sendOtpBtn','verifyOtpBtn','registerEmail','registerName','registerOtp','knownLanguage','learnLanguage','cefrLevel','registerBtn','completeRegisterBtn','copyRegisterToLoginBtn','peerUserId','createConversationBtn','markReadyBtn','conversationId','callId','connectBtn','loadActiveBtn','startAudioBtn','acceptBtn','declineBtn','upgradeBtn','acceptVideoBtn','declineVideoBtn','disableVideoBtn','endBtn','copyReportBtn','clearLogBtn','socketStatus','callStatus','pcStatus','remoteTrackStatus','localVideoInfo','remoteVideoInfo','localVideo','remoteVideo','log','secureBadge','secureWarning','dependencyWarning','matchRegisterAvailabilityBtn','matchGetCompatibleBtn','matchGetIncomingBtn','matchCompatibleCards','incomingMatchIdInput','matchAcceptBtn','matchDeclineBtn'].map(id=>[id,$(id)]));

const DEFAULT_LANGUAGES = [
  ['en','English'],['es','Spanish'],['fr','French'],['de','German'],['it','Italian'],
  ['pt','Portuguese'],['ar','Arabic'],['hi','Hindi'],['ta','Tamil'],['te','Telugu'],
  ['ml','Malayalam'],['kn','Kannada'],['zh','Chinese'],['ja','Japanese'],['ko','Korean']
];

let socket, pc, localStream, remoteStream = new MediaStream();
let currentCallId = '', caller = false, pendingCandidates = [], heartbeat, upgradeRequestedByMe = false;
let videoTransceiver = null, lastNegotiationId = null, lastHandledUpgradeRevision = null;

function safe(value) {
  if (!value) return value;
  const token = ui.token.value.trim();
  let out;
  try { out = typeof value === 'string' ? value : JSON.stringify(value,(key,item)=>/token|authorization|jwt/i.test(key)?'[REDACTED]':item); } catch { out = String(value); }
  if (token) out = out.split(token).join('[REDACTED_TOKEN]');
  return out.replace(/Bearer\s+[\w.-]+/gi, 'Bearer [REDACTED_TOKEN]');
}
function log(kind, message, data) {
  const line = `${new Date().toISOString()} [${ui.role.value || 'device'}] ${kind} ${message}${data === undefined ? '' : ` ${safe(data)}`}`;
  ui.log.textContent += `${line}\n`; ui.log.scrollTop = ui.log.scrollHeight; console.log(line);
}
function setCallStatus(value){ ui.callStatus.textContent=value; }
function unwrap(body){ return body && Object.prototype.hasOwnProperty.call(body,'data') ? body.data : body; }
function callIdFrom(data){ return data?.callId || data?.call_id || data?.id || ''; }

async function api(path, method='GET', body) {
  const token = ui.token.value.trim();
  if (!token) throw new Error('Access token is required');
  log('REST →', `${method} ${path}`);
  const response = await fetch(`${API}${path}`, {method, headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body:body ? JSON.stringify(body):undefined});
  const text = await response.text(); let payload; try{payload=JSON.parse(text)}catch{payload=text}
  log('REST ←', `${response.status} ${path}`, payload);
  if(!response.ok) throw new Error(payload?.message || `HTTP ${response.status}`);
  return unwrap(payload);
}
async function authApi(path,body){
  log('AUTH →',`POST ${path}`,{email:body.email,code:body.code?'[REDACTED]':undefined});
  const response=await fetch(`${API}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const payload=await response.json().catch(()=>({}));log('AUTH ←',`${response.status} ${path}`,payload);if(!response.ok)throw new Error(payload?.message||`HTTP ${response.status}`);return payload;
}
function findAccessToken(value){if(!value||typeof value!=='object')return null;for(const key of ['accessToken','access_token','token','jwt','authToken','idToken'])if(typeof value[key]==='string'&&value[key])return value[key];for(const key of ['data','tokens','payload']){const found=findAccessToken(value[key]);if(found)return found}return null}
async function sendOtp(){if(!ui.email.value.trim())throw new Error('Enter the account email');await authApi('/auth/login',{email:ui.email.value.trim()});log('AUTH','OTP requested — check the email inbox')}
async function verifyOtp(){const payload=await authApi('/auth/verify-otp',{email:ui.email.value.trim(),code:ui.otp.value.trim(),deviceName:ui.role.value||'WebRTC diagnostic',deviceType:/mobile/i.test(navigator.userAgent)?'mobile':'desktop',platform:'Web',deviceId:`webrtc-diag-${crypto.randomUUID()}`,appVersion:'1.0.0'});const token=findAccessToken(payload);if(!token)throw new Error('OTP verified but no access token was returned');ui.token.value=token;ui.otp.value='';log('AUTH','Access token filled (redacted)');await refreshMe().catch(e=>log('WARN','Could not load current user profile',e.message))}

function populateLanguageSelects(languages=DEFAULT_LANGUAGES){
  const options=languages.map(([code,label])=>`<option value="${code}">${label} (${code})</option>`).join('');
  ui.knownLanguage.innerHTML=options;ui.learnLanguage.innerHTML=options;
  ui.knownLanguage.value='en';ui.learnLanguage.value='es';
}
function selectedLanguage(select){
  const option=select.options[select.selectedIndex];
  return {code:select.value,label:(option?.textContent||select.value).replace(/\s*\([^)]*\)\s*$/,'')};
}
async function registerAccount(){
  const email=ui.registerEmail.value.trim();const fullName=ui.registerName.value.trim();
  if(!email)throw new Error('Enter the temp email for registration');
  if(fullName.length<2)throw new Error('Enter a name with at least 2 characters');
  await authApi('/auth/register',{email,fullName});
  ui.email.value=email;
  log('AUTH','Registration OTP requested — check temp-mail inbox',{email});
}
async function verifyRegisterAndOnboard(){
  const email=ui.registerEmail.value.trim();const code=ui.registerOtp.value.trim();
  if(!email||!/^\d{6}$/.test(code))throw new Error('Enter temp email and 6-digit OTP');
  const payload=await authApi('/auth/verify-otp',{email,code,deviceName:ui.role.value||'WebRTC diagnostic',deviceType:/mobile/i.test(navigator.userAgent)?'mobile':'desktop',platform:'Web',deviceId:`webrtc-diag-${crypto.randomUUID()}`,appVersion:'1.0.0'});
  const token=findAccessToken(payload);if(!token)throw new Error('OTP verified but no access token was returned');
  ui.token.value=token;ui.email.value=email;ui.otp.value='';ui.registerOtp.value='';
  log('AUTH','Registration verified; token filled (redacted)');
  await completeMinimalOnboarding();
}
function firstIdFromMeta(data){
  const list=Array.isArray(data)?data:data?.items||data?.interests||data?.data||[];
  const first=list.find(item=>typeof item?.id==='string'&&item.id);
  return first?.id||null;
}
async function completeMinimalOnboarding(){
  const native=selectedLanguage(ui.knownLanguage);const target=selectedLanguage(ui.learnLanguage);const level=ui.cefrLevel.value||'B2';
  if(native.code===target.code)log('WARN','Known and learning languages are the same; backend may still accept this for diagnostics');
  await api('/users/me/languages','PATCH',{nativeLanguage:native.code,targetLanguages:[target.code],targetLanguage:target.code,cefrSelfLevel:level,targetLanguageLevels:[{code:target.code,cefrSelfLevel:level}]});
  const interests=await api('/users/me/meta/interests').catch(e=>{log('WARN','Could not load interests catalog',e.message);return null});
  const interestId=firstIdFromMeta(interests);
  if(interestId)await api('/users/me/interests','PATCH',{interestIds:[interestId]});else log('WARN','No default interest id available; onboarding-complete may fail');
  await api('/users/me/profile','PATCH',{displayName:ui.registerName.value.trim()||ui.role.value||'WebRTC Test User',practiceFrequency:'flexible'}).catch(e=>log('WARN','Profile preferences failed; continuing because call testing only requires login + languages + conversation',e.message));
  await api('/users/me/onboarding-complete','PATCH').catch(e=>log('WARN','Onboarding-complete failed; continuing because call testing can still run after languages/interests',e.message));
  await refreshMe();
  log('AUTH','Minimal onboarding completed',{native:native.code,target:target.code,level});
}
function userIdFromProfile(data){return data?.id||data?.userId||data?.user_id||data?.profile?.id||data?.user?.id||''}
async function refreshMe(){
  const me=await api('/users/me');
  const userId=userIdFromProfile(me);
  if(userId)ui.myUserId.value=userId;
  const native = me?.nativeLanguage || me?.profile?.nativeLanguage || '';
  const target = me?.targetLanguage || me?.profile?.targetLanguage || '';
  ui.myNativeLanguage.value = native;
  ui.myLearnLanguage.value = target;
  log('AUTH','Current user loaded',{userId,native,target,onboardingStatus:me?.onboardingStatus});
}
async function createConversation(){
  const peerUserId=ui.peerUserId.value.trim();
  if(!peerUserId)throw new Error('Paste the peer user ID first');
  const data=await api('/chat/conversations','POST',{userId:peerUserId});
  const id=callIdFrom(data)||data?.conversationId||data?.conversation_id;
  if(!id)throw new Error('Conversation created but no id was returned');
  ui.conversationId.value=id;
  log('CHAT','Conversation ready to share with peer',{conversationId:id,status:data?.status,isActive:data?.isActive});
}
async function markConversationReady(){
  const id=ui.conversationId.value.trim();
  if(!id)throw new Error('Enter or create a conversation ID first');
  const data=await api(`/chat/conversations/${id}/ready`,'POST');
  log('CHAT','Conversation ready response',data);
}

function emitAck(event, payload) {
  return new Promise((resolve,reject)=>{
    if(!socket?.connected) return reject(new Error('Realtime socket is not connected'));
    log('SOCKET →', event, payload);
    const timer=setTimeout(()=>reject(new Error(`${event} ack timed out`)),10000);
    socket.emit(event,payload,(ack)=>{clearTimeout(timer);log('SOCKET ACK',event,ack);ack?.ok===false?reject(new Error(`${ack.code||'ERROR'}: ${ack.message||event}`)):resolve(ack||{ok:true});});
  });
}

async function connectSocket(){
  const token=ui.token.value.trim(); if(!token) throw new Error('Paste this user’s access token first');
  if(typeof window.io!=='function'){ui.dependencyWarning?.classList.remove('hidden');throw new Error('Socket.IO client is missing. Use node server.mjs or keep socket.io.min.js beside index.html.')}
  socket?.disconnect();
  socket=window.io(`${WS}/calls`,{path:'/socket.io',auth:{token},transports:['websocket','polling'],reconnection:true});
  registerSocketEvents();
  await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Socket connection timed out')),10000);socket.once('connect',()=>{clearTimeout(t);resolve()});socket.once('connect_error',(e)=>{clearTimeout(t);reject(e)});});
  ui.socketStatus.textContent=`connected (${socket.id})`; log('SOCKET','connected',{id:socket.id,transport:socket.io.engine.transport.name});
  if(ui.callId.value.trim()) await attachCall(ui.callId.value.trim());
}

function registerSocketEvents(){
  socket.on('disconnect',(reason)=>{ui.socketStatus.textContent=`disconnected: ${reason}`;log('SOCKET','disconnected',reason)});
  socket.on('connect_error',(e)=>log('SOCKET ERROR','connect_error',e.message));
  socket.on('error',(e)=>log('SOCKET ERROR','server error',e));
  socket.on('connected',(d)=>log('SOCKET ←','connected event',d));
  socket.onAny((event,data)=>log('SOCKET ←',event,data));
  socket.on('incoming-call',async d=>{currentCallId=callIdFrom(d);ui.callId.value=currentCallId;ui.conversationId.value=d.conversationId||d.conversation_id||ui.conversationId.value;caller=false;setCallStatus('incoming audio call');ui.acceptBtn.disabled=false;ui.declineBtn.disabled=false;await attachCall(currentCallId)});
  socket.on('call-accepted',async d=>{if(!matches(d))return;setCallStatus('accepted — negotiating audio');if(caller){await ensurePeer();await createAndSendOffer('initial audio')}});
  socket.on('offer',d=>matches(d)&&handleOffer(d).catch(fail));
  socket.on('answer',d=>matches(d)&&handleAnswer(d).catch(fail));
  socket.on('ice-candidate',d=>matches(d)&&handleRemoteCandidate(d).catch(fail));
  socket.on('video-upgrade-request',d=>{if(!matches(d))return;setCallStatus('peer requests video');ui.acceptVideoBtn.disabled=false;ui.declineVideoBtn.disabled=false;log('CHECK','Video request received. Camera is NOT enabled until Accept is pressed.')});
  for(const event of ['video-upgrade-accepted','video-upgrade-accept']) socket.on(event,d=>{if(!matches(d))return;handleUpgradeAccepted(d,event).catch(fail)});
  for(const event of ['video-upgrade-declined','video-upgrade-decline']) socket.on(event,d=>{if(matches(d)){setCallStatus('video upgrade declined');upgradeRequestedByMe=false}});
  socket.on('video-disable',d=>{if(matches(d)){ui.remoteTrackStatus.textContent='peer disabled video';ui.remoteVideoInfo.textContent='peer camera off'}});
  for(const event of ['call-ended','call-cancelled','call-declined','call-missed']) socket.on(event,d=>{if(matches(d)) cleanup(`server event: ${event}`)});
}
function matches(d){return !currentCallId || callIdFrom(d)===currentCallId}
function fail(e){log('ERROR',e.message||String(e));setCallStatus(`error: ${e.message||e}`)}

async function fetchIceServers(){
  try{const data=await api('/calls/turn-credentials');const servers=data?.iceServers||data?.ice_servers||data; if(Array.isArray(servers)){log('WEBRTC','TURN/STUN loaded',{count:servers.length});return servers}}catch(e){log('WARN','TURN fetch failed; using public STUN',e.message)}
  return [{urls:'stun:stun.l.google.com:19302'}];
}
async function ensurePeer(){
  if(pc && pc.connectionState!=='closed')return pc;
  pc=new RTCPeerConnection({iceServers:await fetchIceServers()});remoteStream=new MediaStream();ui.remoteVideo.srcObject=remoteStream;
  pc.onicecandidate=e=>{if(e.candidate&&currentCallId)emitAck('ice-candidate',{callId:currentCallId,candidate:e.candidate.toJSON()}).catch(fail)};
  pc.ontrack=e=>{log('WEBRTC ONTRACK',`${e.track.kind} RECEIVED`,{id:e.track.id,enabled:e.track.enabled,muted:e.track.muted,streamCount:e.streams.length});if(!remoteStream.getTracks().some(t=>t.id===e.track.id))remoteStream.addTrack(e.track);ui.remoteVideo.srcObject=remoteStream;if(e.track.kind==='video'){ui.remoteTrackStatus.textContent=`RECEIVED: ${e.track.id}`;ui.remoteVideoInfo.textContent=`remote track ${e.track.id}`;e.track.onunmute=()=>log('WEBRTC','remote video unmuted',e.track.id);e.track.onended=()=>{ui.remoteTrackStatus.textContent='remote video ended';log('WEBRTC','remote video ended',e.track.id)}}};
  for(const name of ['connectionstatechange','iceconnectionstatechange','signalingstatechange','icegatheringstatechange'])pc[`on${name}`]=()=>{ui.pcStatus.textContent=`${pc.connectionState} / ICE ${pc.iceConnectionState}`;log('WEBRTC STATE',name,{connection:pc.connectionState,ice:pc.iceConnectionState,signaling:pc.signalingState,gathering:pc.iceGatheringState})};
  await ensureAudio();
  videoTransceiver=pc.addTransceiver('video',{direction:'recvonly'});log('WEBRTC','reserved video transceiver',{mid:videoTransceiver.mid,direction:videoTransceiver.direction});
  dumpTransceivers('peer created');return pc;
}
async function ensureAudio(){
  if(localStream?.getAudioTracks().length)return;
  const audio=await navigator.mediaDevices.getUserMedia({audio:true,video:false});localStream=localStream||new MediaStream();for(const track of audio.getAudioTracks()){localStream.addTrack(track);pc.addTrack(track,localStream);log('MEDIA','local audio acquired',{id:track.id,label:track.label})}
}
async function enableCamera(){
  await ensurePeer();let track=localStream?.getVideoTracks()[0];
  if(!track||track.readyState==='ended'){const media=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});track=media.getVideoTracks()[0];localStream.addTrack(track)}
  videoTransceiver=selectVideoTransceiver();
  if(videoTransceiver){await videoTransceiver.sender.replaceTrack(track);videoTransceiver.direction='sendrecv'}else{videoTransceiver=pc.addTransceiver(track,{direction:'sendrecv',streams:[localStream]})}
  ui.localVideo.srcObject=localStream;ui.localVideoInfo.textContent=`sending ${track.id}`;ui.disableVideoBtn.disabled=false;log('MEDIA','camera attached to video sender',{id:track.id,label:track.label,direction:videoTransceiver.direction});dumpTransceivers('camera enabled');
}
async function ensureLocalVideoOnNegotiatedTransceiver(){
  const track=localStream?.getVideoTracks()[0];
  if(!track||track.readyState==='ended')return;
  const negotiated=selectVideoTransceiver();
  if(!negotiated)return;
  if(negotiated.sender.track?.id!==track.id){await negotiated.sender.replaceTrack(track)}
  negotiated.direction='sendrecv';
  videoTransceiver=negotiated;
  log('MEDIA','camera bound to negotiated video transceiver',{mid:negotiated.mid,trackId:track.id,direction:negotiated.direction});
}
function selectVideoTransceiver(){
  if(!pc)return null;
  const videos=pc.getTransceivers().filter(t=>t.receiver.track.kind==='video');
  return videos.find(t=>t.mid!==null&&t.currentDirection!==null)
    || videos.find(t=>t.mid!==null)
    || videoTransceiver
    || videos[0]
    || null;
}
function sdpSummary(desc){const lines=(desc?.sdp||'').split(/\r?\n/);let section='session';const result={type:desc?.type,audio:[],video:[]};for(const line of lines){if(line.startsWith('m=audio'))section='audio';if(line.startsWith('m=video'))section='video';if(/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line))result[section]?.push(line.slice(2));}return result}
function dumpTransceivers(reason){if(!pc)return;log('WEBRTC TRANSCEIVERS',reason,pc.getTransceivers().map((t,i)=>({i,mid:t.mid,currentDirection:t.currentDirection,direction:t.direction,senderKind:t.sender.track?.kind||null,senderId:t.sender.track?.id||null,senderState:t.sender.track?.readyState||null,receiverKind:t.receiver.track?.kind||null,receiverId:t.receiver.track?.id||null})))}
async function createAndSendOffer(reason){await ensurePeer();const offer=await pc.createOffer();await pc.setLocalDescription(offer);log('SDP LOCAL',`offer: ${reason}`,sdpSummary(pc.localDescription));dumpTransceivers('before offer emit');const ack=await emitAck('offer',{callId:currentCallId,sdp:pc.localDescription.toJSON()});lastNegotiationId=ack.negotiationId||lastNegotiationId;log('WEBRTC','offer acknowledged',{negotiationId:lastNegotiationId})}
async function handleOffer(data){await ensurePeer();const desc=data.sdp?.sdp?data.sdp:data;lastNegotiationId=data.negotiationId;log('SDP REMOTE','offer',sdpSummary(desc));await pc.setRemoteDescription(desc);videoTransceiver=selectVideoTransceiver();await ensureLocalVideoOnNegotiatedTransceiver();await flushCandidates();const answer=await pc.createAnswer();await pc.setLocalDescription(answer);log('SDP LOCAL','answer',sdpSummary(pc.localDescription));dumpTransceivers('before answer emit');await emitAck('answer',{callId:currentCallId,negotiationId:lastNegotiationId,sdp:pc.localDescription.toJSON()});setCallStatus('connected')}
async function handleAnswer(data){const desc=data.sdp?.sdp?data.sdp:data;log('SDP REMOTE','answer',sdpSummary(desc));await pc.setRemoteDescription(desc);await flushCandidates();dumpTransceivers('remote answer applied');setCallStatus('connected')}
async function handleRemoteCandidate(data){const candidate=data.candidate?.candidate?data.candidate:data.candidate;if(!candidate)return;if(pc?.remoteDescription){await pc.addIceCandidate(candidate);log('ICE','remote candidate applied',{type:candidate.candidate?.split(' typ ')[1]?.split(' ')[0]})}else{pendingCandidates.push(candidate);log('ICE','remote candidate queued')}}
async function flushCandidates(){for(const c of pendingCandidates.splice(0))await pc.addIceCandidate(c);log('ICE','queued candidates flushed')}

async function attachCall(id){currentCallId=id;ui.callId.value=id;await emitAck('join-call',{callId:id});ui.endBtn.disabled=false;startHeartbeat();log('CALL','joined signaling scope',id)}
function startHeartbeat(){clearInterval(heartbeat);heartbeat=setInterval(()=>currentCallId&&api(`/calls/${currentCallId}/heartbeat`,'POST').catch(e=>log('WARN','heartbeat failed',e.message)),20000)}
async function startAudio(){await connectIfNeeded();await ensurePeer();const data=await api('/calls','POST',{conversationId:ui.conversationId.value.trim(),callType:'audio'});currentCallId=callIdFrom(data);caller=true;ui.callId.value=currentCallId;setCallStatus('ringing');await attachCall(currentCallId);ui.endBtn.disabled=false}
async function acceptCall(){await connectIfNeeded();currentCallId=ui.callId.value.trim()||currentCallId;caller=false;await ensurePeer();await attachCall(currentCallId);await api(`/calls/${currentCallId}/accept`,'POST');ui.acceptBtn.disabled=true;ui.declineBtn.disabled=true;setCallStatus('accepted — waiting for offer')}
async function declineCall(){await api(`/calls/${currentCallId}/decline`,'POST');cleanup('declined')}
async function requestUpgrade(){upgradeRequestedByMe=true;await emitAck('video-upgrade-request',{callId:currentCallId});setCallStatus('waiting for peer to accept video')}
async function acceptUpgrade(){await enableCamera();await emitAck('video-upgrade-accept',{callId:currentCallId});await api(`/calls/${currentCallId}/upgrade-video`,'POST').catch(e=>log('WARN','REST upgrade persistence failed',e.message));ui.acceptVideoBtn.disabled=true;ui.declineVideoBtn.disabled=true;setCallStatus('video accepted — waiting for peer offer')}
async function handleUpgradeAccepted(data,eventName='video-upgrade-accepted'){
  const revision=data?.mediaRevision??data?.media_revision??'no-revision';
  if(lastHandledUpgradeRevision===revision){log('CALL','duplicate video upgrade accepted ignored',{eventName,revision});return}
  lastHandledUpgradeRevision=revision;
  log('CALL','video upgrade accepted',{eventName,...(data||{})});
  if(upgradeRequestedByMe){await enableCamera();await api(`/calls/${currentCallId}/upgrade-video`,'POST').catch(e=>log('WARN','REST upgrade persistence failed',e.message));await createAndSendOffer('audio to video upgrade');upgradeRequestedByMe=false}
  setCallStatus('video negotiation in progress')
}
async function declineUpgrade(){await emitAck('video-upgrade-decline',{callId:currentCallId});ui.acceptVideoBtn.disabled=true;ui.declineVideoBtn.disabled=true;setCallStatus('video declined')}
async function disableVideo(){const track=localStream?.getVideoTracks()[0];track?.stop();if(videoTransceiver){await videoTransceiver.sender.replaceTrack(null);videoTransceiver.direction='recvonly'}ui.localVideo.srcObject=null;ui.localVideoInfo.textContent='camera off';await emitAck('video-disable',{callId:currentCallId});await createAndSendOffer('local video disabled');ui.disableVideoBtn.disabled=true}
async function endCall(){if(currentCallId)await api(`/calls/${currentCallId}/end`,'POST').catch(fail);cleanup('ended locally')}
async function loadActive(){await connectIfNeeded();const data=await api('/calls/active');if(!data)return setCallStatus('no active call');currentCallId=callIdFrom(data);ui.callId.value=currentCallId;ui.conversationId.value=data.conversationId||'';caller=!!data.callerId;await attachCall(currentCallId);setCallStatus(data.status||'active loaded')}
async function connectIfNeeded(){if(!socket?.connected)await connectSocket()}

// --- Matching Flow API Simulation ---
// --- Matching Flow API Simulation ---
let matchPollingInterval = null;

async function registerAvailability() {
  const native = selectedLanguage(ui.knownLanguage);
  const target = selectedLanguage(ui.learnLanguage);
  const now = Math.floor(Date.now() / 1000);
  const data = await api('/matching/availability', 'POST', {
    isReady: true,
    targetLanguage: target.code,
    nativeLanguage: native.code,
    availableFrom: now,
    availableUntil: now + 3600,
    availabilityMode: 'same_time'
  });
  log('MATCH', 'Availability updated successfully', data);
  startMatchingPolling();
}

async function getCompatibleCandidates() {
  const data = await api(`/matching/availability/compatible?limit=10&tab=best_match`, 'GET');
  const candidates = data?.candidates || (Array.isArray(data) ? data : (data?.items || data?.data || []));
  
  log('MATCH', `Compatible candidates found: ${candidates.length}`, candidates);
  
  if (candidates.length > 0) {
    ui.matchCompatibleCards.innerHTML = candidates.map(c => {
      const u = c.partner || c.user || c;
      const uid = u.id || u.userId || c.candidateId || c.userId || '';
      const name = u.displayName || u.fullName || uid;
      const nativeLabel = u.nativeLanguage || '';
      const learnLabel = u.targetLanguage || u.learningLanguages?.join(', ') || '';
      const status = u.availabilityStatus || c.status || 'offline';
      const score = c.score !== undefined ? c.score : '';
      
      const badgeColor = status === 'online' ? '#28a745' : (status === 'recently_offline' ? '#ffc107' : '#6c757d');
      
      return `
        <div class="partner-card" style="border: 1px solid #ddd; border-radius: 4px; padding: 8px; margin-bottom: 4px; background: #fff; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
          <div style="flex: 1;">
            <div style="font-weight: bold; font-size: 14px; display: flex; align-items: center; gap: 6px;">
              <span>${name}</span>
              <span style="font-size: 10px; padding: 2px 6px; border-radius: 10px; background: ${badgeColor}; color: #fff;">${status}</span>
            </div>
            <div style="font-size: 12px; color: #666; margin-top: 2px;">
              Native: <strong>${nativeLabel}</strong> | Learns: <strong>${learnLabel}</strong> ${score ? `| Score: <strong>${score}</strong>` : ''}
            </div>
            <div style="font-size: 10px; color: #999; font-family: monospace; margin-top: 2px;">
              ID: ${uid}
            </div>
          </div>
          <div>
            <button onclick="window.triggerMatchRequest('${uid}')" class="primary" style="padding: 4px 8px; font-size: 11px; margin: 0; min-height: unset; height: auto;">Send Request</button>
          </div>
        </div>
      `;
    }).join('');
  } else {
    ui.matchCompatibleCards.innerHTML = '<p style="color: #666; margin: 8px; font-size: 13px; text-align: center;">No compatible partners found.</p>';
  }
}

// Attach helper to window scope so inline button in card template can call it
window.triggerMatchRequest = (candidateUserId) => {
  ui.peerUserId.value = candidateUserId;
  sendMatchRequest(candidateUserId).catch(fail);
};

async function sendMatchRequest(forcedUid) {
  const candidateUserId = forcedUid || ui.peerUserId.value.trim();
  if (!candidateUserId) throw new Error('Select a partner or enter peer user ID first');
  const data = await api('/matching/requests', 'POST', {
    candidateUserId,
    expiresInSeconds: 300
  });
  log('MATCH', 'Match request sent', data);
}

async function getIncomingRequests() {
  const data = await api('/matching/candidates/incoming', 'GET');
  const incoming = Array.isArray(data) ? data : (data?.items || data?.data || []);
  log('MATCH', `Incoming match requests found: ${incoming.length}`, incoming);
  
  if (incoming.length > 0) {
    // Select the first active request ID
    const firstReq = incoming[0];
    const candidateId = firstReq.id || firstReq.candidateId;
    if (candidateId) {
      ui.incomingMatchIdInput.value = candidateId;
      log('MATCH', `Auto-filled incoming candidate request ID`, candidateId);
    }
  } else {
    log('MATCH', 'No incoming match requests found');
  }
}

async function acceptMatchRequest() {
  const matchId = ui.incomingMatchIdInput.value.trim();
  if (!matchId) throw new Error('Enter or select an incoming match request ID');
  const data = await api(`/matching/candidates/${matchId}/respond`, 'POST', {
    action: 'accept'
  });
  log('MATCH', 'Match request ACCEPTED', data);
  // Auto-load active call when accepted
  setTimeout(() => loadActive().catch(fail), 1500);
}

async function declineMatchRequest() {
  const matchId = ui.incomingMatchIdInput.value.trim();
  if (!matchId) throw new Error('Enter or select an incoming match request ID');
  const data = await api(`/matching/candidates/${matchId}/respond`, 'POST', {
    action: 'reject'
  });
  log('MATCH', 'Match request REJECTED', data);
}

function startMatchingPolling() {
  if (matchPollingInterval) return;
  log('MATCH', 'Starting automatic matching updates (5s interval)');
  matchPollingInterval = setInterval(() => {
    const token = ui.token.value.trim();
    if (token) {
      getCompatibleCandidates().catch(() => {});
      getIncomingRequests().catch(() => {});
    }
  }, 5000);
}

function cleanup(reason){
  clearInterval(heartbeat);
  if (matchPollingInterval) {
    clearInterval(matchPollingInterval);
    matchPollingInterval = null;
  }
  localStream?.getTracks().forEach(t=>t.stop());
  pc?.close();
  pc=null;
  localStream=null;
  remoteStream=new MediaStream();
  currentCallId='';
  lastHandledUpgradeRevision=null;
  videoTransceiver=null;
  ui.callId.value='';
  ui.localVideo.srcObject=null;
  ui.remoteVideo.srcObject=null;
  ui.endBtn.disabled=true;
  ui.upgradeBtn.disabled=true;
  ui.disableVideoBtn.disabled=true;
  ui.remoteTrackStatus.textContent='not received';
  ui.pcStatus.textContent='closed';
  setCallStatus(reason);
  log('CALL','cleanup',reason);
}

function bind(id,fn){ui[id]?.addEventListener('click',()=>fn().catch(fail))}
bind('connectBtn',connectSocket);bind('loadActiveBtn',loadActive);bind('startAudioBtn',startAudio);bind('acceptBtn',acceptCall);bind('declineBtn',declineCall);bind('upgradeBtn',requestUpgrade);bind('acceptVideoBtn',acceptUpgrade);bind('declineVideoBtn',declineUpgrade);bind('disableVideoBtn',disableVideo);bind('endBtn',endCall);
bind('sendOtpBtn',sendOtp);bind('verifyOtpBtn',verifyOtp);
bind('registerBtn',registerAccount);bind('completeRegisterBtn',verifyRegisterAndOnboard);
bind('createConversationBtn',createConversation);bind('markReadyBtn',markConversationReady);

bind('matchRegisterAvailabilityBtn', registerAvailability);
bind('matchGetCompatibleBtn', getCompatibleCandidates);
bind('matchGetIncomingBtn', getIncomingRequests);
bind('matchAcceptBtn', acceptMatchRequest);
bind('matchDeclineBtn', declineMatchRequest);


ui.copyRegisterToLoginBtn.onclick=()=>{ui.email.value=ui.registerEmail.value.trim();log('UI','Register email copied to login OTP field',{email:ui.email.value})};
ui.clearLogBtn.onclick=()=>ui.log.textContent='';ui.copyReportBtn.onclick=async()=>{dumpTransceivers('report requested');await navigator.clipboard.writeText(ui.log.textContent);log('UI','diagnostic report copied')};
document.querySelectorAll('[data-role-preset]').forEach(button=>button.addEventListener('click',()=>{ui.role.value=button.dataset.rolePreset;log('UI','device name changed',ui.role.value)}));
setInterval(()=>{const active=!!currentCallId&&pc?.connectionState!=='closed';ui.upgradeBtn.disabled=!active;ui.endBtn.disabled=!currentCallId},500);
if(window.isSecureContext&&navigator.mediaDevices){ui.secureBadge.textContent='Secure context ✓';ui.secureBadge.classList.add('good')}else{ui.secureBadge.textContent='Camera blocked: HTTPS required';ui.secureBadge.classList.add('bad');ui.secureWarning.classList.remove('hidden')}
if(typeof window.io!=='function'){ui.dependencyWarning?.classList.remove('hidden');setCallStatus('Socket.IO client missing')}
populateLanguageSelects();
log('ENV','page loaded',{secureContext:window.isSecureContext,userAgent:navigator.userAgent,api:API,ws:WS});
