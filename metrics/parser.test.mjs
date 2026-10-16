import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeBattle, normalizeRoomId} from './parser.mjs';

const event = (type, ...data) => ({type, data});
const headers = () => [event('player', 'p1', 'TofuRotom'), event('player', 'p2', 'Opponent'), event('start')];
const parse = (events, options = {}) => analyzeBattle({roomId: 'battle-gen9championsvgc2026regmc-123-secretpw', username: 'TofuRotom', teamId: 'team-1', team: [{species: 'Golisopod', name: 'Goli'}, {species: 'Sylveon', name: 'Sylv'}], events, ...options});
const mon = (result, species) => result.pokemon.find(pokemon => pokemon.species === species);

test('overlapping fragments without a history boundary remain explicitly incomplete',()=>{
  const result=parse([...headers(),event('switch','p1a: Goli','Golisopod, L50','100/100'),event('turn','1'),event('move','p1a: Goli','Protect','p1a: Goli'),event('turn','1'),event('move','p1a: Goli','Protect','p1a: Goli'),event('win','TofuRotom')]);
  assert.equal(result.quality.complete,false);assert(result.quality.warnings.some(w=>w.includes('overlapping history ambiguous')));
});

test('spread move is one use and can credit two confirmed enemy KOs', () => {
  const result = parse([...headers(), event('switch', 'p1a: Sylv', 'Sylveon, L50', '100/100'),
    event('switch', 'p2a: Rock', 'Garchomp, L50', '100/100'), event('switch', 'p2b: Cat', 'Incineroar, L50', '100/100'),
    event('turn', '1'), event('move', 'p1a: Sylv', 'Hyper Voice', 'p2a: Rock'),
    event('-damage', 'p2a: Rock', '0 fnt'), event('-damage', 'p2b: Cat', '0 fnt'), event('faint', 'p2a: Rock'), event('faint', 'p2b: Cat'), event('win', 'TofuRotom')]);
  assert.equal(mon(result, 'Sylveon').moves[0].uses, 1);
  assert.equal(mon(result, 'Sylveon').knockouts, 2);
  assert.equal(mon(result, 'Sylveon').moves[0].knockouts, 2);
  assert.equal(result.roomId, 'battle-gen9championsvgc2026regmc-123');
  assert.equal(result.quality.complete, true);
});

test('Knock Off uses, removals and KOs remain attributed to the same actor across switch backs', () => {
  const result = parse([...headers(), event('switch', 'p1a: Goli', 'Golisopod, L50', '100/100'),
    event('switch', 'p2a: Cat', 'Incineroar, L50', '100/100'), event('turn', '1'),
    event('move', 'p1a: Goli', 'Knock Off', 'p2a: Cat'), event('-damage', 'p2a: Cat', '50/100'),
    event('-enditem', 'p2a: Cat', 'Sitrus Berry', '[from] move: Knock Off', '[of] p1a: Goli'),
    event('switch', 'p1a: Sylv', 'Sylveon, L50', '100/100'), event('turn', '2'),
    event('switch', 'p1a: Goli', 'Golisopod, L50', '100/100'), event('turn', '3'),
    event('move', 'p1a: Goli', 'Knock Off', 'p2a: Cat'), event('-damage', 'p2a: Cat', '0 fnt'), event('faint', 'p2a: Cat'), event('win', 'TofuRotom')]);
  const goli = mon(result, 'Golisopod');
  assert.equal(goli.switchIns, 2); assert.equal(goli.moves[0].uses, 2);
  assert.equal(goli.itemRemovals, 1); assert.equal(goli.moves[0].itemRemovals, 1);
  assert.equal(goli.knockouts, 1); assert.equal(result.pokemon.length, 2);
});

test('Mega and form changes preserve registered actor, nicknames, p2 side and slot swaps', () => {
  const result = parse([event('player', 'p1', 'Opponent'), event('player', 'p2', 'TofuRotom'), event('start'),
    event('switch', 'p2a: Goli', 'Golisopod, L50', '100/100'), event('switch', 'p2b: Sylv', 'Sylveon, L50', '100/100'),
    event('switch', 'p1a: Rock', 'Garchomp, L50', '100/100'), event('turn', '1'),
    event('-mega', 'p2a: Goli', 'Golisopod', 'Golisopite'), event('-formechange', 'p2a: Goli', 'Golisopod-Mega'),
    event('swap', 'p2a: Goli', '1'), event('move', 'p2b: Goli', 'Iron Head', 'p1a: Rock'),
    event('-damage', 'p1a: Rock', '0 fnt'), event('faint', 'p1a: Rock'), event('win', 'TofuRotom')]);
  assert.equal(result.ownSide, 'p2'); assert.equal(mon(result, 'Golisopod').knockouts, 1);
  assert.deepEqual(mon(result, 'Golisopod').forms, ['Golisopod', 'Golisopod-Mega']);
  assert.equal(mon(result, 'Sylveon').moves.length, 0);
  assert.equal(mon(result, 'Golisopod').megaEvolved, true);
  assert.equal(mon(result, 'Sylveon').megaEvolved, false);
});

