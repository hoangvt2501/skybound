/** Biome families. Order matters: it is the index into weight arrays. */
export const enum Biome {
  Temperate = 0,
  Alpine = 1,
  Coast = 2,
  Arid = 3,
  Wetland = 4,
  Upland = 5,
  Ocean = 6,
}
export const BIOME_COUNT = 7;

export interface BiomeInfo {
  id: Biome;
  name: string;
  /** Representative map color (sRGB 0-255). */
  mapColor: [number, number, number];
  description: string;
}

export const BIOMES: BiomeInfo[] = [
  { id: Biome.Temperate, name: 'Temperate forest & meadow', mapColor: [148, 180, 117], description: 'Rolling oak and pine woodland with open meadows.' },
  { id: Biome.Alpine, name: 'Alpine mountains', mapColor: [158, 150, 140], description: 'Broad massifs with snow above the tree line.' },
  { id: Biome.Coast, name: 'Coast & islands', mapColor: [219, 204, 158], description: 'Sandy shores, shallow shelves and scattered islands.' },
  { id: Biome.Arid, name: 'Arid plateau & canyons', mapColor: [214, 168, 117], description: 'Terraced red rock cut by deep canyons.' },
  { id: Biome.Wetland, name: 'Wetlands & lakes', mapColor: [153, 179, 133], description: 'Flat marshes dotted with lakes and reed beds.' },
  { id: Biome.Upland, name: 'Flowering uplands', mapColor: [189, 186, 148], description: 'High rolling hills covered in wildflowers.' },
  { id: Biome.Ocean, name: 'Ocean', mapColor: [64, 110, 158], description: 'Open water.' },
];

/** Vegetation species indexes used by the instancer. */
export const enum Species {
  Oak = 0,
  Pine = 1,
  Birch = 2,
  Palm = 3,
  Cactus = 4,
  Deadwood = 5,
  Shrub = 6,
  Willow = 7,
  /** Boulders: placed by the same deterministic rules as trees, so they are colliders too. */
  Rock = 8,
}
export const SPECIES_COUNT = 9;

export const SPECIES_NAMES = ['oak', 'pine', 'birch', 'palm', 'cactus', 'deadwood', 'shrub', 'willow', 'rock'];

/** Collision radius and height (m) for a unit-scale instance of each species. */
export const SPECIES_COLLIDER: { radius: number; height: number }[] = [
  { radius: 3.2, height: 12 },
  { radius: 2.4, height: 15 },
  { radius: 2.0, height: 11 },
  { radius: 1.6, height: 11 },
  { radius: 0.9, height: 4.5 },
  { radius: 1.2, height: 8 },
  { radius: 1.4, height: 2.2 },
  { radius: 3.0, height: 8 },
  { radius: 2.6, height: 3.2 },
];
