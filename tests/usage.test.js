import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { getSmogonUsage, getSmogonPokemonUsage } from '../dist/usage/smogon.js';
import { getChampionsUsage, getChampionsPokemonUsage } from '../dist/usage/champions.js';

const format = 'gen9championsvgc2026regmc';
const statsRoot = 'https://www.smogon.com/stats/';
const championsRoot = 'https://championsbattledata.com/data/meta/';
const publishedMonths = '<a href="2026-08/">August</a><a href="2026-09/">September</a>';
const usageReport = `Total battles: 1,631,943
 | Rank | Pokemon | Usage % | Raw | % | Real | % |
 | 1 | Rillaboom | 46.59939% | 100 | 20% | 100 | 20% |
 | 2 | Sneasler | 37.07538% | 90 | 18% | 90 | 18% |
 | 3 | Incineroar | 31.67786% | 80 | 16% | 80 | 16% |`;
// Smogon reports have no leading space before the left table border.
const summary = usageReport.replace(/^ \|/gm, '|');
const details = `+----------------------------------------+
| Rillaboom                              |
+----------------------------------------+
| Raw count: 100                         |
| Avg. weight: 0.5                       |
+----------------------------------------+
| Moves                                 |
| Grassy Glide 97.4%                     |
+----------------------------------------+
| Sneasler                               |
+----------------------------------------+
| Raw count: 90                          |
| Avg. weight: 0.4                       |
+----------------------------------------+
| Moves                                 |
| Dire Claw 99.0%                        |
+----------------------------------------+`;

const generatedAt = '2026-10-02T21:38:50.244Z';
function championsIndex() {
  return {
    generatedAt,
    seasons: [
      { season: 'M5', dates: ['10_09_2026'], formats: ['Doubles', 'Singles'] },
      { season: 'M6', dates: ['30_09_2026', '02_10_2026', '01_10_2026'], formats: ['Doubles', 'Singles'] },
    ],
    aliases: { 'Indeedee Female': 'Indeedee-F' },
  };
}
function species(position) {
  return {
    position,
    move: [['Fake Out', 95, 2], ['Grassy Glide', 97.4, 1]],
    held_item: [['Miracle Seed', 59, 1]],
    ability: [['Grassy Surge', 99.9, 1]],
    teammate: [['Incineroar', 1]],
    stat_alignment: [['Adamant', 80, 'Attack', 'Sp. Atk', 1]],
    stat_points: [[12, 32, 32, 0, 0, 0, 2, 1]],
  };
}
function championsSnapshot(season = 'M6', date = '02_10_2026', battleType = 'Doubles') {
  return {
    season, date, format: battleType, generatedAt,
    pokemon: { Incineroar: species(3), Rillaboom: species(1), 'Indeedee-F': species(40) },
  };
}

function stubFetch(routes) {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(String(url));
    assert.ok(options.signal instanceof AbortSignal, 'each request has a timeout signal');
    assert.ok(routes.has(String(url)), `Unexpected request: ${url}`);
    const value = routes.get(String(url));
    if (typeof value === 'number') return new Response(null, { status: value });
    return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status: 200 });
  });
  return calls;
}
function championsRoutes(snapshot = championsSnapshot()) {
  return new Map([
    [`${championsRoot}index.json`, championsIndex()],
    [`${championsRoot}${snapshot.season}/${snapshot.date}/${snapshot.format}.json`, snapshot],
  ]);
}
afterEach(() => mock.restoreAll());

test('Smogon discovers published months and returns the requested number with provenance', async () => {
  const calls = stubFetch(new Map([
    [statsRoot, publishedMonths],
    [`${statsRoot}2026-09/${format}-1760.txt`, summary],
  ]));
  const data = await getSmogonUsage({ format, limit: 2 });
  assert.equal(data.source, 'smogon');
  assert.equal(data.month, '2026-09');
  assert.equal(data.rating, 1760);
  assert.equal(data.totalBattles, 1631943);
  assert.equal(data.rankings.length, 2);
  assert.deepEqual(data.rankings[0], { rank: 1, pokemon: 'Rillaboom', usagePercent: 46.59939 });
  assert.equal(data.sourceUrl, calls[1]);
  assert.equal(calls.length, 2);
});

