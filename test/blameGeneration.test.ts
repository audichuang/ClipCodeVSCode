import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationGate } from '../src/blame/blameGeneration.js';

test('current defaults to 0 and bump increments monotonically', () => {
  const gate = new GenerationGate();
  assert.equal(gate.current('a'), 0);
  assert.equal(gate.bump('a'), 1);
  assert.equal(gate.bump('a'), 2);
  assert.equal(gate.current('a'), 2);
  // Independent keys don't interfere with each other.
  assert.equal(gate.current('b'), 0);
});

test('isCurrent reflects whether a captured generation is still latest', () => {
  const gate = new GenerationGate();
  const generation = gate.bump('editor-1'); // e.g. enable
  assert.ok(gate.isCurrent('editor-1', generation));
  gate.bump('editor-1'); // e.g. disable
  assert.ok(!gate.isCurrent('editor-1', generation));
});

test('disable after an in-flight render started makes that render stale', () => {
  // Simulates: enable -> render captures generation -> disable (before render
  // finishes) -> render's stale check must now fail so it does not
  // resurrect decorations after the user turned blame off.
  const gate = new GenerationGate();
  const key = 'file:///a.ts::1';

  const enableGeneration = gate.bump(key); // toggle on
  const capturedByInFlightRender = gate.current(key);
  assert.equal(capturedByInFlightRender, enableGeneration);

  gate.bump(key); // toggle off, while the render above is still awaiting blame

  // The in-flight render re-checks staleness right before applying decorations.
  assert.ok(!gate.isCurrent(key, capturedByInFlightRender), 'stale render must not apply');
});
