import { expect, test, type Page } from '@playwright/test';

/**
 * Mouse exploration regressions with real pointer sequences:
 * free-look orbit in the 3D scene, and pan/zoom/click on the world map.
 * Waits on the simulation use simulated seconds (fixed-step clock).
 */

declare global {
  interface Window {
    skybound: { debug: () => any };
  }
}

const dbg = (page: Page) =>
  page.evaluate(() => {
    const d = window.skybound.debug();
    return {
      phase: d.phase, x: d.state.x, y: d.state.y, z: d.state.z, heading: d.state.heading, time: d.state.time, odometer: d.state.odometer,
      cam: d.cameraState(), mapView: d.mapView(), mapOpen: d.mapOpen(), waypoint: d.nav.waypoint, input: d.inputSnapshot(),
      origin: { x: d.origin.x, z: d.origin.z }, autopilot: d.autopilot.enabled,
    };
  });

async function simWait(page: Page, seconds: number) {
  const t0 = await page.evaluate(() => window.skybound.debug().state.time as number);
  await page.waitForFunction((target) => window.skybound.debug().state.time >= target, t0 + seconds, { timeout: 120_000, polling: 50 });
}

async function startFlight(page: Page) {
  await page.goto('/?fresh=1');
  await page.evaluate(() => localStorage.setItem('skybound.settings.v1', JSON.stringify({ quality: 'low', helpSeen: true })));
  await page.reload();
  await page.waitForFunction(() => window.skybound && window.skybound.debug().phase === 'start', null, { timeout: 90_000 });
  await page.click('[data-action="start"]');
  await page.waitForFunction(() => window.skybound.debug().phase === 'flying');
  await page.evaluate(() => { const d = window.skybound.debug(); d.autopilot.enabled = false; d.day.cycling = false; });
  await simWait(page, 0.3);
}

const wrap = (a: number) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

