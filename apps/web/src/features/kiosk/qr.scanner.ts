// SPDX-License-Identifier: AGPL-3.0-only
import jsQR from 'jsqr';

type Detector = { detect(source: HTMLVideoElement): Promise<readonly { rawValue: string }[]> };
type DetectorConstructor = { new(options: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> };
export interface CameraScan { stop(): void }
/** Frames stay on the device. One bounded frame every 250 ms avoids continuous CPU use on tablets. */
export async function scanQrCamera(video: HTMLVideoElement, onCode: (code: string) => void, onError: () => void): Promise<CameraScan> {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } } });
  const stop = () => {
    if (stopped) return;
    stopped = true; clearTimeout(timer); stream.getTracks().forEach((track) => track.stop()); video.srcObject = null;
  };
  try {
    video.srcObject = stream;
    await video.play();
    const NativeDetector = (globalThis as typeof globalThis & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
    let detector: Detector | undefined;
    try {
      if (NativeDetector && (!NativeDetector.getSupportedFormats || (await NativeDetector.getSupportedFormats()).includes('qr_code')))
        detector = new NativeDetector({ formats: ['qr_code'] });
    } catch { /* Use the local decoder when the browser's detector is unavailable. */ }
    const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
    if (!detector && !context) throw new Error('Camera decoder is unavailable');
    async function frame() {
      if (stopped) return;
      try {
        let code: string | undefined;
        if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          if (detector) {
            try { code = (await detector.detect(video)).find((item) => /^pgci1_[A-Za-z0-9_-]{43}$/.test(item.rawValue))?.rawValue; }
            catch { detector = undefined; }
          }
          if (!detector && context) {
            const scale = Math.min(1, 640 / video.videoWidth, 480 / video.videoHeight);
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' })?.data;
          }
        }
        if (stopped) return;
        if (code && /^pgci1_[A-Za-z0-9_-]{43}$/.test(code)) { stop(); onCode(code); return; }
        timer = setTimeout(() => void frame(), 250);
      } catch { if (!stopped) { stop(); onError(); } }
    }
    void frame();
    return { stop };
  } catch (error) { stop(); throw error; }
}
