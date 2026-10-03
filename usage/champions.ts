import { z } from "zod";

const PROVIDER_URL = "https://championsbattledata.com";
const INDEX_URL = `${PROVIDER_URL}/data/meta/index.json`;
const ATTRIBUTION = `Battle data provided by Pokémon Champions Battle Data (${PROVIDER_URL}/)`;
const DATA_NOTE = "Community-published snapshots of Pokémon Champions ranked Battle Data. Set-choice percentages describe shares within the selected species. Pokémon and teammate appearance percentages and battle counts are not supplied; rank is not a percentage. No verified mapping from this ladder season to a Showdown regulation is available.";

const battleTypeSchema = z.enum(["Doubles", "Singles"]);
const seasonSchema = z.string().regex(/^M[1-9]\d*$/, "Use a Champions ladder season such as M6.");
const percentageSchema = z.number().finite().min(0).max(100);
const rankSchema = z.number().int().positive();
// Some historical upstream spreads exceed Champions' legal point budget.
// Parse their structure here; exclude illegal spreads only from species detail.
const statPointSchema = z.number().int().nonnegative();
const nameSchema = z.string().trim().min(1);
const generatedAtSchema = z.string().datetime();

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const isoDateSchema = z.string().refine(validIsoDate, "Use a real calendar date in YYYY-MM-DD format.");

function folderDateToIso(value: string): string {
  const [day, month, year] = value.split("_");
  return `${year}-${month}-${day}`;
}

const folderDateSchema = z.string().regex(/^\d{2}_\d{2}_\d{4}$/)
  .refine(value => validIsoDate(folderDateToIso(value)), "Invalid snapshot calendar date.");

const indexSchema = z.object({
  generatedAt: generatedAtSchema,
  seasons: z.array(z.object({
    season: seasonSchema,
    dates: z.array(folderDateSchema).min(1),
    formats: z.array(battleTypeSchema).min(1),
  })).min(1),
  aliases: z.record(z.string(), nameSchema).default({}),
});

const choiceSchema = z.tuple([nameSchema, percentageSchema, rankSchema]);
const teammateSchema = z.tuple([nameSchema, rankSchema]);
const natureSchema = z.tuple([nameSchema, percentageSchema, z.string(), z.string(), rankSchema]);
const pointsSchema = z.tuple([
  percentageSchema,
  statPointSchema, statPointSchema, statPointSchema,
  statPointSchema, statPointSchema, statPointSchema,
  rankSchema,
]);

const pokemonSchema = z.object({
  position: rankSchema,
  move: z.array(choiceSchema),
  held_item: z.array(choiceSchema),
  ability: z.array(choiceSchema),
  teammate: z.array(teammateSchema),
  stat_alignment: z.array(natureSchema),
  stat_points: z.array(pointsSchema),
});

const snapshotSchema = z.object({
  season: seasonSchema,
  date: folderDateSchema,
  format: battleTypeSchema,
  generatedAt: generatedAtSchema,
  pokemon: z.record(nameSchema, pokemonSchema)
    .refine(value => Object.keys(value).length > 0, "Snapshot has no Pokémon records."),
});

const commonInputSchema = z.object({
  battleType: battleTypeSchema.default("Doubles"),
  season: seasonSchema.optional(),
  date: isoDateSchema.optional(),
});

const rankingInputSchema = commonInputSchema.extend({
  limit: z.number().int().min(1).max(100).default(20),
});

const pokemonInputSchema = commonInputSchema.extend({ pokemon: nameSchema });

