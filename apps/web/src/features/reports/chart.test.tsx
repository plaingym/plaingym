// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ReportChart } from './chart.js';

afterEach(cleanup);
describe('ReportChart legend', () => {
  it('uses month and year on monthly axes, point titles and the range, including line series', () => {
    const { container } = render(<ReportChart title="Members" monthly periods={['2025-10-01', '2026-09-01']}
      series={[{ label: 'New', values: [1, 2] }, { label: 'Active', values: [2, 3], line: true }]}/>);
    expect(container.querySelector('rect title')?.textContent).toBe('October 2025: New: 1');
    expect(container.querySelector('circle title')?.textContent).toBe('October 2025: Active: 2');
    expect(container.querySelector('svg')?.textContent).toContain('September 2026');
    expect(container.textContent).toContain('October 2025 to September 2026');
    expect(container.textContent).not.toContain('Sep 1, 2026');
  });
  it('groups count axes, ranges and data point titles', () => {
    const { container } = render(<ReportChart title="Visits" periods={['2026-10-01']} series={[{ label: 'Visits', values: [1200] }]}/>);
    expect(container.textContent).toContain('1,200');
    expect(container.querySelector('rect title')?.textContent).toContain('Visits: 1,200');
    expect(container.querySelector('rect')?.getAttribute('height')).toBe('145');
  });
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
