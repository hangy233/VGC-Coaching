import { appendFileSync } from 'node:fs';

// This preload deliberately replaces fetch entirely. An unknown URL is a test
// failure, and no request can reach the real network.
const smogonRoot = 'https://www.smogon.com/stats/';
const championsRoot = 'https://championsbattledata.com';
const format = 'gen9championsvgc2026regmc';
const generatedAt = '2026-10-02T21:38:50.244Z';

const summary = `Total battles: 1,234
+ ---- + ------------------ + --------- + ------- + ------- + ------- + ------- +
| Rank | Pokemon            | Usage %   | Raw     | %       | Real    | %       |
+ ---- + ------------------ + --------- + ------- + ------- + ------- + ------- +
| 1    | Rillaboom          | 38.25000% | 700     | 56.7%   | 620     | 50.2%   |
| 2    | Incineroar         | 32.50000% | 600     | 48.6%   | 500     | 40.5%   |
| 3    | Indeedee-F         | 20.00000% | 300     | 24.3%   | 250     | 20.2%   |
`;

const detail = `Total battles: 1,234
+-------------------------------+
| Rillaboom                     |
+-------------------------------+
| Raw count: 700                |
| Avg. weight: 0.715            |
+-------------------------------+
| Abilities                     |
| Grassy Surge 100.000%         |
+-------------------------------+
| Items                         |
| Miracle Seed 87.900%          |
+-------------------------------+
| Moves                         |
| Grassy Glide 97.400%          |
| Fake Out 95.000%              |
+-------------------------------+
| Teammates                     |
| Incineroar 60.000%            |
+-------------------------------+
| Incineroar                    |
+-------------------------------+
| Raw count: 600                |
| Avg. weight: 0.833            |
+-------------------------------+
| Abilities                     |
| Intimidate 100.000%           |
+-------------------------------+
| Moves                         |
| Flare Blitz 99.000%           |
+-------------------------------+
`;

function species(position, move, heldItem, teammate, ability) {
  return {
    position,
    move,
    held_item: heldItem,
    teammate,
    ability,
    stat_alignment: [['Adamant', 75.3, 'Attack', 'Sp. Atk', 1]],
    stat_points: [[12, 32, 32, 0, 0, 0, 2, 1]],
  };
}

const doubles = {
  season: 'M6', date: '02_10_2026', format: 'Doubles', generatedAt,
  pokemon: {
    Sneasler: species(2, [['Close Combat', 99, 1]], [['White Herb', 60, 1]], [['Rillaboom', 1]], [['Unburden', 99, 1]]),
    Rillaboom: species(1, [['Fake Out', 95, 2], ['Grassy Glide', 97.4, 1]], [['Assault Vest', 12.1, 2], ['Miracle Seed', 87.9, 1]], [['Incineroar', 2], ['Sneasler', 1]], [['Grassy Surge', 100, 1]]),
    'Indeedee-F': species(5, [['Follow Me', 99, 1]], [['Psychic Seed', 80, 1]], [['Rillaboom', 1]], [['Psychic Surge', 100, 1]]),
  },
};

const singles = {
  season: 'M6', date: '02_10_2026', format: 'Singles', generatedAt,
  pokemon: {
    Rillaboom: species(10, [['Grassy Glide', 75.1, 1]], [['Assault Vest', 60, 1]], [['Garchomp', 1]], [['Grassy Surge', 100, 1]]),
    Garchomp: species(1, [['Earthquake', 90.3, 1]], [['Focus Sash', 50, 1]], [['Rillaboom', 1]], [['Rough Skin', 96.7, 1]]),
  },
};

const fixtures = new Map([
  [smogonRoot, '<a href="2026-08/">2026-08/</a><a href="2026-09/">2026-09/</a>'],
  [`${smogonRoot}2026-09/${format}-1760.txt`, summary],
  [`${smogonRoot}2026-09/moveset/${format}-1760.txt`, detail],
  [`${championsRoot}/data/meta/index.json`, {
    generatedAt,
    seasons: [{ season: 'M6', dates: ['02_10_2026'], formats: ['Doubles', 'Singles'] }],
    aliases: { 'Indeedee Female': 'Indeedee-F' },
  }],
  [`${championsRoot}/data/meta/M6/02_10_2026/Doubles.json`, doubles],
  [`${championsRoot}/data/meta/M6/02_10_2026/Singles.json`, singles],
]);

globalThis.fetch = async function fixtureFetch(input) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (process.env.VGC_USAGE_FETCH_LOG) appendFileSync(process.env.VGC_USAGE_FETCH_LOG, `${url}\n`, 'utf8');
  if (!fixtures.has(url)) throw new Error(`Unexpected fixture fetch: ${url}`);
  const value = fixtures.get(url);
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': typeof value === 'string' ? 'text/plain' : 'application/json' },
  });
};
