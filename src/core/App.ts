/**
 * App: owns the renderer, scene, systems and the simulation/render loop.
 * High-frequency state lives here and in the flight/world systems; UI
 * components only receive diffs at bounded rates.
 */
import * as THREE from 'three';
import { AudioSystem } from '../atmosphere/Audio';
import { Clouds } from '../atmosphere/Clouds';
import { DayCycle } from '../atmosphere/DayCycle';
import { Sky } from '../atmosphere/Sky';
import { WaterMaterial } from '../atmosphere/WaterMaterial';
import { Autopilot } from '../flight/Autopilot';
import { BirdModel } from '../flight/Bird';
import { CameraRig } from '../flight/CameraRig';
import { createFlightState, copyFlightState, emptyInput, FlightController, type FlightInput, type FlightState, type TerrainQuery, findSafeAirborne } from '../flight/FlightController';
import { InputManager } from '../flight/Input';
import { Minimap } from '../map/Minimap';
import { TileCache } from '../map/TileCache';
import { WorldMap } from '../map/WorldMap';
import { loadSave, writeSave, clearSave, type SaveData } from '../persistence/Save';
import { saveSettings, type Settings } from '../persistence/Settings';
import type { KeyValueStore } from '../persistence/Storage';
import { DevOverlay } from '../ui/DevOverlay';
import { HelpPanel } from '../ui/HelpPanel';
import { HUD } from '../ui/HUD';
import { PauseMenu } from '../ui/PauseMenu';
import { SettingsPanel } from '../ui/SettingsPanel';
import { StartScreen } from '../ui/StartScreen';
import { TouchControls } from '../ui/TouchControls';
import { ChunkManager } from '../world/ChunkManager';
import { bearingTo, wrapAngle } from '../world/coords';
import { LandmarkManager } from '../world/Landmarks';
import { Origin } from '../world/Origin';
import { VegetationLibrary } from '../world/Vegetation';
import { WorldGen } from '../world/WorldGen';
import { FixedStepClock } from './Clock';
import { FLIGHT, QUALITY_PRESETS, SAVE_VERSION, SEA_LEVEL, WAYPOINT_ARRIVE_RADIUS, WORLD_GEN_VERSION, type QualitySettings } from './config';
import { Navigation } from './Navigation';

export interface AppOptions {
  seed: number;
  save: SaveData | null;
  settings: Settings;
  store: KeyValueStore;
  /** Seed came from the URL. */
  urlSeed: boolean;
}

type Phase = 'loading' | 'start' | 'flying' | 'paused';

