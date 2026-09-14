import type { FlightProfile } from './FlightController';

/** 1..5 dots shown on the picker card. */
export interface BirdTraits { speed: number; agility: number; glide: number; power: number }

export interface BirdStyle {
  name: string;
  description: string;
  /** Two short lines for the picker card: how it flies, where it feels at home. */
  blurb: [string, string];
  span: number; chord: number; body: number; tail: number; beat: number; head: number; fork: boolean;
  back: string; belly: string; wing: string; under: string; primary: string; face: string; beak: string;
  traits: BirdTraits;
  profile: FlightProfile;
}

export const BIRD_SPECIES: Record<'eagle' | 'gull' | 'swallow' | 'owl', BirdStyle> = {
  eagle: {
    name: 'Eagle', description: 'Broad wings, warm plumage, slow wingbeats.',
    blurb: ['Soars for ages on broad wings; powerful but deliberate in turns.', 'At home over mountain ridges and open valleys.'],
    span: 1, chord: 1, body: 1, tail: 1, beat: 0.85, head: 1, fork: false,
    back: '#4b3a2c', belly: '#d8cbb4', wing: '#3e3024', under: '#bfae95', primary: '#2b2119', face: '#f0e8dc', beak: '#e0a030',
    traits: { speed: 3, agility: 2, glide: 5, power: 4 },
    profile: { speed: 1, agility: 0.88, flapPower: 1.1, glide: 1.18 },
  },
  gull: {
    name: 'Gull', description: 'Long silver wings with dark tips.',
    blurb: ['Fast and efficient; long wings hold speed with little effort.', 'Loves the coast, the surf line and the sea breeze.'],
    span: 1.12, chord: 0.72, body: 0.9, tail: 0.8, beat: 1, head: 0.9, fork: false,
    back: '#bac6d0', belly: '#f3f1e9', wing: '#aabac6', under: '#efeee7', primary: '#303b47', face: '#f5f1e8', beak: '#e4b650',
    traits: { speed: 4, agility: 3, glide: 4, power: 2 },
    profile: { speed: 1.06, agility: 1, flapPower: 0.9, glide: 1.1 },
  },
  swallow: {
    name: 'Swallow', description: 'Swept slender wings and a long forked tail.',
    blurb: ['Darts and flicks through tight turns; quick wingbeats, short glides.', 'Happiest low over meadows, ponds and treetops.'],
    span: 0.86, chord: 0.6, body: 0.7, tail: 1.5, beat: 1.45, head: 0.75, fork: true,
    back: '#253a54', belly: '#dcd1bd', wing: '#263951', under: '#abb3bb', primary: '#1e2b40', face: '#914f3e', beak: '#34343b',
    traits: { speed: 3, agility: 5, glide: 2, power: 4 },
    profile: { speed: 0.96, agility: 1.35, flapPower: 1.2, glide: 0.85 },
  },
  owl: {
    name: 'Owl', description: 'Rounded wings, a wide face and quiet wingbeats.',
    blurb: ['Slow, silent and nimble at low speed; turns tightly between trees.', 'Feels at home in woodland edges at dusk.'],
    span: 0.88, chord: 1.32, body: 1.15, tail: 0.65, beat: 0.72, head: 1.45, fork: false,
    back: '#89745c', belly: '#ded2b9', wing: '#79674f', under: '#c9b797', primary: '#504437', face: '#e6dac2', beak: '#806743',
    traits: { speed: 2, agility: 4, glide: 3, power: 3 },
    profile: { speed: 0.86, agility: 1.15, flapPower: 1, glide: 0.95 },
  },
};

export type BirdSpecies = keyof typeof BIRD_SPECIES;
export const isBirdSpecies = (value: unknown): value is BirdSpecies => typeof value === 'string' && Object.hasOwn(BIRD_SPECIES, value);
