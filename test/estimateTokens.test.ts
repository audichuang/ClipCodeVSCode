import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens } from '../src/copy.js';

// Mirrors the IntelliJ ClipCode heuristic: word count + structural punctuation.
test('empty string has no tokens', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('   \n  '), 0);
});

test('counts whitespace-separated words', () => {
  assert.equal(estimateTokens('hello world'), 2);
});

test('adds structural punctuation to the word count', () => {
  // one word "foo(bar);" + 3 punctuation marks ( ) ;
  assert.equal(estimateTokens('foo(bar);'), 4);
  // three words + two commas
  assert.equal(estimateTokens('a, b, c'), 5);
});
