import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CURRENT_FORMAT = 'gen9championsvgc2026regmc';
const PREVIOUS_FORMAT = 'gen9championsvgc2026regmb';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const client = new Client({ name: 'regulation-tests', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  cwd: projectRoot,
});

before(async () => {
  await client.connect(transport);
});

after(async () => {
  await client.close();
});

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  assert.doesNotMatch(text, /^Error\b/, `${name}: ${text}`);
  return text;
}

function set(species, ability, item, moves = ['Protect']) {
  return `${species}${item ? ` @ ${item}` : ''}\nAbility: ${ability}\nEVs: 32 HP / 32 Atk / 2 SpD\nAdamant Nature\n${moves.map(move => `- ${move}`).join('\n')}`;
}

const rillaboom = set('Rillaboom', 'Grassy Surge', 'Leftovers', ['Grassy Glide', 'Fake Out', 'Wood Hammer', 'Protect']);
const incineroar = set('Incineroar', 'Intimidate', 'Sitrus Berry', ['Fake Out', 'Flare Blitz', 'Parting Shot', 'Protect']);
const legalTeam = [
  rillaboom,
  incineroar,
  set('Salamence', 'Intimidate', 'Salamencite'),
  set('Indeedee-F', 'Psychic Surge', 'Psychic Seed'),
  set('Whimsicott', 'Prankster', 'Focus Sash'),
  set('Pelipper', 'Drizzle', 'Damp Rock'),
].join('\n\n');

test('all format-aware tools advertise Champions M-C as an optional default', async () => {
  const { tools } = await client.listTools();
  for (const name of ['classify_team', 'get_usage_stats', 'get_pokemon_usage', 'validate_pokemon', 'validate_team']) {
    const tool = tools.find(candidate => candidate.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.equal(tool.inputSchema.properties.format.default, CURRENT_FORMAT, `${name} default`);
    assert.ok(!tool.inputSchema.required?.includes('format'), `${name} allows omitted format`);
  }
});

test('omitting the regulation validates a newly eligible M-C Pokemon', async () => {
  const implicit = await callTool('validate_pokemon', { pokemon: rillaboom });
  const explicit = await callTool('validate_pokemon', { pokemon: rillaboom, format: CURRENT_FORMAT });
  assert.equal(implicit, `Pokémon is valid for ${CURRENT_FORMAT}`);
  assert.equal(explicit, implicit);
});

test('an explicit previous regulation preserves its different eligibility rules', async () => {
  const result = await callTool('validate_pokemon', { pokemon: rillaboom, format: PREVIOUS_FORMAT });
  assert.match(result, /^Validation problems:/);
  assert.match(result, /Rillaboom does not exist/);
});

test('the current regulation rejects restricted legendary Pokemon', async () => {
  const result = await callTool('validate_pokemon', {
    pokemon: set('Calyrex-Shadow', 'As One (Spectrier)', '', ['Astral Barrage']),
  });
  assert.match(result, /^Validation problems:/);
  assert.match(result, /Calyrex.*Restricted Legendary.*banned/);
});

test('Champions validates its own learnsets', async () => {
  assert.equal(await callTool('validate_pokemon', { pokemon: incineroar }), `Pokémon is valid for ${CURRENT_FORMAT}`);
  const illegalMoves = incineroar.replace('- Protect', '- Knock Off');
  const result = await callTool('validate_pokemon', { pokemon: illegalMoves });
  assert.match(result, /^Validation problems:/);
  assert.match(result, /Incineroar.*Knock Off/);
});

test('a complete six-Pokemon team is valid in the default regulation', async () => {
  assert.equal(await callTool('validate_team', { team: legalTeam }), `Team is valid for ${CURRENT_FORMAT}`);
});

test('the current regulation enforces the duplicate-item clause', async () => {
  const result = await callTool('validate_team', { team: legalTeam.replace('@ Sitrus Berry', '@ Leftovers') });
  assert.match(result, /^Validation problems:/);
  assert.match(result, /same item|Item Clause/i);
});

test('team classification still returns usable analysis after dependency updates', async () => {
  const result = JSON.parse(await callTool('classify_team', { team: legalTeam }));
  assert.ok(Number.isFinite(result.bias));
  assert.ok(Number.isFinite(result.stalliness));
  assert.ok(Array.isArray(result.tags));
});

test('damage calculations and type effectiveness still work', async () => {
  const damage = await callTool('calculate_damage', {
    attacker: 'Pikachu', attackerOptions: { level: 50 },
    defender: 'Pelipper', defenderOptions: { level: 50 },
    move: 'Thunderbolt', field: { gameType: 'Doubles' },
  });
  assert.match(damage, /Pikachu.*Thunderbolt.*Pelipper/);
  assert.match(damage, /\d+(?:\.\d+)?%/);
  assert.equal(await callTool('get_type_effectiveness', {
    attackType: 'Electric', defenderTypes: ['Water', 'Flying'],
  }), 'Effectiveness of Electric against Water/Flying: 4x');
});

test('data search and detail tools still return expected Pokemon data', async () => {
  for (const [name, query] of [
    ['search_pokemon', 'Rillaboom'], ['search_move', 'Thunderbolt'],
    ['search_item', 'Leftovers'], ['search_ability', 'Intimidate'], ['search_nature', 'Adamant'],
  ]) {
    assert.ok(JSON.parse(await callTool(name, { query })).includes(query), `${name} finds ${query}`);
  }
  const pokemon = JSON.parse(await callTool('get_pokemon', { name: 'Rillaboom' }));
  assert.deepEqual(pokemon.types, ['Grass']);
  assert.equal(pokemon.bs.at, 125);
  const move = JSON.parse(await callTool('get_move', { name: 'Thunderbolt' }));
  assert.equal(move.name, 'Thunderbolt');
  assert.equal(move.type, 'Electric');
  assert.equal(move.basePower, 90);
  assert.match(await callTool('get_movepool', { pokemon: 'Rillaboom' }), /Grassy Glide/);
});
