import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {stripVTControlCharacters} from 'node:util';
import {createBattleState,reduceBattleLine,reduceBattleRequest,battleStateSnapshot} from './battle-state.mjs';
import {validateChoice as compileChoice} from './choice-validation.mjs';
export const FORMAT = 'gen9championsvgc2026regmcbo3';
export const FIXED_TEAM_SHA256 = 'e80b1aaaf56dff7456904ca7fe54ff5e8048fe541031b76ad50cbe96e34f68b2';
export const SOCKET = 'wss://sim3.psim.us/showdown/websocket';
const check = (ok, msg) => { if (!ok) throw new Error(msg); };
const roomID = id => typeof id === 'string' && /^[a-z0-9-]+$/.test(id);
const userID = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const digest = value => createHash('sha256').update(value).digest('hex');
export function compareTimerObservations(a,b) {
  if(Number.isSafeInteger(a.epoch) && Number.isSafeInteger(b.epoch)) {
    if(a.epoch!==b.epoch)return a.epoch-b.epoch;
    if(Number.isSafeInteger(a.sequence) && Number.isSafeInteger(b.sequence))return a.sequence-b.sequence;
  }
  return a.at-b.at;
}
const digestMove = value => typeof value==='string' ? value.toLowerCase().replace(/[^a-z0-9]/g,'') : null;
const replayID = value => battleRoomIdentity(value)?.replace(/^battle-/, '');
const MAX_REPLAY_BYTES = 8 * 1024 * 1024;
const isMcFormat = value => ['gen9championsvgc2026regmc', FORMAT].includes(userID(value));
const OUTGOING_ACTIONS = new Set(['authenticate','join-room','upload-team','search','cancel-search','choose','ready','forfeit','set-timer','save-replay']);
const emptyTransport = () => ({incomingFrames:0,lastIncomingAt:null,outgoingAttempts:0,lastOutgoingAt:null,lastOutgoingAction:null});
const SEARCH_MAINTENANCE_REJECTIONS = new Set([
  'The server will be restarting soon. Best-of-3 battles cannot be started at this time.',
  'The server is restarting. Battles will be available again in a few minutes.',
]);
export function safeServerNotice(value, {authenticated=false}={}) {
  // Server errors can echo authentication input or private access URLs. Retain
  // only bounded plain text after login; sensitive payloads stay metadata-only.
  if(!authenticated || typeof value!=='string')return {text:null,textSuppressed:true,truncated:false};
  const normalized=stripVTControlCharacters(value),text=normalized.replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim();
  const sensitive=/\b(?:password|passwd|assertion|credential|authorization|capability|controllerLease|readReceipt|challstr|access[ _-]?token|auth[ _-]?token)\b|\/(?:trn|utm)\b|https?:\/\/|\||[<>]|\b[a-f0-9]{32,}\b|\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b|\b[A-Za-z0-9_-]{40,}\b/i;
  if([value,text,normalized.replace(/[\p{Cc}\p{Cf}]/gu,'')].some(candidate=>sensitive.test(candidate)))return {text:null,textSuppressed:true,truncated:false};
  return {text:text.slice(0,512),textSuppressed:false,truncated:text.length>512};
}
function abortable(promise, signal) {
  if(signal.aborted){Promise.resolve(promise).catch(()=>{});return Promise.reject(new Error('Replay operation timed out'));}
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(new Error('Replay operation timed out'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
async function replayJSON(response, signal) {
  const length=response.headers?.get?.('content-length');
  check(!length || !/^\d+$/.test(length) || Number(length)<=MAX_REPLAY_BYTES,'Replay response is too large');
  check(typeof response.body?.getReader==='function','Replay response is not a bounded JSON stream');
  const reader=response.body.getReader(),chunks=[];let bytes=0,complete=false;
  try {
    for(;;){const {done,value}=await abortable(reader.read(),signal);if(done)break;check(value instanceof Uint8Array,'Invalid replay response');bytes+=value.byteLength;check(bytes<=MAX_REPLAY_BYTES,'Replay response is too large');chunks.push(value);}
    complete=true;return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));
  } finally {if(!complete)Promise.resolve(reader.cancel()).catch(()=>{});reader.releaseLock();}
}
// Room privacy changes preserve this identity; unrelated rooms never become aliases.
const battleRoomIdentity = value => /^(game-bestof3-gen9championsvgc2026regmcbo3-\d+|battle-gen9championsvgc2026regmcbo3-\d+)(?:-[a-z0-9]+pw)?$/.exec(value)?.[1] || null;
const readyContent = value => value.replace(/(?:game-bestof3-|battle-)gen9championsvgc2026regmcbo3-\d+(?:-[a-z0-9]+pw)?/g, id => battleRoomIdentity(id));
const gameplayLine = line => /^\|(?:start(?:\||$)|turn\||upkeep(?:\||$)|switch\||drag\||replace\||detailschange\||move\||cant\||faint\||swap\||-(?!message\|))/.test(line);
function mergeHistory(source, target) {
  if(!target.length)return {lines:source,tail:[],reconciled:true};
  if(!source.length)return {lines:target,tail:target,reconciled:true};
  if(target.length<=source.length && target.every((line,index)=>line===source[index]))return {lines:source,tail:[],reconciled:true};
  // A newly delivered history can contain the entire previously observed log.
  for(let start=0;start<=target.length-source.length;start++)if(source.every((line,index)=>line===target[start+index]))return {lines:target,tail:target.slice(start+source.length),reconciled:true};
  for(let overlap=Math.min(source.length,target.length);overlap>0;overlap--)if(source.slice(-overlap).every((line,index)=>line===target[index]))return {lines:[...source,...target.slice(overlap)],tail:target.slice(overlap),reconciled:true};
  return {lines:[...source,...target],tail:[],reconciled:false};
}

/** A protocol transport, never a strategy engine. No automatic decisions or retries. */
export class ShowdownClient extends EventEmitter {
  constructor({WebSocketImpl = globalThis.WebSocket, now = Date.now, log = () => {}, broker = null, expectedTeamHash = FIXED_TEAM_SHA256} = {}) {
    super(); check(typeof expectedTeamHash === 'string' && /^[a-f0-9]{64}$/.test(expectedTeamHash), 'Expected an approved SHA-256 team hash'); this.WebSocketImpl = WebSocketImpl; this.now = now; this.log = log; this.broker = broker;
    this.expectedTeamHash = expectedTeamHash; this.rooms = new Map(); this.roomAliases = new Map(); this.observationSequence = 0; this.connected = false; this.authenticated = false; this.epoch = 0;
    this.sent = new Set(); this.grants = new Map(); this.pendingReplay = null; this.replayRequests = new Map(); this.replays = []; this.formats = ''; this.searchGeneration = 0; this.searchPending = false; this.searchObservedActive = false;
    this.transport = emptyTransport();
  }
  audit(event, data = {}) { this.log({time: this.now(), event, ...data}); }
  resolveRoom(id) { return this.roomAliases.get(id) || id; }
  state(id) {
    check(roomID(id), 'Invalid room ID');
    id = this.resolveRoom(id);
    if (!this.rooms.has(id)) this.rooms.set(id, {id, request: null, revision: 0, epoch: -1, ended: false, sheets: {}, children: [], battleLog: [], timers: [], readyPrompt: null, readyRevision:0,battle:createBattleState()});
    return this.rooms.get(id);
  }
  renameRoom(oldRoom, room, {resyncJoin = false} = {}) {
    oldRoom = this.resolveRoom(oldRoom);
    const identity = battleRoomIdentity(oldRoom);
    if (!identity || identity !== battleRoomIdentity(room)) return false;
    if (oldRoom === room) return true;
    const source = this.state(oldRoom);
    const target = this.rooms.get(room), records = [source, target].filter(Boolean);
    const requestRecord = records.reduce((latest, record) => {
      if (record.epoch !== this.epoch || !record.request) return latest;
      if (!latest || (record.request.rqid ?? -1) > (latest.request.rqid ?? -1) || record.request.rqid === latest.request.rqid && (record.requestSequence || 0) > (latest.requestSequence || 0)) return record;
      return latest;
    }, null);
    const chosen = requestRecord && records.some(record => JSON.stringify(record.request) === JSON.stringify(requestRecord.request) && this.sent.has(`choose:${record.id}:${record.request.rqid}:${record.revision}`));
    // A private history/request can precede the old header's rename notice.
    // Reconcile its history without discarding existing opponent observations or
    // applying the same boosts twice. Equal lines on different turns stay intact.
    const current = target && (target.observedSequence || 0) > (source.observedSequence || 0) ? target : source;
    const history=mergeHistory(source.battleLog,target?.battleLog || []);
    const battle=structuredClone(!source.battleLog.length && target?.battleLog.length ? target.battle : source.battle);
    if(source.battleLog.length && target?.battleLog.length) {
      if(history.reconciled)for(const line of history.tail)reduceBattleLine(battle,line,{now:this.now});
      else battle.warnings.push('Room rename histories could not be reconciled; previously observed battle state was retained. Inspect fresh server state.');
    }
    if(requestRecord)reduceBattleRequest(battle,requestRecord.request,{now:this.now});
    const merged = {...current, id:room, revision:Math.max(...records.map(record => record.revision))+1,
      battle,
      sheets:Object.assign({}, ...records.map(record => record.sheets)),
      children:[...new Set(records.flatMap(record => record.children))],
      battleLog:history.lines.slice(-2000),
      // Receipt sequence preserves observation order when alias events share a timestamp.
      timers:records.flatMap(record => record.timers).sort(compareTimerObservations).slice(-20),
      timerRequest:records.map(record=>record.timerRequest).filter(Boolean).sort((a,b)=>b.requestedAt-a.requestedAt)[0] || null,
      ended:records.some(record=>record.ended),
      previewObserved:records.some(record=>record.previewObserved),
      startedObserved:records.some(record=>record.startedObserved),
      startedObservedEpoch:Math.max(-1,...records.map(record=>record.startedObservedEpoch??-1)),
      lastAction:records.map(record=>record.lastAction).filter(Boolean).sort((a,b)=>b.sentAt-a.sentAt)[0],
      readyRevision:Math.max(...records.map(record=>record.readyRevision)),
      forfeitPending:records.find(record=>record.forfeitPending)?.forfeitPending || null,
      readyPrompt:current.readyPrompt || records.find(record=>record.readyPrompt)?.readyPrompt || null};
    if(requestRecord) {
      for(const key of ['request','epoch','receivedAt','requestSequence','confirmedChoice'])merged[key]=requestRecord[key];
      merged.confirmedChoice ||= records.find(record=>record.confirmedChoice && JSON.stringify(record.request)===JSON.stringify(requestRecord.request))?.confirmedChoice || null;
    }
    if(merged.ended){merged.request=null;merged.result=records.find(record=>record.result)?.result;merged.readyPrompt=null;}
    this.rooms.delete(oldRoom);this.rooms.set(room,merged);
    this.roomAliases.delete(room);
    for(const [alias, canonical] of this.roomAliases)if(canonical===oldRoom)this.roomAliases.set(alias,room);
    this.roomAliases.set(oldRoom,room);
    for(const record of this.rooms.values()){
      record.children=[...new Set(record.children.map(child=>this.resolveRoom(child)))];
      if(record.readyParent)record.readyParent=this.resolveRoom(record.readyParent);
    }
    for(const key of [...this.sent]) {
      for(const prefix of ['choose:','ready:','replay:','forfeit:','timer:'])if(key.startsWith(`${prefix}${oldRoom}:`) || key===`${prefix}${oldRoom}`)this.sent.add(`${prefix}${room}${key.slice(prefix.length+oldRoom.length)}`);
      // An explicit rename moves subscribed connections. A search-list handoff
      // can instead race an unconfirmed public join, so its private destination
      // needs one fresh observation join rather than an assumed subscription.
      if(!resyncJoin && key===`join:${this.epoch}:${oldRoom}`)this.sent.add(`join:${this.epoch}:${room}`);
    }
    if(chosen && merged.request)this.sent.add(`choose:${room}:${merged.request.rqid}:${merged.revision}`);
    if(merged.readyPrompt && records.some(record=>record.readyPrompt?.content===merged.readyPrompt.content && this.sent.has(`ready:${record.id}:${record.readyPrompt.token}`)))this.sent.add(`ready:${room}:${merged.readyPrompt.token}`);
    const invalidatedRooms=new Set([oldRoom,room,...(room.startsWith('game-bestof3-')?merged.children:[])]);
    for(const key of this.grants.keys())if([...invalidatedRooms].some(id=>key.endsWith(`:${id}`)))this.grants.delete(key);
    if(this.pendingReplay?.room===oldRoom)this.pendingReplay.room=room;
    if(this.replayRequests.has(oldRoom)){const replay=this.replayRequests.get(oldRoom);this.replayRequests.delete(oldRoom);replay.room=room;this.replayRequests.set(room,replay);}
    for(const replay of this.replays)if(replay.room===oldRoom)replay.room=room;
    if(this.searchState?.games)this.searchState={...this.searchState,games:Object.fromEntries(Object.entries(this.searchState.games).map(([id,title])=>[this.resolveRoom(id),title]))};
    this.emit('room-renamed',{oldRoom,room});
    if(this.searchState)this.emit('search-state',this.searchState);
    return true;
  }
  async connect({timeoutMs = 15000} = {}) {
    check(!this.ws || this.ws.readyState > 1, 'Socket already open or connecting');
    this.epoch++; this.authenticated = false; this.challenge = null; this.expectedUser = null;
    this.transport = emptyTransport();
    this.grants.clear(); this.teamHash = null; this.pendingReplay = null; this.searchState = null; this.searchPending = false; this.searchObservedActive = false;
    for (const r of this.rooms.values()) { r.epoch = -1; r.readyPrompt = null; }
    const ws = this.ws = new this.WebSocketImpl(SOCKET);
    ws.addEventListener('message', e => { try { this.receive(String(e.data)); } catch { this.audit('protocol-error'); this.emit('protocol-error'); } });
    ws.addEventListener('close', () => { this.connected = false; this.authenticated = false; this.grants.clear(); this.audit('disconnected'); this.emit('disconnected'); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('Connection timed out; no retry attempted')); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); this.connected = true; this.audit('connected', {epoch:this.epoch}); resolve(); }, {once:true});
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed; no alternate route attempted')); }, {once:true});
    });
  }
  close() { this.ws?.close(); }
  // An externally approved secure broker must perform login. Never read browser cookies,
  // tokens, environment passwords, command-line secrets, or chat credentials here.
  async authenticate(username, {approved = false} = {}) {
    check(approved, 'Explicit authorization required');
    check(this.connected && this.challenge, 'No live challenge');
    check(this.broker && typeof this.broker.login === 'function', 'Secure authentication broker not configured; user secure handoff required');
    check(/^[A-Za-z0-9 _-]{1,18}$/.test(username), 'Invalid username');
    const epoch = this.epoch;
    const challenge = this.challenge;
    const abort = new AbortController();
    const disconnected = () => abort.abort();
    const challengeChanged = () => { if(this.challenge !== challenge) abort.abort(); };
    this.on('disconnected',disconnected); this.on('challenge',challengeChanged);
    let assertion;
    try {
      assertion = await this.broker.login({username, challenge, origin:'https://play.pokemonshowdown.com',signal:abort.signal,
        isCurrent:()=>this.connected && this.epoch === epoch && this.challenge === challenge});
    } finally { this.off('disconnected',disconnected); this.off('challenge',challengeChanged); }
    check(epoch === this.epoch && this.connected && this.challenge === challenge && !abort.signal.aborted, 'Connection changed during authentication');
    check(typeof assertion === 'string' && assertion.length > 10 && !/[\r\n|]/.test(assertion), 'Invalid broker assertion');
    this.expectedUser = userID(username);
    this.recordOutgoing('authenticate'); this.ws.send(`|/trn ${username},0,${assertion}`); assertion = null;
    this.audit('authentication-submitted');
  }
  receive(frame) {
    this.transport.incomingFrames=Math.min(Number.MAX_SAFE_INTEGER,this.transport.incomingFrames+1);this.transport.lastIncomingAt=this.now();
    let room = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('>')) { room = line.slice(1); check(roomID(room), 'Invalid room'); room=this.resolveRoom(room); continue; }
      if (!line.startsWith('|')) continue;
      const [, type, ...parts] = line.split('|'); const value = parts.join('|');
      if(type==='noinit' && parts[0]==='rename' && room){if(this.renameRoom(room,parts[1]))room=this.resolveRoom(room);continue;}
      const r = room ? this.state(room) : null;
      if(r)r.observedSequence=++this.observationSequence;
      if(r && type==='teampreview')r.previewObserved=true;
      if(r && gameplayLine(line)){r.startedObserved=true;r.startedObservedEpoch=this.epoch;}
      if(r && type !== 'request') {
        reduceBattleLine(r.battle,line,{now:this.now});
        this.observeAction(r,type,parts);
      }
      if (type === 'challstr') { this.challenge = value; this.emit('challenge'); continue; }
      if (type === 'updateuser') {
        this.authenticated = parts[1] === '1' && !!this.expectedUser && userID(parts[0]) === this.expectedUser;
        this.emit('identity', {named:parts[1] === '1', authenticated:this.authenticated}); continue;
      }
      if (type === 'formats') { this.formats = value; continue; }
      if (type === 'updatesearch') {
        const state = JSON.parse(value);
        check(Array.isArray(state.searching) && (state.games === null || (state.games && typeof state.games === 'object' && !Array.isArray(state.games))), 'Invalid search state');
        // The official room rename notice is sent only to connections already
        // in that room. A parent made private while its public join is racing
        // may therefore be visible solely as a replacement in updatesearch.
        // Reconcile only one-to-one replacements of the exact already observed
        // format/type/numeric identity; unrelated rooms grant no authority.
        const previousIds=Object.keys(this.searchState?.games||{}),nextIds=Object.keys(state.games||{});
        for(const oldRoom of previousIds){
          const identity=battleRoomIdentity(oldRoom),current=this.resolveRoom(oldRoom);
          if(!identity||nextIds.includes(current)||previousIds.filter(id=>battleRoomIdentity(id)===identity).length!==1)continue;
          const candidates=nextIds.filter(id=>battleRoomIdentity(id)===identity);
          if(candidates.length===1&&candidates[0]!==current){
            const destination=this.rooms.get(candidates[0]);
            this.renameRoom(current,candidates[0],{resyncJoin:destination?.subscriptionEpoch!==this.epoch});
          }
        }
        if(state.games)state.games=Object.fromEntries(Object.entries(state.games).map(([id,title])=>[this.resolveRoom(id),title]));
        this.searchState = state;
        const active = state.searching.length > 0 || Object.keys(state.games || {}).length > 0;
        if (active) this.searchObservedActive = true;
        else if (this.searchPending && this.searchObservedActive) { this.searchPending = false; this.searchObservedActive = false; this.searchGeneration++; }
        this.emit('search-state',this.searchState); continue;
      }
      if (type === 'popup' || type === 'error' && !r) {
        this.emit('server-notice',{type,scope:r?'room':'global',...safeServerNotice(value,{authenticated:this.authenticated})});
        // These exact server responses reject battle creation. Other notices,
        // an old idle snapshot, or missing acknowledgment retain the reservation.
        const activeRequest=[...this.rooms.values()].some(state=>!state.ended&&(
          state.request&&state.epoch===this.epoch || state.readyPrompt?.epoch===this.epoch ||
          state.startedObserved&&state.startedObservedEpoch===this.epoch
        ));
        if(type==='popup' && !r && this.authenticated && this.searchPending && this.searchState && !this.searchState.searching.length && !Object.keys(this.searchState.games||{}).length && !activeRequest && SEARCH_MAINTENANCE_REJECTIONS.has(value)){
          const generation=this.searchGeneration;
          this.searchPending=false;this.searchObservedActive=false;this.searchGeneration++;
          // The popup carries no server attempt ID; correlation is bounded to
          // this pending generation and the last explicitly observed idle state.
          this.emit('search-rejected',{reasonCode:'server-maintenance',generation,at:this.now(),contextBound:true});
        }
      }
      if (type === 'request' && r) {
        const request = value ? JSON.parse(value) : null;
        if (request && request.rqid !== undefined) check(Number.isSafeInteger(request.rqid), 'Invalid rqid');
        if (request && r.request && request.rqid < r.request.rqid) { this.audit('old-request-ignored',{room}); continue; }
        if (JSON.stringify(r.request) !== JSON.stringify(request)) { r.revision++; r.confirmedChoice = null; }
        r.request = request; r.epoch = this.epoch; r.receivedAt = this.now(); r.requestSequence=this.observationSequence;
        if(request?.teamPreview)r.previewObserved=true;
        else if(request && (Array.isArray(request.active) || Array.isArray(request.forceSwitch) || request.side?.pokemon?.some(p=>p.active))){r.startedObserved=true;r.startedObservedEpoch=this.epoch;}
        if(request && !request.wait)for(const parent of this.rooms.values())if(parent.children.includes(room))parent.readyPrompt=null;
        reduceBattleRequest(r.battle,request,{now:this.now});
        if(r.lastAction && request?.rqid !== r.lastAction.rqid)r.lastAction.boundary='next-request';
        this.emit('request', {room, revision:r.revision, request});
      }
      if (type === 'sentchoice' && r) {
        r.confirmedChoice = value || null;
        if(value && r.lastAction){r.lastAction.acceptedAt=this.now();if(!r.lastAction.evidence.length)r.lastAction.status='accepted';this.emit('action-status',{room,status:'accepted'});}
        this.emit('choice-status',{room,submitted:!!value});
      }
      if (type === 'showteam' && r) { r.sheets[parts[0]] = parts.slice(1).join('|'); this.emit('sheet',{room, side:parts[0], packed:r.sheets[parts[0]]}); }
      if (['inactive','inactiveoff'].includes(type) && r) {
        r.timers.push({at:this.now(), type, text:value,epoch:this.epoch,sequence:this.observationSequence}); r.timers = r.timers.slice(-20);
        this.emit('timer',{room,type,text:value});
      }
      if (['win','tie'].includes(type) && r) { r.ended = true; r.request = null; r.result = {type, winner:value}; if(r.lastAction){r.lastAction.boundary='battle-ended';r.lastAction.endedAt=this.now();}this.emit('result',{room,...r.result}); }
      if (type === 'error' && r) {
        r.lastError = value;
        if (/^\[(Invalid|Unavailable) choice\]/.test(value)) {
          r.revision++;
          if(r.lastAction){r.lastAction.status='rejected';this.emit('action-status',{room,status:'rejected'});}
          if (/too late|rqid|outdated|stale/i.test(value)) r.epoch = -1;
        }
        this.emit('server-error',{room,text:value,revision:r.revision});
      }
      if (r && ['player','teamsize','gametype','gen','tier','rule','poke','teampreview','start','turn','upkeep','switch','drag','replace','detailschange','move','cant','faint','swap','win','tie'].includes(type) || r && type.startsWith('-')) {
        r.battleLog.push(line); r.battleLog = r.battleLog.slice(-2000);
        this.emit('battle-event',{room,type,data:parts});
      }
      // Parse only official server/system HTML, never opponent chat as commands.
      const trustedHTML = ['html','uhtml','uhtmlchange','controlshtml','fieldhtml'].includes(type) || (type === 'c' && parts[0] === '~');
      // Current-connection room init or official room content proves the
      // destination is already subscribed when a search update beats rename.
      if(r && (type==='init' || trustedHTML))r.subscriptionEpoch=this.epoch;
      if (trustedHTML && r) {
        for (const match of value.matchAll(/href="\/(battle-[a-z0-9-]+)"/g)) {const child=this.resolveRoom(match[1]);if(!r.children.includes(child))r.children.push(child);}
        const ready = value.match(/value="\/msgroom ([a-z0-9-]+),\/confirmready"/);
        if (!ready && type === 'c' && parts[0] === '~' && parts.slice(1).join('|').startsWith('/uhtml controls,')) {
          if (r.readyParent) this.state(r.readyParent).readyPrompt = null;
          r.readyPrompt = null;
        }
        if (ready) {
          r.readyParent = this.resolveRoom(ready[1]); const s = this.state(r.readyParent);
          const content=digest(readyContent(value));
          if(!s.readyPrompt || s.readyPrompt.content!==content){s.readyRevision++;s.readyPrompt={epoch:this.epoch,content,token:digest(`${s.readyRevision}:${content}`)};}
          this.emit('ready',{room:s.id});
        }
      }
      if (type === 'popup') {
        // A late response belongs to its exact requested child, never whichever
        // child happens to be waiting now. Opponent chat is not a popup event.
        for(const match of value.matchAll(/https:\/\/replay\.pokemonshowdown\.com\/([a-z0-9-]+)(?=$|[\s"'<>])/g)) {
          for(const pending of this.replayRequests.values()) {
            if(pending.verified || pending.url)continue;
            const expected=replayID(pending.room),accessId=match[1];
            if(accessId!==expected && !new RegExp(`^${expected}-[a-z0-9]+pw$`).test(accessId))continue;
            if(/-[a-z0-9]+pw$/.test(pending.room) && accessId===expected)continue;
            pending.url=match[0];pending.status='url-observed';
            this.emit('replay-url',{room:pending.room,url:pending.url,verified:false});
          }
        }
      }
      if(type==='queryresponse' && parts[0]==='savereplay' && this.pendingReplay) {
        // The pinned server uploads itself and returns a popup. Never POST an
        // unexpected legacy payload or guess a replay URL from it.
        this.pendingReplay.error='Replay server uses an unsupported legacy save response; local evidence must be retained';
        this.emit('replay-failed',{room:this.pendingReplay.room});
      }
    }
  }
  observeAction(r,type,parts) {
    const action=r.lastAction;
    if(!action || action.boundary || !['move','cant','switch'].includes(type) || !action.side)return;
    const match=String(parts[0]).match(/^(p[1-4])([ab]):/);
    if(!match || match[1]!==action.side)return;
    const index=match[2]==='a'?0:1, selected=action.actions[index];
    if(!selected || !(selected.type==='move' && ['move','cant'].includes(type) || selected.type==='switch' && type==='switch'))return;
    // Called/forced actions can occur before the submitted choice (Dancer/Instruct).
    if(type==='move' && (!action.expectedMoves[index] || digestMove(parts[1])!==action.expectedMoves[index] || parts.slice(2).some(part=>part.startsWith('[from]'))))return;
    if(action.evidence.some(entry=>entry.slot===index+1))return;
    const evidence={type,slot:index+1,at:this.now(),executed:type!=='cant',...(type==='move'?{move:parts[1]}:{}),...(type==='cant'?{reason:parts[1]}:{})};
    action.evidence.push(evidence);action.status=type==='cant' && !action.evidence.some(entry=>entry.executed)?'resolution-observed':'execution-observed';
    this.emit('action-status',{room:r.id,status:action.status,evidence});
  }
  // Per-connection observations only. Outgoing timestamps/actions describe write
  // attempts before I/O, including throws; they never establish server delivery.
  transportStatus() { return {...this.transport}; }
  recordOutgoing(action) {
    this.transport.outgoingAttempts=Math.min(Number.MAX_SAFE_INTEGER,this.transport.outgoingAttempts+1);this.transport.lastOutgoingAt=this.now();
    this.transport.lastOutgoingAction=OUTGOING_ACTIONS.has(action)?action:'other';
  }
  // One-shot, bounded operator grants. These enforce scope; they do not replace user approval.
  authorize(action, {room = '', ttlMs = 30000, confirmed = false} = {}) {
    check(confirmed, 'Operator confirmation required'); check(ttlMs > 0 && ttlMs <= 120000, 'Invalid grant lifetime');
    this.grants.set(`${action}:${room}`, {epoch:this.epoch, expires:this.now()+ttlMs});
  }
  send(action, room, command, key) {
    check(this.connected && this.authenticated, 'Authenticated connection required');
    check(!room || room===this.resolveRoom(room), 'Room was renamed; inspect fresh state');
    if(['choose','ready'].includes(action))check(!this.pendingForfeit(room), 'BO3 forfeit was sent or is uncertain; await the official parent result');
    check(!room || roomID(room), 'Invalid room'); check(!/[\r\n]/.test(command), 'Invalid command');
    const grantKey = `${action}:${room}`, grant = this.grants.get(grantKey);
    check(grant && grant.epoch === this.epoch && grant.expires > this.now(), 'Fresh scoped operator confirmation required');
    check(!this.sent.has(key), 'Duplicate or uncertain action blocked');
    this.grants.delete(grantKey); this.sent.add(key); // Mark before I/O: ambiguous failures must not retry.
    if(action==='forfeit')this.state(room).forfeitPending={sentAt:this.now(),status:'sent-not-acknowledged'};
    this.recordOutgoing(action); this.ws.send(`${room}|${command}`); this.audit('sent',{action,room,key:digest(key)});
  }
  pendingForfeit(room) {
    room=this.resolveRoom(room);
    return [...this.rooms.values()].some(parent=>parent.forfeitPending && (parent.id===room || parent.children.includes(room)));
  }
  forfeitSet(room) {
    check(battleRoomIdentity(room)?.startsWith('game-bestof3-') && room===this.resolveRoom(room), 'Current BO3 parent room required');
    check(!this.state(room).ended && Object.hasOwn(this.searchState?.games || {},room), 'BO3 parent is not live in the current server search state');
    try{this.send('forfeit',room,'/forfeit',`forfeit:${room}`);}
    finally{if(this.state(room).forfeitPending)this.emit('forfeit-status',{room,status:'sent-not-acknowledged'});}
    return {room,status:'sent-not-acknowledged'};
  }
  timerStatus(room) {
    const r=this.rooms.get(this.resolveRoom(room));
    const observation=r?.timers.findLast(entry=>entry.epoch===this.epoch);
    const request=r?.timerRequest?.epoch===this.epoch?r.timerRequest:null;
    return {request:request?{enabled:request.enabled,requestedAt:request.requestedAt,status:request.status}:null,
      serverObservation:observation?{at:observation.at,type:observation.type,text:observation.text,afterRequest:!!request&&observation.sequence>request.observationSequence}:null};
  }
  setTimer(room,{enabled=true}={}) {
    check(enabled===true,'Only enabling the battle timer is supported');
    check(battleRoomIdentity(room)?.startsWith('battle-'),'M-C child battle required');
    check(room===this.resolveRoom(room),'Room was renamed; inspect fresh state');
    const r=this.rooms.get(room);
    check(r?.epoch===this.epoch && r.request && !r.ended,'No current live child battle request');
    check(!this.pendingForfeit(room),'BO3 forfeit was sent or is uncertain; await the official parent result');
    const key=`timer:${room}:${this.epoch}:on`,previous=r.timerRequest;
    check(!this.sent.has(key),'Duplicate or uncertain timer request blocked');
    r.timerRequest={enabled:true,epoch:this.epoch,requestedAt:this.now(),observationSequence:this.observationSequence,status:'sent-not-acknowledged'};
    try {this.send('set-timer',room,'/timer on',key);}
    catch(error) {
      if(this.sent.has(key))r.timerRequest.status='send-uncertain';else r.timerRequest=previous;
      throw error;
    }
    return {room,enabled:true,status:'sent-not-acknowledged',serverObservation:this.timerStatus(room).serverObservation};
  }
  uploadTeam(packed) {
    check(typeof packed === 'string' && packed.length > 10 && !/[\r\n]/.test(packed), 'Invalid packed team');
    const hash = digest(packed); check(hash === this.expectedTeamHash, 'Team differs from approved fixed team'); this.send('upload-team','',`/utm ${packed}`,`team:${this.epoch}:${hash}`); this.teamHash = hash;
    return {sha256:hash, acknowledged:false};
  }
  search() {
    check(this.teamHash, 'Upload approved team first');
    check(!this.searchPending && (!this.searchState || (!this.searchState.searching.length && !Object.keys(this.searchState.games || {}).length)), 'Search or set still active or unacknowledged');
    check(this.formats.split('|').some(entry => userID(entry.split(',')[0]) === FORMAT), 'Live server has not advertised requested format');
    this.send('search','',`/search ${FORMAT}`,`search:${this.epoch}:${this.teamHash}:${this.searchGeneration}`);
    this.searchPending = true; this.searchObservedActive = false;
  }
  joinRoom(room) {
    check(this.connected && roomID(room), 'Connected socket and valid room required');
    check(room===this.resolveRoom(room), 'Room was renamed; inspect fresh state');
    const key = `join:${this.epoch}:${room}`; check(!this.sent.has(key), 'Room already joined this connection');
    this.sent.add(key); this.recordOutgoing('join-room'); this.ws.send(`|/join ${room}`); this.audit('joined',{room});
  }
  cancelSearch() { this.send('cancel-search','', `/cancelsearch ${FORMAT}`, `cancel:${this.epoch}:${this.teamHash}:${this.searchGeneration}`); }
  validateChoice(room, {rqid, revision, actions, deadlineAt}) {
    check(roomID(room), 'Invalid room ID');
    check(room === this.resolveRoom(room), 'Room was renamed; inspect fresh state');
    const r = this.rooms.get(room), q = r?.request;
    check(r?.epoch === this.epoch && q && !q.wait && !r.ended && !r.confirmedChoice, 'No fresh actionable request');
    check(Number.isSafeInteger(rqid) && rqid === q.rqid && revision === r.revision, 'Stale rqid or request revision');
    check(Number.isFinite(deadlineAt) && deadlineAt > this.now(), 'Decision deadline expired or missing');
    return {room, rqid, revision, ...compileChoice(q, actions)};
  }
  choose(room, {rqid, revision, actions, deadlineAt}) {
    const compiled = this.validateChoice(room, {rqid, revision, actions, deadlineAt});
    const r = this.state(room), q = r.request;
    this.send('choose',room,`/choose ${compiled.choice}|${rqid}`,`choose:${room}:${rqid}:${revision}`);
    r.lastAction={rqid,revision,side:q.side?.id || null,actions:structuredClone(compiled.actions),expectedMoves:compiled.actions.map((action,index)=>action.type==='move'?digestMove(q.active?.[index]?.moves?.[action.slot-1]?.move || q.active?.[index]?.moves?.[action.slot-1]?.id):null),sentAt:this.now(),acceptedAt:null,status:'sent',evidence:[],boundary:null};
    this.emit('action-status',{room,status:'sent'});
    return {room,rqid,revision,choice:compiled.choice,status:'sent-not-acknowledged'};
  }
  confirmReady(room) {
    const r = this.state(room); check(r.readyPrompt?.epoch === this.epoch, 'No fresh server readiness prompt');
    this.send('ready',room,'/confirmready',`ready:${room}:${r.readyPrompt.token}`);
  }
  saveReplay(room) {
    check(battleRoomIdentity(room)?.startsWith('battle-'), 'M-C child battle required');
    check(room===this.resolveRoom(room),'Room was renamed; inspect fresh state');
    check(this.state(room).ended, 'Battle not finished'); check(!this.pendingReplay, 'Replay request already pending');
    check(!this.replayRequests.has(room),'Replay was already requested; inspect or verify its existing response');
    const pending={room,status:'sent-not-acknowledged'};
    this.pendingReplay=pending;this.replayRequests.set(room,pending);
    try {this.send('save-replay',room,'/savereplay',`replay:${room}`);}
    catch(error){if(!this.sent.has(`replay:${room}`))this.replayRequests.delete(room);else pending.status='send-uncertain';this.pendingReplay=null;throw error;}
    return pending;
  }
  async waitReplayURL(room,{timeoutMs=5000,signal}={}) {
    const pending=this.replayRequests.get(this.resolveRoom(room));check(pending,'Replay was not requested');
    check(Number.isInteger(timeoutMs) && timeoutMs>0 && timeoutMs<=25000,'Invalid replay wait budget');
    if(pending.url)return pending.url;
    await new Promise((resolve,reject)=>{
      let timer;
      const cleanup=()=>{clearTimeout(timer);this.off('replay-url',observed);this.off('replay-failed',failed);this.off('disconnected',lost);signal?.removeEventListener('abort',lost);};
      const done=error=>{cleanup();error?reject(new Error(error)):resolve();};
      const observed=event=>{if(this.resolveRoom(event.room)===pending.room)done();};
      const failed=event=>{if(this.resolveRoom(event.room)===pending.room)done(pending.error || 'Replay save failed');};
      const lost=()=>done('Replay operation interrupted; local evidence must be retained');
      this.on('replay-url',observed);this.on('replay-failed',failed);this.on('disconnected',lost);signal?.addEventListener('abort',lost,{once:true});
      timer=setTimeout(()=>done('Replay URL was not confirmed in time; local evidence must be retained'),timeoutMs);
      if(pending.error)done(pending.error);else if(pending.url)done();else if(signal?.aborted || !this.connected)lost();
    });
    return pending.url;
  }
  releaseReplayWait(room) {if(this.pendingReplay?.room===this.resolveRoom(room))this.pendingReplay=null;}
  async verifyReplay({room=this.pendingReplay?.room,fetchImpl=globalThis.fetch,timeoutMs=15000,signal,username}={}) {
    const pending=this.replayRequests.get(this.resolveRoom(room));check(pending?.url,'No server-confirmed replay URL');
    if(pending.verified)return {...pending};
    check(Number.isInteger(timeoutMs) && timeoutMs>0 && timeoutMs<=25000,'Invalid replay verification budget');
    const budget=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]),endpoint=`${pending.url}.json`;
    let data;
    try {
      const response=await abortable(fetchImpl(endpoint,{method:'GET',credentials:'omit',redirect:'error',signal:budget,headers:{Accept:'application/json'}}),budget);
      check(response?.ok && !response.redirected,'Replay URL is not accessible');
      check(!response.url || response.url===endpoint,'Replay URL redirected unexpectedly');
      data=await replayJSON(response,budget);
    } catch(error) {
      // Native transport failures may contain a private replay capability.
      throw new Error(/Replay URL is not accessible|Replay response is too large/.test(error.message)?error.message:'Replay could not be fetched within its bounded verification budget');
    }
    const state=this.state(pending.room),expected=replayID(pending.room),accessId=new URL(pending.url).pathname.slice(1);
    check(data && [expected,accessId].includes(data.id) && typeof data.log==='string','Replay identity or finished log not verified');
    const lines=data.log.split(/\r?\n/),results=lines.filter(line=>/^\|(?:win\|[^|\r\n]+|tie\|?)$/.test(line));
    check(results.length===1,'Replay identity or finished log not verified');
    const result=results[0].split('|');
    check(result[1]===state.result?.type && (result[1]==='tie' || userID(result[2])===userID(state.result.winner)),'Replay result differs from the official observed result');
    const formats=[data.format,data.formatid,...lines.filter(line=>line.startsWith('|tier|')).map(line=>line.slice(6))].filter(format=>typeof format==='string' && format.trim());
    for(const format of formats)check(isMcFormat(format),'Replay format does not match M-C');
    if(username) {
      const players=lines.filter(line=>/^\|player\|p[12]\|/.test(line)).map(line=>line.split('|')[3]);
      check(players.some(name=>userID(name)===userID(username)),'Replay does not identify the authorized player');
      if(!lines.includes('|start') && !lines.includes('|start|')){
        // A server-confirmed concession can finish during team preview. Its
        // missing start is valid only with exact local preview/player evidence;
        // this cannot excuse a truncated battle that actually began.
        const local=state.battleLog,localPlayers={},replayPlayers={};
        for(const [history,target] of [[local,localPlayers],[lines,replayPlayers]])for(const line of history){const match=/^\|player\|(p[12])\|([^|]+)/.exec(line);if(match)target[match[1]]=userID(match[2]);}
        check(state.ended && state.previewObserved && !state.startedObserved && !local.some(gameplayLine) && lines.some(line=>/^\|teampreview(?:\||$)/.test(line)) && !lines.some(gameplayLine),'Replay is missing its battle start');
        check(formats.length>0 && ['p1','p2'].every(side=>localPlayers[side] && localPlayers[side]===replayPlayers[side]) && (result[1]==='tie' || Object.values(replayPlayers).includes(userID(result[2]))),'Replay preview concession lacks exact format or player evidence');
      }
      const maxTurn=history=>Math.max(0,...history.filter(line=>/^\|turn\|\d+$/.test(line)).map(line=>Number(line.slice(6))));
      check(maxTurn(lines)>=maxTurn(state.battleLog),'Replay is shorter than the observed completed battle');
      for(const name of state.battleLog.filter(line=>/^\|player\|p[12]\|/.test(line)).map(line=>line.split('|')[3]))check(players.some(player=>userID(player)===userID(name)),'Replay players differ from the observed battle');
    }
    pending.verified=true;pending.verifiedAt=new Date(this.now()).toISOString();pending.status='verified';
    const verified={...pending};if(!this.replays.some(replay=>replay.room===pending.room))this.replays.push(verified);
    this.releaseReplayWait(pending.room);this.emit('replay-verified',{room:verified.room,roomId:verified.room,url:verified.url,verified:true,verifiedAt:verified.verifiedAt});return verified;
  }
  battleSnapshot(room) {return battleStateSnapshot(this.state(room).battle,{now:this.now});}
  snapshot() { return {connected:this.connected,authenticated:this.authenticated,epoch:this.epoch,transport:this.transportStatus(),search:this.searchState || null,replays:this.replays,rooms:[...this.rooms.values()].map(({battle,...room})=>({...room,battle:battleStateSnapshot(battle,{now:this.now})}))}; }
}
