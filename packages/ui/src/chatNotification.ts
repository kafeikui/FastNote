import type { ChatSoundId } from '@fastnote/api';
import { translate, type Locale } from '@fastnote/i18n';

interface ToneStep {
  freqFrom: number;
  freqTo: number;
  type: OscillatorType;
  start: number;
  duration: number;
  peakGain: number;
}

const SOUND_RECIPES: Record<ChatSoundId, ToneStep[]> = {
  chime: [
    { freqFrom: 880, freqTo: 660, type: 'sine', start: 0, duration: 0.22, peakGain: 1 },
  ],
  bell: [
    { freqFrom: 1320, freqTo: 1180, type: 'triangle', start: 0, duration: 0.35, peakGain: 0.9 },
    { freqFrom: 1980, freqTo: 1760, type: 'sine', start: 0, duration: 0.18, peakGain: 0.35 },
  ],
  pop: [
    { freqFrom: 520, freqTo: 220, type: 'square', start: 0, duration: 0.09, peakGain: 0.8 },
  ],
  soft: [
    { freqFrom: 520, freqTo: 440, type: 'sine', start: 0, duration: 0.5, peakGain: 0.7 },
  ],
};

export function chatSoundLabel(soundId: ChatSoundId, locale: Locale = 'zh'): string {
  return translate(locale, `chatSound.${soundId}`);
}

/** Short notification tone via Web Audio (no external asset). */
export function playChatNotificationSound(soundId: ChatSoundId = 'chime', volume = 0.6): void {
  try {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = Math.max(0, Math.min(1, volume));
    master.connect(ctx.destination);

    const steps = SOUND_RECIPES[soundId] ?? SOUND_RECIPES.chime;
    let maxEnd = 0;
    for (const step of steps) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const startAt = ctx.currentTime + step.start;
      const endAt = startAt + step.duration;
      osc.type = step.type;
      osc.frequency.setValueAtTime(step.freqFrom, startAt);
      osc.frequency.exponentialRampToValueAtTime(step.freqTo, endAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(step.peakGain, startAt + Math.min(0.02, step.duration / 4));
      gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
      osc.connect(gain);
      gain.connect(master);
      osc.start(startAt);
      osc.stop(endAt + 0.02);
      maxEnd = Math.max(maxEnd, endAt + 0.05);
    }
    setTimeout(() => void ctx.close(), (maxEnd + 0.1) * 1000);
  } catch {
    /* autoplay policy or unsupported */
  }
}
