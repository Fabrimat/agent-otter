import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..', 'src');
const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f));

describe('source hygiene', () => {
  it('never uses dangerouslySetInnerHTML or innerHTML', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(join(src, f), 'utf8'), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|insertAdjacentHTML/);
  });

  it('index.html has no inline script and sets no-referrer', () => {
    const html = readFileSync(join(src, '..', 'index.html'), 'utf8');
    expect(html).toContain('<meta name="referrer" content="no-referrer"');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  });

  it('zod runs in jitless mode, set before anything else loads (no new Function probe under the strict CSP)', () => {
    expect(readFileSync(join(src, 'main.tsx'), 'utf8').trimStart()).toMatch(/^import '[.]\/zodConfig';/);
    expect(readFileSync(join(src, 'zodConfig.ts'), 'utf8')).toContain('z.config({ jitless: true })');
  });
});
