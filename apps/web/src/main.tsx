// SPDX-License-Identifier: AGPL-3.0-only
// The app's Content Security Policy has no 'unsafe-eval'.
import './validation';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import './app/styles.css';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(<StrictMode><App /></StrictMode>);
