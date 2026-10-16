import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Test the public MCP tool, including schema validation and native-engine results.
const client = new Client({ name: 'mcp-speed-tests', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.env.VGC_SPEED_TEST_SERVER || fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
});
before(async () => client.connect(transport));
after(async () => client.close());

const kommo = { species: 'Kommo-o', nature: 'Modest', ability: 'Soundproof', statPoints: { hp: 32, def: 12, spa: 22 } };
const garchomp = { species: 'Garchomp', nature: 'Jolly', ability: 'Rough Skin', statPoints: { hp: 2, atk: 32, spe: 32 } };
const venusaur = { species: 'Venusaur', nature: 'Timid', ability: 'Chlorophyll', statPoints: { hp: 2, spa: 32, spe: 32 } };
const swampert = { species: 'Swampert-Mega', nature: 'Adamant', ability: 'Swift Swim', statPoints: { hp: 32, atk: 32, def: 2 } };
function output(result) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}
async function speed(pokemon, field = {}) {
  const result = await client.callTool({ name: 'calculate_speed', arguments: { pokemon, field } });
  assert.ok(!result.isError, output(result));
  return JSON.parse(output(result));
}

test('MCP advertises a Champions-only Speed calculator with explicit snapshots', async () => {
  const { tools } = await client.listTools();
  const tool = tools.find(entry => entry.name === 'calculate_speed');
  assert.ok(tool);
  assert.match(tool.description, /native Showdown M-C engine/);
  const schema = tool.inputSchema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.gen.const, 0);
  assert.equal(schema.properties.pokemon.minItems, 1);
  assert.equal(schema.properties.pokemon.maxItems, 6);
  assert.ok(schema.properties.pokemon.items.required.includes('nature'));
  assert.ok(schema.properties.pokemon.items.required.includes('ability'));
});

test('native Champions points, nature and boost rounding produce the approved Kommo-o stats', async () => {
  const result = await speed([{ ...kommo, boosts: { spe: 1 } }]);
  assert.equal(result.gen, 0);
  assert.equal(result.format, 'gen9championsvgc2026regmc');
  const entry = result.pokemon[0];
  assert.deepEqual(entry.rawStats, { hp: 182, atk: 117, def: 157, spa: 156, spd: 125, spe: 105 });
  assert.equal(entry.rawSpeed, 105);
  assert.equal(entry.effectiveSpeed, 157);
  assert.equal(entry.level, 50);
  assert.deepEqual(entry.ivs, { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 });
  assert.match(result.assumptions.join(' '), /Omitted stat points.*zero/);
});

test('native modifier stacking includes Choice Scarf, Tailwind and modern paralysis rounding', async () => {
  const result = await speed([
    { ...garchomp, label: 'Scarf Tailwind', item: 'Choice Scarf', tailwind: true },
    { ...garchomp, label: 'Paralyzed', item: 'Choice Scarf', tailwind: true, status: 'par' },
  ]);
  assert.deepEqual(result.pokemon.map(entry => entry.effectiveSpeed), [507, 253]);
  assert.deepEqual(result.order.map(entry => entry.labels), [['Scarf Tailwind'], ['Paralyzed']]);
});

test('Champions action Speed preserves values above 999 and avoids Trick Room underflow', async () => {
  const result = await speed([{ ...garchomp, item: 'Choice Scarf', tailwind: true, boosts: { spe: 6 } }], { trickRoom: true });
  assert.equal(result.pokemon[0].effectiveSpeed, 2028);
  assert.equal(result.pokemon[0].actionSpeed, -2028);
});

test('Quick Feet handles paralysis through native status and ability hooks', async () => {
  const subject = { species: 'Jolteon', nature: 'Timid', ability: 'Quick Feet', statPoints: { spe: 32 }, status: 'par' };
  const result = await speed([subject, { ...subject, abilitySuppressed: true }]);
  assert.deepEqual(result.pokemon.map(entry => entry.effectiveSpeed), [300, 100]);
  assert.equal(result.pokemon[1].abilitySuppressed, true);
});

test('sun activates Chlorophyll and external weather suppression or Gastro Acid disables it', async () => {
  const sunny = await speed([venusaur, { ...venusaur, abilitySuppressed: true }], { weather: 'Sun' });
  assert.deepEqual(sunny.pokemon.map(entry => entry.effectiveSpeed), [290, 145]);
  assert.equal(sunny.pokemon[1].abilitySuppressed, true);
  const suppressed = await speed([venusaur], { weather: 'Sun', weatherSuppressed: true });
  assert.equal(suppressed.pokemon[0].effectiveSpeed, 145);
  assert.equal(suppressed.pokemon[0].effectiveWeather, '');
});

