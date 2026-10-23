// SPDX-License-Identifier: AGPL-3.0-only
/** Short tones so members can hear the result from across the desk; silent where audio is unavailable. */
let context: AudioContext | undefined;
export function playTone(kind: 'success' | 'attention') {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const notes = kind === 'success' ? [660, 880] : [440, 330];
    notes.forEach((frequency, index) => {
      const oscillator = context!.createOscillator(), gain = context!.createGain(), start = context!.currentTime + index * 0.14;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.15, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
      oscillator.connect(gain).connect(context!.destination);
      oscillator.start(start); oscillator.stop(start + 0.13);
    });
  } catch { /* audio unavailable */ }
}
