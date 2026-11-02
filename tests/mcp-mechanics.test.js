import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Dex as BaseDex} from '@pkmn/dex';
import {getChampionsPokemon, getChampionsMove, getChampionsAbility, getChampionsMovepool,
  CHAMPIONS_STATIC_FORMAT} from '../mechanics/static-data.mjs';

// Every tool invoked here is a static read. No calculator, battle bridge,
// authentication, model provider or external network is used.
const client = new Client({name: 'mcp-static-mechanics-tests', version: '1'}, {capabilities: {}});
before(async () => client.connect(new StdioClientTransport({command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
})));
after(async () => client.close());
const text = result => result.content.filter(row => row.type === 'text').map(row => row.text).join('\n');
async function read(name, args) {
  const result = await client.callTool({name, arguments: args});
  assert.notEqual(result.isError, true, text(result));
  return result.structuredContent ?? JSON.parse(text(result));
}

test('pinned Champions species and move reads expose Mega Golisopod and Leech Life without changing source data', () => {
  const first = getChampionsPokemon('Golisopod-Mega');
  assert.deepEqual(first.types, ['Bug', 'Steel']);
  assert.equal(first.ability, 'Tough Claws');
  assert.deepEqual(first.abilities, {'0': 'Tough Claws'});
  assert.deepEqual(first.bs, {hp: 75, atk: 150, def: 175, spa: 70, spd: 120, spe: 40});
  assert.equal(first.source.format, CHAMPIONS_STATIC_FORMAT);
  first.types.push('Fixture mutation'); first.bs.atk = 0;
  assert.deepEqual(getChampionsPokemon('Golisopod-Mega').types, ['Bug', 'Steel']);
  assert.equal(getChampionsPokemon('Golisopod-Mega').bs.atk, 150);
  const move = getChampionsMove('Leech Life');
  assert.equal(move.type, 'Bug'); assert.equal(move.category, 'Physical');
  assert.equal(move.basePower, 80); assert.equal(move.priority, 0); assert.equal(move.target, 'normal');
  assert.equal(move.flags.contact, 1); assert.equal(move.makesContact, true);
  assert.deepEqual(move.effects.drain, [1, 2]);
  assert.equal(move.desc, BaseDex.moves.get('Leech Life').desc);
  assert.equal(move.descriptionSource.scope, 'base-generation-prose');
});

test('static ability prose stays complete and Champions overrides are explicitly separated from base descriptions', () => {
  const claws = getChampionsAbility('Tough Claws');
  assert.equal(claws.desc, BaseDex.abilities.get('Tough Claws').desc);
  assert.match(claws.desc, /contact moves/u);
  assert.equal(claws.descriptionSource.championsExecutableDiffersFromBase, false);
  const healer = getChampionsAbility('Healer');
  assert.equal(healer.desc, BaseDex.abilities.get('Healer').desc);
  assert.equal(healer.descriptionSource.championsExecutableDiffersFromBase, true);
  assert(healer.descriptionSource.differingExecutableFields.includes('onResidual'));
  assert.equal(healer.descriptionSource.status, 'base-prose-with-champions-overrides');
  assert.match(healer.descriptionSource.limitation, /not verified prose for the Champions overrides/u);
  const changedMove = getChampionsMove('Anchor Shot');
  assert.equal(changedMove.basePower, 90);
  assert.equal(changedMove.descriptionSource.championsExecutableDiffersFromBase, true);
  assert(changedMove.descriptionSource.differingExecutableFields.includes('basePower'));
});

test('Champions form movepools use pinned inherited learnsets without claiming full legality', () => {
  const pool = getChampionsMovepool('Golisopod-Mega');
  assert(pool.moves.includes('Leech Life')); assert(pool.moveIds.includes('leechlife'));
  assert(pool.learnsetSpecies.includes('Golisopod'));
  assert.equal(pool.learnsetScope, 'pinned-format-learnset-union');
  assert.equal(pool.legalityChecked, false);
  assert.match(pool.limitation, /not full set or combination legality/u);
  for (const lookup of [getChampionsPokemon, getChampionsMove, getChampionsAbility, getChampionsMovepool]) {
    assert.equal(lookup('Definitely nonexistent static-data entry'), null);
    assert.throws(() => lookup({name: 'Do not accept objects'}), /bounded static-data name/u);
  }
});

