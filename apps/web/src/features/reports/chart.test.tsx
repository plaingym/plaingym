// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ReportChart } from './chart.js';

afterEach(cleanup);
describe('ReportChart legend', () => {
  it('gives each swatch its tone and its bar or line shape as separate classes', () => {
    const { container } = render(<ReportChart title="Chart" periods={['2026-10-01', '2026-11-01']} series={[
      { label: 'New', values: [1, 2] }, { label: 'Active', values: [3, 4], line: true },
    ]} />);
    expect(container.textContent).toContain('Oct 1, 2026');
    expect(container.textContent).not.toContain('2026-10-01');
    const swatches = [...container.querySelectorAll('li > span')].map(span => [...span.classList]);
    expect(swatches[0]).toEqual(expect.arrayContaining(['text-primary', 'h-3', 'bg-current']));
    expect(swatches[1]).toEqual(expect.arrayContaining(['text-muted-foreground', 'border-t-2']));
  });
});
