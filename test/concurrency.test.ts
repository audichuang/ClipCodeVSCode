import assert from 'node:assert/strict';
import test from 'node:test';
import { mapInOrder } from '../src/concurrency.js';

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of gen) out.push(value);
  return out;
}

test('mapInOrder yields results in input order regardless of finish time', async () => {
  // Earlier items resolve slower than later ones — output must still be in order.
  const out = await collect(mapInOrder([10, 1, 8, 2, 6], 3, async n => {
    await new Promise(resolve => setTimeout(resolve, n));
    return n * 2;
  }));
  assert.deepEqual(out, [20, 2, 16, 4, 12]);
});

test('mapInOrder never runs more than `concurrency` tasks at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await collect(mapInOrder(Array.from({ length: 12 }, (_, i) => i), 4, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 3));
    inFlight--;
  }));
  assert.ok(maxInFlight <= 4, `max in-flight ${maxInFlight} exceeded the limit of 4`);
  assert.ok(maxInFlight >= 2, `expected real concurrency, got ${maxInFlight}`);
});

test('mapInOrder treats concurrency < 1 as sequential', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await collect(mapInOrder([1, 2, 3], 0, async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 2));
    inFlight--;
  }));
  assert.equal(maxInFlight, 1);
});
