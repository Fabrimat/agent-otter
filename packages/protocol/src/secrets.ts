import { sanitizeText } from './text.js';

export type SecretKind = 'aws-key' | 'github-token' | 'anthropic-key' | 'openai-key' | 'slack-token' | 'private-key' | 'jwt' | 'env-block';

const PATTERNS: [SecretKind, RegExp][] = [
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-key', /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
];
const ENV_LINE = /^[ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]*=[^\s=]/;

/**
 * Secret scanner v0: known patterns only. It protects from mistakes, not from an adversary
 * (anyone can split or encode a secret). Returns the kinds found, never the secret itself.
 */
export const detectSecrets = (text: string): SecretKind[] =>
  // also scan the sanitised form: invisible chars splitting a key are removed before delivery
  [...new Set([...scan(text), ...scan(sanitizeText(text, true))])];

function scan(text: string): SecretKind[] {
  const found = PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
  let run = 0;
  for (const line of text.split('\n')) {
    run = ENV_LINE.test(line) ? run + 1 : 0;
    if (run >= 3) { found.push('env-block'); break; }
  }
  return found;
}