test('public MCP advertises a read-only ability description tool and Champions generation selection', async () => {
  const tools = (await client.listTools()).tools;
  const ability = tools.find(tool => tool.name === 'get_ability');
  assert(ability); assert.equal(ability.annotations.readOnlyHint, true);
  assert.equal(ability.annotations.destructiveHint, false);
  assert.equal(ability.annotations.openWorldHint, false);
  assert.match(ability.description, /full static ability descriptions/u);
  for (const name of ['get_pokemon', 'get_move', 'get_movepool']) {
    assert.match(tools.find(tool => tool.name === name).inputSchema.properties.gen.description, /0 selects pinned Champions/u);
  }
});

test('actual MCP gen0 reads deliver form, contact, full ability description and inherited movepool', async () => {
  const pokemon = await read('get_pokemon', {name: 'Golisopod-Mega', gen: 0});
  assert.deepEqual(pokemon.types, ['Bug', 'Steel']); assert.equal(pokemon.ability, 'Tough Claws');
  const move = await read('get_move', {name: 'Leech Life', gen: 0});
  assert.equal(move.makesContact, true); assert.equal(move.flags.contact, 1);
  assert.equal(move.target, 'normal'); assert.equal(move.priority, 0);
  const ability = await read('get_ability', {name: 'Tough Claws', gen: 0});
  assert.equal(ability.desc, BaseDex.abilities.get('Tough Claws').desc);
  assert.equal(ability.descriptionSource.championsExecutableDiffersFromBase, false);
  const pool = await read('get_movepool', {pokemon: 'Golisopod-Mega', gen: 0});
  assert(pool.moves.includes('Leech Life')); assert.equal(pool.legalityChecked, false);
  for (const value of [pokemon, move, ability, pool]) assert.equal(value.source.format, CHAMPIONS_STATIC_FORMAT);
});

test('non-Champions static reads retain their ordinary generation behavior', async () => {
  const pokemon = await read('get_pokemon', {name: 'Golisopod', gen: 9});
  assert.deepEqual(pokemon.types, ['Bug', 'Water']);
  const move = await read('get_move', {name: 'Leech Life', gen: 9});
  assert.equal(move.basePower, 80); assert.equal(move.makesContact, true);
  assert.equal(Object.hasOwn(move, 'source'), false, 'The existing gen9 move response shape remains unchanged.');
  const oldMove = await read('get_move', {name: 'Leech Life', gen: 6});
  assert.equal(oldMove.basePower, 20);
  const ability = await read('get_ability', {name: 'Tough Claws', gen: 9});
  assert.equal(ability.desc, BaseDex.abilities.get('Tough Claws').desc);
  assert.equal(ability.source.generation, 9);
  const pool = await client.callTool({name: 'get_movepool', arguments: {pokemon: 'Pikachu', gen: 9}});
  assert.notEqual(pool.isError, true); assert.match(text(pool), /^Movepool for Pikachu \(Gen 9\):/u);
  assert.match(text(pool), /Thunderbolt/u);
});

test('unknown static names remain explicit not-found results at the MCP boundary', async () => {
  for (const [name, args, message] of [
    ['get_pokemon', {name: 'Definitely nonexistent Pokemon', gen: 0}, 'Pokemon not found.'],
    ['get_move', {name: 'Definitely nonexistent move', gen: 0}, 'Move not found.'],
    ['get_ability', {name: 'Definitely nonexistent ability', gen: 0}, 'Ability not found.'],
    ['get_movepool', {pokemon: 'Definitely nonexistent Pokemon', gen: 0}, 'Pokemon not found.'],
  ]) assert.equal(text(await client.callTool({name, arguments: args})), message);
});
