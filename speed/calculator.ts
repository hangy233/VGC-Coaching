import { z } from 'zod';
// The pinned Showdown dependency supplies Champions stat and action-Speed mechanics.
// @ts-ignore pokemon-showdown's published entry has no declaration file.
import PS from 'pokemon-showdown';

const { Battle, Dex } = (PS as any).default || PS;
const FORMAT = 'gen9championsvgc2026regmc';
const dex = Dex.forFormat(FORMAT);
const statNames = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const boostNames = ['atk', 'def', 'spa', 'spd', 'spe'] as const;
const point = z.number().int().min(0).max(32);
const stage = z.number().int().min(-6).max(6);
const pointsSchema = z.strictObject({
  hp: point.optional(), atk: point.optional(), def: point.optional(),
  spa: point.optional(), spd: point.optional(), spe: point.optional(),
}).refine(points => Object.values(points).reduce<number>((sum, value) => sum + (value ?? 0), 0) <= 66,
  'Champions allows at most 66 stat points in total');
const boostsSchema = z.strictObject({
  atk: stage.optional(), def: stage.optional(), spa: stage.optional(),
  spd: stage.optional(), spe: stage.optional(),
});

export const speedPokemonSchema = z.strictObject({
  label: z.string().trim().min(1).max(80).optional().describe('Unique label for this comparison entry'),
  species: z.string().trim().min(1).max(80).describe('Current form, e.g. Swampert-Mega; no automatic Mega Evolution'),
  nature: z.string().trim().min(1).max(30).describe('Explicit nature, e.g. Jolly'),
  statPoints: pointsSchema.default({}).describe('Native Champions stat points, 0–32 per stat, total at most 66; omitted stats are zero'),
  ability: z.string().trim().min(1).max(80).describe('Current effective ability, e.g. Swift Swim'),
  item: z.string().trim().max(80).default('').describe('Currently held item; empty means no item'),
  boosts: boostsSchema.default({}).describe('Current stat stages; omitted stages are zero'),
  status: z.enum(['', 'brn', 'par', 'psn', 'tox', 'slp', 'frz']).default(''),
  tailwind: z.boolean().default(false).describe('Tailwind is currently active on this Pokémon’s side'),
  abilitySuppressed: z.boolean().default(false).describe('Current ability is suppressed as by Gastro Acid; unsuppressible abilities are rejected'),
  itemSuppressed: z.boolean().default(false).describe('Current held item is suppressed as by Embargo'),
  unburdenActive: z.boolean().optional().describe('Required for Unburden: whether its item-loss activation is still active; active requires no held item'),
  slowStartActive: z.boolean().optional().describe('Required for Slow Start: whether its five-turn penalty is still active'),
  boosterEnergyActive: z.boolean().optional().describe('Required for Protosynthesis/Quark Drive: whether a consumed Booster Energy activation is active; true requires no held item'),
});

export const speedFieldSchema = z.strictObject({
  weather: z.enum(['', 'Sun', 'Rain', 'Sand', 'Snow', 'Harsh Sunshine', 'Heavy Rain', 'Strong Winds']).default(''),
  terrain: z.enum(['', 'Electric', 'Grassy', 'Misty', 'Psychic']).default(''),
  trickRoom: z.boolean().default(false),
  magicRoom: z.boolean().default(false),
  weatherSuppressed: z.boolean().default(false).describe('An external Cloud Nine/Air Lock effect suppresses weather'),
});

export const speedInputSchema = z.strictObject({
  pokemon: z.array(speedPokemonSchema).min(1).max(6).describe('One to six independent current-state snapshots to compare'),
  field: speedFieldSchema.default({ weather: '', terrain: '', trickRoom: false, magicRoom: false, weatherSuppressed: false }),
  gen: z.literal(0).default(0).describe('Native Pokémon Champions mode only; level 50 and all IVs 31'),
});
type SpeedInput = z.infer<typeof speedInputSchema>;
type SpeedPokemon = z.infer<typeof speedPokemonSchema>;
type SpeedField = z.infer<typeof speedFieldSchema>;