test('a registered or observed Mega form does not imply an actual Mega Evolution event', () => {
  const result = parse([...headers(), event('switch', 'p1a: Goli', 'Golisopod-Mega, L50', '100/100'),
    event('turn', '1'), event('move', 'p1a: Goli', 'Protect'), event('win', 'TofuRotom')],
  {team: [{species: 'Golisopod-Mega', name: 'Goli'}]});
  assert.equal(mon(result, 'Golisopod-Mega').megaEvolved, false);
  assert.deepEqual(mon(result, 'Golisopod-Mega').forms, ['Golisopod-Mega']);
});

test('opponent preview, observed selections, leads and actual Mega use stay distinct when owner is p2', () => {
  const result = parse([event('player', 'p1', 'Opponent'), event('player', 'p2', 'TofuRotom'),
    ...['Charizard-Mega-Y', 'Incineroar', 'Rillaboom', 'Kommo-o', 'Rotom-Wash', 'Rotom-Heat'].map(species => event('poke', 'p1', `${species}, L50`)),
    event('start'), event('switch', 'p1a: Sun', 'Charizard, L50', '100/100'), event('switch', 'p1b: Cat', 'Incineroar, L50', '100/100'),
    event('switch', 'p2a: Goli', 'Golisopod, L50', '100/100'), event('turn', '1'),
    event('-mega', 'p1a: Sun', 'Charizard', 'Charizardite Y'), event('-formechange', 'p1a: Sun', 'Charizard-Mega-Y'),
    event('turn', '2'), event('switch', 'p1b: Washer', 'Rotom-Wash, L50', '100/100'), event('win', 'TofuRotom')]);
  assert.equal(result.opponentRoster.length, 6);
  assert.deepEqual(result.opponentSelected, ['Charizard-Mega-Y', 'Incineroar', 'Rotom-Wash']);
  assert.deepEqual(result.opponentLeads, ['Charizard-Mega-Y', 'Incineroar']);
  assert.deepEqual(result.opponentMega, ['Charizard-Mega-Y']);
  assert.equal(result.opponentSelectionKnown, false);
  assert.equal(result.opponentSelected.includes('Rotom-Heat'), false);
});

test('opponent selection becomes known only once four distinct actors have been observed', () => {
  const result = parse([...headers(), event('switch', 'p2a: Sun', 'Charizard, L50', '100/100'),
    event('switch', 'p2b: Cat', 'Incineroar, L50', '100/100'), event('turn', '1'),
    event('switch', 'p2a: Grass', 'Rillaboom, L50', '100/100'), event('switch', 'p2b: Dragon', 'Kommo-o, L50', '100/100'),
    event('turn', '2'), event('switch', 'p2a: Sun', 'Charizard, L50', '100/100'), event('win', 'Opponent')]);
  assert.equal(result.opponentSelectionKnown, true);
  assert.deepEqual(result.opponentSelected, ['Charizard', 'Incineroar', 'Rillaboom', 'Kommo-o']);
  assert.deepEqual(result.opponentLeads, ['Charizard', 'Incineroar']);
  assert.deepEqual(result.opponentMega, []);
});

test('recoil, status, residual and ally faints are not credited as direct attack KOs', () => {
  const result = parse([...headers(), event('switch', 'p1a: Goli', 'Golisopod, L50', '100/100'),
    event('switch', 'p1b: Sylv', 'Sylveon, L50', '100/100'), event('switch', 'p2a: Cat', 'Incineroar, L50', '100/100'),
    event('switch', 'p2b: Rock', 'Garchomp, L50', '100/100'), event('turn', '1'),
    event('move', 'p1a: Goli', 'Surf', 'p2a: Cat'), event('-damage', 'p1b: Sylv', '0 fnt'), event('faint', 'p1b: Sylv'),
    event('-damage', 'p2a: Cat', '0 fnt', '[from] recoil'), event('faint', 'p2a: Cat'),
    event('upkeep'), event('-damage', 'p2b: Rock', '0 fnt', '[from] brn'), event('faint', 'p2b: Rock'), event('win', 'TofuRotom')]);
  assert.equal(mon(result, 'Golisopod').knockouts, 0);
  assert.equal(mon(result, 'Golisopod').indirectKnockouts, 0);
  assert.equal(mon(result, 'Sylveon').faints, 1);
  assert.match(result.quality.warnings.join(' '), /no confirmed attacking source/);
});

