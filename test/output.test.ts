/**
 * Tests for log size control.
 *
 * The numbers here come from the live API, not imagination: one real site's
 * application log was 274,503 characters over 500 lines (~550 chars/line,
 * ~69k tokens). That shape — few lines, enormous lines — is why a line limit
 * alone is insufficient and the character cap exists.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_TAIL_LINES,
  MAX_TAIL_LINES,
  tailOutputFields,
  tailText,
  unavailableReason,
} from '../src/output.ts';

const lines = (n: number, text = 'line') =>
  Array.from({ length: n }, (_, i) => `${text} ${i + 1}`).join('\n');

describe('tailText', () => {
  it('leaves short output completely untouched', () => {
    const input = lines(10);
    assert.equal(tailText(input, { lines: 200 }), input);
  });

  it('leaves output of exactly the limit untouched', () => {
    const input = lines(200);
    assert.equal(tailText(input, { lines: 200 }), input);
  });

  it('keeps the END of the log, where failures are', () => {
    const result = tailText(lines(500), { lines: 3 });
    assert.match(result, /line 498\nline 499\nline 500$/);
    assert.ok(!result.includes('line 1\n'), 'the head must be dropped');
  });

  it('says how much it dropped, so a fragment never looks complete', () => {
    const result = tailText(lines(500), { lines: 200 });
    assert.match(result, /^\[300 earlier lines omitted, showing last 200\]/);
  });

  it('caps by characters even when the line count is within limits', () => {
    // The real failure mode: 500 lines is under a 5,000-line limit, but the
    // payload is still 274k characters.
    const fat = Array.from({ length: 500 }, () => 'x'.repeat(550)).join('\n');
    assert.ok(fat.length > 270_000);
    const result = tailText(fat, { lines: 5_000 });
    assert.ok(
      result.length <= DEFAULT_MAX_CHARS + 200,
      `expected ~${DEFAULT_MAX_CHARS} chars, got ${result.length}`,
    );
    assert.match(result, /truncated to the last 20,000 characters of 27\d,\d\d\d/);
  });

  it('caps a single enormous line, which no line limit could catch', () => {
    const oneLine = 'y'.repeat(300_000);
    const result = tailText(oneLine, { lines: 200 });
    assert.ok(result.length <= DEFAULT_MAX_CHARS + 200);
  });

  it('applies the character cap even with no line limit requested', () => {
    const result = tailText('z'.repeat(100_000));
    assert.ok(result.length <= DEFAULT_MAX_CHARS + 200);
  });

  it('clamps an absurd line request rather than trusting it', () => {
    const result = tailText(lines(20_000), { lines: 999_999 });
    assert.match(result, /showing last 5,000/);
    assert.ok(MAX_TAIL_LINES === 5_000);
  });

  it('starts on a clean line after character truncation', () => {
    const input = Array.from({ length: 100 }, (_, i) => `${i}:${'a'.repeat(500)}`).join('\n');
    const result = tailText(input, { maxChars: 2_000 });
    const body = result.split('\n').slice(1).join('\n');
    assert.ok(!body.startsWith('a'), 'should not begin mid-line');
  });
});

describe('unavailableReason', () => {
  it('explains an SSH refusal as a revoked server, not a broken tool', () => {
    // Exactly what the live API returned for 8 of 30 R3 servers.
    const reason = unavailableReason('forge@18.168.158.79: Permission denied (publickey).');
    assert.ok(reason);
    assert.match(reason, /REVOKED/);
    assert.match(reason, /get_server/);
  });

  it('recognises Forge\'s empty-log placeholder', () => {
    assert.match(unavailableReason('=== Empty log file ===') ?? '', /empty/i);
  });

  it('says nothing about an ordinary log', () => {
    assert.equal(unavailableReason('[2026-07-28] production.ERROR: boom'), null);
  });
});

describe('tailOutputFields', () => {
  it('tails the `content` field site logs use', () => {
    const payload = { data: { type: 'applicationLogs', attributes: { content: lines(500) } } };
    const result = tailOutputFields(payload, { lines: 5 }) as typeof payload;
    assert.match(result.data.attributes.content, /^\[495 earlier lines omitted/);
  });

  it('tails the `output` field deployment and job logs use', () => {
    const payload = { data: { type: 'deploymentOutputs', attributes: { output: lines(500) } } };
    const result = tailOutputFields(payload, { lines: 5 }) as typeof payload;
    assert.match(result.data.attributes.output, /^\[495 earlier lines omitted/);
  });

  it('prefixes the revoked-server explanation instead of tailing', () => {
    const payload = { data: { attributes: { content: 'root@1.2.3.4: Permission denied (publickey).' } } };
    const result = tailOutputFields(payload, { lines: 200 }) as typeof payload;
    assert.match(result.data.attributes.content, /REVOKED/);
    // The original text is preserved after the explanation.
    assert.match(result.data.attributes.content, /Permission denied \(publickey\)/);
  });

  it('leaves unrelated string fields completely alone, however long', () => {
    // Regression: an earlier version decorated every string it recursed into, not
    // just the log fields, so a long `name`, `url` or `deployment_script` was
    // silently truncated to the character cap.
    const payload = {
      data: {
        attributes: {
          name: 'x'.repeat(50_000),
          status: 'finished',
          deployment_script: 'cd /home/forge/site\n'.repeat(2_000),
        },
      },
    };
    const result = tailOutputFields(payload, { lines: 1 }) as typeof payload;
    assert.equal(result.data.attributes.name.length, 50_000);
    assert.equal(result.data.attributes.deployment_script.length, 40_000);
    assert.equal(result.data.attributes.status, 'finished');
  });

  it('does not mutate its input', () => {
    const payload = { data: { attributes: { output: lines(500) } } };
    tailOutputFields(payload, { lines: 5 });
    assert.equal(payload.data.attributes.output.split('\n').length, 500);
  });

  it('handles a plain-text body', () => {
    assert.match(tailOutputFields(lines(500), { lines: 2 }) as string, /^\[498 earlier lines/);
  });

  it('has a sane default line count', () => {
    assert.equal(DEFAULT_TAIL_LINES, 200);
  });
});
