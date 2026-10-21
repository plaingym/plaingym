// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';

export const app = new Hono();
// Explicitly public liveness probe; it exposes no gym or household data.
app.get('/healthz', (context) => context.json({ status: 'ok' }));
