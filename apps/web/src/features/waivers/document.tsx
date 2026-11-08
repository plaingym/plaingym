// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { WaiverPdfResponse, WaiverTemplate } from '@plaingym/shared/contracts';
import { t } from '../../lib/i18n.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';

export function useWaiverDocument(template: WaiverTemplate, key: readonly unknown[], load: () => Promise<WaiverPdfResponse>) {
  return useQuery({ queryKey: [...key, 'document', template.id, template.document?.hash], queryFn: load,
    // The interval stops while the tab is hidden, so a reader returning from the document's own tab refreshes on focus.
    enabled: !!template.document, refetchInterval: 240_000, staleTime: 240_000, gcTime: 0, refetchOnWindowFocus: true });
}
export function WaiverDocument({ template, query }: { template: WaiverTemplate; query: ReturnType<typeof useWaiverDocument> }) {
  if (!template.document) return <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3" dir="auto" tabIndex={0}>{template.body}</div>;
  if (query.isPending) return <LoadingState />;
  if (!query.data) return <ErrorState onRetry={() => void query.refetch()} />;
  return <LoadedDocument key={template.id} template={template} url={query.data.data.url} />;
}
function LoadedDocument({ template, url }: { template: WaiverTemplate; url: string }) {
  // Refresh the link's capability without navigating the document under its reader.
  const [previewUrl] = useState(url);
  return <div className="min-w-0 space-y-2">
    <iframe className="h-96 w-full rounded-lg border border-border" src={previewUrl} title={template.name} referrerPolicy="no-referrer" />
    <a className="inline-flex min-h-11 items-center break-words underline" href={url} target="_blank" rel="noopener noreferrer">{t('waivers/waivers:openDocument')}</a>
    <p className="text-sm text-muted-foreground">{t('waivers/waivers:documentHelp')}</p>
  </div>;
}