test('Ability Shield suppression conflicts fail explicitly unless the item itself is suppressed', async () => {
  const subject = { ...venusaur, abilitySuppressed: true, item: 'Ability Shield' };
  const rejected = await client.callTool({ name: 'calculate_speed', arguments: { pokemon: [subject], field: { weather: 'Sun' } } });
  assert.equal(rejected.isError, true);
  assert.match(output(rejected), /native engine rejected ability suppression/);
  const allowed = await speed([{ ...subject, itemSuppressed: true }], { weather: 'Sun' });
  assert.equal(allowed.pokemon[0].effectiveSpeed, 145);
  assert.equal(allowed.pokemon[0].abilitySuppressed, true);
});

test('rain uses the current Mega form and Trick Room reverses native action-Speed ordering', async () => {
  const result = await speed([
    { ...swampert, label: 'Mega Swampert' },
    { species: 'Politoed', label: 'Politoed', nature: 'Modest', ability: 'Drizzle', statPoints: { hp: 32, def: 2, spa: 32 } },
    { species: 'Farigiraf', label: 'Farigiraf', nature: 'Sassy', ability: 'Armor Tail', statPoints: { hp: 32, def: 16, spd: 18 } },
  ], { weather: 'Rain', trickRoom: true });
  assert.equal(result.pokemon[0].rawSpeed, 90);
  assert.equal(result.pokemon[0].effectiveSpeed, 180);
  assert.equal(result.pokemon[0].actionSpeed, -180);
  assert.deepEqual(result.order.map(entry => entry.labels[0]), ['Farigiraf', 'Politoed', 'Mega Swampert']);
});

test('equal Speed is returned as an unresolved group, including under Trick Room', async () => {
  for (const trickRoom of [false, true]) {
    const result = await speed([{ ...kommo, label: 'First' }, { ...kommo, label: 'Second' }], { trickRoom });
    assert.deepEqual(result.order, [{ rank: 1, effectiveSpeed: 105, labels: ['First', 'Second'], tie: true }]);
    assert.match(result.tiePolicy, /input order does not choose a winner/);
  }
});

test('native item suppression and Klutz remove the Choice Scarf modifier', async () => {
  const magic = await speed([{ ...garchomp, item: 'Choice Scarf' }], { magicRoom: true });
  const embargo = await speed([{ ...garchomp, item: 'Choice Scarf', itemSuppressed: true }]);
  const klutz = await speed([{ ...garchomp, item: 'Choice Scarf', ability: 'Klutz' }]);
  for (const result of [magic, embargo, klutz]) {
    assert.equal(result.pokemon[0].effectiveSpeed, 169);
    assert.equal(result.pokemon[0].itemSuppressed, true);
  }
});

test('conditional Unburden and Slow Start states are explicitly represented', async () => {
  const result = await speed([
    { species: 'Hawlucha', nature: 'Jolly', ability: 'Unburden', unburdenActive: false, label: 'Before item loss' },
    { species: 'Hawlucha', nature: 'Jolly', ability: 'Unburden', unburdenActive: true, label: 'After item loss' },
    { species: 'Regigigas', nature: 'Adamant', ability: 'Slow Start', slowStartActive: true, label: 'Slow Start active' },
    { species: 'Regigigas', nature: 'Adamant', ability: 'Slow Start', slowStartActive: false, label: 'Slow Start ended' },
  ]);
  assert.deepEqual(result.pokemon.map(entry => entry.effectiveSpeed), [151, 302, 60, 120]);
  assert.equal(result.pokemon[1].abilityState.unburdenActive, true);
  assert.equal(result.pokemon[2].abilityState.slowStartActive, true);
  assert.equal(result.pokemon[3].abilityState.slowStartActive, false);
});

