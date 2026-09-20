import './style.css';
import { App } from './ui/App';
import { trackViewportHeight } from './ui/viewport';

trackViewportHeight();
// `?buffer=2048` (a power of two from 256 to 16384) sets the fallback tone's block size, to tune
// the trade between dropouts and latency on a device without redeploying. See AudioEngine.ts.
const requestedBuffer = Number(new URLSearchParams(location.search).get('buffer'));
const app = new App({ fallbackBufferSize: requestedBuffer || undefined });

if (location.search.includes('debug')) {
  void import('./ui/debug').then((m) =>
    m.showLayoutDebug({ errors: () => app.debugErrors(), audio: () => app.audioDebugLines() }),
  );
}
