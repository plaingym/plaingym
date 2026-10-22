// SPDX-License-Identifier: AGPL-3.0-only
import type { RoutePermission } from './permissions.js';

export interface RegistryEntry {
  readonly id: string;
  readonly order?: number;
  readonly moduleId?: string;
}

export class Registry<T extends RegistryEntry> {
  readonly #entries = new Map<string, T>();
  register(entry: T): void {
    if (!entry.id || this.#entries.has(entry.id))
      throw new Error(`Duplicate or empty registration: ${entry.id}`);
    this.#entries.set(entry.id, Object.freeze({ ...entry }));
  }
  registerAll(entries: readonly T[]): void {
    for (const entry of entries) this.register(entry);
  }
  all(): readonly T[] {
    return [...this.#entries.values()].sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  forModules(enabled: ReadonlySet<string>): readonly T[] {
    return this.all().filter((entry) => !entry.moduleId || enabled.has(entry.moduleId));
  }
}

export interface NavigationEntry extends RegistryEntry {
  readonly labelKey: string;
  readonly href: string;
  readonly permission: RoutePermission;
  readonly enabled: boolean;
}

export interface ViewEntry<View> extends RegistryEntry {
  readonly labelKey: string;
  readonly permission: RoutePermission;
  readonly enabled: boolean;
  readonly component: View;
}

export interface WebContribution<View> {
  readonly adminNav?: readonly NavigationEntry[];
  readonly portalNav?: readonly NavigationEntry[];
  readonly memberTabs?: readonly ViewEntry<View>[];
  readonly sessionPanels?: readonly ViewEntry<View>[];
  readonly settingsSections?: readonly ViewEntry<View>[];
  readonly setupSteps?: readonly ViewEntry<View>[];
  readonly portalPages?: readonly ViewEntry<View>[];
}

export function createWebRegistries<View>(contributions: readonly WebContribution<View>[]) {
  const registries = {
    adminNav: new Registry<NavigationEntry>(),
    portalNav: new Registry<NavigationEntry>(),
    memberTabs: new Registry<ViewEntry<View>>(),
    sessionPanels: new Registry<ViewEntry<View>>(),
    settingsSections: new Registry<ViewEntry<View>>(),
    setupSteps: new Registry<ViewEntry<View>>(),
    portalPages: new Registry<ViewEntry<View>>(),
  };
  for (const contribution of contributions) {
    registries.adminNav.registerAll(contribution.adminNav ?? []);
    registries.portalNav.registerAll(contribution.portalNav ?? []);
    registries.memberTabs.registerAll(contribution.memberTabs ?? []);
    registries.sessionPanels.registerAll(contribution.sessionPanels ?? []);
    registries.settingsSections.registerAll(contribution.settingsSections ?? []);
    registries.setupSteps.registerAll(contribution.setupSteps ?? []);
    registries.portalPages.registerAll(contribution.portalPages ?? []);
  }
  return registries;
}
