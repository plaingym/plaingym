// SPDX-License-Identifier: AGPL-3.0-only
import { formatCount } from '../../lib/count.js';
import { parseResponse } from '../../lib/response.js';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { importTargetFieldSchema, importUploadSchema, importPreviewStateSchema, importJobSchema, importIssueSchema,
  exportJobSchema, listResponseSchema, type ImportUpload, type ImportColumnMapping, type ImportMapper,
  type ImportPlanRequest, type ImportPreviewResponse } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { useDemoSandbox } from '../demo/notice.js';
import { createJsonTransport, readApiError, reportApiRefusal } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Pager } from '../../components/ui/pager.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert } from '../../components/ui/alert.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { Select } from '../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { Badge, TableContainer } from '../../components/ui/table.js';
const request = createJsonTransport();
const label = (key: string) => t('imports/pipeline:' + key);
class PreviewError extends Error {}
class RetryablePreviewError extends PreviewError {}
async function readPreviewResponse(response: Response) {
  if (!response.ok) {
    await reportApiRefusal(response);
    const { message } = await readApiError(response, [{ status: 400, code: 'invalid_request' }, { status: 404, code: 'not_found' },
      { status: 503, code: 'unavailable' }]);
    if (response.status >= 500) throw new RetryablePreviewError(message ?? label('requestFailed'));
    if (message) throw new PreviewError(message);
    throw new Error('Preview failed');
  }
  const state = parseResponse(importPreviewStateSchema, await response.json());
  if (state.status === 'failed') throw new PreviewError(state.message);
  return state;
}
const card = 'min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 sm:p-6';
const summaryTone = { create: 'success', update: 'default', skip: 'muted' } as const;
function ImportPanel({ gymId }: { gymId: string }) {
  const demo = useDemoSandbox();
  const [upload, setUpload] = useState<ImportUpload>(), [mapping, setMapping] = useState<ImportColumnMapping[]>([]);
  const [mapper, setMapper] = useState<ImportMapper>('people'), [duplicatePolicy, setPolicy] = useState<ImportPlanRequest['duplicatePolicy']>('error');
  const [preview, setPreview] = useState<ImportPreviewResponse>(), [offset, setOffset] = useState(0);
  const [previewTicket, setPreviewTicket] = useState<{ id: string; uploadId: string; status: 'queued' | 'computing'; page: number; fingerprint: string }>();
  const [runId, setRunId] = useState<string>(), [runPlan, setRunPlan] = useState(''), [errorOffset, setErrorOffset] = useState(0);
  const plan = upload ? { uploadId: upload.id, mapper, mapping, duplicatePolicy } : undefined;
  const fingerprint = JSON.stringify(plan);
  const currentPlan = useRef(fingerprint);
  useEffect(() => { currentPlan.current = fingerprint; }, [fingerprint]);
  // Keep polling the upload's previous plan so editing columns cannot queue another abandoned preview.
  const ticket = previewTicket;
  const previewProgress = useQuery({ queryKey: ['import-preview', gymId, ticket?.id, ticket?.page], enabled: !!ticket,
    retry: (failures, error) => failures < 3 && (error instanceof RetryablePreviewError || error instanceof TypeError),
    retryDelay: attempt => Math.min(250 * 2 ** attempt, 1000), refetchOnWindowFocus: false, refetchOnReconnect: false,
    queryFn: async ({ signal }) => readPreviewResponse(await fetch(`/api/imports/uploads/${ticket!.uploadId}/previews/${ticket!.id}?offset=${ticket!.page}&limit=50`,
      { credentials: 'same-origin', redirect: 'error', signal })),
    refetchInterval: query => query.state.status === 'error' || query.state.data?.status === 'ready' ? false : 1000 });
  useEffect(() => {
    if (ticket && previewProgress.data?.status === 'ready') {
      if (ticket.fingerprint === currentPlan.current) {
        setPreview(previewProgress.data.preview); setOffset(previewProgress.data.preview.pagination.offset);
      }
      setPreviewTicket(undefined);
    }
  }, [ticket, previewProgress.data]);
  const progress = useQuery({ queryKey: ['imports', gymId, runId], enabled: !!runId,
    queryFn: async () => parseResponse(importJobSchema, (await request<{ data: unknown }>('/api/imports/' + runId)).data),
    refetchInterval: (query) => query.state.data && ['succeeded', 'failed'].includes(query.state.data.status) ? false : 1500 });
  const errors = useQuery({ queryKey: ['imports', gymId, runId, 'errors', errorOffset], enabled: !!runId && !!progress.data?.errorCount,
    queryFn: async () => {
      const response = await fetch(`/api/imports/${runId}/errors?offset=${errorOffset}&limit=50`, { credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) { await reportApiRefusal(response); throw new Error('Import report unavailable'); }
      return parseResponse(listResponseSchema(importIssueSchema), await response.json());
    }, refetchInterval: progress.data?.status === 'running' ? 1500 : false });
  const uploadFile = useMutation({ mutationFn: async (file: File) => {
    const form = new FormData(); form.set('file', file);
    const response = await fetch('/api/imports/uploads', { method: 'POST', body: form, credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) { await reportApiRefusal(response); throw new Error('Upload failed'); }
    return parseResponse(importUploadSchema, (await response.json() as { data: unknown }).data);
  }, onSuccess(data) { setUpload(data); setMapping(data.suggestedMapping ?? []); setPreview(undefined); setPreviewTicket(undefined); setRunId(undefined); setOffset(0); previewRows.reset(); } });
  const previewRows = useMutation({ mutationFn: async ({ page, fingerprint }: { page: number; fingerprint: string }) => {
    const response = await fetch(`/api/imports/preview?offset=${page}&limit=50`, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: fingerprint });
    return readPreviewResponse(response);
  }, onMutate() { setPreviewTicket(undefined); }, onSuccess(data, { fingerprint: requestedPlan, page }) {
    if (data.status === 'ready') {
      if (requestedPlan === currentPlan.current) { setPreview(data.preview); setOffset(data.preview.pagination.offset); }
    }
    else setPreviewTicket({ ...data, page, fingerprint: requestedPlan });
  } });
  const requestPreview = (page: number) => { if (plan) previewRows.mutate({ page, fingerprint }); };
  const start = useMutation({ mutationFn: async (dryRun: boolean) => parseResponse(importJobSchema, (await request<{ data: unknown }>('/api/imports', { ...plan, dryRun })).data),
    onSuccess(data) { setRunId(data.id); setRunPlan(fingerprint); setErrorOffset(0); } });
  const busy = uploadFile.isPending || start.isPending || progress.data?.status === 'pending' || progress.data?.status === 'running';
  const dryRunPassed = progress.data?.dryRun && progress.data.status === 'succeeded' && progress.data.errorCount === 0 && runPlan === fingerprint;
  // A preview's explanation must not stand in for a later failure of another request.
  const otherFailure = uploadFile.isError || start.isError || progress.isError || errors.isError;
  const previewFailure = ticket
    ? ticket.fingerprint === fingerprint && previewProgress.isError ? previewProgress.error : undefined
    : previewRows.variables?.fingerprint === fingerprint ? previewRows.error : undefined;
  const previewPending = previewRows.isPending || !!ticket && !previewProgress.isError;
  const columns = [...new Set(preview?.data.flatMap(row => Object.keys(row.values)) ?? [])];
  return <PageSection title={label('import')} description={label('mapperNotice')}><div className={card}>
    <ol className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-4" aria-label={label('steps')}>
      {(['stepUpload', 'stepMatch', 'stepCheck', 'stepCommit'] as const).map((step, index) => <li key={step}>{index + 1}. {label(step)}</li>)}</ol>
    <div className="grid gap-2"><Label htmlFor="csv-file">{label('file')}</Label>
      <Input id="csv-file" type="file" accept=".csv,text/csv" className="py-2" disabled={demo || !!busy || previewPending} onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadFile.mutate(file); }}/></div>
    {demo && <Alert>{label('demoNotice')}</Alert>}
    {(otherFailure || previewFailure) && <Alert variant="error" focusOnReveal>{!otherFailure && previewFailure instanceof PreviewError
      ? previewFailure.message : label('requestFailed')}</Alert>}
    {ticket && !previewProgress.isError && <p role="status" className="text-sm text-muted-foreground">{label(
      (previewProgress.data?.status ?? ticket.status) === 'queued' ? 'previewQueued' : 'previewComputing')}</p>}
    {upload && <>
      <p className="break-all text-sm"><span className="font-medium">{upload.filename}</span> · {label('rows')}: {formatCount(upload.rowCount)}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Label className="grid gap-2">{label('mapper')}<Select value={mapper} disabled={!!busy} onChange={(event) => { setMapper(event.target.value as ImportMapper); setPreview(undefined); if (!previewRows.isPending) previewRows.reset(); }}>
          {(['people', 'mat', 'memberships'] as const).map((id) => <option key={id} value={id}>{label('mapper.' + id)}</option>)}
        </Select></Label>
        <Label className="grid gap-2">{label('duplicates')}<Select value={duplicatePolicy} disabled={!!busy} onChange={(event) => { setPolicy(event.target.value as ImportPlanRequest['duplicatePolicy']); setPreview(undefined); if (!previewRows.isPending) previewRows.reset(); }}>
          {(['error', 'skip', 'update'] as const).map((policy) => <option key={policy} value={policy}>{label('policy.' + policy)}</option>)}
        </Select></Label>
      </div>
      <fieldset disabled={!!busy} className="min-w-0 space-y-3"><legend className="font-medium">{label('mapping')}</legend>
        <div className="divide-y divide-border rounded-xl border border-border">{upload.columns.map((column) =>
          <Label key={column} className="grid gap-2 p-3 sm:grid-cols-2 sm:items-center"><span className="break-all font-mono text-sm">{column}</span><Select
            value={mapping.find((item) => item.sourceColumn === column)?.targetField ?? ''} onChange={(event) => {
              const target = importTargetFieldSchema.safeParse(event.target.value);
              setMapping((previous) => [...previous.filter((item) => item.sourceColumn !== column && item.targetField !== event.target.value),
                ...(target.success ? [{ sourceColumn: column, targetField: target.data }] : [])]); setPreview(undefined); if (!previewRows.isPending) previewRows.reset();
            }}><option value="">{label('ignore')}</option>{importTargetFieldSchema.options.map((field) => <option key={field} value={field}>{label('field.' + field)}</option>)}</Select></Label>)}</div>
      </fieldset>
      <div className="grid gap-2 sm:flex">
        <Button variant="outline" disabled={!mapping.length || !!busy || previewPending} onClick={() => requestPreview(0)}>{label('preview')}</Button>
        <Button variant="outline" disabled={!mapping.length || !!busy} onClick={() => start.mutate(true)}>{label('dryRun')}</Button>
        <Button disabled={!dryRunPassed || !!busy} onClick={() => start.mutate(false)}>{label('commit')}</Button>
      </div>
      {!dryRunPassed && <p className="text-sm text-muted-foreground">{label('commitHelp')}</p>}
    </>}
    {preview && <div className="space-y-3">
      <ul className="flex flex-wrap gap-2" aria-label={label('summary')}>
        {(['create', 'update', 'skip'] as const).map((key) => <li key={key}><Badge tone={summaryTone[key]}>{label(key)}: {formatCount(preview.summary[key])}</Badge></li>)}
        <li><Badge tone={preview.summary.errors ? 'destructive' : 'muted'}>{label('errors')}: {formatCount(preview.summary.errors)}</Badge></li>
      </ul>
      <TableContainer label={label('previewTable')}><table className="w-full min-w-[32rem] text-left text-sm">
        <thead className="bg-muted"><tr><th scope="col" className="p-2">{label('row')}</th><th scope="col" className="p-2">{label('action')}</th>{columns.map(field => <th scope="col" className="p-2" key={field}>{importTargetFieldSchema.safeParse(field).success ? label('field.' + field) : field}</th>)}</tr></thead>
        <tbody>{preview.data.map((row) => <tr key={row.rowNumber} className="border-t border-border"><td className="p-2 tabular-nums">{row.rowNumber}</td><td className="p-2">{label(row.action)}</td>
          {columns.map(field => <td key={field} className="max-w-xs wrap-anywhere p-2">{row.values[field] ?? '—'}</td>)}</tr>)}</tbody></table></TableContainer>
      <Pager offset={offset} total={preview.pagination.total} limit={50} onChange={requestPreview} disabled={previewPending} previousLabel={label('previous')} nextLabel={label('next')}/>
    </div>}
    {progress.data && <div role="status" className="space-y-2 rounded-lg border border-border bg-muted p-3 text-sm">
      <p className="font-medium">{label(progress.data.dryRun ? 'dryRun' : 'import')}: {progress.data.status === 'failed' && progress.data.processedRows === progress.data.totalRows && progress.data.errorCount > 0
        ? t('imports/pipeline:status.' + (progress.data.errorCount === 1 ? 'rowError' : 'rowErrors'), { count: formatCount(progress.data.errorCount) }) : label('status.' + progress.data.status)}</p>
      <p>{label('processed')}: {formatCount(progress.data.processedRows)}/{formatCount(progress.data.totalRows)} · {label('committed')}: {formatCount(progress.data.committedRows)} · {label('errors')}: {formatCount(progress.data.errorCount)}</p>
      {progress.data.totalRows > 0 && <progress className="block h-2 w-full accent-primary" aria-label={label('processed')} max={progress.data.totalRows} value={progress.data.processedRows}/>}
    </div>}
    {errors.data && <div className="space-y-2"><h3 className="font-semibold">{label('errorReport')}</h3>
      <ul className="divide-y divide-border rounded-xl border border-border text-sm">{errors.data.data.map((issue, index) => <li key={index} className="wrap-anywhere p-3">
        <span className="font-medium">{label('row')} {issue.rowNumber}:</span> {t(issue.message)}</li>)}</ul>
      <Pager offset={errorOffset} total={errors.data.pagination.total} limit={50} onChange={setErrorOffset} previousLabel={label('previous')} nextLabel={label('next')}/>
    </div>}
  </div></PageSection>;
}
function ExportPanel({ gymId }: { gymId: string }) {
  const [id, setId] = useState<string>();
  const create = useMutation({ mutationFn: async () => parseResponse(exportJobSchema, (await request<{ data: unknown }>('/api/exports', { format: 'csv' })).data), onSuccess(job) { setId(job.id); } });
  const progress = useQuery({ queryKey: ['exports', gymId, id], enabled: !!id,
    queryFn: async () => parseResponse(exportJobSchema, (await request<{ data: unknown }>('/api/exports/' + id)).data),
    refetchInterval: (query) => query.state.data && ['succeeded', 'failed'].includes(query.state.data.status) ? false : 1500 });
  return <PageSection title={t('imports/export:title')} description={t('imports/export:description')}><div className={card}>
    <Button className="w-full sm:w-auto" disabled={create.isPending || progress.data?.status === 'pending' || progress.data?.status === 'running'} onClick={() => create.mutate()}>{t('imports/export:create')}</Button>
    {(create.isError || progress.isError) && <Alert variant="error" focusOnReveal>{label('requestFailed')}</Alert>}
    {progress.data && <p role="status" className="text-sm">{label('status.' + progress.data.status)}</p>}
    {progress.data?.downloadUrl && <a className="inline-flex min-h-11 items-center font-medium underline underline-offset-4" href={progress.data.downloadUrl} rel="noreferrer">{t('imports/export:download')}</a>}
  </div></PageSection>;
}
export function ImportsPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <Page><LoadingState label={label('loading')}/></Page>;
  if (bootstrap.isError) return <Page><ErrorState message={label('requestFailed')} onRetry={() => void bootstrap.refetch()}/></Page>;
  const roles = bootstrap.data.session?.roles ?? [], gymId = bootstrap.data.gym.id;
  if (!canStaff(roles, 'data.export') && !canStaff(roles, 'settings.manage')) return <Page><Alert variant="error">{label('noAccess')}</Alert></Page>;
  return <Page className="max-w-4xl"><PageHeader title={label('title')}/>
    {canStaff(roles, 'settings.manage') && <ImportPanel key={gymId} gymId={gymId}/>}
    {canStaff(roles, 'data.export') && <ExportPanel key={'export-' + gymId} gymId={gymId}/>}
  </Page>;
}
