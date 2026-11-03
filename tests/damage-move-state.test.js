import assert from 'node:assert/strict';
import test from 'node:test';
import PS from 'pokemon-showdown';
import {Move} from '@smogon/calc';
import {resolveChampionsDamageMoveState} from '../mechanics/damage-move-state.mjs';

const resolve = alliesFainted => resolveChampionsDamageMoveState({gen: 0, move: 'Last Respects', attackerOptions: {alliesFainted}});

test('Champions Last Respects uses the pinned callback for each supported explicit faint total', () => {
  const entry = PS.Dex.forFormat('gen9championsvgc2026regmc').moves.get('Last Respects');
  for (const alliesFainted of [0, 1, 2, 3, 4, 5]) {
    const state = resolve(alliesFainted);
    assert.equal(state.moveOptions.overrides.basePower, entry.basePowerCallback({side: {totalFainted: alliesFainted}}));
    assert.equal(state.projection.alliesFainted, alliesFainted);
    assert.equal(state.projection.source.callback, 'lastrespects.basePowerCallback');
    assert.equal(state.projection.source.generationParameter, 0);
  }
  assert.equal(resolve(0).moveOptions.overrides.basePower, 50);
  assert.equal(resolve(3).moveOptions.overrides.basePower, 200);
});

test('the host-owned Last Respects projection survives the calculator Move clone', () => {
  const input = {gen: 0, move: 'Last Respects', attackerOptions: {alliesFainted: 3}};
  const before = structuredClone(input), state = resolveChampionsDamageMoveState(input);
  const move = new Move(0, input.move, {ability: 'Adaptability', ...state.moveOptions});
  assert.equal(move.bp, state.projection.basePower);
  assert.equal(move.clone().bp, state.projection.basePower);
  assert.deepEqual(input, before);
});

test('missing, unknown and unsupported faint totals refuse rather than imply zero', () => {
  for (const alliesFainted of [undefined, null, NaN, -1, 6, 1.5, '3']) {
    assert.throws(() => resolve(alliesFainted), /requires explicit attackerOptions.alliesFainted/);
  }
  assert.throws(() => resolveChampionsDamageMoveState({gen: 0, move: 'Last Respects'}), /requires explicit/);
});

test('ordinary moves and other generation paths receive no state projection', () => {
  for (const alliesFainted of [undefined, 0, 3]) {
    for (const move of ['Shadow Claw', 'Kowtow Cleave', 'Electro Shot']) {
      assert.equal(resolveChampionsDamageMoveState({gen: 0, move, attackerOptions: {ability: 'Supreme Overlord', alliesFainted}}), null);
    }
  }
  assert.equal(resolveChampionsDamageMoveState({gen: 9, move: 'Last Respects'}), null);
});
