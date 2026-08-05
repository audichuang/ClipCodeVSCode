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

// Kotlin's \s is ASCII-only. If this side used JS \s, CJK text separated by a
// full-width space would count as 2 words here and 1 in IntelliJ, so the same
// payload would report different token counts in the two tools.
test('splits on ASCII whitespace only, like the Kotlin side', () => {
  assert.equal(estimateTokens('\u4E2D\u3000\u6587'), 1);   // U+3000 ideographic space
  assert.equal(estimateTokens('a\u00A0b'), 1);             // NBSP
  assert.equal(estimateTokens('a b'), 2);                  // plain space still splits
});

test('adds structural punctuation to the word count', () => {
  // one word "foo(bar);" + 3 punctuation marks ( ) ;
  assert.equal(estimateTokens('foo(bar);'), 4);
  // three words + two commas
  assert.equal(estimateTokens('a, b, c'), 5);
});
