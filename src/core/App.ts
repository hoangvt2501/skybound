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
import { BIRD_SPECIES } from '../flight/BirdSpecies';
import { Wildlife, type Observer } from '../world/Wildlife';
import { BirdModel } from '../flight/Bird';
import { LANDING, PerchFinder, canCapture, landingFlare, landingProgress, type Perch } from '../flight/Perches';
import { renderBirdPortraits } from '../ui/BirdPortraits';
import { PhotoPanel } from '../ui/PhotoPanel';
import { SplashEffects } from '../atmosphere/Splash';
import { ScaledFrame } from './ScaledFrame';
import { LightShafts } from '../atmosphere/LightShafts';
import { Airflow, type Thermal } from '../flight/Airflow';
import { ThermalMotes } from '../atmosphere/ThermalMotes';
import { hash2, Rng } from '../world/noise';
import { CameraRig } from '../flight/CameraRig';
import { createFlightState, copyFlightState, emptyInput, FlightController, type FlightInput, type FlightState, type TerrainQuery, findSafeAirborne, DEFAULT_PROFILE } from '../flight/FlightController';
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
import { WorldGen, createTerrainSample } from '../world/WorldGen';
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
  /** The save was migrated from an older world-generation version. */
  migrated?: boolean;
}

type Phase = 'loading' | 'start' | 'flying' | 'paused' | 'photo';

