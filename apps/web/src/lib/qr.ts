// SPDX-License-Identifier: AGPL-3.0-only
import { renderSVG } from 'uqr';

/** Render a QR image without persisting its contents. Rendering errors belong to the caller's UI. */
export function qrDataUrl(value: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(renderSVG(value, { ecc: 'M', border: 4 }));
}
