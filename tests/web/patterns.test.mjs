// web/lib/patterns.js must return exactly what lib/pipeline/regex_stripper.py returns.
// Expected outputs: tests/web/fixtures/patterns.json, written by scripts/web_fixtures_patterns.py.
//
//   node --test tests/web/patterns.test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

import { stripPatterns } from '../../web/lib/patterns.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/patterns.json', import.meta.url), 'utf8'));
const SHOW = 5; // mismatches printed in full

const short = (value, max = 160) => {
  const s = JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}...` : s;
};

const tokenLine = (t) => (t ? `${t.type} ${t.value} ${short(t.original, 60)} @${t.start}-${t.end} (${t.confidence})` : '(none)');

/** A readable account of how got differs from expected. */
function describe(item, got) {
  const { expected } = item;
  const lines = [`${item.id}  input: ${short(item.input)}`];
  if (got.text !== expected.text) {
    let i = 0;
    while (i < got.text.length && got.text[i] === expected.text[i]) i += 1;
    const from = Math.max(0, i - 40);
    lines.push(`  text differs at ${i}:`);
    lines.push(`    got      ${short(got.text.slice(from, i + 80), 200)}`);
    lines.push(`    expected ${short(expected.text.slice(from, i + 80), 200)}`);
  }
  if (got.senderName !== expected.senderName) {
    lines.push(`  senderName: got ${short(got.senderName)}, expected ${short(expected.senderName)}`);
  }
  const n = Math.max(got.tokens.length, expected.tokens.length);
  let shown = 0;
  for (let k = 0; k < n && shown < 6; k += 1) {
    if (!isDeepStrictEqual(got.tokens[k], expected.tokens[k])) {
      lines.push(`  token ${k}: got      ${tokenLine(got.tokens[k])}`);
      lines.push(`  ${' '.repeat(String(k).length + 7)}expected ${tokenLine(expected.tokens[k])}`);
      shown += 1;
    }
  }
  if (got.tokens.length !== expected.tokens.length) {
    lines.push(`  ${got.tokens.length} tokens, expected ${expected.tokens.length}`);
  }
  return lines.join('\n');
}

test('fixture was generated in the mode the port implements', () => {
  assert.equal(fixture.meta.phoneMode, 'phonenumbers');
  assert.ok(fixture.cases.length > 1000, `only ${fixture.cases.length} cases`);
});

const groups = new Map();
for (const item of fixture.cases) {
  const group = item.source.startsWith('synthetic:') ? item.source : item.source.split(':')[0];
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(item);
}

for (const [group, items] of groups) {
  test(`same output as Python: ${group} (${items.length} texts)`, () => {
    const failures = [];
    for (const item of items) {
      const got = stripPatterns(item.input);
      if (!isDeepStrictEqual(got, item.expected)) failures.push(describe(item, got));
    }
    if (failures.length) {
      assert.fail(
        `${failures.length} of ${items.length} texts differ from Python\n\n`
        + failures.slice(0, SHOW).join('\n\n')
        + (failures.length > SHOW ? `\n\n... and ${failures.length - SHOW} more` : ''),
      );
    }
  });
}

test('counters start again on every call', () => {
  const text = 'Mail a@example.com or call +44 7700 900123.';
  const first = stripPatterns(text);
  assert.deepEqual(stripPatterns(text), first);
  assert.equal(first.text, 'Mail [EMAIL_01] or call [PHONE_01].');
});

test('WhatsApp sender comes back as senderName', () => {
  const out = stripPatterns('[26/02/2026, 09:14] Sarah Müller: My number is +44 7911 123456');
  assert.equal(out.senderName, 'Sarah Müller');
  assert.equal(out.text, '[SENDER] My number is [PHONE_01]');
  assert.deepEqual(out.tokens[0], {
    type: 'SENDER', value: '[SENDER]', original: 'Sarah Müller', start: 20, end: 32, confidence: 1,
  });
  assert.equal(stripPatterns('no header here').senderName, '');
});
