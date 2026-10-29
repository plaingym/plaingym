// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import { scanQrCamera } from './qr.scanner.js';

const code = 'pgci1_' + 'a'.repeat(43), stopTrack = vi.fn(), play = vi.fn(async () => undefined);
let video: HTMLVideoElement;
beforeEach(() => {
  vi.useFakeTimers();
  video = document.createElement('video');
  Object.defineProperties(video, { play: { value: play }, readyState: { value: 2 }, videoWidth: { value: 320 }, videoHeight: { value: 240 } });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('uses the native QR detector, stops the stream after a valid code, and never uploads frames', async () => {
  const detect = vi.fn(async () => [{ rawValue: code }]), found = vi.fn();
  vi.stubGlobal('BarcodeDetector', class { static getSupportedFormats = async () => ['qr_code']; detect = detect; });
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await scanQrCamera(video, found, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(found).toHaveBeenCalledWith(code); expect(stopTrack).toHaveBeenCalledTimes(1); expect(video.srcObject).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('decodes an actual generated QR through jsQR when native detection is missing or fails', async () => {
  const matrix = QRCode.create(code, { errorCorrectionLevel: 'M' }).modules, margin = 4, scale = 5;
  const size = (matrix.size + margin * 2) * scale, pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const row = Math.floor(y / scale) - margin, col = Math.floor(x / scale) - margin;
    if (row >= 0 && col >= 0 && row < matrix.size && col < matrix.size && matrix.get(row, col)) {
      const index = (y * size + x) * 4; pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
    }
  }
  vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({ drawImage: vi.fn(), getImageData: () => ({ data: pixels, width: size, height: size }) } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('BarcodeDetector', class { detect = async () => { throw new Error('unsupported'); }; });
  const found = vi.fn(); await scanQrCamera(video, found, vi.fn()); await vi.advanceTimersByTimeAsync(0);
  expect(found).toHaveBeenCalledWith(code); expect(stopTrack).toHaveBeenCalledTimes(1);
});
it('ignores unrelated QR contents and stops its bounded timer on cancellation', async () => {
  const detect = vi.fn(async () => [{ rawValue: 'https://untrusted.example/' }]), found = vi.fn();
  vi.stubGlobal('BarcodeDetector', class { detect = detect; });
  const active = await scanQrCamera(video, found, vi.fn());
  await vi.advanceTimersByTimeAsync(999);
  expect(detect).toHaveBeenCalledTimes(4); expect(found).not.toHaveBeenCalled();
  active.stop(); await vi.advanceTimersByTimeAsync(1000);
  expect(detect).toHaveBeenCalledTimes(4); expect(stopTrack).toHaveBeenCalledTimes(1);
});
it('cleans up a stream when video playback fails', async () => {
  play.mockRejectedValueOnce(new Error('video failed'));
  await expect(scanQrCamera(video, vi.fn(), vi.fn())).rejects.toThrow('video failed');
  expect(stopTrack).toHaveBeenCalledTimes(1); expect(video.srcObject).toBeNull();
});
it('does not emit a late native result after stopping', async () => {
  let finish!: (value: { rawValue: string }[]) => void;
  vi.stubGlobal('BarcodeDetector', class { detect = () => new Promise<{ rawValue: string }[]>((resolve) => { finish = resolve; }); });
  const found = vi.fn(), active = await scanQrCamera(video, found, vi.fn());
  active.stop(); finish([{ rawValue: code }]); await vi.advanceTimersByTimeAsync(0);
  expect(found).not.toHaveBeenCalled();
});
