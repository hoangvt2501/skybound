import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ART = path.join(process.cwd(), 'e2e', '.artifacts');

declare global {
  interface Window {
    skybound: { debug: () => any };
  }
}

async function simWait(page: Page, seconds: number) {
  const t0 = await page.evaluate(() => window.skybound.debug().state.time as number);
  await page.waitForFunction((target) => window.skybound.debug().state.time >= target, t0 + seconds, { timeout: 120_000, polling: 50 });
}

test('touch layout: joystick turns and climbs, flap button lifts, overlay gestures do not leak', async ({ page }) => {
  fs.mkdirSync(ART, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/?fresh=1');
  await page.waitForFunction(() => window.skybound && window.skybound.debug().phase === 'start', null, { timeout: 90_000 });
  await page.tap('[data-action="start"]');
  await page.waitForFunction(() => window.skybound.debug().phase === 'flying');
  await expect(page.locator('.touch')).toBeVisible();
  await expect(page.locator('.touch-stick')).toBeVisible();
  await simWait(page, 0.5);
  await page.screenshot({ path: path.join(ART, 'mobile-flight.png') });

  const state = () => page.evaluate(() => {
    const d = window.skybound.debug();
    return { x: d.state.x, y: d.state.y, z: d.state.z, heading: d.state.heading, pitch: d.state.pitch, time: d.state.time };
  });
  const s0 = await state();

  // Joystick: touch and hold to the right and up.
  const stick = (await page.locator('.touch-stick').boundingBox())!;
  const cx = stick.x + stick.width / 2, cy = stick.y + stick.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
  };
  await touch('touchStart', [{ x: cx, y: cy, id: 1 }]);
  await touch('touchMove', [{ x: cx + stick.width * 0.4, y: cy - stick.height * 0.4, id: 1 }]);
  await simWait(page, 1.0);
  const s1 = await state();
  await touch('touchEnd', []);
  const dh = ((s1.heading - s0.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  expect(dh).toBeGreaterThan(0.15);
  expect(s1.pitch).toBeGreaterThan(0.1);

  // Releasing the stick clears the input (no stuck movement).
  await simWait(page, 0.5);
  const turnAfter = await page.evaluate(() => window.skybound.debug().state.turnSmooth as number);
  expect(Math.abs(turnAfter)).toBeLessThan(0.5);

  // Flap button: hold it, altitude should not fall.
  const flap = (await page.locator('[data-hold="flap"]').boundingBox())!;
  const y0 = (await state()).y;
  await touch('touchStart', [{ x: flap.x + flap.width / 2, y: flap.y + flap.height / 2, id: 2 }]);
  await simWait(page, 1.5);
  await touch('touchEnd', []);
  const y1 = (await state()).y;
  expect(y1).toBeGreaterThan(y0 - 5);

  // Map opens from the touch button; the simulation pauses and gestures on the map must not move the bird.
  await page.tap('[data-action="map"]');
  await expect(page.locator('.worldmap')).toBeVisible();
  const before = await state();
  const mapBox = (await page.locator('.worldmap-canvas').boundingBox())!;
  // Drag at a human pace: an instantaneous synthetic flick starts a browser
  // "fling", and a tap during the fling window is consumed to stop it.
  await touch('touchStart', [{ x: mapBox.x + 50, y: mapBox.y + 50, id: 3 }]);
  for (let i = 1; i <= 5; i++) {
    await touch('touchMove', [{ x: mapBox.x + 50 + i * 20, y: mapBox.y + 50 + i * 14, id: 3 }]);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(150);
  await touch('touchEnd', []);
  await page.waitForTimeout(1500);
  const after = await state();
  expect(after.time).toBe(before.time);
  expect(after.x).toBe(before.x);
  await page.screenshot({ path: path.join(ART, 'mobile-map.png') });
  await page.tap('.worldmap [data-action="close"]');
  await expect(page.locator('.worldmap')).toBeHidden();
  // Flight resumes after closing the map.
  await simWait(page, 0.5);
  expect(errors).toEqual([]);
});
