// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ShellServices } from './services.js';
export const ShellServicesContext = createContext<ShellServices | null>(null);
export function useShellServices() {
  const services = useContext(ShellServicesContext);
  if (!services) throw new Error('Shell services provider is required');
  return services;
}
export const bootstrapKey = ['shell', 'bootstrap'] as const;
export function useBootstrap() {
  const services = useShellServices();
  return useQuery({ queryKey: bootstrapKey, queryFn: ({ signal }) => services.loadBootstrap(signal) });
}
