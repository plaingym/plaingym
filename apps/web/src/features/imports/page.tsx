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
import { Card } from '../../components/ui/card.js';
import { Alert } from '../../components/ui/alert.js';
const request = createJsonTransport();
const label = (key: string) => t('imports/pipeline:' + key);
const selectStyle = 'min-h-11 rounded-md border border-input bg-background px-3';
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
  return <Card className="space-y-5">
    <h2 className="text-xl font-semibold">{label('import')}</h2>
    <p>{label('mapperNotice')}</p>
    <Label htmlFor="csv-file">{label('file')}</Label>
    <Input id="csv-file" type="file" accept=".csv,text/csv" disabled={!!busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadFile.mutate(file); }}/>
    {(uploadFile.isError || previewRows.isError || start.isError || progress.isError || errors.isError) && <Alert>{label('requestFailed')}</Alert>}
    {upload && <>
      <p>{upload.filename} · {label('rows')}: {upload.rowCount}</p>
      <div className="flex flex-wrap gap-4"><Label>{label('mapper')} <select className={selectStyle} value={mapper} disabled={!!busy} onChange={(event) => { setMapper(event.target.value as ImportMapper); setPreview(undefined); }}>
        {(['people', 'mat', 'memberships'] as const).map((id) => <option key={id} value={id}>{label('mapper.' + id)}</option>)}
      </select></Label>
      <Label>{label('duplicates')} <select className={selectStyle} value={duplicatePolicy} disabled={!!busy} onChange={(event) => { setPolicy(event.target.value as ImportPlanRequest['duplicatePolicy']); setPreview(undefined); }}>
        {(['error', 'skip', 'update'] as const).map((policy) => <option key={policy} value={policy}>{label('policy.' + policy)}</option>)}
      </select></Label></div>
      <fieldset disabled={!!busy} className="space-y-2"><legend className="font-medium">{label('mapping')}</legend>{upload.columns.map((column) =>
        <Label key={column} className="flex flex-wrap items-center justify-between gap-3">{column}<select className={selectStyle}
          value={mapping.find((item) => item.sourceColumn === column)?.targetField ?? ''} onChange={(event) => {
            const target = importTargetFieldSchema.safeParse(event.target.value);
            setMapping((previous) => [...previous.filter((item) => item.sourceColumn !== column && item.targetField !== event.target.value),
              ...(target.success ? [{ sourceColumn: column, targetField: target.data }] : [])]); setPreview(undefined);
          }}><option value="">{label('ignore')}</option>{importTargetFieldSchema.options.map((field) => <option key={field} value={field}>{label('field.' + field)}</option>)}</select></Label>)}</fieldset>
      <div className="flex flex-wrap gap-3">
        <Button disabled={!mapping.length || !!busy || previewRows.isPending} onClick={() => previewRows.mutate(0)}>{label('preview')}</Button>
        <Button variant="outline" disabled={!mapping.length || !!busy} onClick={() => start.mutate(true)}>{label('dryRun')}</Button>
        <Button disabled={!dryRunPassed || !!busy} onClick={() => start.mutate(false)}>{label('commit')}</Button>
      </div>
    </>}
    {preview && <div className="overflow-x-auto"><p>{label('summary')}: {label('create')} {preview.summary.create}, {label('update')} {preview.summary.update}, {label('skip')} {preview.summary.skip}, {label('errors')} {preview.summary.errors}</p>
      <table className="w-full text-left text-sm"><thead><tr><th>{label('row')}</th><th>{label('action')}</th><th>{label('values')}</th></tr></thead><tbody>{preview.data.map((row) =>
        <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{label(row.action)}</td><td className="max-w-xl break-all">{JSON.stringify(row.values)}</td></tr>)}</tbody></table>
      <Button variant="outline" disabled={offset === 0 || previewRows.isPending} onClick={() => previewRows.mutate(Math.max(0, offset - 50))}>{label('previous')}</Button>
      <Button variant="outline" disabled={offset + 50 >= preview.pagination.total || previewRows.isPending} onClick={() => previewRows.mutate(offset + 50)}>{label('next')}</Button>
    </div>}
    {progress.data && <div role="status"><p>{label(progress.data.dryRun ? 'dryRun' : 'import')}: {label('status.' + progress.data.status)}</p>
      <p>{label('processed')}: {progress.data.processedRows}/{progress.data.totalRows} · {label('committed')}: {progress.data.committedRows} · {label('errors')}: {progress.data.errorCount}</p></div>}
    {errors.data && <div><ul>{errors.data.data.map((issue, index) => <li key={index}>{label('row')} {issue.rowNumber}: {t(issue.message)}</li>)}</ul>
      <Button variant="outline" disabled={!errorOffset} onClick={() => setErrorOffset(Math.max(0, errorOffset - 50))}>{label('previous')}</Button>
      <Button variant="outline" disabled={errorOffset + 50 >= errors.data.pagination.total} onClick={() => setErrorOffset(errorOffset + 50)}>{label('next')}</Button></div>}
  </Card>;
}
function ExportPanel({ gymId }: { gymId: string }) {
  const [id, setId] = useState<string>();
  const create = useMutation({ mutationFn: async () => exportJobSchema.parse((await request<{ data: unknown }>('/api/exports', { format: 'csv' })).data), onSuccess(job) { setId(job.id); } });
  const progress = useQuery({ queryKey: ['exports', gymId, id], enabled: !!id,
    queryFn: async () => exportJobSchema.parse((await request<{ data: unknown }>('/api/exports/' + id)).data),
    refetchInterval: (query) => query.state.data && ['succeeded', 'failed'].includes(query.state.data.status) ? false : 1500 });
  return <Card className="space-y-3"><h2 className="text-xl font-semibold">{t('imports/export:title')}</h2><p>{t('imports/export:description')}</p>
    <Button disabled={create.isPending || progress.data?.status === 'pending' || progress.data?.status === 'running'} onClick={() => create.mutate()}>{t('imports/export:create')}</Button>
    {(create.isError || progress.isError) && <Alert>{label('requestFailed')}</Alert>}
    {progress.data && <p role="status">{label('status.' + progress.data.status)}</p>}
    {progress.data?.downloadUrl && <a className="underline" href={progress.data.downloadUrl} rel="noreferrer">{t('imports/export:download')}</a>}
  </Card>;
}
export function ImportsPage() {
  const bootstrap = useBootstrap();
  if (bootstrap.isPending) return <p role="status">{label('loading')}</p>;
  if (bootstrap.isError) return <Alert>{label('requestFailed')}</Alert>;
  const roles = bootstrap.data.session?.roles ?? [], gymId = bootstrap.data.gym.id;
  if (!canStaff(roles, 'data.export') && !canStaff(roles, 'settings.manage')) return <Alert>{label('noAccess')}</Alert>;
  return <main className="mx-auto max-w-5xl space-y-6 p-6"><h1 className="text-2xl font-semibold">{label('title')}</h1>
    {canStaff(roles, 'settings.manage') && <ImportPanel key={gymId} gymId={gymId}/>}
    {canStaff(roles, 'data.export') && <ExportPanel key={'export-' + gymId} gymId={gymId}/>}
  </main>;
}
