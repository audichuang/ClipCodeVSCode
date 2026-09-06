import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens, payloadStats } from '../src/copy.js';

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

// chars/lines/words come off the SAME scan and must mirror TokenEstimator.stats.
// The golden fixture pins the exact values; these spell out the intent locally.
test('counts characters as UTF-16 code units, like Kotlin String.length', () => {
  assert.equal(payloadStats('abc').chars, 3);
  assert.equal(payloadStats('\u4E2D\u6587').chars, 2);
  assert.equal(payloadStats('\uD83D\uDC4D').chars, 2);  // astral char = 2 units on both sides
});

test('counts lines as newline count + 1, and 0 for empty text', () => {
  assert.equal(payloadStats('').lines, 0);
  assert.equal(payloadStats('one line').lines, 1);
  assert.equal(payloadStats('a\nb').lines, 2);
  assert.equal(payloadStats('a\nb\n').lines, 3);      // trailing newline opens a final empty line
  assert.equal(payloadStats('a\r\nb\rc').lines, 2);   // CRLF breaks once, a lone CR not at all
});

test('words is the token count without the punctuation bonus', () => {
  assert.equal(payloadStats('foo(bar);').words, 1);
  assert.equal(payloadStats('foo(bar);').tokens, 4);
  assert.equal(payloadStats('a, b, c').words, 3);
});
