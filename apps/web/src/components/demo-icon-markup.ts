// SPDX-License-Identifier: AGPL-3.0-only
import { renderToStaticMarkup } from 'react-dom/server';
import { DemoIcon, type DemoIconName } from './demo-icon.js';

/** Static SVG for the server-rendered demo page; no browser bundle imports this module. */
export const demoIconMarkup = (name: DemoIconName) => renderToStaticMarkup(DemoIcon({ name }));
