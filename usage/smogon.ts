const STATS_URL = "https://www.smogon.com/stats/";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_MONTHS_TO_SEARCH = 12;

export interface SmogonUsageOptions {
  format: string;
  month?: string;
  rating?: number;
  limit?: number;
}

export interface SmogonPokemonUsageOptions {
  pokemon: string;
  format: string;
  month?: string;
  rating?: number;
}

interface Dataset {
  source: "smogon";
  sourceUrl: string;
  format: string;
  month: string;
  rating: number;
  fetchedAt: string;
  totalBattles?: number;
  warnings?: string[];
  text: string;
}

export interface SmogonRanking {
  rank: number;
  pokemon: string;
  usagePercent: number;
}

export interface SmogonUsageResult extends Omit<Dataset, "text"> {
  available: true;
  rankings: SmogonRanking[];
}

export interface SmogonPokemonUsageResult extends Omit<Dataset, "text"> {
  available: boolean;
  pokemon: string;
  report: string | null;
  message?: string;
}

function validateOptions(options: SmogonUsageOptions): void {
  if (!/^[a-z0-9]+$/.test(options.format)) {
    throw new Error("Smogon format must be a Showdown format ID containing lowercase letters and digits.");
  }
  if (options.month !== undefined && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(options.month)) {
    throw new Error("Smogon month must use YYYY-MM with a valid month.");
  }
  if (options.rating !== undefined && (!Number.isSafeInteger(options.rating) || options.rating < 0)) {
    throw new Error("Smogon rating must be a nonnegative integer.");
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
    throw new Error("Smogon limit must be a positive integer.");
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    return await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not fetch Smogon data at ${url}: ${message}`);
  }
}

async function publishedMonths(month?: string): Promise<string[]> {
  if (month !== undefined) return [month];
  const index = await fetchText(STATS_URL);
  if (index === null) throw new Error(`Smogon's published-month index is unavailable at ${STATS_URL}.`);
  const months = Array.from(index.matchAll(/href\s*=\s*["'](\d{4}-(?:0[1-9]|1[0-2]))\/["']/gi), match => match[1]!);
  const latest = Array.from(new Set(months)).sort().reverse().slice(0, MAX_MONTHS_TO_SEARCH);
  if (!latest.length) throw new Error(`No published usage months were found at ${STATS_URL}.`);
  return latest;
}

function totalBattles(text: string): number | undefined {
  const match = /^Total battles:\s*([\d,]+)/m.exec(text);
  return match ? Number(match[1]!.replace(/,/g, "")) : undefined;
}

async function findDataset(options: SmogonUsageOptions, kind: "usage" | "moveset"): Promise<Dataset> {
  validateOptions(options);
  const months = await publishedMonths(options.month);
  const ratings = options.rating === undefined ? [1760, 0] : [options.rating];
  for (const month of months) {
    for (const rating of ratings) {
      const sourceUrl = `${STATS_URL}${month}/${kind === "moveset" ? "moveset/" : ""}${options.format}-${rating}.txt`;
      const text = await fetchText(sourceUrl);
      if (text === null) continue;
      const battles = totalBattles(text);
      return {
        source: "smogon",
        sourceUrl,
        format: options.format,
        month,
        rating,
        fetchedAt: new Date().toISOString(),
        ...(battles === undefined ? {} : { totalBattles: battles }),
        ...(options.rating === undefined && rating === 0 ? {
          warnings: ["The rating-1760 report is unavailable for this month; this report uses rating 0 (all Showdown ladder ratings)."],
        } : {}),
        text,
      };
    }
  }
  throw new Error(`Smogon ${kind === "moveset" ? "moveset" : "usage"} data is unavailable for ${options.format}, rating ${ratings.join(" or ")}, in ${months.join(", ")}. Missing data does not mean zero usage.`);
}

export async function getSmogonUsage(options: SmogonUsageOptions): Promise<SmogonUsageResult> {
  const { text, ...metadata } = await findDataset(options, "usage");
  const rankings: SmogonRanking[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([\d.]+)%\s*\|/.exec(line);
    if (match) {
      rankings.push({ rank: Number(match[1]), pokemon: match[2]!.trim(), usagePercent: Number(match[3]) });
    }
  }
  if (!rankings.length) throw new Error(`Smogon returned an unrecognized usage report at ${metadata.sourceUrl}.`);
  return { ...metadata, available: true, rankings: rankings.slice(0, options.limit ?? 20) };
}

function pokemonId(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/♀/g, "f").replace(/♂/g, "m").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function getSmogonPokemonUsage(options: SmogonPokemonUsageOptions): Promise<SmogonPokemonUsageResult> {
  const requestedId = pokemonId(options.pokemon);
  if (!requestedId) throw new Error("A Pokémon name is required for Smogon moveset usage.");
  const { text, ...metadata } = await findDataset(options, "moveset");
  const lines = text.split(/\r?\n/);
  const headers: { index: number; pokemon: string }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const name = /^\|\s*([^|]+?)\s*\|$/.exec(lines[index]!);
    if (name && /^\+-{3,}\+\s*$/.test(lines[index - 1] ?? "") &&
      lines.slice(index + 1, index + 5).some(line => /^\|\s*Raw count:/.test(line))) {
      headers.push({ index, pokemon: name[1]!.trim() });
    }
  }
  if (!headers.length) throw new Error(`Smogon returned an unrecognized moveset report at ${metadata.sourceUrl}.`);
  const foundIndex = headers.findIndex(header => pokemonId(header.pokemon) === requestedId);
  if (foundIndex < 0) {
    return {
      ...metadata,
      available: false,
      pokemon: options.pokemon,
      report: null,
      message: `${options.pokemon} is not listed in this Smogon moveset dataset. Its absence does not establish zero usage; no older month or different rating was substituted.`,
    };
  }
  const header = headers[foundIndex]!;
  const nextHeader = headers[foundIndex + 1];
  const report = lines.slice(header.index - 1, nextHeader ? nextHeader.index - 1 : lines.length).join("\n").trim();
  return { ...metadata, available: true, pokemon: header.pokemon, report };
}