const _v = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly worldRoot = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly gen: WorldGen;
  readonly origin: Origin;
  readonly chunks: ChunkManager;
  readonly landmarks: LandmarkManager;
  readonly flight: FlightController;
  readonly autopilot: Autopilot;
  readonly input: InputManager;
  readonly cameraRig: CameraRig;
  readonly day = new DayCycle();
  readonly nav = new Navigation();
  readonly clock = new FixedStepClock();
  readonly audio = new AudioSystem();
  private sky: Sky;
  private clouds: Clouds;
  private waterMat: WaterMaterial;
  private veg: VegetationLibrary;
  private bird: BirdModel;
  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private fog: THREE.Fog;
  private tiles: TileCache;
  private minimap: Minimap;
  private worldMap: WorldMap;
  private hud: HUD;
  private startScreen: StartScreen;
  private pauseMenu: PauseMenu;
  private settingsPanel: SettingsPanel;
  private help: HelpPanel;
  private dev: DevOverlay;
  private touch: TouchControls | null = null;
  private settings: Settings;
  private quality: QualitySettings;
  private store: KeyValueStore;
  private phase: Phase = 'loading';
  private phaseBeforeMap: Phase = 'flying';
  private prevState: FlightState = createFlightState();
  private renderState: FlightState = createFlightState();
  private frameInput: FlightInput = emptyInput();
  private apInput: FlightInput = emptyInput();
  private lastFrame = 0;
  private simTime = 0;
  private wallTime = 0;
  private lastSave = 0;
  private saveDirty = false;
  private raf = 0;
  private frameEma = 16;
  private fpsCounter = { frames: 0, time: 0, fps: 60 };
  private pixelRatio = 1;
  private lastDprAdjust = 0;
  private arrivedWaypointKey: string | null = null;
  private mapOpenedOnce = false;
  private isTouch: boolean;
  private stepCounter = 0;
  private disposed = false;
  private seedIsUrl: boolean;
  readonly seed: number;

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement, opts: AppOptions) {
    this.seed = opts.seed;
    this.seedIsUrl = opts.urlSeed;
    this.settings = opts.settings;
    this.store = opts.store;
    this.quality = QUALITY_PRESETS[this.settings.quality];
    this.isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

    // Renderer.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.3, 30000);
    this.scene.add(this.worldRoot);

    // World.
    this.gen = new WorldGen(opts.seed);
    this.origin = new Origin(this.worldRoot);
    this.veg = new VegetationLibrary();
    this.waterMat = new WaterMaterial();
    const workers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    this.chunks = new ChunkManager(this.worldRoot, this.gen, this.veg, this.waterMat, this.quality, workers);
    this.chunks.setShadows(this.quality.shadows);
    this.landmarks = new LandmarkManager(this.worldRoot, this.gen);

    // Terrain query shared by flight, autopilot and camera.
    const terrain: TerrainQuery = {
      heightAt: (x, z) => this.chunks.heightAt(x, z),
      forEachObstacleNear: (x, z, r, cb) => {
        let stop = false;
        this.chunks.forEachTreeNear(x, z, r, (t) => {
          if (cb({ x: t.x, z: t.z, radius: t.radius * 0.7, bottom: t.y, top: t.top }) === true) { stop = true; return true; }
        });
        if (stop) return;
        this.landmarks.forEachColliderNear(x, z, r, (cx, cz, cr, bottom, top) => cb({ x: cx, z: cz, radius: cr, bottom, top }));
      },
    };
    this.flight = new FlightController(terrain);
    this.autopilot = new Autopilot(terrain, (opts.seed % 1000) / 100);
    this.flight.onImpact = (speed, kind) => this.onImpact(speed, kind);

    // Bird & camera.
    this.bird = new BirdModel();
    this.bird.group.scale.setScalar(1.6);
    this.scene.add(this.bird.group);
    this.cameraRig = new CameraRig(this.camera, (x, z) => this.chunks.surfaceAt(x, z));
    this.cameraRig.reducedMotion = this.settings.reducedMotion;

    // Atmosphere.
    this.sky = new Sky(opts.seed);
    this.scene.add(this.sky.group);
    this.clouds = new Clouds(opts.seed);
    this.clouds.visible = this.quality.clouds;
    this.scene.add(this.clouds.group);
    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.sun.castShadow = this.quality.shadows;
    this.sun.shadow.mapSize.set(this.settings.quality === 'high' ? 2048 : 1024, this.settings.quality === 'high' ? 2048 : 1024);
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 1600;
    this.sun.shadow.camera.left = -220;
    this.sun.shadow.camera.right = 220;
    this.sun.shadow.camera.top = 220;
    this.sun.shadow.camera.bottom = -220;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0x9fc3ea, 0x6e6a58, 1);
    this.scene.add(this.hemi);
    this.fog = new THREE.Fog(0xc9dff2, this.quality.fogFar * 0.22, this.quality.fogFar);
    this.scene.fog = this.fog;

    // Input.
    this.input = new InputManager(canvas);
    this.input.sensitivity = this.settings.sensitivity;
    this.input.invertVertical = this.settings.invertVertical;

    // Map & UI.
    this.tiles = new TileCache(this.chunks.workerPool);
    this.hud = new HUD(ui);
    this.minimap = new Minimap(ui, this.tiles, {
      getPlayer: () => ({ x: this.renderState.x, z: this.renderState.z, heading: this.renderState.heading }),
      getLandmarks: () => this.landmarks.landmarks,
      nav: this.nav,
      onOpenMap: () => this.toggleMap(),
      onZoomChange: (z) => { this.settings.minimapZoom = z; saveSettings(this.store, this.settings); },
    }, this.settings.minimapZoom);
    this.worldMap = new WorldMap(ui, this.tiles, {
      nav: this.nav,
      landmarks: this.landmarks.landmarks,
      getPlayer: () => ({ x: this.flight.state.x, z: this.flight.state.z, heading: this.flight.state.heading }),
      onClose: () => this.closeMap(),
      onWaypointSet: (x, z, id) => this.setWaypoint(x, z, id),
      onWaypointClear: () => { this.nav.clearWaypoint(); this.autopilot.target = null; this.hud.toast('Waypoint cleared'); this.saveDirty = true; },
    });
    this.help = new HelpPanel(ui, this.isTouch);
    this.dev = new DevOverlay(ui);
    this.dev.setVisible(this.settings.showDevOverlay);
    this.settingsPanel = new SettingsPanel(ui, this.settings, {
      onChange: (s) => this.applySettings(s),
      onClose: () => this.closeSettings(),
      getTimeOfDay: () => this.day.time,
      setTimeOfDay: (t) => { this.day.setTime(t); this.saveDirty = true; },
      getCycling: () => this.day.cycling,
      setCycling: (c) => { this.day.cycling = c; this.saveDirty = true; },
    });
    this.pauseMenu = new PauseMenu(ui, {
      onResume: () => this.resume(),
      onSettings: () => this.openSettings(),
      onHelp: () => { this.help.toggle(); },
      onNewWorld: () => { clearSave(this.store); },
      onResetProgress: () => { this.nav.reset(); this.autopilot.target = null; this.arrivedWaypointKey = null; this.save(true); this.hud.toast('Progress reset'); },
    });
    if (this.isTouch) {
      document.body.classList.add('has-touch');
      this.touch = new TouchControls(ui, canvas, this.input, {
        onMap: () => this.toggleMap(),
        onAutopilot: () => this.toggleAutopilot(),
        onRecover: () => this.recover(),
        onPause: () => this.togglePause(),
        onCamera: () => this.cycleCamera(),
      });
    }
    this.startScreen = new StartScreen(ui, {
      seed: opts.seed,
      hasSave: !!opts.save,
      onStart: (mode, seedText) => this.onStartPressed(mode, seedText),
      onSettings: () => this.openSettings(),
    });
    this.hud.setVisible(false);
    this.minimap.setVisible(false);

    // Initial flight state.
    if (opts.save) this.restore(opts.save);
    else this.placeAtShowcaseStart();
    copyFlightState(this.flight.state, this.prevState);
    copyFlightState(this.flight.state, this.renderState);
    this.origin.setOrigin(Math.round(this.flight.state.x / 1000) * 1000, Math.round(this.flight.state.z / 1000) * 1000);
    this.cameraRig.setOrigin(this.origin.value.x, this.origin.value.z);
    this.chunks.onFirstChunksReady = () => this.onWorldReady();
    this.chunks.update(this.flight.state.x, this.flight.state.z, Math.sin(this.flight.state.heading), -Math.cos(this.flight.state.heading), 0, true);
    this.landmarks.update(this.flight.state.x, this.flight.state.z, 1, this.quality.shadows);

    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('beforeunload', this.onPageHide);
    this.onResize();
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.loop);
    // Fallback: if chunks take long (slow device), enable Start after 6 s anyway.
    setTimeout(() => { if (this.phase === 'loading') this.onWorldReady(); }, 6000);
  }

  // ---------------------------------------------------------------------
  // Setup helpers
  // ---------------------------------------------------------------------

  private placeAtShowcaseStart(): void {
    // Compose the opening: between the wetland coast and the mountain spine,
    // facing the peaks, so water, forest, and mountains share the frame.
    const L = this.gen.layout;
    const wet = this.gen.regionToWorld(L.wet.x, L.wet.y);
    const spine = this.gen.regionToWorld(L.spine[1][0], L.spine[1][1]);
    const t = 0.3;
    const x = wet.x + (spine.x - wet.x) * t;
    const z = wet.z + (spine.z - wet.z) * t;
    const heading = bearingTo(x, z, spine.x, spine.z);
    const safe = findSafeAirborne(
      { heightAt: (a, b) => this.gen.heightAt(a, b), forEachObstacleNear: () => {} },
      x, z, heading, 200,
    );
    const s = this.flight.state;
    s.x = safe.x; s.z = safe.z; s.y = Math.max(safe.y, 220);
    s.heading = heading;
    s.pitch = 0;
    s.speed = FLIGHT.cruiseSpeed;
    this.day.setTime(0.31);
  }

  private restore(save: SaveData): void {
    const s = this.flight.state;
    s.x = save.position.x; s.y = save.position.y; s.z = save.position.z;
    s.heading = save.heading;
    s.pitch = save.pitch;
    s.speed = save.speed;
    s.boost = save.boost;
    s.odometer = save.odometer;
    // Validate: keep the bird above safe terrain with clearance.
    const ground = Math.max(this.gen.heightAt(s.x, s.z), SEA_LEVEL);
    if (s.y < ground + 25) s.y = ground + 60;
    this.day.setTime(save.timeOfDay);
    this.day.cycling = save.cycling;
    this.nav.load(save.discovered, save.explored, save.waypoint);
    if (save.waypoint) this.autopilot.target = { x: save.waypoint.x, z: save.waypoint.z };
    this.autopilot.enabled = save.autopilot;
    this.cameraRig.setMode(save.cameraMode);
  }

  private onWorldReady(): void {
    if (this.phase !== 'loading') return;
    this.phase = 'start';
    this.startScreen.setReady(true, `Seed ${this.seed} · ${this.landmarks.landmarks.length} landmarks to find`);
  }

  private onStartPressed(mode: 'continue' | 'new', seedText: string): void {
    const parsed = WorldGen.parseSeed(seedText, this.seed);
    if (mode === 'new' && parsed !== this.seed) {
      clearSave(this.store);
      const url = new URL(window.location.href);
      url.searchParams.set('seed', seedText.trim());
      url.searchParams.set('fresh', '1');
      window.location.href = url.toString();
      return;
    }
    if (mode === 'new') {
      clearSave(this.store);
      this.nav.reset();
    }
    this.beginFlight();
  }

  private beginFlight(): void {
    this.audio.start();
    this.audio.setVolume(this.settings.volume);
    this.audio.setMuted(this.settings.muted);
    this.startScreen.hide();
    this.hud.setVisible(true);
    this.minimap.setVisible(true);
    this.touch?.setVisible(true);
    this.phase = 'flying';
    this.clock.reset();
    this.lastFrame = performance.now();
    this.cameraRig.snap();
    if (!this.settings.helpSeen) {
      this.help.show(11000);
      this.settings.helpSeen = true;
      saveSettings(this.store, this.settings);
    }
    if (this.autopilot.enabled) this.hud.toast('Autopilot engaged (F to take control)');
    this.saveDirty = true;
  }

  // ---------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.5) dt = 0.5;
    this.wallTime += dt;
    this.frameEma += (dt * 1000 - this.frameEma) * 0.08;
    this.fpsCounter.frames++;
    this.fpsCounter.time += dt;
    if (this.fpsCounter.time >= 0.5) {
      this.fpsCounter.fps = this.fpsCounter.frames / this.fpsCounter.time;
      this.fpsCounter.frames = 0;
      this.fpsCounter.time = 0;
    }

    this.handleActions();

    if (this.phase === 'flying' && !this.worldMap.isOpen) {
      const steps = this.clock.advance(dt);
      if (steps > 0) copyFlightState(this.flight.state, this.prevState);
      const cam = this.input.takeCamera();
      for (let i = 0; i < steps; i++) this.simStep();
      this.interpolate(steps > 0 ? this.clock.alpha : 1);
      this.day.advance(dt);
      this.cameraRig.update(dt, this.renderState, cam);
      this.bird.update(dt, {
        flap: this.flight.state.flapping ? 1 : this.flight.state.boosting ? 0.6 : 0,
        beatRate: this.flight.state.boosting ? 1.35 : 1,
        pitchInput: this.flight.state.pitchSmooth,
        turnInput: this.flight.state.turnSmooth,
        speed: this.flight.state.speed,
        brake: this.frameInput.brake,
      });
      this.audio.update(dt, this.flight.state.speed, this.flight.state.flapping, this.flight.state.boosting, this.flight.state.boosting ? 1.35 : 1);
    } else if (this.phase === 'start') {
      // Idle: gentle glide animation, camera slowly orbits.
      this.input.takeCamera();
      this.bird.update(dt, { flap: 0, beatRate: 1, pitchInput: 0, turnInput: 0, speed: 30, brake: 0 });
      this.day.advance(dt * 0.15);
      const cam = { orbitYaw: 0.05 * dt, orbitPitch: 0, zoom: 0, dragging: true };
      this.cameraRig.update(dt, this.renderState, cam);
    } else {
      this.input.takeCamera();
    }

    // Bounded GPU uploads of finished chunks/tiles each frame.
    this.chunks.processInstalls(this.phase === 'flying' ? 4 : 12, this.phase === 'flying' ? 6 : 24);

    if (this.worldMap.isOpen) {
      // Map covers the screen; skip the 3D render but keep streaming alive.
      this.chunks.update(this.flight.state.x, this.flight.state.z, Math.sin(this.flight.state.heading), -Math.cos(this.flight.state.heading), this.wallTime);
      return;
    }

    this.updateWorld(dt);
    this.render();
    this.updateUI(dt);
    if (this.saveDirty && this.wallTime - this.lastSave > 5) this.save(false);
  };

  private simStep(): void {
    const s = this.flight.state;
    this.input.read(this.frameInput);
    let input = this.frameInput;
    if (this.autopilot.enabled) {
      if (this.input.manualActive) {
        this.autopilot.enabled = false;
        this.hud.toast('Manual control');
      } else {
        this.autopilot.update(this.clock.step, s, this.apInput);
        input = this.apInput;
      }
    }
    this.flight.step(input, this.clock.step);
    this.simTime += this.clock.step;
    this.stepCounter++;
    if (this.stepCounter % 6 === 0) {
      if (this.nav.markExplored(s.x, s.z)) this.saveDirty = true;
      this.checkDiscovery();
      this.checkWaypoint();
    }
    if (this.origin.maybeRebase(s.x, s.z)) {
      this.cameraRig.setOrigin(this.origin.value.x, this.origin.value.z);
    }
  }

  private interpolate(alpha: number): void {
    const a = this.prevState, b = this.flight.state, r = this.renderState;
    copyFlightState(b, r);
    if (alpha >= 1) return;
    r.x = a.x + (b.x - a.x) * alpha;
    r.y = a.y + (b.y - a.y) * alpha;
    r.z = a.z + (b.z - a.z) * alpha;
    r.pitch = a.pitch + (b.pitch - a.pitch) * alpha;
    r.roll = a.roll + (b.roll - a.roll) * alpha;
    r.heading = a.heading + wrapAngle(b.heading - a.heading) * alpha;
  }

  private updateWorld(dt: number): void {
    const s = this.flight.state;
    const r = this.renderState;
    const fwdX = Math.sin(s.heading), fwdZ = -Math.cos(s.heading);
    this.chunks.update(s.x, s.z, fwdX, fwdZ, this.wallTime);
    this.landmarks.update(s.x, s.z, this.wallTime, this.quality.shadows);

    // Bird transform (render space).
    const bx = r.x - this.origin.value.x, bz = r.z - this.origin.value.z;
    this.bird.group.position.set(bx, r.y, bz);
    _euler.set(r.pitch, -r.heading, r.roll, 'YXZ');
    this.bird.group.quaternion.setFromEuler(_euler);

    // Lighting & atmosphere.
    const pal = this.day.compute();
    this.day.keyLightDir(_v);
    this.sun.position.set(bx + _v.x * 700, r.y + _v.y * 700, bz + _v.z * 700);
    this.sun.target.position.set(bx, r.y, bz);
    this.sun.color.copy(pal.sunColor);
    this.sun.intensity = pal.sunIntensity;
    this.hemi.color.copy(pal.ambientSky);
    this.hemi.groundColor.copy(pal.ambientGround);
    this.hemi.intensity = pal.ambientIntensity;
    this.fog.color.copy(pal.fog);
    this.renderer.setClearColor(pal.fog);
    this.sky.update(this.camera.position, pal, this.day.sunDir, this.day.moonDir, this.simTime);
    if (this.quality.clouds) this.clouds.update(this.camera.position, this.origin.value.x, this.origin.value.z, this.simTime, this.day.sunDir, pal.sunColor, pal.daylight, pal.fog);
    const wu = this.waterMat.uniforms;
    wu.uTime.value = this.simTime;
    (wu.uOrigin.value as THREE.Vector2).set(this.origin.value.x, this.origin.value.z);
    (wu.uSunDir.value as THREE.Vector3).copy(_v);
    (wu.uSunColor.value as THREE.Color).copy(pal.sunColor);
    (wu.uSkyColor.value as THREE.Color).copy(pal.horizon).lerp(pal.zenith, 0.5);
    wu.uAmbient.value = THREE.MathUtils.lerp(0.35, 1, pal.daylight);
    void dt;
  }

  private render(): void {
    this.renderer.render(this.scene, this.camera);
    this.adjustResolution();
  }

  private adjustResolution(): void {
    if (!this.settings.dynamicResolution || this.phase !== 'flying') return;
    if (this.wallTime - this.lastDprAdjust < 1.5) return;
    const maxPr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    let next = this.pixelRatio;
    if (this.frameEma > 24 && this.pixelRatio > 0.6) next = Math.max(0.6, this.pixelRatio - 0.1);
    else if (this.frameEma < 13 && this.pixelRatio < maxPr) next = Math.min(maxPr, this.pixelRatio + 0.1);
    if (Math.abs(next - this.pixelRatio) > 0.01) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.lastDprAdjust = this.wallTime;
    }
  }

  private updateUI(dt: number): void {
    void dt;
    if (this.phase === 'flying' || this.phase === 'paused') {
      const s = this.renderState;
      const ground = this.chunks.surfaceAt(s.x, s.z);
      const wp = this.nav.toWaypoint(s.x, s.z);
      const lm = this.nav.waypoint?.landmarkId ? this.landmarks.get(this.nav.waypoint.landmarkId) : null;
      this.hud.update({
        speed: s.speed,
        altitudeAGL: s.y - ground,
        altitudeASL: s.y,
        heading: s.heading,
        boost: (s.boost / FLIGHT.boostCapacity) * 100,
        boosting: s.boosting,
        autopilot: this.autopilot.enabled,
        autopilotStatus: this.autopilot.status,
        waypoint: wp ? { bearing: wp.bearing, distance: wp.distance, name: lm ? lm.name : null } : null,
        timeLabel: this.day.label,
        cameraMode: this.cameraRig.mode,
      });
      this.minimap.update(this.wallTime);
      this.settingsPanel.syncTime();
    }
    if (this.dev.visible) {
      const st = this.chunks.stats();
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      this.dev.update(this.wallTime, {
        fps: this.fpsCounter.fps,
        frameMs: this.frameEma,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        chunks: st.loaded,
        farTiles: st.farLoaded,
        pendingJobs: st.pending,
        queuedJobs: st.queued,
        trees: st.trees,
        seed: this.seed,
        x: this.flight.state.x, y: this.flight.state.y, z: this.flight.state.z,
        originX: this.origin.value.x, originZ: this.origin.value.z,
        pixelRatio: this.pixelRatio,
        simSteps: this.clock.steps,
        dropped: this.clock.dropped,
        tiles: this.tiles.size,
        memoryMB: mem ? mem.usedJSHeapSize / 1048576 : null,
      });
    }
  }

  // ---------------------------------------------------------------------
  // Gameplay events
  // ---------------------------------------------------------------------

  private checkDiscovery(): void {
    const s = this.flight.state;
    for (const lm of this.landmarks.within(s.x, s.z)) {
      if (this.nav.discover(lm.id)) {
        this.hud.toast(`Discovered: ${lm.name}`, 'discover', 4500);
        this.audio.chime('discover');
        this.saveDirty = true;
      }
    }
  }

  private checkWaypoint(): void {
    const wp = this.nav.waypoint;
    if (!wp) return;
    const s = this.flight.state;
    const key = `${wp.x},${wp.z}`;
    if (this.arrivedWaypointKey === key) return;
    const d = Math.hypot(wp.x - s.x, wp.z - s.z);
    const ground = this.chunks.surfaceAt(wp.x, wp.z);
    // Arrival: within horizontal radius and not absurdly high above the spot.
    if (d < WAYPOINT_ARRIVE_RADIUS && s.y - ground < 450) {
      this.arrivedWaypointKey = key;
      const lm = wp.landmarkId ? this.landmarks.get(wp.landmarkId) : null;
      this.hud.toast(lm ? `Arrived at ${lm.name}` : 'Waypoint reached', 'info', 4000);
      this.audio.chime('waypoint');
      if (!this.autopilot.enabled) {
        this.nav.clearWaypoint();
        this.autopilot.target = null;
      }
      this.saveDirty = true;
    }
  }

  private setWaypoint(x: number, z: number, landmarkId: string | null): void {
    this.nav.setWaypoint(x, z, landmarkId);
    this.autopilot.target = { x, z };
    this.arrivedWaypointKey = null;
    if (this.autopilot.status === 'arrived' || this.autopilot.status === 'loitering') this.autopilot.status = 'enroute';
    const lm = landmarkId ? this.landmarks.get(landmarkId) : null;
    this.hud.toast(lm ? `Destination: ${lm.name}` : 'Waypoint set', 'info');
    this.saveDirty = true;
  }

  private onImpact(speed: number, kind: 'terrain' | 'water' | 'obstacle'): void {
    const strength = Math.min(1, speed / 60);
    this.cameraRig.addShake(0.3 + strength * 0.6);
    this.audio.thump(strength);
    if (kind === 'water') this.hud.toast('Splash! Pull up.', 'warn', 1800);
    else if (kind === 'obstacle') this.hud.toast('Bumped into something.', 'warn', 1800);
    else this.hud.toast('Ground contact. Climb!', 'warn', 1800);
  }

  private recover(): void {
    this.flight.recover();
    copyFlightState(this.flight.state, this.prevState);
    copyFlightState(this.flight.state, this.renderState);
    this.cameraRig.snap();
    this.hud.toast('Recovered to safe air');
    this.saveDirty = true;
  }

  private toggleAutopilot(): void {
    this.autopilot.enabled = !this.autopilot.enabled;
    if (this.autopilot.enabled) {
      this.autopilot.target = this.nav.waypoint ? { x: this.nav.waypoint.x, z: this.nav.waypoint.z } : null;
      this.hud.toast(this.nav.waypoint ? 'Autopilot: flying to waypoint' : 'Autopilot: exploring');
    } else {
      this.hud.toast('Manual control');
    }
    this.saveDirty = true;
  }

  private cycleCamera(): void {
    const mode = this.cameraRig.cycleMode();
    this.hud.toast(`${mode === 'chase' ? 'Chase' : 'Cinematic'} camera`);
    this.saveDirty = true;
  }

  // ---------------------------------------------------------------------
  // Overlays & phases
  // ---------------------------------------------------------------------

  private handleActions(): void {
    for (const a of this.input.takeActions()) {
      switch (a) {
        case 'escape':
          if (this.worldMap.isOpen) this.closeMap();
          else if (this.settingsPanel.visible) this.closeSettings();
          else if (this.phase === 'flying') this.pause();
          else if (this.phase === 'paused') this.resume();
          break;
        case 'toggleMap':
          if (this.phase === 'flying' || this.phase === 'paused' || this.worldMap.isOpen) this.toggleMap();
          break;
        case 'toggleAutopilot':
          if (this.phase === 'flying') this.toggleAutopilot();
          break;
        case 'recover':
          if (this.phase === 'flying') this.recover();
          break;
        case 'toggleHelp':
          if (this.phase === 'flying' || this.phase === 'paused') this.help.toggle();
          break;
        case 'cycleCamera':
          if (this.phase === 'flying') this.cycleCamera();
          break;
        case 'togglePause':
          this.togglePause();
          break;
        case 'toggleDev':
          this.settings.showDevOverlay = !this.settings.showDevOverlay;
          this.dev.setVisible(this.settings.showDevOverlay);
          saveSettings(this.store, this.settings);
          break;
      }
    }
  }

  private togglePause(): void {
    if (this.phase === 'flying') this.pause();
    else if (this.phase === 'paused') this.resume();
  }

  pause(): void {
    if (this.phase !== 'flying') return;
    this.phase = 'paused';
    this.input.clear();
    this.touch?.resetAll();
    this.input.blocked = true;
    void this.audio.suspend();
    const s = this.flight.state;
    this.pauseMenu.show(`Seed ${this.seed} · ${(s.odometer / 1000).toFixed(1)} km flown · ${this.nav.discovered.size}/${this.landmarks.landmarks.length} landmarks`);
    this.save(true);
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.pauseMenu.hide();
    this.settingsPanel.hide();
    this.phase = 'flying';
    this.input.blocked = false;
    this.input.clear();
    this.clock.reset();
    this.lastFrame = performance.now();
    void this.audio.resume();
  }

  private toggleMap(): void {
    if (this.worldMap.isOpen) this.closeMap();
    else this.openMap();
  }

  private openMap(): void {
    if (this.worldMap.isOpen || this.phase === 'loading' || this.phase === 'start') return;
    this.phaseBeforeMap = this.phase;
    this.input.clear();
    this.touch?.resetAll();
    this.input.blocked = true;
    if (this.phase === 'flying') void this.audio.suspend();
    this.pauseMenu.hide();
    this.hud.setVisible(false);
    this.minimap.setVisible(false);
    this.touch?.setVisible(false);
    this.worldMap.show(!this.mapOpenedOnce);
    this.mapOpenedOnce = true;
    this.save(true);
  }

  private closeMap(): void {
    if (!this.worldMap.isOpen) return;
    this.worldMap.hide();
    this.hud.setVisible(true);
    this.minimap.setVisible(true);
    this.touch?.setVisible(true);
    this.input.blocked = this.phaseBeforeMap !== 'flying';
    this.input.clear();
    if (this.phaseBeforeMap === 'paused') {
      this.pauseMenu.show(`Seed ${this.seed}`);
    } else {
      this.clock.reset();
      this.lastFrame = performance.now();
      void this.audio.resume();
    }
    this.minimap.update(this.wallTime);
  }

  private openSettings(): void {
    this.settingsPanel.show(this.settings);
    this.input.clear();
    this.input.blocked = true;
    if (this.phase === 'flying') {
      // Settings pause the flight like the menu does.
      this.phase = 'paused';
      void this.audio.suspend();
    }
  }

  private closeSettings(): void {
    this.settingsPanel.hide();
    saveSettings(this.store, this.settings);
    if (this.phase === 'paused' && !this.pauseMenu.visible) this.resume();
    else if (this.phase === 'start') this.input.blocked = false;
  }

  private applySettings(s: Settings): void {
    const prevQuality = this.settings.quality;
    this.settings = s;
    saveSettings(this.store, s);
    this.input.sensitivity = s.sensitivity;
    this.input.invertVertical = s.invertVertical;
    this.cameraRig.reducedMotion = s.reducedMotion;
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.dev.setVisible(s.showDevOverlay);
    if (s.quality !== prevQuality) this.applyQuality(QUALITY_PRESETS[s.quality]);
    if (!s.dynamicResolution) {
      this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
      this.renderer.setPixelRatio(this.pixelRatio);
      this.onResize();
    }
  }

  private applyQuality(q: QualitySettings): void {
    this.quality = q;
    this.renderer.shadowMap.enabled = q.shadows;
    this.sun.castShadow = q.shadows;
    const size = this.settings.quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(size, size);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.chunks.setShadows(q.shadows);
    this.chunks.setQuality(q);
    this.landmarks.setShadows(q.shadows);
    this.clouds.visible = q.clouds;
    this.fog.near = q.fogFar * 0.22;
    this.fog.far = q.fogFar;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, q.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.onResize();
    this.chunks.update(this.flight.state.x, this.flight.state.z, Math.sin(this.flight.state.heading), -Math.cos(this.flight.state.heading), this.wallTime, true);
  }

  // ---------------------------------------------------------------------
  // Persistence & lifecycle
  // ---------------------------------------------------------------------

  save(force: boolean): void {
    if (this.phase === 'loading' || this.phase === 'start') return;
    if (!force && this.wallTime - this.lastSave < 5) return;
    const s = this.flight.state;
    const data: SaveData = {
      version: SAVE_VERSION,
      worldVersion: WORLD_GEN_VERSION,
      seed: this.seed,
      savedAt: Date.now(),
      position: { x: s.x, y: s.y, z: s.z },
      heading: s.heading,
      pitch: s.pitch,
      speed: s.speed,
      boost: s.boost,
      timeOfDay: this.day.time,
      cycling: this.day.cycling,
      autopilot: this.autopilot.enabled,
      cameraMode: this.cameraRig.mode,
      discovered: Array.from(this.nav.discovered),
      explored: Array.from(this.nav.explored),
      waypoint: this.nav.waypoint ? { ...this.nav.waypoint } : null,
      odometer: s.odometer,
    };
    writeSave(this.store, data);
    this.lastSave = this.wallTime;
    this.saveDirty = false;
  }

  private onResize = (): void => {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.minimap.resize();
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      if (this.phase === 'flying') this.pause();
      this.save(true);
    }
  };

  private onPageHide = (): void => {
    this.save(true);
  };

  /** Expose a few things for browser tests. */
  debug() {
    return {
      seed: this.seed,
      phase: this.phase,
      state: this.flight.state,
      nav: this.nav,
      landmarks: this.landmarks.landmarks,
      chunks: this.chunks.stats(),
      autopilot: this.autopilot,
      origin: this.origin.value,
      day: this.day,
      loadedAtPlayer: this.chunks.isLoadedAt(this.flight.state.x, this.flight.state.z),
      groundAt: (x: number, z: number) => this.chunks.heightAt(x, z),
      setWaypoint: (x: number, z: number) => this.setWaypoint(x, z, null),
      teleport: (x: number, z: number, y?: number) => {
        const s = this.flight.state;
        s.x = x; s.z = z;
        s.y = y ?? Math.max(this.gen.heightAt(x, z), SEA_LEVEL) + 120;
        copyFlightState(s, this.prevState);
        copyFlightState(s, this.renderState);
        this.cameraRig.snap();
        this.chunks.update(x, z, Math.sin(s.heading), -Math.cos(s.heading), this.wallTime, true);
      },
      save: () => this.save(true),
      frameMs: () => this.frameEma,
      fps: () => this.fpsCounter.fps,
      renderInfo: () => ({ calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles }),
      seedIsUrl: this.seedIsUrl,
      worldRoot: this.worldRoot,
      landmarkMeshes: () => this.landmarks.meshInfo(),
    };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('beforeunload', this.onPageHide);
    this.input.dispose();
    this.touch?.dispose();
    this.chunks.dispose();
    this.landmarks.dispose();
    this.veg.dispose();
    this.waterMat.dispose();
    this.sky.dispose();
    this.clouds.dispose();
    this.bird.dispose();
    this.audio.dispose();
    this.renderer.dispose();
  }
}
