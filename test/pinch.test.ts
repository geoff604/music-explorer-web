import { beforeEach, describe, expect, it } from 'vitest';
import { Bounds1D, PinchInput, Window1D, zoomPanWindow } from '../src/core/pinch';
import { GestureEvent, TwoFingerGesture } from '../src/ui/gestures';

// ---- zoomPanWindow ------------------------------------------------------------------------

describe('zoomPanWindow', () => {
  const bounds: Bounds1D = { minSpan: 10, maxSpan: 1000, lo: 0, hi: 1000 };
  const start: Window1D = { left: 200, span: 400 };
  const width = 400; // 1 px = 1 unit at the start, which keeps the arithmetic readable
  const pinch = (over: Partial<PinchInput>): PinchInput => ({ startCentre: 200, centre: 200, scale: 1, width, ...over });
  /** The point of the line under a pixel position, for a window. */
  const under = (w: Window1D, px: number) => w.left + (px / width) * w.span;

  it('leaves the window alone when nothing has moved', () => {
    expect(zoomPanWindow(start, pinch({}), bounds)).toEqual(start);
  });

  it('scrolls with the fingers: dragging right shows earlier content', () => {
    const next = zoomPanWindow(start, pinch({ centre: 300 }), bounds); // both fingers 100 px right
    expect(next.span).toBe(400);
    expect(next.left).toBe(100); // 100 px at 1 unit per px
  });

  it('zooms in when the fingers move apart, keeping the point under them fixed', () => {
    const next = zoomPanWindow(start, pinch({ scale: 2 }), bounds);
    expect(next.span).toBe(200);
    expect(under(next, 200)).toBeCloseTo(under(start, 200), 9);
  });

  it('zooms out when the fingers move together, keeping the point under them fixed', () => {
    const next = zoomPanWindow(start, pinch({ scale: 0.5, startCentre: 100, centre: 100 }), bounds);
    expect(next.span).toBe(800);
    expect(under(next, 100)).toBeCloseTo(under(start, 100), 9);
  });

  it('does both at once: the content under the fingers follows them while it zooms', () => {
    const p = pinch({ scale: 1.6, startCentre: 150, centre: 260 });
    const next = zoomPanWindow(start, p, bounds);
    expect(next.span).toBeCloseTo(250, 9);
    // What was under the fingers when they started is under them now.
    expect(under(next, 260)).toBeCloseTo(under(start, 150), 9);
  });

  it('stops at the most zoomed in and most zoomed out', () => {
    expect(zoomPanWindow(start, pinch({ scale: 1000 }), bounds).span).toBe(10);
    expect(zoomPanWindow(start, pinch({ scale: 0.001 }), bounds).span).toBe(1000);
  });

  it('never leaves the line, at either end', () => {
    const farRight = zoomPanWindow(start, pinch({ centre: -5000 }), bounds);
    expect(farRight.left + farRight.span).toBeLessThanOrEqual(1000);
    const farLeft = zoomPanWindow(start, pinch({ centre: 5000 }), bounds);
    expect(farLeft.left).toBe(0);
    const whole = zoomPanWindow(start, pinch({ scale: 0.001 }), bounds);
    expect(whole.left).toBe(0);
  });

  it('is measured from the start, so repeating an update gives the same answer', () => {
    const p = pinch({ scale: 1.3, centre: 230 });
    expect(zoomPanWindow(start, p, bounds)).toEqual(zoomPanWindow(start, p, bounds));
  });

  it('ignores a pane with no width or a nonsense scale', () => {
    expect(zoomPanWindow(start, pinch({ width: 0 }), bounds)).toEqual(start);
    expect(zoomPanWindow(start, pinch({ scale: 0 }), bounds)).toEqual(start);
    expect(zoomPanWindow(start, pinch({ scale: Number.NaN }), bounds)).toEqual(start);
  });
});

// ---- TwoFingerGesture ---------------------------------------------------------------------

