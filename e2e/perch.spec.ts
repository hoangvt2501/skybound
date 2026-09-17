import { expect, test, type Page } from '@playwright/test';

/**
 * Landing and take-off: a slow glide onto a landmark perch is captured, the bird sits still on the
 * point, and Space lifts it back into free flight. Waits use simulated seconds (fixed-step clock).
 */

declare global {
  interface Window {
    skybound: { debug: () => any };
  }
}

async function startFlight(page: Page) {
  await page.goto('/?fresh=1');
  await page.evaluate(() => localStorage.setItem('skybound.settings.v1', JSON.stringify({ quality: 'low', helpSeen: true, wildlife: 'off', skyMoods: false })));
  await page.reload();
  await page.waitForFunction(() => window.skybound && window.skybound.debug().phase === 'start', null, { timeout: 90_000 });
  await page.click('[data-action="start"]');
  await page.waitForFunction(() => window.skybound.debug().phase === 'flying');
  await page.evaluate(() => { const d = window.skybound.debug(); d.autopilot.enabled = false; d.day.cycling = false; d.day.setTime(0.4); });
}

test('a slow glide onto a landmark perch lands the bird; Space takes off again', async ({ page }) => {
  test.setTimeout(420_000);
  await startFlight(page);
  // The nearest landmark perch to the spawn, approached from 90 m out and 6 m above at 19 m/s.
  const target = await page.evaluate(() => {
    const d = window.skybound.debug(), s = d.state;
    const pts = d.landmarkPerches().slice().sort((a: any, b: any) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z));
    const p = pts[0];
    const ang = 2.1, bx = p.x + Math.cos(ang) * 90, bz = p.z + Math.sin(ang) * 90;
    d.teleport(bx, bz, p.y + 6);
    s.heading = Math.atan2(p.x - bx, -(p.z - bz)); s.speed = 19; s.pitch = -0.02; s.vy = 0; s.roll = 0;
    return { id: p.id, name: p.name, x: p.x, y: p.y, z: p.z };
  });
  expect(target.id).toMatch(/^lm:/);
  await page.waitForFunction(() => window.skybound.debug().loadedAtPlayer, null, { timeout: 90_000 });
  // Hold the approach speed below the capture limit (a glide accelerates toward cruise) until the perch takes over.
  await page.waitForFunction(() => {
    const d = window.skybound.debug(), s = d.state, p = d.perch();
    const w = window as any;
    if (p.candidate) w.__perchOffered = p.candidate.name;
    if (!p.phase) s.speed = Math.min(s.speed, 20);
    return p.phase === 'perched';
  }, null, { timeout: 240_000, polling: 20 });
  const offered = await page.evaluate(() => (window as any).__perchOffered);
  expect(offered).toBe(target.name);
  // Sits on the point, still.
  const sat = await page.evaluate(() => { const d = window.skybound.debug(), s = d.state; return { x: s.x, y: s.y, z: s.z, speed: s.speed, perch: d.perch().perch.id }; });
  expect(sat.perch).toBe(target.id);
  expect(Math.hypot(sat.x - target.x, sat.z - target.z)).toBeLessThan(0.05);
  expect(sat.y - target.y).toBeGreaterThan(0.2);
  expect(sat.y - target.y).toBeLessThan(0.5);
  expect(sat.speed).toBe(0);
  await expect(page.locator('.toast', { hasText: 'Perched on' })).toBeVisible({ timeout: 20_000 });
  // Space: hop off and fly.
  await page.keyboard.down('Space');
  await page.waitForFunction(() => window.skybound.debug().perch().phase !== 'perched', null, { timeout: 30_000 });
  await page.keyboard.up('Space');
  await page.waitForFunction(() => { const d = window.skybound.debug(); return d.perch().phase === null && d.state.speed > 10; }, null, { timeout: 60_000 });
  const flying = await page.evaluate(() => { const s = window.skybound.debug().state; return { y: s.y, speed: s.speed }; });
  expect(flying.y).toBeGreaterThan(target.y + 0.5);
  expect(flying.speed).toBeGreaterThan(10);
});
