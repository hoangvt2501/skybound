import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Real-browser smoke test of the production build. Exercises start, manual
 * flight, flap/boost, terrain contact recovery, map + waypoint, landmark
 * discovery, autopilot with manual interruption, reload persistence, and
 * chunk streaming across many boundaries, while collecting console errors.
 *
 * Waits are expressed in simulated seconds (the fixed-step clock) so the
 * checks are independent of how fast the machine renders.
 */

const ART = path.join(process.cwd(), 'e2e', '.artifacts');

declare global {
  interface Window {
    skybound: { debug: () => any };
  }
}

async function debug(page: Page) {
  return page.evaluate(() => {
    const d = window.skybound.debug();
    return {
      phase: d.phase,
      x: d.state.x, y: d.state.y, z: d.state.z, time: d.state.time,
      heading: d.state.heading, speed: d.state.speed, pitch: d.state.pitch, boost: d.state.boost,
      chunks: d.chunks, fps: d.fps(), frameMs: d.frameMs(), loaded: d.loadedAtPlayer,
      ground: d.groundAt(d.state.x, d.state.z),
      discovered: Array.from(d.nav.discovered), waypoint: d.nav.waypoint,
      autopilot: d.autopilot.enabled, apStatus: d.autopilot.status,
      origin: { x: d.origin.x, z: d.origin.z }, seed: d.seed,
      landmarks: d.landmarks.map((l: any) => ({ id: l.id, name: l.name, x: l.x, z: l.z, type: l.type })),
    };
  });
}

/** Wait until the simulation has advanced by `seconds` of fixed steps. */
async function simWait(page: Page, seconds: number) {
  const t0 = await page.evaluate(() => window.skybound.debug().state.time as number);
  await page.waitForFunction((target) => window.skybound.debug().state.time >= target, t0 + seconds, { timeout: 120_000, polling: 50 });
}

