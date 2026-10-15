import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
export const FORMAT = 'gen9championsvgc2026regmcbo3';
export const FIXED_TEAM_SHA256 = 'e80b1aaaf56dff7456904ca7fe54ff5e8048fe541031b76ad50cbe96e34f68b2';
export const SOCKET = 'wss://sim3.psim.us/showdown/websocket';
const check = (ok, msg) => { if (!ok) throw new Error(msg); };
const roomID = id => typeof id === 'string' && /^[a-z0-9-]+$/.test(id);
const userID = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const digest = value => createHash('sha256').update(value).digest('hex');

/** A protocol transport, never a strategy engine. No automatic decisions or retries. */
export class ShowdownClient extends EventEmitter {
  constructor({WebSocketImpl = globalThis.WebSocket, now = Date.now, log = () => {}, broker = null, expectedTeamHash = FIXED_TEAM_SHA256} = {}) {
    super(); check(typeof expectedTeamHash === 'string' && /^[a-f0-9]{64}$/.test(expectedTeamHash), 'Expected an approved SHA-256 team hash'); this.WebSocketImpl = WebSocketImpl; this.now = now; this.log = log; this.broker = broker;
    this.expectedTeamHash = expectedTeamHash; this.rooms = new Map(); this.connected = false; this.authenticated = false; this.epoch = 0;
    this.sent = new Set(); this.grants = new Map(); this.pendingReplay = null; this.replays = []; this.formats = ''; this.searchGeneration = 0; this.searchPending = false; this.searchObservedActive = false;
  }
  audit(event, data = {}) { this.log({time: this.now(), event, ...data}); }
  state(id) {
    check(roomID(id), 'Invalid room ID');
    if (!this.rooms.has(id)) this.rooms.set(id, {id, request: null, revision: 0, epoch: -1, ended: false, sheets: {}, children: [], battleLog: [], timers: [], readyPrompt: null});
    return this.rooms.get(id);
  }
  async connect({timeoutMs = 15000} = {}) {
    check(!this.ws || this.ws.readyState > 1, 'Socket already open or connecting');
    this.epoch++; this.authenticated = false; this.challenge = null; this.expectedUser = null;
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
    this.ws.send(`|/trn ${username},0,${assertion}`); assertion = null;
    this.audit('authentication-submitted');
  }
  receive(frame) {
    let room = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('>')) { room = line.slice(1); check(roomID(room), 'Invalid room'); continue; }
      if (!line.startsWith('|')) continue;
      const [, type, ...parts] = line.split('|'); const value = parts.join('|');
      const r = room ? this.state(room) : null;
      if (type === 'challstr') { this.challenge = value; this.emit('challenge'); continue; }
      if (type === 'updateuser') {
        this.authenticated = parts[1] === '1' && !!this.expectedUser && userID(parts[0]) === this.expectedUser;
        this.emit('identity', {named:parts[1] === '1', authenticated:this.authenticated}); continue;
      }
      if (type === 'formats') { this.formats = value; continue; }
      if (type === 'updatesearch') {
        const state = JSON.parse(value);
        check(Array.isArray(state.searching) && (state.games === null || (state.games && typeof state.games === 'object' && !Array.isArray(state.games))), 'Invalid search state');
        this.searchState = state;
        const active = state.searching.length > 0 || Object.keys(state.games || {}).length > 0;
        if (active) this.searchObservedActive = true;
        else if (this.searchPending && this.searchObservedActive) { this.searchPending = false; this.searchObservedActive = false; this.searchGeneration++; }
        this.emit('search-state',this.searchState); continue;
      }
      if (type === 'popup') this.emit('server-notice',{text:value});
      if (type === 'request' && r) {
        const request = value ? JSON.parse(value) : null;
        if (request && request.rqid !== undefined) check(Number.isSafeInteger(request.rqid), 'Invalid rqid');
        if (request && r.request && request.rqid < r.request.rqid) { this.audit('old-request-ignored',{room}); continue; }
        if (JSON.stringify(r.request) !== JSON.stringify(request)) { r.revision++; r.confirmedChoice = null; }
        r.request = request; r.epoch = this.epoch; r.receivedAt = this.now();
        this.emit('request', {room, revision:r.revision, request});
      }
      if (type === 'sentchoice' && r) { r.confirmedChoice = value || null; this.emit('choice-status',{room,submitted:!!value}); }
      if (type === 'showteam' && r) { r.sheets[parts[0]] = parts.slice(1).join('|'); this.emit('sheet',{room, side:parts[0], packed:r.sheets[parts[0]]}); }
      if (['inactive','inactiveoff'].includes(type) && r) {
        r.timers.push({at:this.now(), type, text:value}); r.timers = r.timers.slice(-20);
        this.emit('timer',{room,type,text:value});
      }
      if (['win','tie'].includes(type) && r) { r.ended = true; r.request = null; r.result = {type, winner:value}; this.emit('result',{room,...r.result}); }
      if (type === 'error' && r) {
        r.lastError = value;
        if (/^\[(Invalid|Unavailable) choice\]/.test(value)) {
          r.revision++;
          if (/too late|rqid|outdated|stale/i.test(value)) r.epoch = -1;
        }
        this.emit('server-error',{room,text:value,revision:r.revision});
      }
      if (r && ['player','teamsize','gametype','gen','tier','rule','poke','teampreview','start','turn','switch','drag','replace','move','cant','faint','swap','win','tie'].includes(type) || r && type.startsWith('-')) {
        r.battleLog.push(line); r.battleLog = r.battleLog.slice(-2000);
        this.emit('battle-event',{room,type,data:parts});
      }
      // Parse only official server/system HTML, never opponent chat as commands.
      const trustedHTML = ['html','uhtml','uhtmlchange','controlshtml','fieldhtml'].includes(type) || (type === 'c' && parts[0] === '~');
      if (trustedHTML && r) {
        for (const match of value.matchAll(/href="\/(battle-[a-z0-9-]+)"/g)) if (!r.children.includes(match[1])) r.children.push(match[1]);
        const ready = value.match(/value="\/msgroom ([a-z0-9-]+),\/confirmready"/);
        if (!ready && type === 'c' && parts[0] === '~' && parts.slice(1).join('|').startsWith('/uhtml controls,')) {
          if (r.readyParent) this.state(r.readyParent).readyPrompt = null;
          r.readyPrompt = null;
        }
        if (ready) { r.readyParent = ready[1]; const s = this.state(ready[1]); s.readyPrompt = {epoch:this.epoch, token:digest(value)}; this.emit('ready',{room:s.id}); }
      }
      if (type === 'popup' && this.pendingReplay) {
        const urls = [...value.matchAll(/https:\/\/replay\.pokemonshowdown\.com\/[a-zA-Z0-9-]+/g)].map(m => m[0]);
        const expected = this.pendingReplay.room.replace(/^battle-/, '').replace(/-[a-z0-9]+pw$/, '');
        const url = urls.find(u => { const id = new URL(u).pathname.slice(1); return id === expected || id.startsWith(expected + '-'); });
        if (url) { this.pendingReplay.url = url; this.emit('replay-url',{room:this.pendingReplay.room,url,verified:false}); }
      }
    }
  }
  // One-shot, bounded operator grants. These enforce scope; they do not replace user approval.
  authorize(action, {room = '', ttlMs = 30000, confirmed = false} = {}) {
    check(confirmed, 'Operator confirmation required'); check(ttlMs > 0 && ttlMs <= 120000, 'Invalid grant lifetime');
    this.grants.set(`${action}:${room}`, {epoch:this.epoch, expires:this.now()+ttlMs});
  }
  send(action, room, command, key) {
    check(this.connected && this.authenticated, 'Authenticated connection required');
    check(!room || roomID(room), 'Invalid room'); check(!/[\r\n]/.test(command), 'Invalid command');
    const grantKey = `${action}:${room}`, grant = this.grants.get(grantKey);
    check(grant && grant.epoch === this.epoch && grant.expires > this.now(), 'Fresh scoped operator confirmation required');
    check(!this.sent.has(key), 'Duplicate or uncertain action blocked');
    this.grants.delete(grantKey); this.sent.add(key); // Mark before I/O: ambiguous failures must not retry.
    this.ws.send(`${room}|${command}`); this.audit('sent',{action,room,key:digest(key)});
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
    const key = `join:${this.epoch}:${room}`; check(!this.sent.has(key), 'Room already joined this connection');
    this.sent.add(key); this.ws.send(`|/join ${room}`); this.audit('joined',{room});
  }
  cancelSearch() { this.send('cancel-search','', '/cancelsearch', `cancel:${this.epoch}:${this.teamHash}:${this.searchGeneration}`); }
  choose(room, {rqid, revision, actions, deadlineAt}) {
    const r = this.state(room), q = r.request;
    check(r.epoch === this.epoch && q && !q.wait && !r.ended && !r.confirmedChoice, 'No fresh actionable request');
    check(Number.isSafeInteger(rqid) && rqid === q.rqid && revision === r.revision, 'Stale rqid or request revision');
    check(Number.isFinite(deadlineAt) && deadlineAt > this.now(), 'Decision deadline expired or missing');
    check(Array.isArray(actions) && actions.length > 0, 'Structured actions required');
    let choice;
    if (q.teamPreview) {
      check(actions.length === 1 && actions[0].type === 'team', 'Team-preview action required');
      const order = actions[0].order, count = q.maxTeamSize || 4;
      check(Array.isArray(order) && order.length === count && new Set(order).size === order.length && order.every(i => Number.isInteger(i) && i >= 1 && i <= q.side.pokemon.length), 'Invalid team-preview order');
      choice = `team ${order.join('')}`;
    } else {
      const slots = q.forceSwitch?.length || q.active?.length;
      check(slots === 2 && actions.length === slots, 'Both doubles slots required');
      const switches = new Set(); let megas = 0;
      const available = q.side?.pokemon?.filter(p => !p.active && !/ fnt$/.test(p.condition)).length || 0;
      // Revival Blessing uses a switch request, but selects a fainted target
      // (even an active one) instead of consuming an available bench replacement.
      const reviving = i => !!q.forceSwitch?.[i] && !!q.side?.pokemon?.[i]?.reviving;
      const requiredSwitches = q.forceSwitch?.filter((required, i) => required && !reviving(i)).length || 0;
      const selectedSwitches = actions.filter((a, i) => a.type === 'switch' && !reviving(i)).length;
      if (q.forceSwitch) check(selectedSwitches === Math.min(available, requiredSwitches), 'All available forced replacements required');
      choice = actions.map((a, i) => {
        if (a.type === 'pass') {
          check(q.forceSwitch ? (q.forceSwitch[i] === false || !reviving(i) && requiredSwitches > available) : / fnt$/.test(q.side?.pokemon?.[i]?.condition || ''), 'Slot requires a decision'); return 'pass';
        }
        if (a.type === 'switch') {
          const p = q.side?.pokemon?.[a.slot-1];
          const revival = reviving(i);
          check(Number.isInteger(a.slot) && p && (revival ? / fnt$/.test(p.condition) : !p.active && !/ fnt$/.test(p.condition)) && !switches.has(a.slot), revival ? 'Invalid revival target' : 'Invalid switch');
          check(!q.forceSwitch || q.forceSwitch[i], 'Slot does not need a forced switch');
          if (revival) return `switch ${a.slot}`;
          check(!q.active?.[i]?.trapped, 'Active slot is trapped'); switches.add(a.slot); return `switch ${a.slot}`;
        }
        check(a.type === 'move' && !q.forceSwitch, 'Move unavailable');
        const active = q.active[i], m = active?.moves?.[a.slot-1];
        check(Number.isInteger(a.slot) && m && !m.disabled && m.pp !== 0, 'Move unavailable');
        check(a.target === undefined || [-2,-1,1,2].includes(a.target), 'Invalid target');
        const targeted = ['normal','any','adjacentAlly','adjacentAllyOrSelf','adjacentFoe'].includes(m.target);
        if (targeted) {
          check(a.target !== undefined, 'Explicit target required');
          const self = -(i+1);
          if (m.target === 'adjacentAlly') check(a.target < 0 && a.target !== self, 'Target must be the ally');
          if (m.target === 'adjacentAllyOrSelf') check(a.target < 0, 'Target must be ally or self');
          if (m.target === 'adjacentFoe') check(a.target > 0, 'Target must be a foe');
          if (['normal','any'].includes(m.target)) check(a.target !== self, 'Move cannot target self');
        } else check(a.target === undefined, 'Move does not accept a chosen target');
        if (a.mega) { check(active.canMegaEvo && ++megas === 1, 'Mega unavailable'); }
        return `move ${a.slot}${a.target === undefined ? '' : ` ${a.target}`}${a.mega ? ' mega' : ''}`;
      }).join(', ');
    }
    this.send('choose',room,`/choose ${choice}|${rqid}`,`choose:${room}:${rqid}:${revision}`);
    return {room,rqid,revision,choice,status:'sent-not-acknowledged'};
  }
  confirmReady(room) {
    const r = this.state(room); check(r.readyPrompt?.epoch === this.epoch, 'No fresh server readiness prompt');
    this.send('ready',room,'/confirmready',`ready:${room}:${r.readyPrompt.token}`);
  }
  saveReplay(room) {
    check(this.state(room).ended, 'Battle not finished'); check(!this.pendingReplay, 'Replay request already pending');
    this.send('save-replay',room,'/savereplay',`replay:${room}`); this.pendingReplay = {room};
  }
  async verifyReplay({fetchImpl = fetch} = {}) {
    const pending = this.pendingReplay; check(pending?.url, 'No server-confirmed replay URL');
    const response = await fetchImpl(`${pending.url}.json`,{redirect:'error',signal:AbortSignal.timeout(15000)});
    check(response.ok, 'Replay URL is not accessible'); const data = await response.json();
    check(data.id === pending.room.replace(/^battle-/, '').replace(/-[a-z0-9]+pw$/, '') && typeof data.log === 'string' && /(?:^|\n)\|(?:win\|[^\n]+|tie)(?:\n|$)/.test(data.log), 'Replay identity or finished log not verified');
    pending.verified = true; const result = {...pending}; this.replays.push(result); this.pendingReplay = null; this.emit('replay-verified',{room:result.room,url:result.url}); return result;
  }
  snapshot() { return {connected:this.connected,authenticated:this.authenticated,epoch:this.epoch,search:this.searchState || null,replays:this.replays,rooms:[...this.rooms.values()]}; }
}