type CommonInput = z.input<typeof commonInputSchema>;
export type ChampionsUsageInput = z.input<typeof rankingInputSchema>;
export type ChampionsPokemonUsageInput = z.input<typeof pokemonInputSchema>;

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Pokémon Champions Battle Data request failed with HTTP ${response.status}: ${url}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Pokémon Champions Battle Data returned invalid JSON: ${url}`);
  }
}

async function loadSnapshot(input: CommonInput) {
  const options = commonInputSchema.parse(input);
  const indexResult = indexSchema.safeParse(await fetchJson(INDEX_URL));
  if (!indexResult.success) {
    throw new Error(`Pokémon Champions Battle Data index has an unsupported shape: ${indexResult.error.message}`);
  }
  const index = indexResult.data;
  if (options.season && !index.seasons.some(value => value.season === options.season)) {
    throw new Error(`Champions ladder season ${options.season} is unavailable. Available seasons: ${index.seasons.map(value => value.season).join(", ")}.`);
  }

  const candidates = index.seasons
    .filter(value => (!options.season || value.season === options.season) && value.formats.includes(options.battleType))
    .flatMap(value => value.dates.map(date => ({ season: value.season, folderDate: date, date: folderDateToIso(date) })))
    .filter(value => !options.date || value.date === options.date)
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.season.slice(1)) - Number(a.season.slice(1)));
  const selected = candidates[0];
  if (!selected) {
    const scope = options.season ? ` in season ${options.season}` : "";
    const date = options.date ? ` for ${options.date}` : "";
    throw new Error(`No Champions ${options.battleType} snapshot${scope}${date} is available. Explicit season and date requests require an exact match.`);
  }

  const sourceUrl = `${PROVIDER_URL}/data/meta/${encodeURIComponent(selected.season)}/${encodeURIComponent(selected.folderDate)}/${options.battleType}.json`;
  const snapshotResult = snapshotSchema.safeParse(await fetchJson(sourceUrl));
  if (!snapshotResult.success) {
    throw new Error(`Pokémon Champions Battle Data snapshot has an unsupported shape: ${snapshotResult.error.message}`);
  }
  const snapshot = snapshotResult.data;
  if (snapshot.season !== selected.season || snapshot.date !== selected.folderDate || snapshot.format !== options.battleType) {
    throw new Error("Pokémon Champions Battle Data returned a snapshot for a different season, date, or battle type.");
  }

  return {
    index,
    snapshot,
    metadata: {
      source: "champions" as const,
      provider: "Pokémon Champions Battle Data",
      sourceUrl,
      attribution: ATTRIBUTION,
      season: selected.season,
      date: selected.date,
      battleType: options.battleType,
      generatedAt: snapshot.generatedAt,
      fetchedAt: new Date().toISOString(),
      regulation: null,
      note: DATA_NOTE,
    },
  };
}

function normalizedName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/♀/g, "f").replace(/♂/g, "m").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function resolvePokemon(input: string, names: string[], aliases: Record<string, string>): string | undefined {
  const normalized = normalizedName(input);
  const matches = new Set(names.filter(name => normalizedName(name) === normalized));
  for (const [alias, target] of Object.entries(aliases)) {
    if (normalizedName(alias) !== normalized) continue;
    for (const name of names) {
      if (normalizedName(name) === normalizedName(target)) matches.add(name);
    }
  }
  if (matches.size > 1) throw new Error(`Pokémon name ${input} is ambiguous in this Champions snapshot; use its exact species/form name.`);
  return [...matches][0];
}

function rankedChoices(values: z.infer<typeof choiceSchema>[]) {
  return values.map(([name, percent, rank]) => ({ rank, name, percent })).sort((a, b) => a.rank - b.rank);
}

export async function getChampionsUsage(input: ChampionsUsageInput = {}) {
  const options = rankingInputSchema.parse(input);
  const { snapshot, metadata } = await loadSnapshot(options);
  const rankings = Object.entries(snapshot.pokemon)
    .map(([pokemon, values]) => ({ rank: values.position, pokemon, usagePercent: null }))
    .sort((a, b) => a.rank - b.rank || a.pokemon.localeCompare(b.pokemon))
    .slice(0, options.limit);
  return { ...metadata, rankings };
}

export async function getChampionsPokemonUsage(input: ChampionsPokemonUsageInput) {
  const options = pokemonInputSchema.parse(input);
  const { index, snapshot, metadata } = await loadSnapshot(options);
  const pokemon = resolvePokemon(options.pokemon, Object.keys(snapshot.pokemon), index.aliases);
  if (!pokemon) {
    throw new Error(`No Champions usage record for ${options.pokemon} in ${metadata.battleType}, season ${metadata.season}, ${metadata.date}. Forms are matched exactly; query a base species explicitly if the provider groups its Mega Evolutions there.`);
  }
  const values = snapshot.pokemon[pokemon]!;
  const validSpreads = values.stat_points.filter(spread => {
    const points = spread.slice(1, 7);
    return points.every(point => point <= 32) && points.reduce((sum, point) => sum + point, 0) <= 66;
  });
  const omittedSpreads = values.stat_points.length - validSpreads.length;
  return {
    ...metadata,
    pokemon,
    rank: values.position,
    usagePercent: null,
    moves: rankedChoices(values.move),
    items: rankedChoices(values.held_item),
    abilities: rankedChoices(values.ability),
    teammates: values.teammate.map(([pokemon, rank]) => ({ rank, pokemon, percent: null })).sort((a, b) => a.rank - b.rank),
    natures: values.stat_alignment.map(([name, percent, statUp, statDown, rank]) => ({ rank, name, percent, statUp, statDown })).sort((a, b) => a.rank - b.rank),
    statPoints: validSpreads.map(([percent, hp, atk, def, spa, spd, spe, rank]) => ({ rank, percent, hp, atk, def, spa, spd, spe })).sort((a, b) => a.rank - b.rank),
    ...(omittedSpreads ? {
      warnings: [`Omitted ${omittedSpreads} upstream stat-point spread(s) exceeding 32 points per stat or 66 total points. Remaining percentages are the original shares and have not been renormalized.`],
    } : {}),
  };
}