const weatherIds = {
  '': '', Sun: 'sunnyday', Rain: 'raindance', Sand: 'sandstorm', Snow: 'snow',
  'Harsh Sunshine': 'desolateland', 'Heavy Rain': 'primordialsea', 'Strong Winds': 'deltastream',
};
const terrainIds = { '': '', Electric: 'electricterrain', Grassy: 'grassyterrain', Misty: 'mistyterrain', Psychic: 'psychicterrain' };
const orderItems = new Set(['quickclaw', 'custapberry', 'laggingtail', 'fullincense']);
const orderAbilities = new Set(['stall', 'myceliummight', 'quickdraw']);
const limits = [
  'Compares Speed only within the same move-priority bracket. Priority, Quick Claw/Custap Berry, Lagging Tail/Full Incense, Stall/Mycelium Might/Quick Draw, Quash, After You, and move-dependent ordering are not resolved.',
  'Each entry is calculated independently under the supplied field. Entries are not assumed to be simultaneous active allies/opponents; supply external weather suppression explicitly.',
  'Uses current forms, abilities, held items, status and boosts as supplied. It does not simulate switching, Mega Evolution, item consumption, end-of-turn changes, Transform, or validate a complete legal team.',
  'Protosynthesis/Quark Drive select their boosted stat from the supplied snapshot at activation. An already active boost chosen under a different earlier stat distribution is unsupported.',
];

function canonicalEntry(entry: SpeedPokemon) {
  const species = dex.species.get(entry.species);
  if (!species.exists) throw new Error(`Unknown species: ${entry.species}`);
  const nature = dex.natures.get(entry.nature);
  if (!nature.exists) throw new Error(`Unknown nature: ${entry.nature}`);
  const ability = dex.abilities.get(entry.ability);
  if (!ability.exists) throw new Error(`Unknown ability: ${entry.ability}`);
  const item = entry.item ? dex.items.get(entry.item) : undefined;
  if (item && !item.exists) throw new Error(`Unknown item: ${entry.item}`);
  if (entry.abilitySuppressed && ability.flags.cantsuppress) {
    throw new Error(`${ability.name} cannot be suppressed`);
  }
  if (ability.id === 'unburden') {
    if (entry.unburdenActive === undefined) throw new Error('Specify unburdenActive for Unburden');
    if (entry.unburdenActive && item) throw new Error('Active Unburden requires no currently held item');
  } else if (entry.unburdenActive !== undefined) {
    throw new Error('unburdenActive is only valid with Unburden');
  }
  if (ability.id === 'slowstart') {
    if (entry.slowStartActive === undefined) throw new Error('Specify slowStartActive for Slow Start');
  } else if (entry.slowStartActive !== undefined) {
    throw new Error('slowStartActive is only valid with Slow Start');
  }
  if (['protosynthesis', 'quarkdrive'].includes(ability.id)) {
    if (entry.boosterEnergyActive === undefined) throw new Error('Specify boosterEnergyActive for Protosynthesis/Quark Drive');
    if (entry.boosterEnergyActive && item) throw new Error('A consumed Booster Energy activation requires no currently held item');
    if (item?.id === 'boosterenergy') {
      throw new Error('Booster Energy consumption is not simulated; provide the post-activation snapshot with item empty and boosterEnergyActive true, or a weather/terrain activation with no Booster Energy held');
    }
  } else if (entry.boosterEnergyActive !== undefined) {
    throw new Error('boosterEnergyActive is only valid with Protosynthesis/Quark Drive');
  }
  return { species, nature, ability, item };
}

