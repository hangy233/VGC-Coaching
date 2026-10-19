import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {ShowdownClient} from './client.mjs';
import {callLocalSession} from './local-bridge.mjs';
import {createWindowsCredentialBroker} from './windows-credential-login.mjs';

// This one reviewed legacy dispatcher asserts its lease before rejecting an
// unknown operation. Other builds must use their normal supported operation.
const LEGACY_BUILD = 'becaa885d5d272146a72a847fa6babb835d10442f608499f034411ce6ead615b';
const normalized = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const identity = value => /^(game-bestof3-gen9championsvgc2026regmcbo3-[1-9]\d*|battle-gen9championsvgc2026regmcbo3-[1-9]\d*)(?:-[a-z0-9]+pw)?$/.exec(value)?.[1];
const check = (value, message) => { if (!value) throw new Error(message); };
const invocations = new Map();
const reservedRooms = new Set();

function primaryContext(status, options) {
  const {sessionId, generation, username, teamId, parentId, roomId} = options;
  check(status?.sessionId === sessionId && status.connected && status.authenticated && !status.stopped, 'Primary session changed or disconnected');
  check(status.capabilities?.buildRevision === LEGACY_BUILD && status.capabilities?.features?.controllerLease === true && !status.capabilities?.operations?.includes('set-timer'), 'This legacy adapter does not support the loaded primary build');
  check(status.controller?.generation === generation && status.controller.owner, 'Primary controller changed');
  check(normalized(status.username) === normalized(username) && status.teamSha256 === teamId, 'Primary account or approved team changed');
  const parents = status.rooms.filter(room => identity(room.id) === parentId);
  const children = status.rooms.filter(room => identity(room.id) === roomId);
  check(parents.length === 1 && children.length === 1, 'Expected one already-owned parent and child');
  const parent = parents[0], child = children[0];
  check(!parent.ended && !child.ended && !parent.forfeit && !child.forfeit && parent.children.includes(child.id), 'Owned set is no longer live with this linked child');
  check(Object.hasOwn(status.search?.games || {}, parent.id), 'Owned parent is absent from current server account state');
  check(!(status.actions || []).length, 'A fresh primary action needs the operator first');
  const choice = child.choice;
  check(child.state?.request?.teamPreview === true && choice?.actions?.length === 1 && choice.actions[0].type === 'team' && !choice.boundary && ['sent', 'accepted'].includes(choice.status), 'Only an unchanged submitted preview can use this legacy adapter');
  check(Number.isSafeInteger(choice.rqid) && child.state.request.rqid === choice.rqid, 'Primary preview identity is unavailable or changed');
  return {parent: parent.id, room: child.id, rqid: choice.rqid, request: structuredClone(child.state.request), choiceRevision: choice.revision,
    preview: `team ${choice.actions[0].order.join('')}`, owner: status.controller.owner};
}

/** Explicit controller-operated terminal remediation, never an automatic MCP
 * authentication fallback. It cannot upload, search, choose, ready or forfeit.
 * The original socket remains open and responsible for every battle decision.
 */
export function enableLegacyBattleTimer(options) {
  const {commandId} = options || {};
  check(typeof commandId === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(commandId), 'A stable legacy timer command ID is required');
  const safeFingerprint = JSON.stringify({...Object.fromEntries(Object.entries(options).filter(([key]) => !['controllerLease','input','output','primaryCall','clientFactory','brokerFactory'].includes(key))),
    leaseDigest:createHash('sha256').update(String(options.controllerLease || '')).digest('hex')});
  if (invocations.has(commandId)) {
    const prior = invocations.get(commandId);
    check(prior.fingerprint === safeFingerprint, 'Legacy timer command ID belongs to different arguments');
    return withBudget(options, async bounded => {
      const result = await bounded(() => prior.promise);
      const call = options.primaryCall || callLocalSession;
      const status = await bounded(() => call(options.descriptorPath, {id:randomUUID(),op:'status'}));
      check(status?.ok, 'Primary state could not be verified');
      const context = primaryContext(status.result, {...options, teamId:result.teamId});
      const probe = await bounded(() => call(options.descriptorPath, {id:`${commandId}-probe-replay`,op:'set-timer',room:context.room,enabled:true,confirmed:true,controllerLease:options.controllerLease}));
      check(probe?.ok === false && probe.error === 'Unsupported operation', 'Primary timer probe was not the reviewed legacy refusal; inspect it without retrying');
      return result;
    });
  }
  const promise = run(options);
  invocations.set(commandId, {fingerprint: safeFingerprint, promise});
  return promise;
}