test('explicit contact ability source counts an indirect KO only', () => {
  const result = parse([...headers(), event('switch', 'p1a: Goli', 'Golisopod, L50', '100/100'),
    event('switch', 'p2a: Cat', 'Incineroar, L50', '100/100'), event('turn', '1'),
    event('move', 'p2a: Cat', 'Flare Blitz', 'p1a: Goli'), event('-damage', 'p1a: Goli', '20/100'),
    event('-damage', 'p2a: Cat', '0 fnt', '[from] ability: Rough Skin', '[of] p1a: Goli'), event('faint', 'p2a: Cat'), event('win', 'TofuRotom')]);
  assert.equal(mon(result, 'Golisopod').indirectKnockouts, 1);
  assert.equal(mon(result, 'Golisopod').knockouts, 0);
});

test('failure, miss and spread protection are flags per observed attempt, not inflated per target', () => {
  const result = parse([...headers(), event('switch', 'p1a: Sylv', 'Sylveon, L50', '100/100'),
    event('switch', 'p2a: Cat', 'Incineroar, L50', '100/100'), event('switch', 'p2b: Rock', 'Garchomp, L50', '100/100'),
    event('turn', '1'), event('move', 'p1a: Sylv', 'Hyper Voice', 'p2a: Cat'),
    event('-activate', 'p2a: Cat', 'move: Wide Guard'), event('-activate', 'p2b: Rock', 'move: Wide Guard'),
    event('turn', '2'), event('move', 'p1a: Sylv', 'Hyper Voice', 'p2a: Cat'), event('-miss', 'p1a: Sylv', 'p2a: Cat'), event('-miss', 'p1a: Sylv', 'p2b: Rock'),
    event('turn', '3'), event('move', 'p1a: Sylv', 'Calm Mind'), event('-fail', 'p1a: Sylv'), event('cant', 'p2a: Cat', 'slp'), event('tie')]);
  const [voice, calm] = mon(result, 'Sylveon').moves;
  assert.equal(voice.uses, 2); assert.equal(voice.blocked, 1); assert.equal(voice.missed, 1);
  assert.equal(calm.uses, 1); assert.equal(calm.failed, 1);
});

test('post-preview request counts unseen selected reserves and omits raw private data', () => {
  const request = {rqid: 18, active: [{moves: [{move: 'Secret'}]}], side: {id: 'p1', name: 'TofuRotom', pokemon: [
    {ident: 'p1: Goli', details: 'Golisopod, L50', condition: '100/100', item: 'Golisopite'},
    {ident: 'p1: Sylv', details: 'Sylveon, L50', condition: '100/100', item: 'Fairy Feather'}]}};
  const result = parse([...headers(), {type: 'request', request}, event('switch', 'p1a: Goli', 'Golisopod, L50', '100/100'),
    event('turn', '1'), event('win', 'Opponent'), event('c', 'opponent', 'password private chat')], {metadata: {password: 'private', operational: false}});
  assert.equal(result.selectionKnown, true); assert.equal(mon(result, 'Sylveon').selected, true);
  assert.equal(mon(result, 'Sylveon').switchIns, 0); assert.equal(result.outcome, 'loss');
  assert.equal(result.quality.operational, false);
  assert.doesNotMatch(JSON.stringify(result), /Secret|password|rqid|Fairy Feather|condition/);
});

test('preview request does not claim that every registered Pokémon was selected', () => {
  const result = parse([...headers(), {type: 'request', request: {teamPreview: true, side: {id: 'p1', pokemon: [
    {ident: 'p1: Goli', details: 'Golisopod, L50'}, {ident: 'p1: Sylv', details: 'Sylveon, L50'}]}}},
    event('switch', 'p1a: Goli', 'Golisopod, L50', '100/100'), event('win', 'TofuRotom')]);
  assert.equal(result.selectionKnown, false); assert.deepEqual(result.selected, ['Golisopod']);
});

