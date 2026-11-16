// SPDX-License-Identifier: AGPL-3.0-only
import { createElement } from 'react';
import { Users, Award, CalendarDays, ScanLine, Smartphone, CreditCard, FileSignature, UserPlus, ChartNoAxesCombined, Server, Database, Code, LockKeyhole, HeartHandshake, Play, Github, Menu } from 'lucide-react';

const icons = { members: Users, ranks: Award, schedule: CalendarDays, kiosk: ScanLine, portal: Smartphone,
  billing: CreditCard, waivers: FileSignature, join: UserPlus, reports: ChartNoAxesCombined, server: Server,
  data: Database, standards: LockKeyhole, open: Code, selfHost: Server, owner: HeartHandshake, coach: Award, student: Smartphone,
  play: Play, github: Github, menu: Menu };
export type DemoIconName = keyof typeof icons;
/** Text beside every icon supplies its accessible name. Also rendered statically by the entry page. */
export function DemoIcon({ name, className = 'h-6 w-6' }: { name: DemoIconName; className?: string }) {
  return createElement(icons[name], { className, 'aria-hidden': true, focusable: false, strokeWidth: 1.75 });
}