const _v = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _hazeTint = new THREE.Color();
/** Lowest adaptive render scale; below this the blur costs more than a few missed refreshes. */
const MIN_RENDER_SCALE = 0.7;

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
  private wildlife: Wildlife;
  private splash: SplashEffects;
  private shafts: LightShafts;
  private photoPanel: PhotoPanel;
  private photoHideBird = false;
  private lastPhotoBytes = 0;
  private airflow: Airflow;
  private motes: ThermalMotes;
  private liftSample = { total: 0, thermal: 0, ridge: 0, nearest: null as Thermal | null };
  private thermalScratch: Thermal[] = [];
  private valleyAxis = new THREE.Vector2(0, -1);
  private valleyScratch = { mask: 0, t: 0, dist: 0 };
  private valleyReady = false;
  /** Diagnostic switches (debug hooks) for same-session cost attribution. */
  private diag = { mist: true, lookahead: true };
  private lastSkimRing = 0;
  private lastSkimContact = 0;
  /** Player position, velocity and boost as the wildlife sees them (reused every frame). */
  private wildlifeObserver: Observer = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, boosting: false };
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
  private phaseBeforeSettings: Phase = 'start';
  private prevState: FlightState = createFlightState();
  private renderState: FlightState = createFlightState();
  private frameInput: FlightInput = emptyInput();
  private apInput: FlightInput = emptyInput();
  private lastFrame = 0;
  private simTime = 0;
  private perches!: PerchFinder;
  /** Landing on, sitting on or leaving a perch; null in free flight. The physics step pauses meanwhile. */
  private perchState: { phase: 'landing' | 'perched' | 'takeoff'; perch: Perch; t: number; from: { x: number; y: number; z: number; pitch: number; speed: number } } | null = null;
  private perchCandidate: Perch | null = null;
  private perchScanAt = -Infinity;
  private perchHintId = '';
  private perchHintAt = -Infinity;
  private lastTakeoffAt = -Infinity;
  private perchMarker!: THREE.Sprite;
  /** Soft contact shadow under the bird while it lands, sits and hops off: grounds it on the perch. */
  private perchShadow!: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private wallTime = 0;
  private lastSave = 0;
  private lastUiUpdate = -1;
  private saveDirty = false;
  private raf = 0;
  private frameEma = 16;
  private fpsCounter = { frames: 0, time: 0, fps: 60 };
  private pixelRatio = 1;
  private lastDprAdjust = 0;
  private lastDprDrop = -Infinity;
  private lastTransientDrop = -Infinity;
  private lastProbeUp = -Infinity;
  private lastProbeJudged = -Infinity;
  private preProbeScale = MIN_RENDER_SCALE;
  /** Consecutive probes up that missed; each one doubles the wait before the ceiling is retried. */
  private probeFailures = 0;
  private settleUntil = -Infinity;
  private shortMissed = 0;
  private shortFrames = 0;
  private shadersWarm = false;
  /** Scene renders at `pixelRatio` into a scaled target and is upsampled onto the full-size canvas. */
  private frame = new ScaledFrame();
  private dprCeiling = Infinity;
  private missedFrames = 0;
  private windowFrames = 0;
  /** Refresh interval estimate (s), learned from the shortest frames seen. */
  private refreshInterval = 1 / 60;
  private arrivedWaypointKey: string | null = null;
  private isTouch: boolean;
  private stepCounter = 0;
  private disposed = false;
  private seedIsUrl: boolean;
  readonly seed: number;
  /** Debug/benchmark: when true the simulation does not step (rendering continues). */
  private frozen = false;
  /** Debug/benchmark: recent frame times in ms (bounded). */
  private frameLog: number[] = [];
  private canvasGrabbing = false;
  private migrated = false;
  private vegShaderHook: THREE.Material['onBeforeCompile'] | null = null;

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
    // The canvas keeps the preset's pixel ratio for the whole session; the adaptive render scale
    // lives in `frame` (a scaled render target), so scale changes never resize the canvas.
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.frame.setSize(window.innerWidth * this.pixelRatio, window.innerHeight * this.pixelRatio);
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
    this.flight.setProfile(this.profileFor(this.settings));
    this.autopilot = new Autopilot(terrain, (opts.seed % 1000) / 100);
    this.flight.onImpact = (speed, kind) => this.onImpact(speed, kind);
    this.splash = new SplashEffects();
    this.scene.add(this.splash.group);
    this.shafts = new LightShafts(12);
    this.scene.add(this.shafts.mesh);
    this.airflow = new Airflow(this.gen);
    this.flight.airflow = (x, y, z) => this.airflow.lift(x, y, z, this.day.time, this.liftSample).total;
    this.motes = new ThermalMotes();
    this.scene.add(this.motes.points);
    this.flight.onWater = (event, speed, steepness) => {
      if (event !== 'enter') return;
      const s = this.flight.state, dir = Math.sin(s.heading), dirZ = -Math.cos(s.heading);
      const strength = Math.min(1, 0.25 + speed / 70 * 0.5 + steepness * 0.6);
      this.splash.splash(s.x, s.z, strength, dir, dirZ, speed);
      this.wildlife.onWaterContact(s.x, s.z, strength, this.simTime);
      this.audio.splash(strength);
      this.cameraRig.addShake(0.15 + strength * 0.4);
      this.hud.toast(steepness > 0.45 ? 'Splash! Pull up.' : 'Skimming the water.', 'warn', 1400);
    };

    // Bird & camera.
    this.bird = new BirdModel(this.settings.birdSpecies);
    this.bird.group.scale.setScalar(1.6);
    this.scene.add(this.bird.group);
    this.perches = new PerchFinder(this.landmarks.landmarks, this.gen.seed, {
      forEachTreeNear: (x, z, r, cb) => this.chunks.forEachTreeNear(x, z, r, cb),
      heightAt: (x, z) => this.chunks.heightAt(x, z),
    });
    this.perchMarker = App.makePerchMarker();
    this.scene.add(this.perchMarker);
    this.perchShadow = App.makePerchShadow();
    this.scene.add(this.perchShadow);
    this.wildlife = new Wildlife(this.gen, {
      surfaceAt: (x, z) => this.chunks.surfaceAt(x, z),
      heightAt: (x, z) => this.chunks.heightAt(x, z),
      treeNear: (x, z, r) => this.chunks.treeNear(x, z, r),
    });
    this.scene.add(this.wildlife.group);
    this.wildlife.onFishSplash = (x, z, landing) => { if (landing) this.splash.splash(x, z, 0.12); else this.splash.ring(x, z, 0.7); };
    this.wildlife.onDuckRipple = (x, z, size) => this.splash.ring(x, z, size);
    this.wildlife.thermalFinder = (x, z, r) => this.airflow.thermalsNear(x, z, r, this.thermalScratch)[0] ?? null;
    this.cameraRig = new CameraRig(this.camera, {
      surfaceAt: (x, z) => this.chunks.surfaceAt(x, z),
      forEachObstacleNear: (x, z, r, cb) => terrain.forEachObstacleNear(x, z, r, cb),
    });
    this.cameraRig.reducedMotion = this.settings.reducedMotion;
    this.cameraRig.autoCenter = this.settings.autoCenterCamera;

    // Atmosphere.
    this.sky = new Sky(opts.seed);
    this.scene.add(this.sky.group);
    this.clouds = new Clouds(opts.seed, QUALITY_PRESETS.high.cloudPuffs);
    this.clouds.setBudget(this.quality.cloudPuffs);
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
    this.hud.onSettings = () => this.openSettings();
    this.hud.onPhoto = () => { if (this.phase === 'flying' && !this.worldMap.isOpen) this.enterPhoto(); };
    this.photoPanel = new PhotoPanel(ui, {
      onCapture: () => this.capturePhoto(),
      onExit: () => this.exitPhoto(),
      onFov: (fov) => { this.cameraRig.fovOverride = fov; },
      onTime: (t) => { this.day.setTime(t); },
      onHideBird: (hide) => { this.photoHideBird = hide; this.bird.group.visible = !hide; },
    });
    this.hud.onResetView = () => this.cameraRig.resetView();
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
    this.migrated = !!opts.migrated;
    if (opts.save) this.restore(opts.save, this.migrated);
    else this.placeAtShowcaseStart();
    copyFlightState(this.flight.state, this.prevState);
    copyFlightState(this.flight.state, this.renderState);
    this.origin.setOrigin(Math.round(this.flight.state.x / 1000) * 1000, Math.round(this.flight.state.z / 1000) * 1000);
    this.cameraRig.setOrigin(this.origin.value.x, this.origin.value.z);
    this.chunks.setOrigin(this.origin.value.x, this.origin.value.z);
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

  private restore(save: SaveData, migrated = false): void {
    const s = this.flight.state;
    s.x = save.position.x; s.y = save.position.y; s.z = save.position.z;
    s.heading = save.heading;
    s.pitch = save.pitch;
    s.speed = save.speed;
    s.boost = save.boost;
    s.odometer = save.odometer;
    if (migrated) {
      // Geography changed under the saved position: keep x/z but re-seat the
      // bird in validated clear air above the new terrain.
      const safe = findSafeAirborne({ heightAt: (a, b) => this.gen.heightAt(a, b), forEachObstacleNear: () => {} }, s.x, s.z, s.heading, 90);
      s.x = safe.x; s.y = Math.max(safe.y, s.y); s.z = safe.z;
      s.pitch = 0;
    }
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

  /** Compile every material already in the scene so the first balloon, boat or flock does not stall a frame. */
  private warmShaders(): void {
    const onDemand: THREE.Object3D[] = [this.motes.points, this.shafts.mesh, ...this.splash.group.children];
    const was = onDemand.map((o) => o.visible);
    for (const o of onDemand) o.visible = true;
    try {
      this.renderer.compile(this.scene, this.camera);
      this.frame.warm(this.renderer);
      // compile() only queues the links (KHR_parallel_shader_compile); the link result is read on a
      // program's first use, which would block that frame. Read it now, while the start screen is up.
      for (const program of this.renderer.info.programs ?? []) program.getUniforms();
    } catch (err) { console.warn('[skybound] shader warm-up skipped', err); }
    onDemand.forEach((o, i) => { o.visible = was[i]; });
  }

  /** A soft ring sprite hovering over the perch the bird is being offered. */
  private static makePerchShadow(): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
    const size = 64, canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(20, 18, 24, 0.85)');
    grad.addColorStop(0.45, 'rgba(20, 18, 24, 0.5)');
    grad.addColorStop(1, 'rgba(20, 18, 24, 0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, opacity: 0 }));
    mesh.renderOrder = 2; mesh.visible = false; mesh.name = 'perch-shadow';
    return mesh;
  }

  private static makePerchMarker(): THREE.Sprite {
    const size = 128, canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size * 0.5);
    grad.addColorStop(0, 'rgba(255, 240, 190, 0)');
    grad.addColorStop(0.55, 'rgba(255, 240, 190, 0)');
    grad.addColorStop(0.7, 'rgba(255, 240, 190, 0.9)');
    grad.addColorStop(0.82, 'rgba(255, 240, 190, 0.35)');
    grad.addColorStop(1, 'rgba(255, 240, 190, 0)');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(255, 246, 210, 0.95)';
    ctx.beginPath(); ctx.arc(size / 2, size / 2, size * 0.07, 0, Math.PI * 2); ctx.fill();
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, depthTest: false, opacity: 0.9 }));
    sprite.renderOrder = 8; sprite.visible = false; sprite.name = 'perch-marker';
    return sprite;
  }

  private beginFlight(): void {
    // A quick Start click can beat the start-screen warm-up; compile now rather than mid-flight.
    if (!this.shadersWarm) { this.shadersWarm = true; this.warmShaders(); }
    this.audio.setMix(this.settings);
    this.audio.setVolume(this.settings.volume);
    this.audio.setMuted(this.settings.muted);
    this.audio.setMusicStyle(this.settings.musicStyle);
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
    this.cameraRig.exitFreeLook();
    this.cameraRig.snap();
    if (!this.settings.helpSeen) {
      this.help.show(11000);
      this.settings.helpSeen = true;
      saveSettings(this.store, this.settings);
      setTimeout(() => {
        if (this.phase === 'flying') this.hud.toast(this.isTouch ? 'Drag empty space to look around · Pinch to zoom' : 'Drag to look around · Scroll to zoom · V to reset view', 'info', 6000);
      }, 2500);
    }
    if (this.autopilot.enabled) this.hud.toast('Autopilot engaged (F to take control)');
    if (this.migrated) {
      this.hud.toast('World geography was updated: your position was kept, discoveries and waypoint were reset.', 'warn', 7000);
      this.migrated = false;
    }
    this.saveDirty = true;
  }

  // ---------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------

  private loop = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) { this.lastFrame = now; return; }
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.5) dt = 0.5;
    this.wallTime += dt;
    this.frameEma += (dt * 1000 - this.frameEma) * 0.08;
    // Learn the display refresh from the shortest frames (snaps down, creeps up very slowly, capped
    // at 20 ms so a slow stretch cannot pass for a slow display), then count frames that missed a
    // refresh. Displays faster than 60 Hz are held to 60: the target is smoothness, not 144 fps.
    if (dt > 1 / 250) this.refreshInterval = Math.min(Math.max(dt, 1 / 165), Math.min(1 / 50, this.refreshInterval * 1.001));
    this.windowFrames++; this.shortFrames++;
    if (dt > Math.max(this.refreshInterval, 1 / 60) * 1.35) { this.missedFrames++; this.shortMissed++; }
    if (this.frameLog.length < 4000) this.frameLog.push(dt * 1000);
    this.fpsCounter.frames++;
    this.fpsCounter.time += dt;
    if (this.fpsCounter.time >= 0.5) {
      this.fpsCounter.fps = this.fpsCounter.frames / this.fpsCounter.time;
      this.fpsCounter.frames = 0;
      this.fpsCounter.time = 0;
    }

    this.handleActions();

    if ((this.phase === 'flying' || this.phase === 'photo') && !this.worldMap.isOpen) {
      const cam = this.input.takeCamera();
      if (!this.frozen) this.clock.run(dt, () => copyFlightState(this.flight.state, this.prevState), () => this.simStep());
      // Render the last pair even on a zero-step frame (e.g. 144 Hz display).
      this.interpolate(this.frozen ? 1 : this.clock.alpha);
      if (this.phase !== 'photo') this.day.advance(dt);
      this.cameraRig.update(dt, this.renderState, cam);
      if (this.phase === 'flying') this.scanPerches();
      const ps = this.perchState;
      const u = ps ? Math.min(1, ps.t / (ps.phase === 'landing' ? LANDING.seconds : LANDING.takeoffSeconds)) : 0;
      const perched = ps?.phase === 'perched';
      const preenCycle = this.simTime % 11;
      this.bird.update(dt, {
        flap: ps ? (ps.phase === 'takeoff' ? 1 : 0) : this.flight.state.flapping ? 1 : this.flight.state.boosting ? 0.6 : 0,
        beatRate: this.flight.state.boosting ? 1.35 : 1,
        pitchInput: this.flight.state.pitchSmooth,
        turnInput: this.flight.state.turnSmooth,
        speed: this.flight.state.speed,
        brake: ps ? 0 : this.frameInput.brake,
        flare: ps?.phase === 'landing' ? landingFlare(u) : ps?.phase === 'takeoff' ? 0.35 * (1 - u) : 0,
        perch: perched ? 1 : ps?.phase === 'landing' ? Math.max(0, (u - 0.75) / 0.25) : 0,
        lookYaw: perched ? 0.75 * Math.sin(this.simTime * 0.31) * Math.sin(this.simTime * 0.13 + 1) : 0,
        preen: perched && preenCycle > 6 && preenCycle < 7.4 ? Math.sin(Math.PI * (preenCycle - 6) / 1.4) : 0,
      });
      // Contact shadow on the perch: fades in over the touchdown and out again on the hop.
      this.perchShadow.visible = !!ps;
      if (ps) {
        const k = ps.phase === 'landing' ? THREE.MathUtils.smoothstep(u, 0.35, 1) : ps.phase === 'perched' ? 1 : 1 - u;
        this.perchShadow.position.set(ps.perch.x - this.origin.value.x, ps.perch.y + 0.04, ps.perch.z - this.origin.value.z);
        this.perchShadow.rotation.set(-Math.PI / 2, -this.flight.state.heading, 0, 'YXZ');
        const span = this.bird.wingspan;
        this.perchShadow.scale.set(span * 0.5, span * 0.72, 1);
        this.perchShadow.material.opacity = 0.55 * k * (0.25 + 0.75 * this.day.palette.daylight);
      }
      this.audio.update(dt, this.flight.state.speed, this.flight.state.flapping, this.flight.state.boosting, (this.flight.state.boosting ? 1.35 : 1) * BIRD_SPECIES[this.settings.birdSpecies].beat, {
        exposure: this.waterExposureAt(this.flight.state.x, this.flight.state.z), wet: this.flight.state.wet,
        aboveGround: this.flight.state.y - this.chunks.surfaceAt(this.flight.state.x, this.flight.state.z),
        water: this.chunks.heightAt(this.flight.state.x, this.flight.state.z) < SEA_LEVEL,
        daylight: Math.max(0, Math.sin((this.day.time - 0.25) * Math.PI * 2)),
        resting: perched,
      });
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
    // One chunk per frame while flying: each install also means the GPU uploads and vertex-array setup
    // of the new meshes on their first draw, and two in one frame pushed a 13 ms frame past the refresh.
    this.chunks.processInstalls(this.phase === 'flying' ? 2 : 8, this.phase === 'flying' ? 1 : 12);

    if (this.worldMap.isOpen) {
      // Map covers the screen; skip the 3D render but keep streaming alive.
      this.chunks.update(this.flight.state.x, this.flight.state.z, Math.sin(this.flight.state.heading), -Math.cos(this.flight.state.heading), this.wallTime);
      return;
    }

    this.updateWorld(dt);
    this.render();
    if (this.wallTime - this.lastUiUpdate >= 0.1) {
      this.lastUiUpdate = this.wallTime;
      this.updateUI(dt);
    }
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
    if (this.perchState) {
      this.stepPerch(input);
    } else {
      this.flight.step(input, this.clock.step);
      this.maybeCapturePerch();
    }
    this.simTime += this.clock.step;
    this.stepCounter++;
    if (this.stepCounter % 6 === 0) {
      if (this.nav.markExplored(s.x, s.z)) this.saveDirty = true;
      this.checkDiscovery();
      this.checkWaypoint();
    }
    if (this.origin.maybeRebase(s.x, s.z)) {
      this.cameraRig.setOrigin(this.origin.value.x, this.origin.value.z);
      this.chunks.setOrigin(this.origin.value.x, this.origin.value.z);
    }
  }

  /**
   * A slow pass close over a perch captures it: the physics pauses and the bird glides the last few
   * metres onto the point (flare, legs down), then sits until Space (or the autopilot) lifts it off.
   */
  private maybeCapturePerch(): void {
    const s = this.flight.state;
    if (this.autopilot.enabled || s.speed > LANDING.maxSpeed || this.simTime - this.lastTakeoffAt < 2.5) return;
    let perch: Perch | null = null;
    const c = this.perchCandidate;
    if (c && canCapture(s, c)) perch = c;
    else if (this.stepCounter % 4 === 0) for (const p of this.perches.near(s.x, s.z, LANDING.captureRadius + 2)) if (canCapture(s, p)) { perch = p; break; }
    if (!perch) return;
    this.perchState = { phase: 'landing', perch, t: 0, from: { x: s.x, y: s.y, z: s.z, pitch: s.pitch, speed: s.speed } };
    s.boosting = false; s.flapping = false; s.onWater = false; s.turnSmooth = 0;
    this.perchCandidate = null;
  }

  private stepPerch(input: FlightInput): void {
    const st = this.perchState!, s = this.flight.state, dt = this.clock.step, p = st.perch;
    st.t += dt; s.time += dt;
    const restY = p.y + LANDING.birdLift;
    if (st.phase === 'landing') {
      const u = st.t / LANDING.seconds, k = landingProgress(u);
      s.x = st.from.x + (p.x - st.from.x) * k; s.z = st.from.z + (p.z - st.from.z) * k; s.y = st.from.y + (restY - st.from.y) * k;
      s.speed = st.from.speed * (1 - k); s.vy = 0; s.roll *= 0.85; s.turnSmooth = 0;
      s.pitch = st.from.pitch * (1 - k) + landingFlare(u) * 0.55 + 0.1 * k; s.pitchSmooth = s.pitch;
      if (u >= 1) {
        st.phase = 'perched'; st.t = 0;
        s.x = p.x; s.y = restY; s.z = p.z; s.speed = 0; s.pitch = 0.1; s.pitchSmooth = 0; s.roll = 0;
        this.hud.toast(`Perched on ${p.name} · Space to take off`, 'info', 4500);
        this.cameraRig.addShake(0.08);
        this.saveDirty = true;
      }
    } else if (st.phase === 'perched') {
      s.x = p.x; s.y = restY; s.z = p.z; s.speed = 0; s.vy = 0; s.pitch = 0.1; s.roll = 0; s.lift = 0;
      s.boost = Math.min(FLIGHT.boostCapacity, s.boost + FLIGHT.boostRecovery * dt); // resting restores the boost
      if (input.flap || this.autopilot.enabled) { st.phase = 'takeoff'; st.t = 0; }
    } else {
      const u = Math.min(1, st.t / LANDING.takeoffSeconds);
      const fx = Math.sin(s.heading), fz = -Math.cos(s.heading);
      s.x = p.x + fx * 3 * u * u; s.z = p.z + fz * 3 * u * u; s.y = restY + 1.2 * Math.sin(Math.PI * u) + 0.4 * u;
      s.speed = LANDING.takeoffSpeed * u; s.pitch = 0.3 * (1 - u) + 0.1; s.pitchSmooth = s.pitch; s.flapping = true;
      if (u >= 1) { this.perchState = null; s.speed = LANDING.takeoffSpeed; s.vy = 2.5; this.lastTakeoffAt = this.simTime; }
    }
  }

  /** Every quarter second in free flight: pick the perch to show, move the marker, hint once per perch. */
  private scanPerches(): void {
    const s = this.flight.state;
    if (this.perchState || this.autopilot.enabled) { this.perchCandidate = null; this.perchMarker.visible = false; return; }
    if (this.simTime - this.perchScanAt >= 0.25) {
      this.perchScanAt = this.simTime;
      this.perchCandidate = this.perches.best(s.x, s.y, s.z, Math.sin(s.heading), -Math.cos(s.heading));
      const c = this.perchCandidate;
      if (c && c.id !== this.perchHintId && this.simTime - this.perchHintAt > 25 && Math.hypot(c.x - s.x, c.z - s.z) < 140) {
        this.perchHintId = c.id; this.perchHintAt = this.simTime;
        this.hud.toast(`Perch ahead: ${c.name}. Slow down (X) and glide onto the marker to land`, 'info', 4500);
      }
    }
    const c = this.perchCandidate;
    this.perchMarker.visible = !!c;
    if (c) {
      this.perchMarker.position.set(c.x - this.origin.value.x, c.y + 0.9, c.z - this.origin.value.z);
      const pulse = 1 + 0.12 * Math.sin(this.simTime * 4);
      const d = Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z);
      this.perchMarker.scale.setScalar((1.6 + d * 0.012) * pulse);
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
    // Look ahead along the flight path so chunks in front load before they are needed
    // (about 2.5 s of travel, capped at half a chunk).
    const lookahead = this.diag.lookahead ? Math.min(260, s.speed * 2.5) : 0;
    this.chunks.time = this.wallTime;
    this.chunks.update(s.x + fwdX * lookahead, s.z + fwdZ * lookahead, fwdX, fwdZ, this.wallTime);
    this.landmarks.update(s.x, s.z, this.wallTime, this.quality.shadows);
    this.veg.update(this.simTime, 0.83, 0.56, this.wallTime);
    {
      const hx = Math.sin(s.heading), hz = -Math.cos(s.heading), horizontal = s.speed * Math.cos(s.pitch);
      this.wildlifeObserver.x = r.x; this.wildlifeObserver.y = r.y; this.wildlifeObserver.z = r.z;
      this.wildlifeObserver.vx = hx * horizontal; this.wildlifeObserver.vz = hz * horizontal; this.wildlifeObserver.vy = s.speed * Math.sin(s.pitch) + s.vy;
      this.wildlifeObserver.boosting = s.boosting;
      this.wildlife.update(this.simTime, this.wildlifeObserver, this.origin.value.x, this.origin.value.z, this.settings.wildlife, this.settings.quality);
    }
    this.splash.update(this.simTime, this.origin.value.x, this.origin.value.z, window.innerHeight);
    // Dust motes in the nearest thermals, strongest at midday.
    {
      const near = this.airflow.thermalsNear(s.x, s.z, 650, this.thermalScratch);
      near.sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z));
      const strength = Airflow.daylightFactor(this.day.time);
      this.motes.update(this.simTime, window.innerHeight, near.slice(0, 3).map(t => ({ x: t.x - this.origin.value.x, z: t.z - this.origin.value.z, base: t.base, radius: t.radius, top: t.top, strength })));
    }
    if (s.onWater && this.phase === 'flying') {
      const dirX = Math.sin(s.heading), dirZ = -Math.cos(s.heading);
      this.splash.skim(s.x, s.z, dirX, dirZ, s.speed, Math.min(1, s.speed / 45));
      if (this.simTime - this.lastSkimRing > 0.22) { this.lastSkimRing = this.simTime; this.splash.ring(s.x, s.z, 0.8 + s.speed / 60); }
      // Skimming counts as water contact for the fish below (rate-limited; the enter event covers plunges).
      if (this.simTime - this.lastSkimContact > 0.5) { this.lastSkimContact = this.simTime; this.wildlife.onWaterContact(s.x, s.z, Math.min(1, s.speed / 45), this.simTime); }
    }

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
    // Fog distance is rebuilt from the preset every frame (moods and the valley only scale it), so no
    // per-frame factor can compound: with sky moods off, the valley's factor used to multiply the
    // previous frame's value until the whole world was fogged out.
    let fogFar = this.quality.fogFar;
    // Sky moods: slowly drifting haze and cloud cover so the same route never looks the same twice.
    if (this.settings.skyMoods) {
      const t = this.simTime, seedPhase = (this.seed % 1000) * 0.0063;
      // Mostly clear-to-light haze; heavy haze and overcast are the occasional extremes, never the norm.
      const haze = THREE.MathUtils.clamp(0.34 + 0.32 * Math.sin(t / 171 + seedPhase) * Math.sin(t / 263 + seedPhase * 1.7) + 0.22 * Math.sin(t / 97 + 4.5), 0, 1);
      const cloudiness = THREE.MathUtils.clamp(0.5 + 0.5 * Math.sin(t / 211 + seedPhase * 2.3) * Math.cos(t / 149 + 0.6), 0, 1);
      fogFar *= THREE.MathUtils.lerp(1.15, 0.55, haze);
      _hazeTint.set(0.93, 0.9, 0.86).multiplyScalar(THREE.MathUtils.lerp(0.9, 1.05, pal.daylight));
      pal.fog.lerp(_hazeTint, haze * 0.32 * pal.daylight);
      pal.horizon.lerp(_hazeTint, haze * 0.26 * pal.daylight);
      pal.sunIntensity *= 1 - 0.28 * haze;
      pal.ambientIntensity *= 1 + 0.18 * haze;
      this.clouds.setCoverage(0.5 + 0.7 * cloudiness);
      this.skyMoodState.haze = haze; this.skyMoodState.cloudiness = cloudiness;
    } else if (this.skyMoodState.haze !== 0) {
      this.clouds.setCoverage(1);
      this.skyMoodState.haze = 0; this.skyMoodState.cloudiness = 0;
    }
    // The mist valley: banks thin out over the day, sun shafts appear when a low sun lies along
    // the valley, and inside it the air itself is hazier.
    if (!this.valleyReady) { this.valleyReady = true; this.setupValley(); }
    {
      const mist = this.mistAmount();
      for (let i = 0; i < 10; i++) this.clouds.setStaticOpacity(`mist-${i}`, this.diag.mist ? mist : 0);
      const vm = this.gen.valleyAt(s.x, s.z, this.valleyScratch).mask;
      const sunLow = THREE.MathUtils.smoothstep(this.day.sunDir.y, 0.02, 0.12) * (1 - THREE.MathUtils.smoothstep(this.day.sunDir.y, 0.3, 0.5));
      const along = Math.abs(this.day.sunDir.x * this.valleyAxis.x + this.day.sunDir.z * this.valleyAxis.y) / Math.max(1e-3, Math.hypot(this.day.sunDir.x, this.day.sunDir.z));
      const shaftStrength = sunLow * Math.pow(along, 2) * (0.35 + 0.65 * mist) * (this.quality.clouds ? 1 : 0);
      this.shafts.update(this.simTime, this.day.sunDir, this.camera.position, this.origin.value.x, this.origin.value.z, shaftStrength * 0.9);
      if (vm > 0.001) {
        const haze = vm * mist;
        fogFar *= THREE.MathUtils.lerp(1, 0.6, haze);
        _hazeTint.set(0.96, 0.9, 0.82).multiplyScalar(THREE.MathUtils.lerp(0.85, 1.05, pal.daylight));
        pal.fog.lerp(_hazeTint, haze * 0.4 * pal.daylight);
        pal.horizon.lerp(_hazeTint, haze * 0.3 * pal.daylight);
        pal.sunIntensity *= 1 - 0.15 * haze;
      }
      this.skyMoodState.valley = vm;
    }
    this.fog.far = fogFar;
    this.fog.near = fogFar * 0.22;
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
    this.frame.render(this.renderer, this.scene, this.camera);
    this.adjustResolution();
    // Compile every program once the opening chunks are in, while the start screen is still up.
    if (!this.shadersWarm && this.phase === 'start' && this.wallTime > 1.5 && this.chunks.isLoadedAt(this.flight.state.x, this.flight.state.z)) { this.shadersWarm = true; this.warmShaders(); }
  }

  /**
   * Adaptive resolution that holds the display rate. Frame times are quantised
   * by vsync, so a 60 Hz display never reports frames much below 16.7 ms: the
   * old controller (raise below 13 ms) could lower the resolution but never
   * bring it back, and it tolerated 24 ms frames, which on a 60 Hz display
   * means alternating one- and two-refresh frames: exactly the judder players
   * see. This one counts missed refreshes over a window: too many and the
   * render scale steps down; a clean window after a cooldown probes one small
   * step up, so the game settles at the highest scale that keeps every frame
   * inside one refresh.
   */
  private adjustResolution(): void {
    // Runs on the start screen too (the same world renders behind it), so the scale is settled before the flight begins.
    if (!this.settings.dynamicResolution || (this.phase !== 'flying' && this.phase !== 'start')) { this.missedFrames = 0; this.windowFrames = 0; return; }
    // The frames right after a scale change include the target reallocation itself; they say nothing
    // about the new scale, so they are not counted.
    if (this.wallTime < this.settleUntil) { this.missedFrames = 0; this.windowFrames = 0; this.shortMissed = 0; this.shortFrames = 0; return; }
    // A sudden run of misses (the view swung round to a heavier direction) steps down right away
    // instead of waiting a full window: half of the last 20 frames late is not noise.
    if (this.shortFrames >= 20) {
      const burst = this.shortMissed / this.shortFrames;
      this.shortMissed = 0; this.shortFrames = 0;
      if (burst >= 0.5 && this.pixelRatio > MIN_RENDER_SCALE && this.wallTime - this.lastDprAdjust > 0.5) {
        this.pixelRatio = Math.max(MIN_RENDER_SCALE, this.pixelRatio - 0.1);
        this.lastTransientDrop = this.wallTime;
        this.applyRenderScale();
        this.lastDprAdjust = this.wallTime;
        this.settleUntil = this.wallTime + 0.6;
        this.missedFrames = 0; this.windowFrames = 0;
        return;
      }
    }
    if (this.wallTime - this.lastDprAdjust < 1.5 || this.windowFrames < 60) return;
    const missRatio = this.missedFrames / this.windowFrames;
    this.missedFrames = 0; this.windowFrames = 0;
    const maxPr = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    let next = this.pixelRatio;
    // The ceiling is set only when a probe up fails within a few seconds: that scale is genuinely
    // too expensive. Misses at a scale that had been holding for a while come from streaming
    // (uploads, installs, a burst after a turn) and only lower the scale for the moment, so the game
    // does not sit at the floor for minutes after the GPU has room again. The ceiling relaxes after
    // 45 clean seconds (then every 10 s) so a heavier stretch is retried eventually; every probe that
    // fails at that ceiling doubles the wait (45 s, 90 s, 180 s, up to 6 min), so a scale the GPU
    // cannot hold is not retried every minute and the picture does not breathe.
    const relaxDelay = Math.min(360, 45 * 2 ** this.probeFailures);
    if (this.wallTime - this.lastDprDrop > relaxDelay && this.dprCeiling < maxPr) { this.dprCeiling = Math.min(maxPr, this.dprCeiling + 0.05); this.lastDprDrop = this.wallTime - (relaxDelay - 10); }
    // A probe that has held for 6 s without a miss is a success: the retry wait starts over.
    if (this.lastProbeUp > this.lastProbeJudged && this.wallTime - this.lastProbeUp >= 6 && missRatio <= 0.12) { this.lastProbeJudged = this.lastProbeUp; this.probeFailures = 0; }
    const probeLimit = Math.min(maxPr, this.dprCeiling - 0.05);
    // A scale change only resizes the scaled render target (see ScaledFrame), so a badly missing
    // window can step down decisively and a clean one can probe up in small steps.
    const step = missRatio > 0.45 ? 0.2 : missRatio > 0.25 ? 0.1 : 0.05;
    // Below 0.7 the picture turns to mush; a few missed refreshes are the better trade there.
    // Held windows: step down at 6 % late frames and probe up only from a clean window (< 1 %), so the
    // scale settles one notch below the edge instead of on it (at the edge, 3-5 % of frames took two
    // refreshes, which reads as a jerk whenever the camera is held still on the bird).
    if (missRatio > 0.06 && this.pixelRatio > MIN_RENDER_SCALE) {
      const probeFailed = this.wallTime - this.lastProbeUp < 6;
      if (probeFailed) {
        // The scale it came from was holding a moment ago: go straight back there, not further.
        this.dprCeiling = this.pixelRatio; this.lastDprDrop = this.wallTime; this.lastProbeJudged = this.lastProbeUp; this.probeFailures++;
        next = Math.max(MIN_RENDER_SCALE, Math.min(this.preProbeScale, this.pixelRatio - 0.05));
      } else {
        next = Math.max(MIN_RENDER_SCALE, this.pixelRatio - step);
      }
      this.lastTransientDrop = this.wallTime;
    } else if (missRatio < 0.01 && this.pixelRatio < probeLimit && this.wallTime - this.lastDprDrop > 8 && this.wallTime - this.lastTransientDrop > 4) {
      this.preProbeScale = this.pixelRatio;
      next = Math.min(probeLimit, this.pixelRatio + 0.05);
      this.lastProbeUp = this.wallTime;
    }
    if (Math.abs(next - this.pixelRatio) > 0.01) {
      this.pixelRatio = next;
      this.applyRenderScale();
      this.lastDprAdjust = this.wallTime;
      this.settleUntil = this.wallTime + 0.6;
    }
  }

  /** Render scale relative to the canvas' fixed pixel ratio. */
  private applyRenderScale(): void {
    this.frame.setScale(this.pixelRatio / this.renderer.getPixelRatio());
  }

  private updateUI(dt: number): void {
    this.hud.setLift(this.phase === 'flying' ? this.flight.state.lift : 0);
    this.audio.setLift(this.phase === 'flying' ? Math.min(1, this.flight.state.lift / 4) : 0);
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
      this.hud.setFreeLook(this.cameraRig.freeLook);
      const grabbing = this.input.isDragging;
      if (grabbing !== this.canvasGrabbing) {
        this.canvasGrabbing = grabbing;
        this.renderer.domElement.classList.toggle('grabbing', grabbing);
      }
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

  /** Mist banks and sun-shaft anchors along the valley floor, from the generator's axis. */
  private setupValley(): void {
    const path = this.gen.valleyPath(9);
    const a = path[0], b = path[path.length - 1];
    this.valleyAxis.set(b.x - a.x, b.z - a.z).normalize();
    const rng = new Rng(hash2(3, 9, this.seed ^ 0x7a11));
    const anchors = [];
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      if (p.t < 0.05 || p.t > 0.92) continue;
      const floor = Math.max(this.gen.heightAt(p.x, p.z), SEA_LEVEL);
      const puffs = [];
      for (let k = 0; k < 18; k++) {
        const across = (rng.next() - 0.5) * 2 * 300, along = (rng.next() - 0.5) * 2 * 150;
        puffs.push({ ox: -this.valleyAxis.y * across + this.valleyAxis.x * along, oy: 6 + rng.next() * 26, oz: this.valleyAxis.x * across + this.valleyAxis.y * along, size: 110 + rng.next() * 90 });
      }
      this.clouds.addStaticMass(`mist-${i}`, p.x, floor + 10, p.z, puffs, this.seed + i);
      if (i % 2 === 0) anchors.push({ x: p.x + (rng.next() - 0.5) * 200, y: floor + 40, z: p.z + (rng.next() - 0.5) * 200, length: 380 + rng.next() * 160, width: 50 + rng.next() * 70, seed: rng.next() });
    }
    this.shafts.setAnchors(anchors);
  }

  /** Mist is thickest at dawn, burns off by midday and gathers again toward dusk. */
  private mistAmount(): number {
    const t = this.day.time;
    const dawn = Math.exp(-Math.pow((t - 0.29) / 0.05, 2)), dusk = Math.exp(-Math.pow((t - 0.76) / 0.06, 2));
    return THREE.MathUtils.clamp(0.18 + 0.72 * Math.max(dawn, dusk) + 0.2 * (1 - this.day.compute().daylight), 0, 1);
  }

  /** 0 sheltered lake .. 1 open sea at a point (the same measure the water shader uses for surf). */
  private waterExposureAt(x: number, z: number): number {
    const land = this.gen.sample(x, z, this.exposureSample).land;
    return Math.max(0, Math.min(1, (0.75 - land) * 2.5));
  }
  private exposureSample = createTerrainSample();

  private onImpact(speed: number, kind: 'terrain' | 'water' | 'obstacle'): void {
    const strength = Math.min(1, speed / 60);
    this.cameraRig.addShake(0.3 + strength * 0.6);
    this.audio.thump(strength);
    if (kind === 'water') this.hud.toast('Splash! Pull up.', 'warn', 1800);
    else if (kind === 'obstacle') this.hud.toast('Bumped into something.', 'warn', 1800);
    else this.hud.toast('Ground contact. Climb!', 'warn', 1800);
  }

  private recover(): void {
    this.perchState = null;
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
          if (this.phase === 'photo') { this.exitPhoto(); break; }
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
        case 'resetView':
          if (this.phase === 'flying') this.cameraRig.resetView();
          break;
        case 'togglePause':
          this.togglePause();
          break;
        case 'photo':
          if (this.phase === 'photo') this.exitPhoto(); else if (this.phase === 'flying' && !this.worldMap.isOpen) this.enterPhoto();
          break;
        case 'confirm':
          if (this.phase === 'photo') this.capturePhoto();
          break;
        case 'toggleDev':
          this.settings.showDevOverlay = !this.settings.showDevOverlay;
          this.dev.setVisible(this.settings.showDevOverlay);
          saveSettings(this.store, this.settings);
          break;
      }
    }
  }

  private enterPhoto(): void {
    if (this.phase !== 'flying') return;
    this.phase = 'photo';
    this.frozen = true;
    this.input.clear();
    this.hud.setVisible(false);
    this.minimap.setVisible(false);
    this.touch?.setVisible(false);
    this.cameraRig.fovOverride = this.camera.fov;
    this.photoPanel.show(this.camera.fov, this.day.time, this.photoHideBird);
    this.bird.group.visible = !this.photoHideBird;
  }

  private exitPhoto(): void {
    if (this.phase !== 'photo') return;
    this.phase = 'flying';
    this.frozen = false;
    this.clock.reset();
    this.lastFrame = performance.now();
    this.cameraRig.fovOverride = null;
    this.photoPanel.hide();
    this.bird.group.visible = true;
    this.hud.setVisible(true);
    this.minimap.setVisible(true);
    this.touch?.setVisible(true);
  }

  /** Render the current view and hand the PNG to the browser as a download. */
  private capturePhoto(): void {
    // Photos are taken at the canvas' full resolution, whatever the adaptive scale is at the time.
    const liveScale = this.frame.getScale();
    this.frame.setScale(1);
    this.frame.render(this.renderer, this.scene, this.camera);
    this.frame.setScale(liveScale);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.lastPhotoBytes = url.length;
    const a = document.createElement('a');
    const t = new Date();
    a.href = url;
    a.download = `skybound-${this.seed}-${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    this.photoPanel.flash();
    this.audio.chime('ui');
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
    this.touch?.setVisible(true);
    this.input.blocked = false;
    this.input.clear();
    this.clock.reset();
    copyFlightState(this.flight.state, this.prevState);
    this.lastFrame = performance.now();
    void this.audio.resume();
  }

  private toggleMap(): void {
    if (this.worldMap.isOpen) this.closeMap();
    else this.openMap();
  }

  private openMap(): void {
    if (this.settingsPanel.visible || this.worldMap.isOpen || this.phase === 'loading' || this.phase === 'start') return;
    this.phaseBeforeMap = this.phase;
    this.input.clear();
    this.touch?.resetAll();
    this.input.blocked = true;
    if (this.phase === 'flying') void this.audio.suspend();
    this.pauseMenu.hide();
    this.hud.setVisible(false);
    this.minimap.setVisible(false);
    this.touch?.setVisible(false);
    this.worldMap.show();
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
      copyFlightState(this.flight.state, this.prevState);
      this.lastFrame = performance.now();
      void this.audio.resume();
    }
    this.minimap.update(this.wallTime);
  }

  private portraitsReady = false;
  private appliedUniform = false;
  private profileFor(s: Settings) { return s.uniformHandling ? DEFAULT_PROFILE : BIRD_SPECIES[s.birdSpecies].profile; }
  private skyMoodState = { haze: 0, cloudiness: 0, valley: 0 };

  private openSettings(): void {
    if (this.settingsPanel.visible) return;
    if (!this.portraitsReady) {
      this.portraitsReady = true;
      try { this.settingsPanel.setPortraits(renderBirdPortraits(this.renderer)); } catch (err) { console.warn('[skybound] bird portraits unavailable', err); }
    }
    this.phaseBeforeSettings = this.phase;
    this.pauseMenu.hide();
    this.startScreen.root.inert = true;
    this.pauseMenu.root.inert = true;
    this.settingsPanel.show(this.settings);
    this.input.clear();
    this.touch?.resetAll();
    this.input.blocked = true;
    this.touch?.setVisible(false);
    if (this.phase === 'flying') {
      this.phase = 'paused';
      void this.audio.suspend();
    }
  }

  private closeSettings(): void {
    this.startScreen.root.inert = false;
    this.pauseMenu.root.inert = false;
    this.settingsPanel.hide();
    // Back in flight nothing should keep keyboard focus: Enter/Space must fly the bird, not re-open the dialog.
    if (this.phaseBeforeSettings === 'flying' && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    saveSettings(this.store, this.settings);
    if (this.phaseBeforeSettings === 'flying') this.resume();
    else if (this.phaseBeforeSettings === 'paused') {
      if (this.audio.started && !this.audio.wasSuspendedByUs) void this.audio.suspend(); // music preview ends with the dialog
      this.pauseMenu.show(`Seed ${this.seed}`);
      this.pauseMenu.root.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus();
    } else this.input.blocked = false;
  }

  private applySettings(s: Settings): void {
    const prevQuality = this.settings.quality;
    const prevSpecies = this.settings.birdSpecies;
    const prevDynamic = this.settings.dynamicResolution;
    const prevMusic = this.settings.musicStyle;
    this.settings = s;
    saveSettings(this.store, s);
    this.input.sensitivity = s.sensitivity;
    this.input.invertVertical = s.invertVertical;
    this.cameraRig.reducedMotion = s.reducedMotion;
    this.cameraRig.autoCenter = s.autoCenterCamera;
    this.audio.setVolume(s.volume);
    this.audio.setMuted(s.muted);
    this.audio.setMix(s);
    if (s.musicStyle !== prevMusic) {
      this.audio.setMusicStyle(s.musicStyle);
      // Picking a style is a user gesture: start the mix so the choice is audible right away,
      // even from the start screen or the pause menu (re-suspended when Settings closes to pause).
      if (!this.audio.started) this.audio.start();
      else if (this.settingsPanel.visible && this.audio.wasSuspendedByUs) void this.audio.resume();
    }
    if (s.uniformHandling !== this.appliedUniform) { this.appliedUniform = s.uniformHandling; this.flight.setProfile(this.profileFor(s)); }
    if (s.birdSpecies !== prevSpecies) {
      this.flight.setProfile(this.profileFor(s));
      const next = new BirdModel(s.birdSpecies);
      next.group.position.copy(this.bird.group.position);
      next.group.quaternion.copy(this.bird.group.quaternion);
      next.group.scale.copy(this.bird.group.scale);
      this.scene.remove(this.bird.group);
      this.bird.dispose();
      this.bird = next;
      this.scene.add(next.group);
    }
    this.dev.setVisible(s.showDevOverlay);
    if (s.quality !== prevQuality) this.applyQuality(QUALITY_PRESETS[s.quality]);
    if (!s.dynamicResolution && (prevDynamic || s.quality !== prevQuality)) {
      this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
      this.applyRenderScale();
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
    this.clouds.setBudget(q.cloudPuffs);
    this.fog.near = q.fogFar * 0.22;
    this.fog.far = q.fogFar;
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, q.maxPixelRatio);
    this.dprCeiling = Infinity; this.lastDprDrop = -Infinity;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.applyRenderScale();
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
    this.frame.setSize(w * this.renderer.getPixelRatio(), h * this.renderer.getPixelRatio());
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
      perch: () => ({ phase: this.perchState?.phase ?? null, perch: this.perchState?.perch ?? null, t: this.perchState?.t ?? 0, candidate: this.perchCandidate }),
      perchPoints: (r = 200) => this.perches.near(this.flight.state.x, this.flight.state.z, r),
      landmarkPerches: () => this.perches.landmarkPoints,
      /** Sit the bird straight onto a perch (by id, or the nearest landmark perch) for pose checks. */
      perchOn: (id?: string) => {
        const s = this.flight.state;
        const pts = id && !id.startsWith('lm:') ? this.perches.near(s.x, s.z, 600) : this.perches.landmarkPoints;
        const p = (id ? pts.find((q) => q.id === id) : null) ?? pts.slice().sort((a, b) => Math.hypot(a.x - s.x, a.z - s.z) - Math.hypot(b.x - s.x, b.z - s.z))[0];
        if (!p) return null;
        s.x = p.x; s.y = p.y + LANDING.birdLift; s.z = p.z; s.speed = 0; s.vy = 0; s.pitch = 0.1; s.pitchSmooth = 0; s.roll = 0;
        this.perchState = { phase: 'perched', perch: p, t: 0, from: { x: s.x, y: s.y, z: s.z, pitch: 0, speed: 0 } };
        copyFlightState(s, this.prevState);
        copyFlightState(s, this.renderState);
        this.cameraRig.snap();
        this.chunks.update(p.x, p.z, Math.sin(s.heading), -Math.cos(s.heading), this.wallTime, true);
        return p;
      },
      teleport: (x: number, z: number, y?: number) => {
        const s = this.flight.state;
        this.perchState = null;
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
      freeze: (on: boolean) => {
        this.frozen = on;
        if (!on) {
          this.clock.reset();
          this.lastFrame = performance.now();
        }
      },
      isFrozen: () => this.frozen,
      takeFrameLog: () => {
        const log = this.frameLog;
        this.frameLog = [];
        return log;
      },
      cameraPosition: () => this.camera.position.clone(),
      cameraState: () => this.cameraRig.state(),
      orbit: (az: number, el: number, dist?: number) => this.cameraRig.setOrbit(az, el, dist),
      setClouds: (v: boolean) => { this.clouds.visible = v; },
      setShafts: (v: boolean) => { this.shafts.mesh.visible = v; },
      setMist: (v: boolean) => { this.diag.mist = v; },
      setMotes: (v: boolean) => { this.motes.enabled = v; },
      setLookahead: (v: boolean) => { this.diag.lookahead = v; },

      terrainDetail: (v: number) => { this.chunks.setDetail(v); },
      vegPlain: (on: boolean) => {
        // Diagnostic: render trees with the stock Lambert shader.
        const m = this.veg.material;
        this.vegShaderHook ??= m.onBeforeCompile;
        m.onBeforeCompile = on ? () => {} : this.vegShaderHook;
        m.customProgramCacheKey = () => (on ? 'plain' : 'skybound-veg-v1');
        m.needsUpdate = true;
      },
      mapView: () => this.worldMap.getView(),
      mapOpen: () => this.worldMap.isOpen,
      inputSnapshot: () => ({ dragging: this.input.isDragging, pitch: this.frameInput.pitch, turn: this.frameInput.turn, flap: this.frameInput.flap, boost: this.frameInput.boost, blocked: this.input.blocked }),
      quality: () => this.settings.quality,
      birdSpecies: () => this.bird.species,
      wildlife: () => this.wildlife.counts(),
      settingsVisible: () => this.settingsPanel.visible,
      musicStyle: () => this.audio.currentMusicStyle,
      lift: () => this.flight.state.lift,
      photo: () => ({ active: this.phase === 'photo', lastPhotoBytes: this.lastPhotoBytes, fov: this.camera.fov, birdVisible: this.bird.group.visible }),
      thermalsNear: (r = 1500) => this.airflow.thermalsNear(this.flight.state.x, this.flight.state.z, r, []),
      skyMood: () => ({ ...this.skyMoodState, fogFar: this.fog.far }),
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
    this.wildlife.dispose();
    this.splash.dispose();
    this.shafts.dispose();
    this.motes.dispose();
    this.frame.dispose();
    this.audio.dispose();
    this.renderer.dispose();
  }
}
