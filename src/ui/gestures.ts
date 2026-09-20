import type { PinchInput } from '../core/pinch';

/** Just what the tracker uses of an element and of a pointer event, so it can be tested without a DOM. */
export interface GestureTarget {
  getBoundingClientRect(): { left: number; width: number };
  setPointerCapture(pointerId: number): void;
}

export interface GestureEvent {
  pointerId: number;
  pointerType: string;
  isPrimary?: boolean;
  clientX: number;
  clientY: number;
}

export interface PinchCallbacks {
  /** A second finger landed: cancel whatever the first finger had started (a drag, a held key). */
  begin(): void;
  update(pinch: PinchInput): void;
}

/** Fingers closer than this are treated as this far apart, so a near-touching start cannot blow the scale up. */
const MIN_DISTANCE = 12;

interface Point {
  x: number;
  y: number;
}

/**
 * Turns the pointer events of one pane into a two-finger pan and pinch.
 *
 * Each pointer handler asks it first (`down`, `move`, `up`) and stops if it says the event was
 * taken. It never takes a single finger's events, so one-finger behaviour is untouched. From the
 * moment a second finger lands until every finger is lifted, it takes them all: the finger that
 * is left when the other lifts must not start a selection or play a key mid-gesture.
 *
 * Only touch is handled. A mouse has one pointer and its own wheel and drag controls.
 */
export class TwoFingerGesture {
  private readonly points = new Map<number, Point>();
  /** The two fingers driving the gesture, or null when there is none. */
  private pair: [number, number] | null = null;
  private start = { centre: 0, distance: 1 };
  /** A finger is still down after a gesture ended; it is ignored until it lifts. */
  private leftover = false;

  constructor(
    private readonly target: GestureTarget,
    private readonly callbacks: PinchCallbacks,
  ) {}

  /** True while this gesture owns the pointer events. */
  get active(): boolean {
    return this.pair !== null || this.leftover;
  }

  /** A finger went down. Returns true if the event belongs to a gesture. */
  down(e: GestureEvent): boolean {
    if (e.pointerType !== 'touch') return false;
    if (e.isPrimary) this.reset(); // a fresh touch sequence: anything still tracked is stale
    this.points.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this.pair && this.points.size >= 2) this.beginPair(e.pointerId);
    return this.active;
  }

  /** A finger moved. Returns true if the event belongs to a gesture. */
  move(e: GestureEvent): boolean {
    if (e.pointerType !== 'touch') return false;
    const point = this.points.get(e.pointerId);
    if (!point) return false;
    point.x = e.clientX;
    point.y = e.clientY;

    if (this.pair?.includes(e.pointerId)) {
      const now = this.measure(this.pair);
      const rect = this.target.getBoundingClientRect();
      this.callbacks.update({
        startCentre: this.start.centre,
        centre: now.centre,
        scale: Math.max(now.distance, MIN_DISTANCE) / Math.max(this.start.distance, MIN_DISTANCE),
        width: rect.width,
      });
    }
    return this.active;
  }

  /** A finger lifted (or the browser cancelled it). Returns true if the event belongs to a gesture. */
  up(e: GestureEvent): boolean {
    if (e.pointerType !== 'touch') return false;
    const taken = this.active;
    this.points.delete(e.pointerId);
    if (this.pair?.includes(e.pointerId)) {
      this.pair = null;
      this.leftover = this.points.size > 0;
    }
    if (this.points.size === 0) this.reset();
    return taken;
  }

  private reset(): void {
    this.points.clear();
    this.pair = null;
    this.leftover = false;
  }

  private beginPair(latestId: number): void {
    const ids = [...this.points.keys()].slice(0, 2) as [number, number];
    this.pair = ids;
    this.leftover = false;
    this.start = this.measure(ids);
    this.callbacks.begin();
    // Keep receiving this finger's moves even if it strays off the pane.
    this.target.setPointerCapture(latestId);
  }

  /** Midpoint (px from the pane's left edge) and distance of the two fingers. */
  private measure(ids: [number, number]): { centre: number; distance: number } {
    const a = this.points.get(ids[0]) as Point;
    const b = this.points.get(ids[1]) as Point;
    const left = this.target.getBoundingClientRect().left;
    return { centre: (a.x + b.x) / 2 - left, distance: Math.hypot(a.x - b.x, a.y - b.y) };
  }
}