async function withBudget(options, operation) {
  const timeoutMs = options?.timeoutMs ?? 45000;
  check(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 45000, 'Invalid bounded timer-adapter budget');
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error('Legacy timer observation budget expired; do not retry')), timeoutMs);
  const bounded = async factory => {
    if (abort.signal.aborted) throw abort.signal.reason;
    let onAbort;
    try {
      return await Promise.race([Promise.resolve().then(() => {if(abort.signal.aborted)throw abort.signal.reason;return factory();}),
        new Promise((_resolve,reject) => {onAbort=()=>reject(abort.signal.reason);abort.signal.addEventListener('abort',onAbort,{once:true});})]);
    } finally {abort.signal.removeEventListener('abort',onAbort);}
  };
  try {return await operation(bounded, abort);}
  finally {clearTimeout(deadline);}
}

async function run(options) {
  return withBudget(options, (bounded, abort) => runBounded({...options, abort, bounded}));
}

async function runBounded({confirmed, savedLogin, commandId, descriptorPath, controllerLease, sessionId, generation, username, parentId, roomId, teamFile,
  input = process.stdin, output = process.stderr, timeoutMs = 45000, pollMs = 500,
  primaryCall = callLocalSession, clientFactory = options => new ShowdownClient(options), brokerFactory = createWindowsCredentialBroker, abort, bounded} = {}) {
  check(confirmed === true && savedLogin === true, 'Explicit timer remediation and saved-login authorization required');
  check(input?.isTTY && output?.isTTY, 'Legacy timer remediation requires the current operator terminal');
  check(typeof controllerLease === 'string' && /^[a-f0-9]{64}$/.test(controllerLease), 'Current private primary controller lease required');
  check(identity(parentId) === parentId && parentId.startsWith('game-bestof3-') && identity(roomId) === roomId && roomId.startsWith('battle-'), 'Supply canonical existing parent and child identities');
  check(Number.isInteger(generation) && generation > 0 && typeof sessionId === 'string' && typeof descriptorPath === 'string', 'Bound primary session and generation required');
  check(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 45000 && Number.isInteger(pollMs) && pollMs >= 10 && pollMs <= 1000, 'Invalid bounded timer-adapter budget');
  const {Teams, TeamValidator, Dex} = createRequire(import.meta.url)('pokemon-showdown');
  const team = Teams.import(await bounded(() => readFile(teamFile, 'utf8')));
  check(team?.length === 6 && !new TeamValidator('gen9championsvgc2026regmc').validateTeam(team)?.length, 'Approved team file is not a legal complete M-C team');
  const teamId = createHash('sha256').update(Teams.pack(team)).digest('hex');
  const bound = {sessionId, generation, username, teamId, parentId, roomId};
  const readPrimary = async () => {
    const reply = await bounded(() => primaryCall(descriptorPath, {id: randomUUID(), op: 'status'}));
    check(reply?.ok, 'Primary state could not be verified');
    return primaryContext(reply.result, bound);
  };
  const initial = await readPrimary();
  const samePrimary = async () => {
    const current = await readPrimary();
    check(JSON.stringify(current) === JSON.stringify(initial), 'Primary preview, room or controller changed');
    return current;
  };
  let probe = 0;
  const assertLease = async () => {
    await samePrimary();
    const reply = await bounded(() => primaryCall(descriptorPath, {id: `${commandId}-probe-${++probe}`, op: 'set-timer', room: initial.room, enabled: true, confirmed: true, controllerLease}));
    // Success or transport uncertainty must never start a second timer sender.
    check(reply?.ok === false && reply.error === 'Unsupported operation', 'Primary timer probe was not the reviewed legacy refusal; inspect it without retrying');
  };
  await assertLease();
  const roomKey = `${sessionId}:${roomId}`;
  check(!reservedRooms.has(roomKey), 'This process already attempted legacy timer remediation for this child');
  reservedRooms.add(roomKey); // Authentication and uncertain writes are never retried.
  let client, monitor, timerSent = false, monitoring = false;
  const fail = error => { if (!abort.signal.aborted) abort.abort(error); };
  const waitFor = async predicate => {
    while (!predicate()) {
      if (abort.signal.aborted) throw abort.signal.reason;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (abort.signal.aborted) throw abort.signal.reason;
  };
  try {
    monitor = setInterval(async () => {
      if (monitoring || abort.signal.aborted) return;
      monitoring = true;
      try { await samePrimary(); } catch (error) { fail(error); }
      finally { monitoring = false; }
    }, pollMs);
    const credentialBroker = brokerFactory({username});
    const broker = {login: context => credentialBroker.login({...context,
      signal: context.signal ? AbortSignal.any([context.signal, abort.signal]) : abort.signal,
      isCurrent: () => !abort.signal.aborted && (context.isCurrent?.() ?? true)})};
    client = clientFactory({expectedTeamHash: teamId, broker, log: () => {}});
    const closeAuxiliary = () => client.close();
    abort.signal.addEventListener('abort', closeAuxiliary, {once: true});
    client.on('disconnected', () => fail(new Error('Auxiliary timer connection ended; no retry scheduled')));
    await bounded(() => client.connect());
    await waitFor(() => !!client.challenge);
    await samePrimary();
    output.write('Opening one authorized timer-only connection; the primary battle client stays open.\n');
    await bounded(() => client.authenticate(username, {approved: true}));
    await waitFor(() => client.authenticated);
    await waitFor(() => Object.hasOwn(client.searchState?.games || {}, initial.parent));
    await samePrimary();
    client.joinRoom(initial.parent);
    await waitFor(() => client.rooms.get(initial.parent)?.children.includes(initial.room));
    client.joinRoom(initial.room);
    await waitFor(() => !!client.rooms.get(initial.room)?.request && !!client.rooms.get(initial.room)?.confirmedChoice);
    const child = client.rooms.get(initial.room), request = child.request;
    check(!child.ended && child.epoch === client.epoch && request.teamPreview === true && request.rqid === initial.rqid && normalized(request.side?.name) === normalized(username), 'Auxiliary server preview does not match the primary account/request');
    check(child.confirmedChoice === initial.preview, 'Server-restored preview does not match the primary submitted order');
    const baseSpecies = species => normalized(Dex.mod('champions').species.get(species).baseSpecies);
    check(Array.isArray(request.side.pokemon) && request.side.pokemon.length === 6, 'Auxiliary registered team snapshot is unavailable');
    const registered = new Map(team.map(set => [baseSpecies(set.species), set]));
    const seen = new Set();
    for (const pokemon of request.side.pokemon) {
      const species = baseSpecies(String(pokemon.details || '').split(',')[0]), set = registered.get(species);
      check(set && !seen.has(species) && typeof pokemon.item === 'string' && normalized(pokemon.item) === normalized(set.item) &&
        normalized(pokemon.baseAbility || pokemon.ability) === normalized(set.ability) && Array.isArray(pokemon.moves) &&
        JSON.stringify(pokemon.moves.map(normalized).sort()) === JSON.stringify(set.moves.map(normalized).sort()), 'Auxiliary registered team differs from the approved primary snapshot');
      seen.add(species);
    }
    await assertLease();
    check(!abort.signal.aborted, 'Primary changed before timer submission');
    client.authorize('set-timer', {room: initial.room, confirmed: true});
    timerSent = true; // Conservatively reserve before the potentially uncertain write.
    const sent = client.setTimer(initial.room, {enabled: true});
    await waitFor(() => client.timerStatus(initial.room).serverObservation?.afterRequest === true);
    const observation = client.timerStatus(initial.room).serverObservation;
    return {primarySessionId: sessionId, teamId, parentId, roomId, status: observation.type === 'inactive' ? 'timer-activity-observed' : 'timer-off-observed',
      sentStatus: sent.status, serverRestoredPreviewVerified: true, serverObservation: observation, primaryConnectionPreserved: true,
      limitation: 'Cross-connection primary monitoring is bounded, not atomic. Species/items/moves/abilities were matched; investments remain bound to the primary approved fingerprint. Timer activity does not establish a final game result.'};
  } catch (error) {
    const safe = ['Primary ', 'Auxiliary ', 'Legacy ', 'Server-restored ', 'This process ', 'Saved sign-in '].some(prefix => error.message?.startsWith(prefix));
    const wrapped = new Error(safe ? error.message : 'Timer remediation was not confirmed; preserve the primary session and inspect state without retrying');
    wrapped.timerSendAttempted = timerSent;
    throw wrapped;
  } finally {
    clearInterval(monitor);
    client?.close();
  }
}