function calculateEntry(entry: SpeedPokemon, field: SpeedField, index: number) {
  const { species, nature, ability, item } = canonicalEntry(entry);
  const points = Object.fromEntries(statNames.map(name => [name, entry.statPoints[name] ?? 0]));
  const boosts = Object.fromEntries(boostNames.map(name => [name, entry.boosts[name] ?? 0]));
  const neutral = (suppressWeather = false) => ({
    species: 'Magikarp', level: 50, nature: 'Serious',
    ability: suppressWeather ? 'Cloud Nine' : 'No Ability', moves: ['Protect'],
    evs: {}, ivs: Object.fromEntries(statNames.map(name => [name, 31])),
  });
  const battle = new Battle({
    formatid: FORMAT, seed: [1, 2, 3, 4],
    p1: { name: 'Speed snapshot', team: [{
      species: species.name, level: 50, nature: nature.name,
      ability: ability.name, item: item?.name ?? '', evs: points,
      ivs: Object.fromEntries(statNames.map(name => [name, 31])), moves: ['Protect'],
    }, neutral()] },
    p2: { name: 'Neutral context', team: [neutral(field.weatherSuppressed), neutral()] },
  });
  try {
    // Activate snapshot occupants without simulating switch-in effects. Stat points,
    // stat stages, modifier rounding and Trick Room ordering remain engine-owned.
    for (const side of battle.sides) {
      for (let slot = 0; slot < 2; slot++) {
        side.active[slot] = side.pokemon[slot];
        side.pokemon[slot].isActive = true;
        side.pokemon[slot].position = slot;
      }
    }
    const pokemon = battle.p1.active[0];
    pokemon.boosts = { ...pokemon.boosts, ...boosts };
    pokemon.status = entry.status;
    pokemon.statusState = battle.initEffectState({ id: entry.status, target: pokemon });
    if (entry.itemSuppressed) pokemon.addVolatile('embargo', pokemon);
    if (field.magicRoom) battle.field.addPseudoWeather('magicroom', pokemon);
    if (entry.abilitySuppressed && !pokemon.addVolatile('gastroacid', pokemon)) {
      throw new Error(`The native engine rejected ability suppression for ${species.name}; check Ability Shield and suppression state`);
    }
    if (field.weather) battle.field.setWeather(weatherIds[field.weather], pokemon);
    if (field.terrain) battle.field.setTerrain(terrainIds[field.terrain], pokemon);
    if (field.trickRoom) battle.field.addPseudoWeather('trickroom', pokemon);
    if (entry.tailwind) pokemon.side.addSideCondition('tailwind', pokemon);
    if (entry.unburdenActive) pokemon.addVolatile('unburden', pokemon);
    if (ability.id === 'slowstart' && entry.slowStartActive) {
      battle.singleEvent('Start', ability, pokemon.abilityState, pokemon);
    }
    if (['protosynthesis', 'quarkdrive'].includes(ability.id) && !pokemon.ignoringAbility()) {
      if (entry.boosterEnergyActive) {
        pokemon.addVolatile(ability.id, pokemon, dex.items.get('Booster Energy'));
      } else {
        battle.singleEvent('Start', ability, pokemon.abilityState, pokemon);
      }
    }
    const orderingWarnings = [];
    if (item && orderItems.has(item.id) && !pokemon.ignoringItem()) {
      orderingWarnings.push(`${item.name} can change actual move order independently of Speed`);
    }
    if (orderAbilities.has(ability.id) && !pokemon.ignoringAbility()) {
      orderingWarnings.push(`${ability.name} can change actual move order independently of Speed`);
    }
    const activation = pokemon.volatiles.protosynthesis || pokemon.volatiles.quarkdrive;
    return {
      index, label: entry.label ?? `${species.name} (${index + 1})`, species: species.name,
      nature: nature.name, ability: ability.name, item: item?.name ?? '',
      level: 50, ivs: Object.fromEntries(statNames.map(name => [name, 31])), statPoints: points,
      boosts, status: entry.status, tailwind: entry.tailwind,
      rawStats: { hp: pokemon.maxhp, ...pokemon.storedStats },
      rawSpeed: pokemon.storedStats.spe as number,
      effectiveSpeed: pokemon.getStat('spe', false, false) as number,
      actionSpeed: pokemon.getActionSpeed() as number,
      effectiveWeather: battle.field.effectiveWeather(),
      abilitySuppressed: pokemon.ignoringAbility() as boolean,
      itemSuppressed: Boolean(item && pokemon.ignoringItem()),
      abilityState: {
        ...(ability.id === 'unburden' ? { unburdenActive: Boolean(pokemon.volatiles.unburden) } : {}),
        ...(ability.id === 'slowstart' ? { slowStartActive: Boolean(pokemon.abilityState.counter) } : {}),
        ...(activation ? { boostedStat: activation.bestStat, boosterEnergyActive: Boolean(activation.fromBooster) } : {}),
      },
      orderingWarnings,
    };
  } finally {
    battle.destroy();
  }
}

export function calculateSpeed(input: unknown) {
  const parsed: SpeedInput = speedInputSchema.parse(input);
  const labels = parsed.pokemon.map((entry, index) => entry.label ?? `${entry.species} (${index + 1})`);
  if (new Set(labels).size !== labels.length) throw new Error('Comparison labels must be unique');
  const results = parsed.pokemon.map((entry, index) => calculateEntry(entry, parsed.field, index));
  const sorted = [...results].sort((a, b) => b.actionSpeed - a.actionSpeed);
  const order: Array<{ rank: number; effectiveSpeed: number; labels: string[]; tie: boolean }> = [];
  for (const result of sorted) {
    const previous = order[order.length - 1];
    if (previous && previous.effectiveSpeed === result.effectiveSpeed) {
      previous.labels.push(result.label);
      previous.tie = true;
    } else {
      order.push({ rank: order.length + 1, effectiveSpeed: result.effectiveSpeed, labels: [result.label], tie: false });
    }
  }
  return {
    engine: 'pokemon-showdown native Champions M-C simulation', format: FORMAT, gen: 0,
    field: parsed.field, scope: 'Speed order within the same move-priority bracket; rank 1 acts first',
    tiePolicy: 'Equal effective Speed is an unresolved Speed tie; input order does not choose a winner',
    assumptions: ['Level 50; every IV is 31', 'Omitted stat points and stat stages are zero; omitted held item means no held item', 'Current field and conditional ability states are supplied snapshots, not inferred from team preview'],
    limitations: limits, pokemon: results, order,
  };
}