test.describe('Scene free-look', () => {
  test('a drag starts from the displayed view: no snap toward the bird after a turn (photo mode)', async ({ page }) => {
    test.setTimeout(240_000);
    await startFlight(page);
    // A held turn banks the bird and leaves the chase camera lagging and off to the side; photo mode then
    // freezes the flight in that state, so the only thing that can move the camera is the drag itself.
    await page.keyboard.down('KeyD');
    await simWait(page, 1);
    await page.keyboard.press('KeyP');
    await page.keyboard.up('KeyD');
    await page.waitForFunction(() => window.skybound.debug().phase === 'photo');
    await page.waitForTimeout(2500); // chase smoothing converges on the frozen state
    const camPos = () => page.evaluate(() => { const c = (window.skybound as any).camera.position; return [c.x, c.y, c.z]; });
    const frame = () => page.evaluate(() => (window.skybound as any).wallTime as number);
    const p0 = await camPos();
    const heading = (await dbg(page)).heading;
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.down();
    const t0 = await frame();
    await page.mouse.move(vp.width / 2 + 2, vp.height / 2);
    await page.waitForFunction((t) => (window.skybound as any).wallTime > t + 0.05, t0, { timeout: 20_000, polling: 30 });
    const p1 = await camPos();
    const after = await dbg(page);
    await page.mouse.up();
    // 2 px of drag orbit the camera by 0.007 rad, about 0.1 m at chase distance. The old rig re-seeded the
    // orbit from the bird's heading and preset elevation and moved the camera 1.5-2 m in one frame.
    const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
    expect(moved).toBeLessThan(0.5);
    expect(after.cam.freeLook).toBe(true);
    // The orbit was seeded from where the camera was (off to the banked side), not from behind the bird.
    expect(Math.abs(wrap(after.cam.azimuth - (heading + Math.PI)))).toBeGreaterThan(0.03);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.skybound.debug().phase === 'flying');
  });

  test('drag orbits the bird, the view is kept for 5 s while the bird keeps flying, V resets', async ({ page }) => {
    test.setTimeout(300_000);
    await startFlight(page);
    const before = await dbg(page);
    expect(before.cam.freeLook).toBe(false);
    const vp = page.viewportSize()!;
    const cx = vp.width / 2, cy = vp.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(cx + i * 30, cy + i * 6);
      await page.waitForTimeout(30);
    }
    const during = await dbg(page);
    expect(during.input.dragging).toBe(true);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const released = await dbg(page);
    expect(released.cam.freeLook).toBe(true);
    expect(Math.abs(wrap(released.cam.azimuth - (released.heading + Math.PI)))).toBeGreaterThan(0.5);
    expect(released.input.dragging).toBe(false);
    // Dragging does not steer or engage flight input.
    expect(released.input.turn).toBe(0);
    expect(released.input.pitch).toBe(0);

    // Keep flying for 5 simulated seconds: the view azimuth must not drift back.
    await simWait(page, 5);
    const later = await dbg(page);
    expect(later.cam.freeLook).toBe(true);
    expect(Math.abs(wrap(later.cam.azimuth - released.cam.azimuth))).toBeLessThan(0.02);
    expect(later.odometer - released.odometer).toBeGreaterThan(100);

    // Keyboard flight stays usable during free-look and a turn does not move the camera behind the bird.
    await page.keyboard.down('KeyD');
    await simWait(page, 1);
    await page.keyboard.up('KeyD');
    const turned = await dbg(page);
    expect(Math.abs(wrap(turned.heading - later.heading))).toBeGreaterThan(0.3);
    expect(Math.abs(wrap(turned.cam.azimuth - released.cam.azimuth))).toBeLessThan(0.02);

    // V resets smoothly behind the bird.
    await page.keyboard.press('KeyV');
    await page.waitForFunction(() => !window.skybound.debug().cameraState().freeLook, null, { timeout: 30_000 });
    const reset = await dbg(page);
    expect(Math.abs(wrap(reset.cam.azimuth - (reset.heading + Math.PI)))).toBeLessThan(0.1);
  });

  test('wheel over the scene changes camera distance; wheel over the map zooms the map only', async ({ page }) => {
    await startFlight(page);
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    const d0 = (await dbg(page)).cam.distance;
    await page.mouse.wheel(0, 400);
    // The delta is consumed on the next rendered frame (slow under software GL).
    await page.waitForFunction((prev) => window.skybound.debug().cameraState().distance > prev, d0, { timeout: 20_000 });
    const d1 = (await dbg(page)).cam.distance;
    expect(d1).toBeGreaterThan(d0);
    await page.keyboard.press('KeyM');
    await expect(page.locator('.worldmap')).toBeVisible();
    const box = (await page.locator('.worldmap-canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const m0 = (await dbg(page)).mapView.metersPerPixel;
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(150);
    const s = await dbg(page);
    expect(s.mapView.metersPerPixel).toBeLessThan(m0);
    expect(s.cam.distance).toBeCloseTo(d1, 5);
    await page.keyboard.press('KeyM');
  });
});

