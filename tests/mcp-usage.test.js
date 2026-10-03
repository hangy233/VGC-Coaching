import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const currentFormat = 'gen9championsvgc2026regmc';
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'vgc-mcp-usage-'));
const fetchLog = join(temporaryDirectory, 'fetch-requests.txt');
writeFileSync(fetchLog, '', 'utf8');
const client = new Client({ name: 'mcp-usage-tests', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', new URL('./fixtures/usage-fetch.js', import.meta.url).href, fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  cwd: projectRoot,
  env: { ...getDefaultEnvironment(), VGC_USAGE_FETCH_LOG: fetchLog },
});

before(async () => {
  await client.connect(transport);
});

after(async () => {
  await client.close();
  unlinkSync(fetchLog);
  rmdirSync(temporaryDirectory);
});

function requests() {
  return readFileSync(fetchLog, 'utf8').split('\n').filter(Boolean);
}

function resultText(result) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${resultText(result)}`);
  return JSON.parse(resultText(result));
}

test('the MCP advertises four usage tools with distinct ladder sources', async () => {
  const { tools } = await client.listTools();
  for (const name of ['get_usage_stats', 'get_pokemon_usage', 'get_champions_usage_stats', 'get_champions_pokemon_usage']) {
    assert.ok(tools.some(tool => tool.name === name), `${name} is registered`);
  }
  assert.match(tools.find(tool => tool.name === 'get_usage_stats').description, /Showdown/);
  assert.match(tools.find(tool => tool.name === 'get_champions_usage_stats').description, /in-game|In-game/);
  assert.equal(tools.find(tool => tool.name === 'get_usage_stats').inputSchema.properties.format.default, currentFormat);
  assert.equal(tools.find(tool => tool.name === 'get_champions_usage_stats').inputSchema.properties.battleType.default, 'Doubles');
});

test('Smogon MCP summary finds the latest published month and preserves percentage units', async () => {
  const result = await callTool('get_usage_stats', { limit: 2 });
  assert.equal(result.source, 'smogon');
  assert.equal(result.available, true);
  assert.equal(result.format, currentFormat);
  assert.equal(result.month, '2026-09');
  assert.equal(result.rating, 1760);
  assert.equal(result.totalBattles, 1234);
  assert.equal(result.sourceUrl, `https://www.smogon.com/stats/2026-09/${currentFormat}-1760.txt`);
  assert.deepEqual(result.rankings, [
    { rank: 1, pokemon: 'Rillaboom', usagePercent: 38.25 },
    { rank: 2, pokemon: 'Incineroar', usagePercent: 32.5 },
  ]);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
});

test('Smogon MCP detailed usage returns one species from the exact dataset', async () => {
  const result = await callTool('get_pokemon_usage', { pokemon: 'rillaboom', month: '2026-09', rating: 1760 });
  assert.equal(result.source, 'smogon');
  assert.equal(result.available, true);
  assert.equal(result.pokemon, 'Rillaboom');
  assert.equal(result.format, currentFormat);
  assert.equal(result.month, '2026-09');
  assert.equal(result.rating, 1760);
  assert.equal(result.sourceUrl, `https://www.smogon.com/stats/2026-09/moveset/${currentFormat}-1760.txt`);
  assert.match(result.report, /Grassy Glide 97\.400%/);
  assert.match(result.report, /Miracle Seed 87\.900%/);
  assert.doesNotMatch(result.report, /Raw count: 600|Flare Blitz/);
});

test('Champions MCP rankings return ladder ranks, dated provenance and attribution', async () => {
  const result = await callTool('get_champions_usage_stats', { limit: 2 });
  assert.equal(result.source, 'champions');
  assert.equal(result.provider, 'Pokémon Champions Battle Data');
  assert.equal(result.battleType, 'Doubles');
  assert.equal(result.season, 'M6');
  assert.equal(result.date, '2026-10-02');
  assert.equal(result.generatedAt, '2026-10-02T21:38:50.244Z');
  assert.equal(result.regulation, null);
  assert.equal(result.sourceUrl, 'https://championsbattledata.com/data/meta/M6/02_10_2026/Doubles.json');
  assert.match(result.attribution, /Battle data provided by Pokémon Champions Battle Data/);
  assert.match(result.attribution, /https:\/\/championsbattledata\.com/);
  assert.deepEqual(result.rankings, [
    { rank: 1, pokemon: 'Rillaboom', usagePercent: null },
    { rank: 2, pokemon: 'Sneasler', usagePercent: null },
  ]);
  assert.match(result.note, /rank is not a percentage/);
});