test('a waiting preview side containing all six does not establish the selected four', () => {
  const roster = ['Golisopod', 'Sylveon', 'Politoed', 'Farigiraf', 'Rillaboom', 'Kommo-o'];
  const result = parse([...headers(), {type: 'request', request: {wait: true, side: {id: 'p1', pokemon: roster.map(species => ({ident: `p1: ${species}`, details: `${species}, L50`}))}}},
    event('win', 'TofuRotom')], {team: roster.map(species => ({species}))});
  assert.equal(result.selectionKnown, false); assert.deepEqual(result.selected, []);
});

test('Illusion replacement reattributes only its appearance and does not steal an earlier teammate turn', () => {
  const result = parse([...headers(), event('switch', 'p1a: Fox', 'Zoroark, L50', '100/100'),
    event('switch', 'p2a: Cat', 'Incineroar, L50', '100/100'), event('turn', '1'),
    event('move', 'p1a: Fox', 'Dark Pulse', 'p2a: Cat'), event('switch', 'p1a: Mask', 'Sylveon, L50', '100/100'),
    event('turn', '2'), event('move', 'p1a: Mask', 'Hyper Voice', 'p2a: Cat'), event('switch', 'p1a: Mask', 'Sylveon, L50', '100/100'),
    event('turn', '3'), event('move', 'p1a: Mask', 'Flamethrower', 'p2a: Cat'), event('replace', 'p1a: Fox', 'Zoroark, L50', '90/100'),
    event('-damage', 'p2a: Cat', '0 fnt'), event('faint', 'p2a: Cat'), event('win', 'TofuRotom')],
  {team: [{species: 'Zoroark', name: 'Fox'}, {species: 'Sylveon', name: 'Mask'}]});
  assert.deepEqual(mon(result, 'Zoroark').moves.map(row => row.move), ['Dark Pulse', 'Flamethrower']);
  assert.deepEqual(mon(result, 'Sylveon').moves.map(row => row.move), ['Hyper Voice']);
  assert.equal(mon(result, 'Zoroark').knockouts, 1);
});

test('partial records retain observations but do not claim a complete result or initial leads', () => {
  const result = parse([event('player', 'p1', 'TofuRotom'), event('player', 'p2', 'Opponent'), event('turn', '5'),
    event('switch', 'p1a: Goli', 'Golisopod, L50', '100/100'), event('move', 'p1a: Goli', 'Protect')]);
  assert.equal(result.completed, false); assert.equal(result.quality.complete, false);
  assert.equal(result.outcome, 'unknown'); assert.deepEqual(result.leads, []);
  assert.equal(mon(result, 'Golisopod').moves[0].uses, 1);
});

test('unresolved revealed Illusion does not confidently credit its apparent registered teammate', () => {
  const result = parse([...headers(), event('switch', 'p1a: Sylv', 'Sylveon, L50', '100/100'),
    event('switch', 'p2a: Cat', 'Incineroar, L50', '100/100'), event('turn', '1'),
    event('move', 'p1a: Sylv', 'Flamethrower', 'p2a: Cat'), event('-ability', 'p1a: Sylv', 'Illusion'),
    event('-damage', 'p2a: Cat', '0 fnt'), event('faint', 'p2a: Cat'), event('win', 'TofuRotom')]);
  assert.equal(mon(result, 'Sylveon').knockouts, 0); assert.equal(mon(result, 'Sylveon').moves.length, 0);
  assert.equal(mon(result, 'Unknown (Illusion)').knockouts, 1);
  assert.equal(mon(result, 'Unknown (Illusion)').identityConfidence, 'ambiguous');
  assert.equal(result.quality.complete, false);
});

test('called move events remain visible but are labelled separately from ordinary move events', () => {
  const result = parse([...headers(), event('switch', 'p1a: Sylv', 'Sylveon, L50', '100/100'), event('turn', '1'),
    event('move', 'p1a: Sylv', 'Metronome'), event('move', 'p1a: Sylv', 'Protect', 'p1a: Sylv', '[from] move: Metronome'), event('win', 'TofuRotom')]);
  assert.deepEqual(mon(result, 'Sylveon').moves.map(row => [row.move, row.uses, row.calledUses]), [['Metronome', 1, 0], ['Protect', 1, 1]]);
});

test('room normalization rejects unknown URLs and removes a private room suffix', () => {
  assert.equal(normalizeRoomId('https://play.pokemonshowdown.com/battle-gen9doublesou-123-abcpw'), 'battle-gen9doublesou-123');
  assert.equal(normalizeRoomId('game-bestof3-gen9championsvgc2026regmc-123'), 'game-bestof3-gen9championsvgc2026regmc-123');
  assert.equal(normalizeRoomId('https://evil.test/battle-x-123'), null);
});