test('suppression disables activated Unburden, Slow Start and Quark Drive modifiers', async () => {
  const result = await speed([
    { species: 'Hawlucha', nature: 'Jolly', ability: 'Unburden', unburdenActive: true, abilitySuppressed: true },
    { species: 'Regigigas', nature: 'Adamant', ability: 'Slow Start', slowStartActive: true, abilitySuppressed: true },
    { species: 'Iron Bundle', nature: 'Timid', ability: 'Quark Drive', statPoints: { spe: 32 }, boosterEnergyActive: true, abilitySuppressed: true },
  ]);
  assert.deepEqual(result.pokemon.map(entry => entry.effectiveSpeed), [151, 120, 206]);
  assert.ok(result.pokemon.every(entry => entry.abilitySuppressed));
});

test('native terrain and booster activation select the actual highest stat', async () => {
  const fast = { species: 'Iron Bundle', nature: 'Timid', ability: 'Quark Drive', statPoints: { hp: 2, spa: 32, spe: 32 }, boosterEnergyActive: false };
  const terrain = await speed([fast], { terrain: 'Electric' });
  assert.equal(terrain.pokemon[0].rawSpeed, 206);
  assert.equal(terrain.pokemon[0].effectiveSpeed, 309);
  assert.equal(terrain.pokemon[0].abilityState.boostedStat, 'spe');
  const booster = await speed([{ ...fast, boosterEnergyActive: true }]);
  assert.equal(booster.pokemon[0].effectiveSpeed, 309);
  assert.equal(booster.pokemon[0].abilityState.boosterEnergyActive, true);
  const attackBoost = await speed([{ ...fast, boosts: { spa: 6 }, boosterEnergyActive: true }]);
  assert.equal(attackBoost.pokemon[0].abilityState.boostedStat, 'spa');
  assert.equal(attackBoost.pokemon[0].effectiveSpeed, 206);
});

test('effects outside Speed ordering are identified instead of predicting a move winner', async () => {
  const result = await speed([{ ...kommo, item: 'Quick Claw', ability: 'Stall' }]);
  assert.equal(result.pokemon[0].orderingWarnings.length, 2);
  assert.match(result.scope, /same move-priority bracket/);
  assert.match(result.limitations.join(' '), /Quash, After You/);
});

test('MCP rejects malformed or unsupported snapshots, stat-point overflow and unknown names', async () => {
  const invalid = [
    { pokemon: [] },
    { pokemon: Array(7).fill(kommo) },
    { pokemon: [{ ...kommo, species: 'DefinitelyNotAPokemon' }] },
    { pokemon: [{ ...kommo, nature: 'Fastest' }] },
    { pokemon: [{ ...kommo, ability: 'Extremely Fast' }] },
    { pokemon: [{ ...kommo, item: 'Fast Shoes' }] },
    { pokemon: [{ ...kommo, statPoints: { spe: 252 } }] },
    { pokemon: [{ ...kommo, statPoints: { hp: 32, spa: 32, spe: 3 } }] },
    { pokemon: [{ ...kommo, statPoints: { spe: 0.5 } }] },
    { pokemon: [{ ...kommo, boosts: { spe: 7 } }] },
    { pokemon: [{ ...kommo, level: 100 }] },
    { pokemon: [{ ...kommo, ivs: { spe: 0 } }] },
    { pokemon: [{ ...kommo, priority: 1 }] },
    { pokemon: [kommo], gen: 9 },
    { pokemon: [kommo], level: 100 },
    { pokemon: [kommo], field: { pledgeSwamp: true } },
    { pokemon: [{ ...kommo, label: 'Duplicate' }, { ...kommo, label: 'Duplicate' }] },
  ];
  for (const args of invalid) {
    const result = await client.callTool({ name: 'calculate_speed', arguments: args });
    assert.equal(result.isError, true, `Should reject ${JSON.stringify(args)}: ${output(result)}`);
  }
});

test('MCP requires and validates conditional ability activation instead of guessing it', async () => {
  const invalid = [
    { ...kommo, ability: 'Unburden' },
    { ...kommo, ability: 'Unburden', unburdenActive: true, item: 'Sitrus Berry' },
    { ...kommo, unburdenActive: false },
    { ...kommo, ability: 'Slow Start' },
    { ...kommo, ability: 'Quark Drive' },
    { ...kommo, ability: 'Protosynthesis', boosterEnergyActive: true, item: 'Booster Energy' },
    { ...kommo, ability: 'Protosynthesis', boosterEnergyActive: false, item: 'Booster Energy' },
  ];
  for (const entry of invalid) {
    const result = await client.callTool({ name: 'calculate_speed', arguments: { pokemon: [entry] } });
    assert.equal(result.isError, true, output(result));
  }
});