test('Champions MCP detail preserves within-species percentages and teammate ranks', async () => {
  const result = await callTool('get_champions_pokemon_usage', { pokemon: 'rillaboom', season: 'M6', date: '2026-10-02' });
  assert.equal(result.source, 'champions');
  assert.equal(result.pokemon, 'Rillaboom');
  assert.equal(result.battleType, 'Doubles');
  assert.equal(result.season, 'M6');
  assert.equal(result.date, '2026-10-02');
  assert.equal(result.sourceUrl, 'https://championsbattledata.com/data/meta/M6/02_10_2026/Doubles.json');
  assert.equal(result.rank, 1);
  assert.equal(result.usagePercent, null);
  assert.deepEqual(result.moves, [
    { rank: 1, name: 'Grassy Glide', percent: 97.4 },
    { rank: 2, name: 'Fake Out', percent: 95 },
  ]);
  assert.deepEqual(result.items[0], { rank: 1, name: 'Miracle Seed', percent: 87.9 });
  assert.deepEqual(result.abilities, [{ rank: 1, name: 'Grassy Surge', percent: 100 }]);
  assert.deepEqual(result.teammates, [
    { rank: 1, pokemon: 'Sneasler', percent: null },
    { rank: 2, pokemon: 'Incineroar', percent: null },
  ]);
  assert.deepEqual(result.natures, [{ rank: 1, name: 'Adamant', percent: 75.3, statUp: 'Attack', statDown: 'Sp. Atk' }]);
  assert.deepEqual(result.statPoints, [{ rank: 1, percent: 12, hp: 32, atk: 32, def: 0, spa: 0, spd: 0, spe: 2 }]);
  assert.match(result.note, /within the selected species/);
});

test('Champions MCP Singles uses its own rankings and detail snapshot', async () => {
  const ranking = await callTool('get_champions_usage_stats', { battleType: 'Singles', season: 'M6', date: '2026-10-02', limit: 1 });
  assert.deepEqual(ranking.rankings, [{ rank: 1, pokemon: 'Garchomp', usagePercent: null }]);
  assert.equal(ranking.battleType, 'Singles');
  assert.equal(ranking.sourceUrl, 'https://championsbattledata.com/data/meta/M6/02_10_2026/Singles.json');
  const detail = await callTool('get_champions_pokemon_usage', { pokemon: 'Rillaboom', battleType: 'Singles' });
  assert.equal(detail.rank, 10);
  assert.deepEqual(detail.moves, [{ rank: 1, name: 'Grassy Glide', percent: 75.1 }]);
  assert.equal(detail.battleType, 'Singles');
});

test('MCP rejects invalid usage arguments before any fetch', async () => {
  for (const [name, args] of [
    ['get_usage_stats', { rating: 1234 }],
    ['get_pokemon_usage', { pokemon: 'Rillaboom', rating: 1234 }],
    ['get_usage_stats', { limit: 0 }],
    ['get_usage_stats', { month: '2026-13' }],
    ['get_usage_stats', { format: '../invalid' }],
    ['get_champions_usage_stats', { limit: 0 }],
    ['get_champions_usage_stats', { limit: 101 }],
    ['get_champions_usage_stats', { battleType: 'Triples' }],
    ['get_champions_usage_stats', { season: 'M-C' }],
    ['get_champions_usage_stats', { date: '2026-02-30' }],
    ['get_champions_pokemon_usage', { pokemon: 'Rillaboom', date: '2026/10/02' }],
    ['get_champions_pokemon_usage', { pokemon: '' }],
  ]) {
    const beforeRequests = requests();
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} rejects ${JSON.stringify(args)}`);
    assert.doesNotMatch(resultText(result), /Unexpected fixture fetch/);
    assert.deepEqual(requests(), beforeRequests, `${name} performed no fetch for ${JSON.stringify(args)}`);
  }
});

test('the integration suite uses only the six controlled fixture endpoints', () => {
  const allowed = new Set([
    'https://www.smogon.com/stats/',
    `https://www.smogon.com/stats/2026-09/${currentFormat}-1760.txt`,
    `https://www.smogon.com/stats/2026-09/moveset/${currentFormat}-1760.txt`,
    'https://championsbattledata.com/data/meta/index.json',
    'https://championsbattledata.com/data/meta/M6/02_10_2026/Doubles.json',
    'https://championsbattledata.com/data/meta/M6/02_10_2026/Singles.json',
  ]);
  assert.ok(requests().length > 0);
  assert.deepEqual(new Set(requests()), allowed);
});