describe('TwoFingerGesture', () => {
  const RECT_LEFT = 10;
  const RECT_WIDTH = 300;

  let log: string[];
  let updates: PinchInput[];
  let captured: number[];
  let gesture: TwoFingerGesture;

  const touch = (id: number, x: number, y = 0, isPrimary = id === 1): GestureEvent => ({
    pointerId: id,
    pointerType: 'touch',
    isPrimary,
    clientX: x,
    clientY: y,
  });

  beforeEach(() => {
    log = [];
    updates = [];
    captured = [];
    gesture = new TwoFingerGesture(
      {
        getBoundingClientRect: () => ({ left: RECT_LEFT, width: RECT_WIDTH }),
        setPointerCapture: (id) => void captured.push(id),
      },
      {
        begin: () => log.push('begin'),
        update: (p) => {
          log.push('update');
          updates.push(p);
        },
      },
    );
  });

  it('never takes a single finger: one-finger behaviour is untouched', () => {
    expect(gesture.down(touch(1, 100))).toBe(false);
    expect(gesture.move(touch(1, 140))).toBe(false);
    expect(gesture.up(touch(1, 140))).toBe(false);
    expect(log).toEqual([]);
  });

  it('starts when a second finger lands, telling the pane to cancel what the first began', () => {
    gesture.down(touch(1, 100));
    expect(gesture.down(touch(2, 200))).toBe(true);
    expect(log).toEqual(['begin']);
    expect(captured).toEqual([2]);
    expect(gesture.active).toBe(true);
  });

  it('reports the midpoint from the pane edge, and the scale from the start distance', () => {
    gesture.down(touch(1, 100));
    gesture.down(touch(2, 200)); // 100 apart, centred on x=150 => 140 from the pane's left edge
    gesture.move(touch(1, 50)); // 150 apart, centre x=125
    expect(updates.at(-1)).toEqual({ startCentre: 140, centre: 115, scale: 1.5, width: RECT_WIDTH });
    gesture.move(touch(2, 250)); // 200 apart, centre x=150
    expect(updates.at(-1)).toMatchObject({ centre: 140, scale: 2 });
  });

  it('measures distance in both directions, so fingers at an angle still pinch', () => {
    gesture.down(touch(1, 100, 100));
    gesture.down(touch(2, 100, 200)); // stacked vertically: 100 apart
    gesture.move(touch(2, 100, 300)); // 200 apart
    expect(updates.at(-1)?.scale).toBe(2);
  });

  it('stays finite when the fingers start almost touching', () => {
    gesture.down(touch(1, 100));
    gesture.down(touch(2, 101)); // 1 px apart
    gesture.move(touch(2, 300));
    const scale = updates.at(-1)?.scale ?? Number.NaN;
    expect(Number.isFinite(scale)).toBe(true);
    expect(scale).toBeLessThan(30);
  });

  it('takes the leftover finger until it lifts, so it cannot start a selection or a note', () => {
    gesture.down(touch(1, 100));
    gesture.down(touch(2, 200));
    expect(gesture.up(touch(2, 200))).toBe(true); // the gesture ends...
    const before = log.length;
    expect(gesture.move(touch(1, 120))).toBe(true); // ...but finger 1 is still not a normal touch
    expect(log.length).toBe(before); // and it does not drive the view
    expect(gesture.up(touch(1, 120))).toBe(true);
    expect(gesture.active).toBe(false);
  });

  it('treats the next touch as an ordinary one once everything has lifted', () => {
    gesture.down(touch(1, 100));
    gesture.down(touch(2, 200));
    gesture.up(touch(1, 100));
    gesture.up(touch(2, 200));
    expect(gesture.down(touch(3, 100, 0, true))).toBe(false);
    expect(gesture.up(touch(3, 100))).toBe(false);
  });

  it('starts a new gesture when a second finger joins the leftover one', () => {
    gesture.down(touch(1, 100));
    gesture.down(touch(2, 200));
    gesture.up(touch(2, 200));
    expect(gesture.down(touch(3, 250))).toBe(true);
    expect(log.filter((l) => l === 'begin')).toHaveLength(2);
  });

  it('ignores a third finger without disturbing the gesture', () => {
    gesture.down(touch(1, 100));
    gesture.down(touch(2, 200));
    expect(gesture.down(touch(3, 150))).toBe(true);
    expect(log.filter((l) => l === 'begin')).toHaveLength(1);
    const n = updates.length;
    gesture.move(touch(3, 190));
    expect(updates.length).toBe(n); // only the two driving fingers move the view
  });

  it('ends cleanly when the browser cancels the touches', () => {
    gesture.down(touch(1, 100));
    gesture.down(touch(2, 200));
    gesture.up(touch(1, 100)); // a pointercancel arrives through up() as well
    gesture.up(touch(2, 200));
    expect(gesture.active).toBe(false);
  });

  it('recovers if a finger lifted without an event ever arriving', () => {
    gesture.down(touch(1, 100));
    gesture.down(touch(2, 200)); // then both lift, but the page never hears about it
    expect(gesture.active).toBe(true);
    // A new touch sequence starts with a primary pointer, which clears the stale state.
    expect(gesture.down(touch(7, 100, 0, true))).toBe(false);
    expect(gesture.active).toBe(false);
  });

  it('ignores the mouse and pen entirely', () => {
    for (const pointerType of ['mouse', 'pen']) {
      const e = { ...touch(1, 100), pointerType };
      expect(gesture.down(e)).toBe(false);
      expect(gesture.down({ ...e, pointerId: 2 })).toBe(false);
      expect(gesture.move(e)).toBe(false);
      expect(gesture.up(e)).toBe(false);
    }
    expect(log).toEqual([]);
  });

  it('does not report moves from a pointer it never saw go down', () => {
    expect(gesture.move(touch(9, 100))).toBe(false);
  });
});
