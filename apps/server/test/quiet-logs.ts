// SPDX-License-Identifier: AGPL-3.0-only
// Tests that throw on purpose would print an error log line each; TEST_LOGS=1 shows them.
import { setLogSink } from '../src/core/log.js';

if (process.env.TEST_LOGS !== '1') setLogSink(() => {});
