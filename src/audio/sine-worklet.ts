/**
 * AudioWorklet processor wrapping {@link SineVoice}. Runs in the audio rendering thread; the main
 * thread sends `{ type: 'on', hz }` / `{ type: 'off' }` messages.
 */

import { SineVoice } from '../core/sineVoice';

// The DOM lib does not describe the AudioWorkletGlobalScope, so declare what we use.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  ctor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  },
): void;

type Message = { type: 'on'; hz: number } | { type: 'off' };

class SineProcessor extends AudioWorkletProcessor {
  private readonly voice = new SineVoice(sampleRate);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<Message>) => {
      if (e.data.type === 'on') this.voice.noteOn(e.data.hz);
      else this.voice.noteOff();
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channel = outputs[0]?.[0];
    if (!channel) return true;
    this.voice.render(channel);
    // Mirror to any extra channels so the tone is centred.
    for (let c = 1; c < (outputs[0]?.length ?? 0); c++) (outputs[0]?.[c] as Float32Array).set(channel);
    return true;
  }
}

registerProcessor('music-explorer-sine', SineProcessor);