test('Smogon labels automatic all-ratings fallback within the latest month', async () => {
  const calls = stubFetch(new Map([
    [statsRoot, publishedMonths],
    [`${statsRoot}2026-09/${format}-1760.txt`, 404],
    [`${statsRoot}2026-09/${format}-0.txt`, summary],
  ]));
  const data = await getSmogonUsage({ format });
  assert.equal(data.month, '2026-09');
  assert.equal(data.rating, 0);
  assert.match(data.warnings.join(' '), /rating 0/);
  assert.equal(calls.length, 3);
});

test('Smogon respects an explicit cutoff and month without fallback', async () => {
  const url = `${statsRoot}2026-08/${format}-1630.txt`;
  const calls = stubFetch(new Map([[url, 404]]));
  await assert.rejects(getSmogonUsage({ format, month: '2026-08', rating: 1630 }), /unavailable.*1630/);
  assert.deepEqual(calls, [url]);
});

test('Smogon scans older published months only when the format dataset is missing', async () => {
  stubFetch(new Map([
    [statsRoot, publishedMonths],
    [`${statsRoot}2026-09/${format}-1760.txt`, 404],
    [`${statsRoot}2026-09/${format}-0.txt`, 404],
    [`${statsRoot}2026-08/${format}-1760.txt`, summary],
  ]));
  const data = await getSmogonUsage({ format });
  assert.equal(data.month, '2026-08');
  assert.match(data.sourceUrl, /2026-08/);
});

test('Smogon normalizes species names and isolates a single detailed section', async () => {
  stubFetch(new Map([[`${statsRoot}2026-09/moveset/${format}-1760.txt`, details]]));
  const data = await getSmogonPokemonUsage({ format, month: '2026-09', pokemon: 'rIlLaBoOm' });
  assert.equal(data.pokemon, 'Rillaboom');
  assert.ok(data.available);
  assert.match(data.report, /Grassy Glide/);
  assert.doesNotMatch(data.report, /Sneasler|Dire Claw/);
});

test('Smogon species absence stays attached to the newest dataset', async () => {
  const calls = stubFetch(new Map([
    [statsRoot, publishedMonths],
    [`${statsRoot}2026-09/moveset/${format}-1760.txt`, details],
  ]));
  const data = await getSmogonPokemonUsage({ format, pokemon: 'Absentmon' });
  assert.equal(data.available, false);
  assert.equal(data.report, null);
  assert.equal(data.month, '2026-09');
  assert.equal(data.rating, 1760);
  assert.equal(calls.length, 2);
});

test('Smogon surfaces HTTP errors and malformed reports without hiding them as missing data', async () => {
  const calls = stubFetch(new Map([[`${statsRoot}2026-09/${format}-1760.txt`, 503]]));
  await assert.rejects(getSmogonUsage({ format, month: '2026-09' }), /HTTP 503/);
  assert.equal(calls.length, 1);
  mock.restoreAll();
  stubFetch(new Map([[`${statsRoot}2026-09/${format}-1760.txt`, '<html>broken</html>']]));
  await assert.rejects(getSmogonUsage({ format, month: '2026-09' }), /unrecognized usage report/);
});

test('Champions selects the latest actual date and returns ranks without invented percentages', async () => {
  const calls = stubFetch(championsRoutes());
  const data = await getChampionsUsage({ limit: 2 });
  assert.equal(data.source, 'champions');
  assert.equal(data.season, 'M6');
  assert.equal(data.date, '2026-10-02');
  assert.equal(data.battleType, 'Doubles');
  assert.equal(data.regulation, null);
  assert.deepEqual(data.rankings, [
    { rank: 1, pokemon: 'Rillaboom', usagePercent: null },
    { rank: 3, pokemon: 'Incineroar', usagePercent: null },
  ]);
  assert.match(data.attribution, /https:\/\/championsbattledata.com/);
  assert.equal(data.sourceUrl, calls[1]);
  assert.equal(calls.length, 2);
});

