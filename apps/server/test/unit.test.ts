import { describe, expect, it } from 'vitest';
import { normalizeIp } from '../src/http.js';
import { SlidingWindow } from '../src/ratelimit.js';

describe('normalizeIp', () => {
  it('maps v4-mapped to v4 and collapses IPv6 to /64', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:db8:1:2:ffff::9')).toBe(normalizeIp('2001:DB8:1:2:0:0:0:1'));
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeIp('::1')).toBe('0:0:0:0::/64');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(normalizeIp('2001:db8:1:3::1')).not.toBe(normalizeIp('2001:db8:1:2::1'));
    expect(normalizeIp('unknown')).toBe('unknown');
  });
});

describe('SlidingWindow', () => {
  it('limits per key within the window, and prunes stale keys at most once a minute', () => {
    let t = 0;
    const w = new SlidingWindow(2, 1000, () => t);
    expect([w.hit('a'), w.hit('a'), w.hit('a'), w.hit('b')]).toEqual([true, true, false, true]);
    t = 1001;
    expect(w.hit('a')).toBe(true);
    for (let i = 0; i < 1500; i++) w.hit('k' + i);
    expect(w.size).toBeGreaterThan(1500);
    t = 70_000; // all stale; first big-map hit after a minute prunes
    w.hit('fresh');
    expect(w.size).toBe(1);
    for (let i = 0; i < 1500; i++) w.hit('j' + i);
    t = 71_000; // < 60 s since last prune: no scan
    w.hit('x');
    expect(w.size).toBeGreaterThan(1500);
  });
});
