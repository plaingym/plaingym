// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from 'react';
import { text } from './data.js';

export interface ChartSeries { label: string; values: number[]; line?: boolean }
/** Small SVG chart; the immediately following table is the full text alternative. */
export function ReportChart({ title, periods, series, format = String }: {
  title: string; periods: string[]; series: ChartSeries[]; format?: (value: number) => string;
}) {
  const id = useId();
  const values = series.flatMap(item => item.values), min = Math.min(0, ...values), max = Math.max(1, ...values);
  const y = (value: number) => 170 - (value - min) / (max - min) * 145;
  const step = 540 / Math.max(periods.length, 1), x = (index: number) => 50 + (index + 0.5) * step;
  const bars = series.filter(item => !item.line), width = Math.min(28, step / (bars.length + 1));
  const tones = ['text-primary', 'text-muted-foreground', 'text-foreground'];
  return <figure className="min-w-0 space-y-2 rounded-xl border border-border p-3">
    <figcaption className="font-medium">{title}</figcaption>
    <p id={id + '-description'} className="text-sm text-muted-foreground">{text('chartHelp')}</p>
    <svg role="img" aria-labelledby={id + '-title'} aria-describedby={id + '-description'} viewBox="0 0 610 220" className="h-auto w-full">
      <title id={id + '-title'}>{title}</title>
      <line x1="50" y1={y(0)} x2="590" y2={y(0)} className="stroke-border" />
      <text x="4" y="18" className="hidden fill-muted-foreground text-[12px] sm:block">{format(max)}</text>
      <text x="4" y="190" className="hidden fill-muted-foreground text-[12px] sm:block">{format(min)}</text>
      {series.map((item, seriesIndex) => <g key={item.label} className={tones[seriesIndex % tones.length]}>
        {item.line ? <>
          <polyline fill="none" stroke="currentColor" strokeWidth="2" points={item.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')} />
          {item.values.map((value, index) => <circle key={index} cx={x(index)} cy={y(value)} r="3" fill="currentColor"><title>{periods[index]}: {item.label}: {format(value)}</title></circle>)}
        </> : item.values.map((value, index) => <rect key={index} x={x(index) + (bars.indexOf(item) - bars.length / 2) * width} y={Math.min(y(0), y(value))}
          width={width * 0.85} height={Math.abs(y(value) - y(0))} fill="currentColor">
          <title>{periods[index]}: {item.label}: {format(value)}</title>
        </rect>)}
      </g>)}
      {periods.map((label, index) => (index === 0 || index === periods.length - 1 || index % Math.max(1, Math.ceil(periods.length / 4)) === 0)
        && <text key={index} x={x(index)} y="210" textAnchor="middle" className="hidden fill-muted-foreground text-[12px] sm:block">{label}</text>)}
    </svg>
    <p className="text-sm text-muted-foreground">{text('chartRange', { from: periods[0] ?? '', to: periods.at(-1) ?? '', min: format(min), max: format(max) })}</p>
    <ul className="flex flex-wrap gap-3 text-sm">{series.map((item, index) => <li key={item.label} className="flex items-center gap-2">
      <span aria-hidden="true" className={'inline-block w-5 border-current ' + tones[index % tones.length] + (item.line ? ' border-t-2' : ' h-3 bg-current')} />
      {text(item.line ? 'lineLegend' : 'barLegend', { name: item.label })}
    </li>)}</ul>
  </figure>;
}
