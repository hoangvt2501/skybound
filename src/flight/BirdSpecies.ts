export const BIRD_SPECIES = {
  eagle: { name: 'Eagle', description: 'Broad wings, warm plumage, slow wingbeats.', span: 1, chord: 1, body: 1, tail: 1, beat: 0.85, head: 1, fork: false, back: '#4b3a2c', belly: '#d8cbb4', wing: '#3e3024', under: '#bfae95', primary: '#2b2119', face: '#f0e8dc', beak: '#e0a030' },
  gull: { name: 'Gull', description: 'Long silver wings with dark tips.', span: 1.12, chord: 0.72, body: 0.9, tail: 0.8, beat: 1, head: 0.9, fork: false, back: '#bac6d0', belly: '#f3f1e9', wing: '#aabac6', under: '#efeee7', primary: '#303b47', face: '#f5f1e8', beak: '#e4b650' },
  swallow: { name: 'Swallow', description: 'Swept slender wings and a long forked tail.', span: 0.86, chord: 0.6, body: 0.7, tail: 1.5, beat: 1.45, head: 0.75, fork: true, back: '#253a54', belly: '#dcd1bd', wing: '#263951', under: '#abb3bb', primary: '#1e2b40', face: '#914f3e', beak: '#34343b' },
  owl: { name: 'Owl', description: 'Rounded wings, a wide face and quiet wingbeats.', span: 0.88, chord: 1.32, body: 1.15, tail: 0.65, beat: 0.72, head: 1.45, fork: false, back: '#89745c', belly: '#ded2b9', wing: '#79674f', under: '#c9b797', primary: '#504437', face: '#e6dac2', beak: '#806743' },
} as const;

export type BirdSpecies = keyof typeof BIRD_SPECIES;
export const isBirdSpecies = (value: unknown): value is BirdSpecies => typeof value === 'string' && Object.hasOwn(BIRD_SPECIES, value);
