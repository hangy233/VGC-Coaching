// Static reads only. Executable Champions fields come from the project's pinned
// Showdown mod; prose is separately attributed to the base @pkmn/dex dataset.
import PS from 'pokemon-showdown';
import {Dex as DescriptionDex} from '@pkmn/dex';

export const CHAMPIONS_STATIC_FORMAT = 'gen9championsvgc2026regmc';
const champions = PS.Dex.forFormat(CHAMPIONS_STATIC_FORMAT);
const baseline = PS.Dex.forGen(9);
const descriptiveKeys = new Set(['name', 'id', 'fullname', 'effectType', 'exists', 'num', 'gen',
  'isNonstandard', 'shortDesc', 'desc', 'rating', 'sourceEffect']);
const object = value => value !== null && typeof value === 'object';
const requestedName = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('A bounded static-data name is required.');
  }
  return value.trim();
};
const copy = value => JSON.parse(JSON.stringify(value));
const source = () => ({engine: 'pinned pokemon-showdown', format: CHAMPIONS_STATIC_FORMAT,
  mod: champions.currentMod, generationParameter: 0, executableGeneration: champions.gen,
  scope: 'static-format-data; not a current battle observation or a legality verdict'});

function comparable(value, seen = new Set()) {
  if (typeof value === 'function') return {$callback: String(value)};
  if (value === undefined) return {$undefined: true};
  if (!object(value)) return value;
  if (seen.has(value)) return {$circular: true};
  seen.add(value);
  const result = Array.isArray(value) ? value.map(item => comparable(item, seen)) :
    Object.fromEntries(Object.keys(value).sort().map(key => [key, comparable(value[key], seen)]));
  seen.delete(value);
  return result;
}

function descriptions(kind, entry) {
  const ordinary = baseline[kind].get(entry.id), prose = DescriptionDex[kind].get(entry.id);
  const differingExecutableFields = ordinary.exists ? [...new Set([...Object.keys(entry), ...Object.keys(ordinary)])]
    .filter(key => !descriptiveKeys.has(key) && JSON.stringify(comparable(entry[key])) !== JSON.stringify(comparable(ordinary[key])))
    .sort() : null;
  const available = prose?.exists === true && typeof prose.desc === 'string' && prose.desc.length > 0;
  const differs = differingExecutableFields === null || differingExecutableFields.length > 0;
  return {
    shortDesc: prose?.exists === true && prose.shortDesc ? prose.shortDesc : null,
    desc: available ? prose.desc : null,
    descriptionSource: {
      dataset: '@pkmn/dex', generation: 9, scope: 'base-generation-prose',
      status: !available ? 'unavailable' : differs ? 'base-prose-with-champions-overrides' : 'base-prose-with-unchanged-pinned-entry',
      championsExecutableDiffersFromBase: differs, differingExecutableFields,
      limitation: !available ? 'No full description is available in the base dataset; custom or scripted effects remain undescribed. No description was invented.' :
        differs ? 'This is the base description, not verified prose for the Champions overrides. Use the pinned executable fields below; undocumented custom/scripted differences remain unknown.' :
          'Base prose supplements the unchanged pinned entry; it does not establish current activation, suppression, recipients or battle state.',
    },
  };
}

export function getChampionsPokemon(name) {
  const entry = champions.species.get(requestedName(name));
  if (!entry.exists) return null;
  return {name: entry.name, types: [...entry.types], bs: {...entry.baseStats},
    ability: entry.abilities['0'] ?? null, abilities: {...entry.abilities}, weight: entry.weightkg,
    baseSpecies: entry.baseSpecies, forme: entry.forme, isMega: entry.isMega === true,
    requiredItem: entry.requiredItem ?? null, isNonstandard: entry.isNonstandard ?? null,
    source: source(), limitation: 'Registered form abilities are static data; this does not reveal a current ability, suppression, investment, selected reserve or format eligibility.'};
}

export function getChampionsMove(name) {
  const entry = champions.moves.get(requestedName(name));
  if (!entry.exists) return null;
  const effects = {};
  for (const key of ['drain', 'recoil', 'heal', 'multihit', 'multiaccuracy', 'secondary', 'secondaries',
    'self', 'boosts', 'status', 'volatileStatus', 'selfSwitch', 'forceSwitch', 'damage', 'critRatio',
    'ignoreAbility', 'ignoreImmunity', 'ignoreDefensive', 'ignoreNegativeOffensive', 'ignorePositiveDefensive']) {
    if (entry[key] !== undefined) effects[key] = copy(entry[key]);
  }
  return {name: entry.name, type: entry.type, category: entry.category, basePower: entry.basePower,
    accuracy: entry.accuracy === true ? 'Always hits' : entry.accuracy, pp: entry.pp,
    priority: entry.priority, target: entry.target, flags: {...entry.flags}, makesContact: Boolean(entry.flags.contact),
    effects, scriptedCallbacks: Object.keys(entry).filter(key => typeof entry[key] === 'function').sort(),
    ...descriptions('moves', entry), isNonstandard: entry.isNonstandard ?? null, source: source(),
    limitation: 'Fields describe the pinned move before current-board modifiers. Conditional priority, contact changes, ability effects and target eligibility still depend on actual battle state.'};
}

export function getChampionsAbility(name) {
  const entry = champions.abilities.get(requestedName(name));
  if (!entry.exists) return null;
  return {name: entry.name, flags: {...entry.flags}, suppressWeather: entry.suppressWeather === true,
    scriptedCallbacks: Object.keys(entry).filter(key => typeof entry[key] === 'function').sort(),
    ...descriptions('abilities', entry), isNonstandard: entry.isNonstandard ?? null, source: source(),
    limitation: 'This is static ability data, not evidence that a Pokemon currently has or can activate it. Base prose is explicitly qualified when Champions executable callbacks differ.'};
}

export function getChampionsMovepool(name) {
  const entry = champions.species.get(requestedName(name));
  if (!entry.exists) return null;
  const learnsets = champions.species.getFullLearnset(entry.id);
  if (!learnsets.length) return {name: entry.name, moves: [], moveIds: [], learnsetSpecies: [],
    source: source(), learnsetScope: 'pinned-format-learnset-union', legalityChecked: false,
    limitation: 'No learnset data was found. An empty list is not proof that this form has no legal moves.'};
  const moveIds = [...new Set(learnsets.flatMap(record => Object.keys(record.learnset)))].sort();
  const moves = moveIds.map(id => champions.moves.get(id)).map((move, index) => move.exists ? move.name : moveIds[index]).sort();
  return {name: entry.name, moves, moveIds,
    learnsetSpecies: learnsets.map(record => record.species.name),
    unresolvedMoveIds: moveIds.filter(id => !champions.moves.get(id).exists),
    source: source(), learnsetScope: 'pinned-format-learnset-union', legalityChecked: false,
    limitation: 'Union of the pinned format learnsets and its form/base inheritance. This is not full set or combination legality, registration eligibility, a selected four, or proof of a current moveset; validate complete sets/teams separately.'};
}
