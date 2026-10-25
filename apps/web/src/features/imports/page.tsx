// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { canStaff } from '@plaingym/shared';
import { importTargetFieldSchema, importUploadSchema, importPreviewResponseSchema, importJobSchema, importIssueSchema,
  exportJobSchema, listResponseSchema, type ImportUpload, type ImportColumnMapping, type ImportMapper,
  type ImportPlanRequest, type ImportPreviewResponse } from '@plaingym/shared/contracts';
import { useBootstrap } from '../../app/context.js';
import { createJsonTransport } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert } from '../../components/ui/alert.js';
import { Page, PageHeader, PageSection } from '../../components/ui/page.js';
import { Select } from '../../components/ui/select.js';
import { ErrorState, LoadingState } from '../../components/ui/states.js';
import { Badge, TableContainer } from '../../components/ui/table.js';
const request = createJsonTransport();
const label = (key: string) => t('imports/pipeline:' + key);
const card = 'min-w-0 space-y-5 rounded-xl border border-border bg-card p-4 sm:p-6';
const summaryTone = { create: 'success', update: 'default', skip: 'muted' } as const;
function ImportPanel({ gymId }: { gymId: string }) {
  const [upload, setUpload] = useState<ImportUpload>(), [mapping, setMapping] = useState<ImportColumnMapping[]>([]);
  const [mapper, setMapper] = useState<ImportMapper>('people'), [duplicatePolicy, setPolicy] = useState<ImportPlanRequest['duplicatePolicy']>('error');
  const [preview, setPreview] = useState<ImportPreviewResponse>(), [offset, setOffset] = useState(0);
  const [runId, setRunId] = useState<string>(), [runPlan, setRunPlan] = useState(''), [errorOffset, setErrorOffset] = useState(0);
  const plan = upload ? { uploadId: upload.id, mapper, mapping, duplicatePolicy } : undefined;
  const fingerprint = JSON.stringify(plan);
  const progress = useQuery({ queryKey: ['imports', gymId, runId], enabled: !!runId,
    queryFn: async () => importJobSchema.parse((await request<{ data: unknown }>('/api/imports/' + runId)).data),
    refetchInterval: (query) => query.state.data && ['succeeded', 'failed'].includes(query.state.data.status) ? false : 1500 });
  const errors = useQuery({ queryKey: ['imports', gymId, runId, 'errors', errorOffset], enabled: !!runId && !!progress.data?.errorCount,
    queryFn: async () => {
      const response = await fetch(`/api/imports/${runId}/errors?offset=${errorOffset}&limit=50`, { credentials: 'same-origin', redirect: 'error' });
      if (!response.ok) throw new Error('Import report unavailable');
      return listResponseSchema(importIssueSchema).parse(await response.json());
    }, refetchInterval: progress.data?.status === 'running' ? 1500 : false });
  const uploadFile = useMutation({ mutationFn: async (file: File) => {
    const form = new FormData(); form.set('file', file);
    const response = await fetch('/api/imports/uploads', { method: 'POST', body: form, credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error('Upload failed');
    return importUploadSchema.parse((await response.json() as { data: unknown }).data);
  }, onSuccess(data) { setUpload(data); setMapping(data.suggestedMapping ?? []); setPreview(undefined); setRunId(undefined); setOffset(0); } });
  const previewRows = useMutation({ mutationFn: async (page: number) => {
    const response = await fetch(`/api/imports/preview?offset=${page}&limit=50`, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(plan) });
    if (!response.ok) throw new Error('Preview failed');
    return importPreviewResponseSchema.parse(await response.json());
  }, onSuccess(data) { setPreview(data); setOffset(data.pagination.offset); } });
  const start = useMutation({ mutationFn: async (dryRun: boolean) => importJobSchema.parse((await request<{ data: unknown }>('/api/imports', { ...plan, dryRun })).data),
    onSuccess(data) { setRunId(data.id); setRunPlan(fingerprint); setErrorOffset(0); } });
  const busy = uploadFile.isPending || start.isPending || progress.data?.status === 'pending' || progress.data?.status === 'running';
  const dryRunPassed = progress.data?.dryRun && progress.data.status === 'succeeded' && progress.data.errorCount === 0 && runPlan === fingerprint;
  // Exactly one status region: the run's progress.
  return <PageSection title={label('import')} description={label('mapperNotice')}><div className={card}>
    <ol className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-4" aria-label={label('steps')}>
      {(['stepUpload', 'stepMatch', 'stepCheck', 'stepCommit'] as const).map((step, index) => <li key={step}>{index + 1}. {label(step)}</li>)}</ol>
    <div className="grid gap-2"><Label htmlFor="csv-file">{label('file')}</Label>
      <Input id="csv-file" type="file" accept=".csv,text/csv" className="py-2" disabled={!!busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadFile.mutate(file); }}/></div>
    {(uploadFile.isError || previewRows.isError || start.isError || progress.isError || errors.isError) && <Alert>{label('requestFailed')}</Alert>}
    {upload && <>
      <p className="break-all text-sm"><span className="font-medium">{upload.filename}</span> · {label('rows')}: {upload.rowCount}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Label className="grid gap-2">{label('mapper')}<Select value={mapper} disabled={!!busy} onChange={(event) => { setMapper(event.target.value as ImportMapper); setPreview(undefined); }}>
          {(['people', 'mat', 'memberships'] as const).map((id) => <option key={id} value={id}>{label('mapper.' + id)}</option>)}
        </Select></Label>
        <Label className="grid gap-2">{label('duplicates')}<Select value={duplicatePolicy} disabled={!!busy} onChange={(event) => { setPolicy(event.target.value as ImportPlanRequest['duplicatePolicy']); setPreview(undefined); }}>
          {(['error', 'skip', 'update'] as const).map((policy) => <option key={policy} value={policy}>{label('policy.' + policy)}</option>)}
        </Select></Label>
      </div>
      <fieldset disabled={!!busy} className="min-w-0 space-y-3"><legend className="font-medium">{label('mapping')}</legend>
        <div className="divide-y divide-border rounded-xl border border-border">{upload.columns.map((column) =>
          <Label key={column} className="grid gap-2 p-3 sm:grid-cols-2 sm:items-center"><span className="break-all font-mono text-sm">{column}</span><Select
            value={mapping.find((item) => item.sourceColumn === column)?.targetField ?? ''} onChange={(event) => {
              const target = importTargetFieldSchema.safeParse(event.target.value);
              setMapping((previous) => [...previous.filter((item) => item.sourceColumn !== column && item.targetField !== event.target.value),
                ...(target.success ? [{ sourceColumn: column, targetField: target.data }] : [])]); setPreview(undefined);
            }}><option value="">{label('ignore')}</option>{importTargetFieldSchema.options.map((field) => <option key={field} value={field}>{label('field.' + field)}</option>)}</Select></Label>)}</div>
      </fieldset>
      <div className="grid gap-2 sm:flex">
        <Button variant="outline" disabled={!mapping.length || !!busy || previewRows.isPending} onClick={() => previewRows.mutate(0)}>{label('preview')}</Button>
        <Button variant="outline" disabled={!mapping.length || !!busy} onClick={() => start.mutate(true)}>{label('dryRun')}</Button>
        <Button disabled={!dryRunPassed || !!busy} onClick={() => start.mutate(false)}>{label('commit')}</Button>
      </div>
      {!dryRunPassed && <p className="text-sm text-muted-foreground">{label('commitHelp')}</p>}
    </>}
    {preview && <div className="space-y-3">
      <ul className="flex flex-wrap gap-2" aria-label={label('summary')}>
        {(['create', 'update', 'skip'] as const).map((key) => <li key={key}><Badge tone={summaryTone[key]}>{label(key)}: {preview.summary[key]}</Badge></li>)}
        <li><Badge tone={preview.summary.errors ? 'destructive' : 'muted'}>{label('errors')}: {preview.summary.errors}</Badge></li>
      </ul>
      <TableContainer label={label('previewTable')}><table className="w-full min-w-[32rem] text-left text-sm">
        <thead className="bg-muted"><tr><th scope="col" className="p-2">{label('row')}</th><th scope="col" className="p-2">{label('action')}</th><th scope="col" className="p-2">{label('values')}</th></tr></thead>
        <tbody>{preview.data.map((row) => <tr key={row.rowNumber} className="border-t border-border"><td className="p-2 tabular-nums">{row.rowNumber}</td><td className="p-2">{label(row.action)}</td>
          <td className="max-w-xl break-all p-2 font-mono text-xs">{JSON.stringify(row.values)}</td></tr>)}</tbody></table></TableContainer>
      {preview.pagination.total > 50 && <div className="flex justify-between gap-2">
        <Button variant="outline" disabled={offset === 0 || previewRows.isPending} onClick={() => previewRows.mutate(Math.max(0, offset - 50))}>{label('previous')}</Button>
        <Button variant="outline" disabled={offset + 50 >= preview.pagination.total || previewRows.isPending} onClick={() => previewRows.mutate(offset + 50)}>{label('next')}</Button>
      </div>}
    </div>}
    {progress.data && <div role="status" className="space-y-2 rounded-lg border border-border bg-muted p-3 text-sm">
      <p className="font-medium">{label(progress.data.dryRun ? 'dryRun' : 'import')}: {label('status.' + progress.data.status)}</p>
      <p>{label('processed')}: {progress.data.processedRows}/{progress.data.totalRows} · {label('committed')}: {progress.data.committedRows} · {label('errors')}: {progress.data.errorCount}</p>
      {progress.data.totalRows > 0 && <progress className="block h-2 w-full accent-primary" aria-label={label('processed')} max={progress.data.totalRows} value={progress.data.processedRows}/>}
    </div>}
    {errors.data && <div className="space-y-2"><h3 className="font-semibold">{label('errorReport')}</h3>
      <ul className="divide-y divide-border rounded-xl border border-border text-sm">{errors.data.data.map((issue, index) => <li key={index} className="break-words p-3">
        <span className="font-medium">{label('row')} {issue.rowNumber}:</span> {t(issue.message)}</li>)}</ul>
      {errors.data.pagination.total > 50 && <div className="flex justify-between gap-2">
        <Button variant="outline" disabled={!errorOffset} onClick={() => setErrorOffset(Math.max(0, errorOffset - 50))}>{label('previous')}</Button>
        <Button variant="outline" disabled={errorOffset + 50 >= errors.data.pagination.total} onClick={() => setErrorOffset(errorOffset + 50)}>{label('next')}</Button>
      </div>}
    </div>}
  </div></PageSection>;
}
function ExportPanel({ gymId }: { gymId: string }) {
  const [id, setId] = useState<string>();
  const create = useMutation({ mutationFn: async () => exportJobSchema.parse((await request<{ data: unknown }>('/api/exports', { format: 'csv' })).data), onSuccess(job) { setId(job.id); } });
  const progress = useQuery({ queryKey: ['exports', gymId, id], enabled: !!id,
    queryFn: async () => exportJobSchema.parse((await request<{ data: unknown }>('/api/exports/' + id)).data),
    refetchInterval: (query) => query.state.data && ['succeeded', 'failed'].includes(query.state.data.status) ? false : 1500 });
  return <PageSection title={t('imports/export:title')} description={t('imports/export:description')}><div className={card}>
    <Button className="w-full sm:w-auto" disabled={create.isPending || progress.data?.status === 'pending' || progress.data?.status === 'running'} onClick={() => create.mutate()}>{t('imports/export:create')}</Button>
    {(create.isError || progress.isError) && <Alert>{label('requestFailed')}</Alert>}
    {progress.data && <p role="status" className="text-sm">{label('status.' + progress.data.status)}</p>}
    {progress.data?.downloadUrl && <a className="inline-flex min-h-11 items-center font-medium underline underline-offset-4" href={progress.data.downloadUrl} rel="noreferrer">{t('imports/export:download')}</a>}
  </div></PageSection>;
}
export function ImportsPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <Page><LoadingState label={label('loading')}/></Page>;
  if (bootstrap.isError) return <Page><ErrorState message={label('requestFailed')} onRetry={() => void bootstrap.refetch()}/></Page>;
  const roles = bootstrap.data.session?.roles ?? [], gymId = bootstrap.data.gym.id;
  if (!canStaff(roles, 'data.export') && !canStaff(roles, 'settings.manage')) return <Page><Alert>{label('noAccess')}</Alert></Page>;
  return <Page className="max-w-4xl"><PageHeader title={label('title')}/>
    {canStaff(roles, 'settings.manage') && <ImportPanel key={gymId} gymId={gymId}/>}
    {canStaff(roles, 'data.export') && <ExportPanel key={'export-' + gymId} gymId={gymId}/>}
  </Page>;
}