test('Champions preserves within-species percentages and native stat points', async () => {
  stubFetch(championsRoutes());
  const data = await getChampionsPokemonUsage({ pokemon: 'rillaboom' });
  assert.deepEqual(data.moves[0], { rank: 1, name: 'Grassy Glide', percent: 97.4 });
  assert.deepEqual(data.items[0], { rank: 1, name: 'Miracle Seed', percent: 59 });
  assert.deepEqual(data.teammates[0], { rank: 1, pokemon: 'Incineroar', percent: null });
  assert.deepEqual(data.statPoints[0], { rank: 1, percent: 12, hp: 32, atk: 32, def: 0, spa: 0, spd: 0, spe: 2 });
  assert.equal(data.natures[0].statUp, 'Attack');
  assert.equal(data.usagePercent, null);
});

test('Champions uses exact historical dates and Singles when requested', async () => {
  const snapshot = championsSnapshot('M5', '10_09_2026', 'Singles');
  stubFetch(championsRoutes(snapshot));
  const data = await getChampionsUsage({ season: 'M5', date: '2026-09-10', battleType: 'Singles' });
  assert.equal(data.season, 'M5');
  assert.equal(data.date, '2026-09-10');
  assert.equal(data.battleType, 'Singles');
});

test('Champions rejects missing explicit seasons or dates instead of substituting data', async () => {
  const calls = stubFetch(new Map([[`${championsRoot}index.json`, championsIndex()]]));
  await assert.rejects(getChampionsUsage({ season: 'M9' }), /M9 is unavailable/);
  await assert.rejects(getChampionsUsage({ season: 'M6', date: '2026-09-10' }), /exact match/);
  assert.equal(calls.length, 2);
});

test('Champions matches female forms and aliases but does not merge Mega species', async () => {
  stubFetch(championsRoutes());
  assert.equal((await getChampionsPokemonUsage({ pokemon: 'Indeedee♀' })).pokemon, 'Indeedee-F');
  assert.equal((await getChampionsPokemonUsage({ pokemon: 'Indeedee Female' })).pokemon, 'Indeedee-F');
  await assert.rejects(getChampionsPokemonUsage({ pokemon: 'Rillaboom-Mega' }), /Forms are matched exactly/);
});

test('malformed upstream spreads do not block rankings or unrelated species', async () => {
  const snapshot = championsSnapshot();
  snapshot.pokemon.Malamar = species(100);
  snapshot.pokemon.Malamar.stat_points.push([12, 4, 1, 4, 1, 145, 32, 2]);
  stubFetch(championsRoutes(snapshot));
  assert.equal((await getChampionsUsage()).rankings.length, 4);
  const rillaboom = await getChampionsPokemonUsage({ pokemon: 'Rillaboom' });
  assert.equal(rillaboom.statPoints.length, 1);
  assert.equal(rillaboom.warnings, undefined);
  const malamar = await getChampionsPokemonUsage({ pokemon: 'Malamar' });
  assert.equal(malamar.statPoints.length, 1);
  assert.match(malamar.warnings[0], /Omitted 1 upstream/);
  assert.equal(malamar.statPoints[0].percent, 12);
});

test('Champions validates snapshot scope, field units and HTTP failures', async () => {
  const wrongScope = championsSnapshot('M5');
  stubFetch(new Map([
    [`${championsRoot}index.json`, championsIndex()],
    [`${championsRoot}M6/02_10_2026/Doubles.json`, wrongScope],
  ]));
  await assert.rejects(getChampionsUsage(), /different season, date, or battle type/);
  mock.restoreAll();
  const invalidPercent = championsSnapshot();
  invalidPercent.pokemon.Rillaboom.move[0][1] = 150;
  stubFetch(championsRoutes(invalidPercent));
  await assert.rejects(getChampionsUsage(), /unsupported shape/);
  mock.restoreAll();
  stubFetch(new Map([[`${championsRoot}index.json`, 429]]));
  await assert.rejects(getChampionsUsage(), /HTTP 429/);
});

test('invalid calendar dates and URL path inputs fail before making requests', async () => {
  const calls = stubFetch(new Map());
  await assert.rejects(getChampionsUsage({ date: '2026-02-30' }));
  await assert.rejects(getChampionsUsage({ season: '../M6' }));
  await assert.rejects(getChampionsUsage({ limit: 0 }));
  await assert.rejects(getSmogonUsage({ format: '../other' }));
  await assert.rejects(getSmogonUsage({ format, month: '2026-13' }));
  assert.deepEqual(calls, []);
});
