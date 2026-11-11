export type BeatStrength = 'p' | 'mp' | 'mf' | 'f';
export type DetectedBeat = { time: number; isDownbeat: boolean; confidence: number };
export type Beat = DetectedBeat & { strength: BeatStrength };
export type Note = Beat & { id: number; type: 'tap' };
