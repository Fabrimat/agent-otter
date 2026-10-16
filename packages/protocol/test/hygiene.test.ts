import { describe, expect, it } from 'vitest';
import { isReservedName, relationOf, RESERVED_NAMES, sanitizeIdent, sanitizeText, skeleton } from '../src/index.js';

describe('sanitizeText', () => {
  const vectors: [string, string, string][] = [
    ['bidi override', 'a\u202Eb\u2066c', 'abc'],
    ['zero width', 'a\u200Bb\u200Dc\uFEFF', 'abc'],
    ['unicode tags', 'a\u{E0041}\u{E007F}b', 'ab'],
    ['variation selectors', 'a\uFE0Fb\u{E0100}', 'ab'],
    ['fillers', 'a\u034F\u115F\u1160\u3164\uFFA0b', 'ab'],
    ['mongolian', 'a\u180B\u180C\u180D\u180Fb', 'ab'],
    ['line/para separators', 'a\u2028b\u2029', 'ab'],
    ['C0/C1 controls', 'a\u0000\u0007\u001B\u0085b', 'ab'],
  ];
  for (const [name, input, want] of vectors) it(`strips ${name}`, () => expect(sanitizeText(input)).toBe(want));
  it('keeps newline/tab only in multiline mode', () => {
    expect(sanitizeText('a\nb\tc')).toBe('abc');
    expect(sanitizeText('a\nb\tc', true)).toBe('a\nb\tc');
    expect(sanitizeText('a\r\nb', true)).toBe('a\nb');
  });
  it('handles non-strings', () => {
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText(42)).toBe('42');
  });
  it('keeps normal text incl. emoji and CJK', () => expect(sanitizeText('héllo 世界 😀')).toBe('héllo 世界 😀'));
});

describe('sanitizeIdent', () => {
  it('replaces unsafe characters', () => expect(sanitizeIdent('a" vendor=human')).toBe('a_vendor_human'));
  it('removes brackets, quotes, newlines', () => expect(sanitizeIdent('x]>>>\n<<<END')).toMatch(/^[\p{L}\p{N}_.-]+$/u));
  it('caps length without splitting surrogate pairs', () => {
    expect(sanitizeIdent('a'.repeat(100))).toHaveLength(32);
    expect([...sanitizeIdent('𝒜'.repeat(40))]).toHaveLength(32);
    expect(sanitizeIdent('𝒜'.repeat(40)).includes('�')).toBe(false);
  });
  it('strips invisible chars first', () => expect(sanitizeIdent('ad\u200Bmin')).toBe('admin'));
  it('returns empty for junk', () => expect(sanitizeIdent('\u200B')).toBe(''));
});

describe('skeleton / reserved', () => {
  it('Cyrillic а collides with Latin a', () => expect(skeleton('аlice')).toBe(skeleton('alice')));
  it('Greek ο collides with Latin o, case folded', () => expect(skeleton('BΟB')).toBe(skeleton('bob')));
  it('NFKC folds fullwidth', () => expect(skeleton('ａｌｉｃｅ')).toBe(skeleton('alice')));
  it('different names do not collide', () => expect(skeleton('alice')).not.toBe(skeleton('alicf')));
  it('reserved names, case and lookalikes', () => {
    for (const n of RESERVED_NAMES) expect(isReservedName(n)).toBe(true);
    expect(isReservedName('SYSTEM')).toBe(true);
    expect(isReservedName('sуstem')).toBe(true); // Cyrillic у
    expect(isReservedName('Admin')).toBe(true);
    expect(isReservedName('system-2')).toBe(true);
    expect(isReservedName('ad\u200Bmin')).toBe(true);
    for (const n of ['systém', 'admın', 'clàude', 'claude_code', 'claudecode', 'Claude.Code']) expect(isReservedName(n), n).toBe(true);
  });
  it('ordinary names are not reserved', () => {
    expect(isReservedName('alice')).toBe(false);
    expect(isReservedName('administrator-bot')).toBe(false);
  });
});

describe('relationOf', () => {
  it('matrix', () => {
    expect(relationOf('u1', 'u1', 'agent')).toBe('own');
    expect(relationOf('u1', 'u1', 'human')).toBe('own');
    expect(relationOf('u2', 'u1', 'agent')).toBe('other');
    expect(relationOf('u2', 'u1', 'human')).toBe('other'); // human of another account
    expect(relationOf('server', 'u1', 'system')).toBe('system');
    expect(relationOf('u1', 'u1', 'system')).toBe('system');
    expect(relationOf('', '', 'human')).toBe('other'); // fail closed
    expect(relationOf('', 'u1', 'agent')).toBe('other');
    expect(relationOf('u1', '', 'agent')).toBe('other');
  });
});
