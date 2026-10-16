import {stripVTControlCharacters} from 'node:util';

// Only these structured protocol events become terminal text. Chat, HTML,
// authentication events, assertions, and unknown messages are never rendered.
const stats = {atk:'Attack',def:'Defense',spa:'Sp. Atk',spd:'Sp. Def',spe:'Speed',accuracy:'accuracy',evasion:'evasion'};
const statuses = {brn:'burned',par:'paralyzed',slp:'asleep',frz:'frozen',psn:'poisoned',tox:'badly poisoned'};
const weather = {RainDance:'Rain',SunnyDay:'Sun',Sandstorm:'Sandstorm',Hail:'Hail',Snow:'Snow',Snowscape:'Snow',PrimordialSea:'Heavy rain',DesolateLand:'Harsh sun',DeltaStream:'Strong winds'};

function text(value, max = 180) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const clean = stripVTControlCharacters(String(value)).replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim();
  // Do not display HTML, even when it arrives through a normally textual field.
  if (/[<>]|&(?:lt|gt|#(?:x[0-9a-f]+|[0-9]+));/i.test(clean)) return '';
  return clean.slice(0,max);
}

const effect = value => text(value).replace(/^(?:move|ability|item):\s*/, '');
const condition = value => text(value,80);
const amount = value => /^\d$/.test(String(value)) && Number(value) <= 6 ? String(value) : '';

/** Plain, bounded text for observed battle events; null means deliberately hidden. */
export function formatBattleEvent(event) {
  if (!event || !Array.isArray(event.data)) return null;
  const {type,data} = event;
  const actor = text(data[0]), target = text(data[2]), second = text(data[1]);
  switch (type) {
  case 'player': return actor && second ? `${actor}: ${second}` : null;
  case 'tier': return actor ? `Format: ${actor}` : null;
  case 'teampreview': return 'Team preview.';
  case 'start': return 'Battle started.';
  case 'turn': return /^\d{1,5}$/.test(actor) ? `Turn ${actor}` : null;
  case 'switch': case 'drag': case 'replace': {
    const species = text(data[1]?.split?.(',')[0]);
    return actor && species && condition(data[2]) ? `${actor} ${type === 'drag' ? 'was dragged in' : type === 'replace' ? 'was revealed' : 'entered'} (${species}); HP ${condition(data[2])}.` : null;
  }
  case 'move': return actor && second ? `${actor} used ${second}${target ? ` → ${target}` : ''}.` : null;
  case 'cant': return actor && second ? `${actor} could not act (${statuses[second] || second}${target ? `: ${target}` : ''}).` : null;
  case 'faint': return actor ? `${actor} fainted.` : null;
  case 'swap': return actor && second ? `${actor} changed position (${second}).` : null;
  case '-damage': case '-heal': return actor && condition(data[1]) ? `${actor} ${type === '-heal' ? 'healed; ' : ''}HP → ${condition(data[1])}.` : null;
  case '-status': return actor && second ? `${actor} is ${statuses[second] || second}.` : null;
  case '-curestatus': return actor && second ? `${actor} recovered from ${statuses[second] || second}.` : null;
  case '-cureteam': return actor ? `${actor}'s team was cured of status.` : null;
  case '-boost': case '-unboost': case '-setboost': {
    const stage = amount(data[2]);
    return actor && Object.hasOwn(stats,second) && stage ? `${actor}: ${stats[second]} ${type === '-setboost' ? 'set to ' : ''}${type === '-unboost' ? '−' : '+'}${stage}.` : null;
  }
  case '-clearboost': return actor ? `${actor}'s stat changes were reset.` : null;
  case '-clearallboost': return 'All stat changes were reset.';
  case '-clearpositiveboost': return actor ? `${actor}'s positive stat changes were cleared.` : null;
  case '-clearnegativeboost': return actor ? `${actor}'s negative stat changes were cleared.` : null;
  case '-weather': {
    if (data.includes('[upkeep]')) return null;
    return actor === 'none' ? 'Weather ended.' : actor ? `${weather[actor] || actor} began.` : null;
  }
  case '-fieldstart': case '-fieldend': return effect(data[0]) ? `${effect(data[0])} ${type === '-fieldstart' ? 'started' : 'ended'}.` : null;
  case '-sidestart': case '-sideend': return actor && effect(data[1]) ? `${actor}: ${effect(data[1])} ${type === '-sidestart' ? 'started' : 'ended'}.` : null;
  case '-start': case '-end': return actor && effect(data[1]) ? `${actor}: ${effect(data[1])} ${type === '-start' ? 'started' : 'ended'}.` : null;
  case '-ability': return actor && second ? `${actor}'s ability: ${second}.` : null;
  case '-item': return actor && second ? `${actor}'s item: ${second}.` : null;
  case '-enditem': return actor && second ? `${actor}'s ${second} was consumed or removed.` : null;
  case '-mega': return actor ? `${actor} Mega Evolved${target ? ` with ${target}` : ''}.` : null;
  case '-terastallize': return actor && second ? `${actor} Terastallized (${second}).` : null;
  case '-activate': return actor && effect(data[1]) ? `${actor}: ${effect(data[1])} activated.` : null;
  case '-immune': return actor ? `${actor} was immune.` : null;
  case '-supereffective': return actor ? `Super effective against ${actor}.` : null;
  case '-resisted': return actor ? `${actor} resisted the attack.` : null;
  case '-crit': return actor ? `Critical hit on ${actor}.` : null;
  case '-miss': return actor ? `${actor}'s attack missed${second ? ` ${second}` : ''}.` : null;
  case '-fail': return actor ? `${actor}'s action failed${effect(data[1]) ? ` (${effect(data[1])})` : ''}.` : 'The action failed.';
  case '-notarget': return 'The move had no target.';
  case '-mustrecharge': return actor ? `${actor} must recharge.` : null;
  case '-singleturn': case '-singlemove': return actor && effect(data[1]) ? `${actor}: ${effect(data[1])}.` : null;
  default: return null;
  }
}

function roomLabel(room) {
  if (typeof room !== 'string' || !/^[a-z0-9-]+$/.test(room)) return 'Client';
  const id = text(room,120);
  const battle = id.match(/^battle-[a-z0-9-]+-(\d+)(?:-[a-z0-9]+pw)?$/);
  if (battle) return `Battle ${battle[1]}`;
  const set = id.match(/^game-bestof\d+-[a-z0-9-]+-(\d+)$/);
  return set ? `Set ${set[1]}` : id || 'Client';
}

/**
 * Stream observed events to the user's terminal (stderr by default), never MCP
 * stdout. This is presentation only: it never chooses moves or sends commands.
 * `output` is a Node Writable. The returned cleanup removes subscriptions; any
 * pending write errors are absorbed until those writes have completed.
 */
export function attachTerminalLog(client, {output = process.stderr, now = Date.now} = {}) {
  if (!client?.on || !client?.off || typeof output?.write !== 'function') throw new TypeError('Expected an event client and writable terminal output');
  const started = now();
  const listeners = [], accepted = new Set(), requests = new Map(), announcedRooms = new Set();
  let active = true, pending = 0, releaseScheduled = false, searchKey;
  const releaseOutput = () => {
    if (active || pending || releaseScheduled) return;
    releaseScheduled = true;
    const immediate = setImmediate(() => { releaseScheduled = false; if (!active && !pending) output.off?.('error',onOutputError); });
    immediate.unref?.();
  };
  const stop = () => { active = false; for (const [event,listener] of listeners) client.off(event,listener); releaseOutput(); };
  const onOutputError = () => stop();
  output.on?.('error',onOutputError);
  const write = (room,message) => {
    if (!active || !message) return;
    const elapsed = Math.max(0,Math.floor((now()-started)/1000));
    const clock = `${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;
    const line = `[+${clock}] [${roomLabel(room)}] ${message}\n`;
    pending++;
    try {
      output.write(line,error => { pending--; if (error) stop(); releaseOutput(); });
    } catch { pending--; stop(); }
  };
  const on = (event,handler) => {
    // A malformed observation or a broken terminal must not crash the battle.
    const listener = value => { if (active) { try { handler(value || {}); } catch { /* hide malformed events */ } } };
    listeners.push([event,listener]); client.on(event,listener);
  };
  const acknowledge = room => {
    if (accepted.has(room)) return;
    accepted.add(room);
    write(room,'Choice confirmed submitted by server; waiting for resolution.');
  };
  const announceRoom = room => {
    // Use the complete observed ID, including private-room suffixes. Never
    // construct a guessed child ID or accept a URL supplied by chat/HTML.
    if (typeof room !== 'string' || !/^(?:battle-|game-bestof[1-9]\d*-)[a-z0-9]+(?:-[a-z0-9]+)*$/.test(room) || announcedRooms.has(room)) return;
    announcedRooms.add(room);
    write(room,`Watch ${room.startsWith('game-bestof') ? 'set' : 'battle'}: https://play.pokemonshowdown.com/${room}`);
  };
  on('battle-event',event => {
    if (event.type === 'start' && Array.isArray(event.data)) announceRoom(event.room);
    write(event.room,formatBattleEvent(event));
  });
  on('timer',event => { const message = text(event.text,300); if (message) write(event.room,`Timer: ${message}`); });
  on('ready',event => write(event.room,'Ready confirmation requested.'));
  on('result',event => {
    if (event.type === 'tie') write(event.room,'Result: tie.');
    else if (event.type === 'win' && text(event.winner)) write(event.room,`Winner: ${text(event.winner)}.`);
  });
  on('request',event => {
    const request = event.request;
    if (!request || typeof request !== 'object') return;
    const key = `${request.rqid}:${event.revision}`;
    if (requests.get(event.room) !== key) { accepted.delete(event.room); requests.set(event.room,key); }
    const id = Number.isSafeInteger(request.rqid) ? ` (request ${request.rqid})` : '';
    if (request.wait) write(event.room,'Waiting for the opponent.');
    else if (request.teamPreview) write(event.room,`Choose your team and leads${id}.`);
    else if (request.forceSwitch?.some(Boolean)) write(event.room,`Replacement required${id}.`);
    else if (Array.isArray(request.active)) write(event.room,`Choose actions${id}.`);
  });
  on('choice-status',event => {
    if (event.submitted === true) acknowledge(event.room);
    else if (event.submitted === false) { accepted.delete(event.room); write(event.room,'Server reports no submitted choice.'); }
  });
  on('action-status',event => {
    if (event.status === 'sent') {
      accepted.delete(event.room);
      write(event.room,'Choice sent; awaiting server confirmation.');
    } else if (event.status === 'accepted') acknowledge(event.room);
    else if (event.status === 'rejected') {
      accepted.delete(event.room);
      write(event.room,'Server rejected the choice; inspect fresh battle status.');
    } else if (event.status === 'execution-observed' || event.status === 'resolution-observed') {
      const evidence = event.evidence || {}, details = [];
      const type = text(evidence.type,40), slot = text(evidence.slot,40), move = text(evidence.move,80);
      if (type) details.push(type);
      if (slot) details.push(`slot ${slot}`);
      if (move) details.push(move);
      // A move/cant/switch observation proves only that action's resolution;
      // it does not imply every chosen action or the whole turn completed.
      write(event.room,`Action resolution observed${details.length ? ` (${details.join(', ')})` : ''}.`);
    }
  });
  on('search-state',event => {
    const searching = Array.isArray(event.searching) ? event.searching.length : 0;
    const rooms = event.games && typeof event.games === 'object' && !Array.isArray(event.games) ? Object.keys(event.games) : [];
    for (const room of rooms) announceRoom(room);
    const games = rooms.length;
    const key = `${searching}:${games}`;
    if (key === searchKey) return;
    searchKey = key;
    write('',searching ? 'Searching for a battle.' : games ? `Battle rooms active: ${games}.` : 'Search idle.');
  });
  // Server error text is deliberately not echoed: it can contain arbitrary HTML
  // or credential-related responses. Structured control status retains details.
  on('server-error',event => write(event.room,'Server reported an action error; inspect battle status.'));
  on('protocol-error',() => write('','An unreadable server update was ignored.'));
  on('disconnected',() => write('','Connection closed.'));
  return stop;
}