/** Hold a key for a number of simulated seconds. */
async function hold(page: Page, key: string, seconds: number) {
  await page.keyboard.down(key);
  await simWait(page, seconds);
  await page.keyboard.up(key);
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function waitReady(page: Page) {
  await page.waitForFunction(() => window.skybound && window.skybound.debug().phase === 'start', null, { timeout: 90_000 });
}

test.beforeAll(() => {
  fs.mkdirSync(ART, { recursive: true });
});

test('start, fly, map, waypoint, discovery, autopilot, reload', async ({ page }) => {
  // Software-GL machines render at a few fps; the scenario needs generous time.
  test.setTimeout(480_000);
  const errors = collectErrors(page);
  await page.goto('/?fresh=1');
  await waitReady(page);
  await expect(page.locator('.start .title')).toHaveText('SKYBOUND');
  await page.screenshot({ path: path.join(ART, 'desktop-start.png') });

  // Start flying.
  await page.click('[data-action="start"]');
  await page.waitForFunction(() => window.skybound.debug().phase === 'flying');
  await simWait(page, 0.5);
  const s0 = await debug(page);
  expect(s0.loaded).toBe(true);

  // Climb: hold W and check altitude rises and the bird moves.
  await hold(page, 'KeyW', 2.5);
  const s1 = await debug(page);
  expect(s1.y).toBeGreaterThan(s0.y + 5);
  expect(Math.hypot(s1.x - s0.x, s1.z - s0.z)).toBeGreaterThan(20);

  // Turn: hold D and check heading increases (clockwise). One second keeps
  // the change well under 180 degrees even at the low-speed turn rate.
  await hold(page, 'KeyD', 1.0);
  const s2 = await debug(page);
  const dh = ((s2.heading - s1.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  expect(dh).toBeGreaterThan(0.2);

  // Flap and boost.
  await hold(page, 'Space', 1.2);
  await hold(page, 'ShiftLeft', 1.2);
  const s3 = await debug(page);
  expect(s3.boost).toBeLessThan(100);
  await page.screenshot({ path: path.join(ART, 'desktop-flight.png') });

  // Terrain contact: dive hard, then verify the bird stays above ground and recovers.
  await hold(page, 'KeyS', 8);
  const s4 = await debug(page);
  expect(s4.y).toBeGreaterThanOrEqual(Math.max(s4.ground, 0) + 1);
  await page.keyboard.press('KeyR');
  await simWait(page, 0.2);
  const s5 = await debug(page);
  expect(s5.y - Math.max(s5.ground, 0)).toBeGreaterThan(30);

  // Open the map (simulation pauses), place a waypoint, close, and verify bearing.
  await page.keyboard.press('KeyM');
  await expect(page.locator('.worldmap')).toBeVisible();
  const posWhileOpen = await debug(page);
  await page.waitForTimeout(1200);
  const posWhileOpen2 = await debug(page);
  expect(posWhileOpen2.time).toBe(posWhileOpen.time); // paused
  expect(posWhileOpen2.x).toBe(posWhileOpen.x);
  const canvas = page.locator('.worldmap-canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.38);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(ART, 'desktop-map-waypoint.png') });
  const wp = (await debug(page)).waypoint;
  expect(wp).not.toBeNull();
  await page.keyboard.press('KeyM');
  await expect(page.locator('.worldmap')).toBeHidden();
  await expect(page.locator('.hud-waypoint')).toBeVisible();
  await simWait(page, 0.2);
  const hudText = await page.locator('.hud-wp-text').textContent();
  const s6 = await debug(page);
  const expectedBearing = ((Math.atan2(wp.x - s6.x, -(wp.z - s6.z)) * 180) / Math.PI + 360) % 360;
  const shown = Number(/(\d+)°/.exec(hudText ?? '')?.[1]);
  expect(Math.abs((((shown - expectedBearing) % 360) + 540) % 360 - 180)).toBeLessThan(4);

  // Landmark discovery: teleport near the first landmark and check the journal marker.
  const lm = s6.landmarks[0];
  await page.evaluate(([x, z]) => window.skybound.debug().teleport(x + 120, z + 120), [lm.x, lm.z]);
  await simWait(page, 0.5);
  const s7 = await debug(page);
  expect(s7.discovered).toContain(lm.id);
  // (The discovery toast lives 4.5 s of wall time, which a software-GL run can
  // exceed while chunks load; the journal check below is the durable effect.)
  await page.keyboard.press('KeyM');
  await expect(page.locator('.worldmap-journal .journal-item')).toHaveCount(1);
  await page.screenshot({ path: path.join(ART, 'desktop-map-discovered.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('.worldmap')).toBeHidden();

  // Autopilot on, then interrupt manually.
  await page.keyboard.press('KeyF');
  await simWait(page, 3);
  const s8 = await debug(page);
  expect(s8.autopilot).toBe(true);
  expect(['enroute', 'climbing', 'exploring', 'arrived', 'loitering', 'blocked']).toContain(s8.apStatus);
  await hold(page, 'KeyA', 0.3);
  const s9 = await debug(page);
  expect(s9.autopilot).toBe(false);

  // Save and reload: same seed, same discoveries and waypoint, position near the saved one.
  await page.evaluate(() => window.skybound.debug().save());
  const before = await debug(page);
  await page.reload();
  await waitReady(page);
  await expect(page.locator('[data-action="start"]')).toHaveText('Continue flying');
  await page.click('[data-action="start"]');
  await page.waitForFunction(() => window.skybound.debug().phase === 'flying');
  const after = await debug(page);
  expect(after.seed).toBe(before.seed);
  expect(after.discovered).toEqual(before.discovered);
  expect(after.waypoint).toEqual(before.waypoint);
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(400);

  // Stream across many chunk boundaries: boost + flap straight for a while.
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('Space');
  await simWait(page, 12);
  await page.keyboard.up('Space');
  await page.keyboard.up('ShiftLeft');
  const s10 = await debug(page);
  expect(s10.loaded).toBe(true);
  expect(s10.chunks.loaded).toBeGreaterThan(20);
  expect(Math.hypot(s10.x - after.x, s10.z - after.z)).toBeGreaterThan(400);
  fs.writeFileSync(path.join(ART, 'desktop-stats.json'), JSON.stringify({ before: s0, after: s10, errors }, null, 2));

  // Pause/resume and escape handling.
  await page.keyboard.press('Escape');
  await expect(page.locator('.pause')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pause')).toBeHidden();

  expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
});

test('a ?seed= URL takes precedence over an unrelated save', async ({ page }) => {
  await page.goto('/?fresh=1');
  await waitReady(page);
  await page.click('[data-action="start"]');
  await page.waitForFunction(() => window.skybound.debug().phase === 'flying');
  await page.evaluate(() => window.skybound.debug().save());
  const a = await debug(page);
  await page.goto('/?seed=777');
  await waitReady(page);
  const b = await debug(page);
  expect(b.seed).toBe(777);
  expect(b.seed).not.toBe(a.seed);
  await expect(page.locator('[data-action="start"]')).toHaveText('Start flying');
});

test('resized layout keeps the HUD and minimap in view', async ({ page }) => {
  await page.goto('/?fresh=1');
  await waitReady(page);
  await page.click('[data-action="start"]');
  await page.waitForFunction(() => window.skybound.debug().phase === 'flying');
  for (const [w, h] of [[900, 600], [1600, 900], [700, 1000]] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
    const mm = (await page.locator('.minimap-canvas').boundingBox())!;
    expect(mm.x + mm.width).toBeLessThanOrEqual(w + 1);
    expect(mm.y + mm.height).toBeLessThanOrEqual(h + 1);
    const hud = (await page.locator('.hud-readout').boundingBox())!;
    expect(hud.x).toBeGreaterThanOrEqual(0);
    expect(hud.x + hud.width).toBeLessThanOrEqual(w + 1);
  }
});