test.describe('World map mouse handling', () => {
  test('drag pans without placing a waypoint; out-and-back is still a drag; click places at the intended coordinate', async ({ page }) => {
    await startFlight(page);
    await page.keyboard.press('KeyM');
    await expect(page.locator('.worldmap')).toBeVisible();
    const box = (await page.locator('.worldmap-canvas').boundingBox())!;
    const sx = box.x + box.width * 0.5, sy = box.y + box.height * 0.5;
    const v0 = (await dbg(page)).mapView;

    // 1) Drag 200 px: center changes, no waypoint.
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(sx + i * 25, sy + i * 5); await page.waitForTimeout(20); }
    await page.mouse.up();
    await page.waitForTimeout(100);
    const s1 = await dbg(page);
    expect(s1.waypoint).toBeNull();
    expect(Math.abs(s1.mapView.centerX - v0.centerX)).toBeGreaterThan(100 * v0.metersPerPixel);
    // Content follows the pointer: moving right by 200 px moves the center west by 200 px worth of meters.
    expect(s1.mapView.centerX).toBeCloseTo(v0.centerX - 200 * v0.metersPerPixel, 0);

    // 2) Drag out and back to the start: still a drag, no waypoint, view unchanged.
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) { await page.mouse.move(sx + i * 25, sy); await page.waitForTimeout(20); }
    for (let i = 5; i >= 0; i--) { await page.mouse.move(sx + i * 25, sy); await page.waitForTimeout(20); }
    await page.mouse.up();
    await page.waitForTimeout(100);
    const s2 = await dbg(page);
    expect(s2.waypoint).toBeNull();
    expect(s2.mapView.centerX).toBeCloseTo(s1.mapView.centerX, 3);

    // 3) Short click places a waypoint at the world coordinate under the pointer.
    const px = box.width * 0.62, py = box.height * 0.38;
    const v = s2.mapView;
    const expectedX = (px - v.width / 2) * v.metersPerPixel + v.centerX;
    const expectedZ = (py - v.height / 2) * v.metersPerPixel + v.centerZ;
    await page.mouse.move(box.x + px, box.y + py);
    await page.mouse.down();
    await page.mouse.move(box.x + px + 2, box.y + py + 1); // sub-threshold jitter
    await page.mouse.up();
    await page.waitForTimeout(150);
    const s3 = await dbg(page);
    expect(s3.waypoint).not.toBeNull();
    expect(s3.waypoint.x).toBeCloseTo(expectedX, 0);
    expect(s3.waypoint.z).toBeCloseTo(expectedZ, 0);
    // A right-button press is ignored.
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6, { button: 'right' });
    await page.waitForTimeout(100);
    const s4 = await dbg(page);
    expect(s4.waypoint.x).toBeCloseTo(s3.waypoint.x, 3);
    await page.keyboard.press('Escape');
    await expect(page.locator('.worldmap')).toBeHidden();
  });

  test('wheel zoom keeps the world point under an off-center pointer fixed; +/- and fit work; view persists across reopen', async ({ page }) => {
    await startFlight(page);
    await page.keyboard.press('KeyM');
    await expect(page.locator('.worldmap')).toBeVisible();
    const box = (await page.locator('.worldmap-canvas').boundingBox())!;
    // Integer client coordinates so the browser and the test agree on the anchor pixel.
    const clientX = Math.round(box.x + box.width * 0.2), clientY = Math.round(box.y + box.height * 0.75);
    const px = clientX - box.x, py = clientY - box.y;
    const under = (view: any) => ({ x: (px - view.width / 2) * view.metersPerPixel + view.centerX, z: (py - view.height / 2) * view.metersPerPixel + view.centerZ });
    const a = under((await dbg(page)).mapView);
    await page.mouse.move(clientX, clientY);
    for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(40); }
    const vb = (await dbg(page)).mapView;
    const b = under(vb);
    expect(b.x).toBeCloseTo(a.x, 0);
    expect(b.z).toBeCloseTo(a.z, 0);
    // Zoom buttons.
    await page.click('.worldmap-zoom [data-action="zoom-in"]');
    const vc = (await dbg(page)).mapView;
    expect(vc.metersPerPixel).toBeLessThan(vb.metersPerPixel);
    await page.click('.worldmap-zoom [data-action="zoom-out"]');
    const vd = (await dbg(page)).mapView;
    expect(vd.metersPerPixel).toBeCloseTo(vb.metersPerPixel, 3);
    // Center on bird keeps zoom.
    await page.click('.worldmap-top [data-action="recenter"]');
    const s = await dbg(page);
    expect(s.mapView.centerX).toBeCloseTo(s.x, 0);
    expect(s.mapView.metersPerPixel).toBeCloseTo(vd.metersPerPixel, 3);
    // Arrow keys pan when the map has focus.
    await page.keyboard.press('ArrowLeft');
    const sk = await dbg(page);
    expect(sk.mapView.centerX).toBeLessThan(s.mapView.centerX);
    // Close and reopen: view retained.
    await page.keyboard.press('KeyM');
    await expect(page.locator('.worldmap')).toBeHidden();
    await page.keyboard.press('KeyM');
    await expect(page.locator('.worldmap')).toBeVisible();
    const again = await dbg(page);
    expect(again.mapView.centerX).toBeCloseTo(sk.mapView.centerX, 3);
    expect(again.mapView.metersPerPixel).toBeCloseTo(sk.mapView.metersPerPixel, 3);
    // Fit region frames the 32 km region.
    await page.click('.worldmap-top [data-action="fit"]');
    const fit = await dbg(page);
    expect(fit.mapView.centerX).toBe(0);
    expect(fit.mapView.centerZ).toBe(0);
    await page.keyboard.press('KeyM');
  });

  test('opening the map during a held key and drag leaves no stuck input; closing restores the previous pause state', async ({ page }) => {
    await startFlight(page);
    const vp = page.viewportSize()!;
    await page.keyboard.down('KeyW');
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.down();
    await page.mouse.move(vp.width / 2 + 60, vp.height / 2);
    await page.keyboard.press('KeyM');
    await expect(page.locator('.worldmap')).toBeVisible();
    await page.keyboard.up('KeyW');
    await page.mouse.up();
    // Map gestures must not orbit the camera.
    const camBefore = (await dbg(page)).cam;
    const box = (await page.locator('.worldmap-canvas').boundingBox())!;
    await page.mouse.move(box.x + 100, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 160);
    await page.mouse.up();
    const camAfter = (await dbg(page)).cam;
    expect(camAfter.azimuth).toBeCloseTo(camBefore.azimuth, 5);
    await page.keyboard.press('KeyM');
    await expect(page.locator('.worldmap')).toBeHidden();
    await simWait(page, 0.5);
    const s = await dbg(page);
    expect(s.input.pitch).toBe(0);
    expect(s.input.dragging).toBe(false);
    expect(s.phase).toBe('flying');

    // Open from pause: closing returns to pause, not to flight.
    await page.keyboard.press('Escape');
    await expect(page.locator('.pause')).toBeVisible();
    await page.keyboard.press('KeyM');
    await expect(page.locator('.worldmap')).toBeVisible();
    const t0 = (await dbg(page)).time;
    await page.waitForTimeout(600);
    expect((await dbg(page)).time).toBe(t0);
    await page.keyboard.press('KeyM');
    await expect(page.locator('.pause')).toBeVisible();
    expect((await dbg(page)).phase).toBe('paused');
    await page.keyboard.press('Escape');
    await expect(page.locator('.pause')).toBeHidden();
  });

  test('camera and map stay correct after a floating-origin rebase', async ({ page }) => {
    await startFlight(page);
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, vp.height / 2);
    await page.mouse.down();
    await page.mouse.move(vp.width / 2 + 200, vp.height / 2 + 40);
    await page.mouse.up();
    const before = await dbg(page);
    // Teleport 9 km east: the next simulation step rebases the origin.
    await page.evaluate(([x, z]) => window.skybound.debug().teleport(x, z), [before.x + 9000, before.z]);
    await simWait(page, 0.3);
    const after = await dbg(page);
    expect(after.origin.x).not.toBe(before.origin.x);
    expect(after.cam.freeLook).toBe(true);
    expect(Math.abs(wrap(after.cam.azimuth - before.cam.azimuth))).toBeLessThan(0.02);
    const camPos = await page.evaluate(() => { const p = window.skybound.debug().cameraPosition(); return [p.x, p.y, p.z]; });
    expect(camPos.every((v: number) => Number.isFinite(v) && Math.abs(v) < 20000)).toBe(true);
    // Map click after rebase resolves to global coordinates near the bird.
    await page.keyboard.press('KeyM');
    await expect(page.locator('.worldmap')).toBeVisible();
    await page.click('.worldmap-top [data-action="recenter"]');
    const box = (await page.locator('.worldmap-canvas').boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const s = await dbg(page);
    expect(s.waypoint).not.toBeNull();
    expect(Math.hypot(s.waypoint.x - after.x, s.waypoint.z - after.z)).toBeLessThan(2 * s.mapView.metersPerPixel + 1);
    await page.keyboard.press('KeyM');
  });
});
