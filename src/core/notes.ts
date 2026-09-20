/**
 * MIDI note <-> name <-> frequency, equal temperament, A440.
 *
 * Note names use the original's flat spelling (Db, Eb, Gb, Ab, Bb). Octaves use standard
 * scientific pitch notation, so MIDI 60 is C4. (The 2003 original called it C5 because it
 * computed the octave as `note / 12`.)
 */

export const A4_MIDI = 69;
export const A4_HZ = 440;

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const BLACK = new Set([1, 3, 6, 8, 10]);

/** Pitch class 0..11 (C = 0). Safe for negative input. */
export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

export function isBlackKey(midi: number): boolean {
  return BLACK.has(pitchClass(midi));
}

/** Standard scientific pitch octave: MIDI 60 => 4. */
export function octaveOf(midi: number): number {
  return Math.floor(midi / 12) - 1;
}

/** Just the letter part, e.g. `Bb`. */
export function noteLetter(midi: number): string {
  return NAMES[pitchClass(midi)] as string;
}

/** Letter plus octave, e.g. `C4`, `Bb2`. */
export function noteName(midi: number): string {
  return `${noteLetter(midi)}${octaveOf(midi)}`;
}

/** Status-bar text, e.g. `60 (C4)`. */
export function noteStatusText(midi: number): string {
  return `${midi} (${noteName(midi)})`;
}

/** MIDI note number -> Hz. `440 * 2^((n - 69) / 12)` (appView.cpp:408). */
export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

/**
 * Hz -> semitones above A440 (a continuous MIDI number minus 69).
 * `12 * (ln f - ln 440) / ln 2` (MusicGraph.cpp:57). This is the spectrum's x axis.
 */
export function hzToSemitones(hz: number): number {
  return (12 * (Math.log(hz) - Math.log(A4_HZ))) / Math.LN2;
}

/** Hz -> continuous MIDI number. */
export function hzToMidi(hz: number): number {
  return hzToSemitones(hz) + A4_MIDI;
}
