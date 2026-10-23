// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { importsContracts, importJobSchema, importTargetFieldSchema, importUploadSchema, type ImportColumnMapping, type ImportJob,
  type ImportMapper, type ImportUpload, type ImportPlanRequest } from '@plaingym/shared/contracts';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Alert } from '../../components/ui/alert.js';
import { t } from '../../lib/i18n.js';
import { ApiError, createJsonTransport } from '../../lib/api.js';
import { createSetupClient } from './api.js';

const label = (key: string, values?: Record<string, string | number>) => t('setup/import-step:' + key, values);
const pipeline = (key: string) => t('imports/pipeline:' + key);
const selectStyle = 'min-h-11 rounded-md border border-input bg-background px-3';
type Failure = 'error' | 'changed' | 'invalidImport' | 'running';

/**
 * Setup step 8, "Import or start fresh". The import path uploads a CSV, checks it with a dry run,
 * commits it through the import pipeline, and finishes setup with that run's ID. Either way,
 * billing and member emails stay off until the owner turns them on from go-live settings.
 */
export function ImportStep({ fetcher = fetch, pollMs = 1500 }: { fetcher?: typeof fetch; pollMs?: number }) {
  const [client] = useState(() => createSetupClient(fetcher)), [request] = useState(() => createJsonTransport(fetcher));
  const [importing, setImporting] = useState(false), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pollFailed, setPollFailed] = useState(false), [pollRetry, setPollRetry] = useState(0);
  const [upload, setUpload] = useState<ImportUpload>(), [mapping, setMapping] = useState<ImportColumnMapping[]>([]);
  const [mapper, setMapper] = useState<ImportMapper>('people'), [job, setJob] = useState<ImportJob>();
  const [duplicatePolicy, setDuplicatePolicy] = useState<ImportPlanRequest['duplicatePolicy']>('error');
  const finished = job && ['succeeded', 'failed'].includes(job.status);
  useEffect(() => {
    if (!job || finished) return;
    let alive = true;
    const timer = setTimeout(() => {
      void request<{ data: unknown }>('/api/imports/' + job.id).then((result) => {
        if (alive) { setJob(importJobSchema.parse(result.data)); setPollFailed(false); }
      }).catch(() => { if (alive) { setFailure('error'); setPollFailed(true); } });
    }, pollMs);
    return () => { alive = false; clearTimeout(timer); };
  }, [job, finished, pollMs, pollRetry, request]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setFailure(null);
    try { await action(); }
    catch (error) {
      setFailure(error instanceof ApiError && error.status === 409 ? 'changed'
        : error instanceof ApiError && error.status === 400 ? 'invalidImport' : 'error');
    } finally { setBusy(false); }
  }
  const finish = (importId?: string) => run(async () => {
    const { revision, completedSteps } = await client.call('status');
    // Reaching this step without a confirmed backup step means the owner chose to set backups up later.
    const deferred = completedSteps.includes(7) ? {} : { skipBackups: true as const };
    await client.call('finish', importId ? { choice: 'import', revision, importId, ...deferred } : { choice: 'fresh', revision, ...deferred });
    setDone(true);
  });
  const uploadFile = (file: File) => run(async () => {
    const form = new FormData(); form.set('file', file);
    const response = await fetcher('/api/imports/uploads', { method: 'POST', body: form, credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new ApiError(response.status, 'request_failed');
    const data = importUploadSchema.parse((await response.json() as { data: unknown }).data);
    setUpload(data); setMapping(data.suggestedMapping ?? []); setJob(undefined);
  });
  const start = (dryRun: boolean) => run(async () => {
    if (!upload) return;
    setJob(importJobSchema.parse((await request<{ data: unknown }>('/api/imports',
      { uploadId: upload.id, mapper, mapping, duplicatePolicy, dryRun })).data));
  });
  if (done) return <div className="space-y-3"><p role="status">{label('finished')}</p><a href="/login" className="underline">{t('setup/setup:signIn')}</a></div>;
  const checked = job?.dryRun && job.status === 'succeeded' && job.errorCount === 0;
  const committed = job && !job.dryRun && job.status === 'succeeded';
  const active = busy || (!!job && !finished) || !!committed;
  return <div className="space-y-4">
    <p>{label('help')}</p>
    <Alert>{label('offNotice')}</Alert>
    {failure && <Alert>{label(failure)}</Alert>}
    {pollFailed && <Button variant="outline" onClick={() => {
      setFailure(null); setPollFailed(false); setPollRetry((value) => value + 1);
    }}>{label('retryProgress')}</Button>}
    {!importing ? <div className="flex flex-wrap gap-3">
      <Button disabled={busy} onClick={() => void finish()}>{label('fresh')}</Button>
      <Button variant="outline" disabled={busy} onClick={() => setImporting(true)}>{label('import')}</Button>
    </div> : <div className="space-y-4">
      <p>{label('importHelp')}</p>
      <div className="space-y-2"><Label htmlFor="setup-import-file">{pipeline('file')}</Label>
        <Input id="setup-import-file" type="file" accept=".csv,text/csv" disabled={active}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadFile(file); }}/></div>
      {upload && <fieldset disabled={active} className="space-y-3">
        <legend className="font-medium">{pipeline('mapping')}</legend>
        <p>{upload.filename} · {pipeline('rows')}: {upload.rowCount}</p>
        <Label className="flex flex-wrap items-center gap-3">{pipeline('mapper')}<select className={selectStyle} value={mapper}
          onChange={(event) => { setMapper(event.target.value as ImportMapper); setJob(undefined); }}>
          {(['people', 'mat', 'memberships'] as const).map((id) => <option key={id} value={id}>{pipeline('mapper.' + id)}</option>)}</select></Label>
        <Label className="flex flex-wrap items-center gap-3">{pipeline('duplicates')}<select className={selectStyle} value={duplicatePolicy}
          onChange={(event) => { setDuplicatePolicy(event.target.value as ImportPlanRequest['duplicatePolicy']); setJob(undefined); }}>
          {(['error', 'skip', 'update'] as const).map((policy) => <option key={policy} value={policy}>{pipeline('policy.' + policy)}</option>)}</select></Label>
        {upload.columns.map((column) => <Label key={column} className="flex flex-wrap items-center justify-between gap-3">{column}
          <select className={selectStyle} value={mapping.find((item) => item.sourceColumn === column)?.targetField ?? ''} onChange={(event) => {
            const target = importTargetFieldSchema.safeParse(event.target.value);
            setMapping((previous) => [...previous.filter((item) => item.sourceColumn !== column && item.targetField !== event.target.value),
              ...(target.success ? [{ sourceColumn: column, targetField: target.data }] : [])]); setJob(undefined);
          }}><option value="">{pipeline('ignore')}</option>
            {importTargetFieldSchema.options.map((field) => <option key={field} value={field}>{pipeline('field.' + field)}</option>)}</select></Label>)}
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" disabled={!mapping.length || !!committed} onClick={() => void start(true)}>{pipeline('dryRun')}</Button>
          <Button disabled={!checked} onClick={() => void start(false)}>{pipeline('commit')}</Button>
        </div>
      </fieldset>}
      {job && <div role="status"><p>{label('status', { status: label('status.' + job.status) })}</p>
        <p>{pipeline('processed')}: {job.processedRows}/{job.totalRows} · {label('committed', { count: job.committedRows })} · {pipeline('errors')}: {job.errorCount}</p>
        {job.dryRun && job.status === 'succeeded' && <p>{label('dryRunOnly')}</p>}</div>}
      {job?.status === 'failed' && job.committedRows > 0 && <Alert>{label('partialImport')}</Alert>}
      {job && finished && job.errorCount > 0 && <ImportIssues key={job.id} id={job.id} fetcher={fetcher}/>}
      <div className="flex flex-wrap gap-3">
        {committed && <Button disabled={busy} onClick={() => void finish(job.id)}>{label('finishWithImport')}</Button>}
        <Button variant="outline" disabled={active || !!committed} onClick={() => { setImporting(false); setUpload(undefined); setJob(undefined); setFailure(null); }}>{label('back')}</Button>
      </div>
    </div>}
  </div>;
}

function ImportIssues({ id, fetcher }: { id: string; fetcher: typeof fetch }) {
  const [offset, setOffset] = useState(0), [retry, setRetry] = useState(0);
  const [data, setData] = useState<ReturnType<typeof importsContracts.errors.response.parse>>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true; setData(undefined); setFailed(false);
    void fetcher(`/api/imports/${encodeURIComponent(id)}/errors?limit=50&offset=${offset}`, {
      credentials: 'same-origin', redirect: 'error', headers: { Accept: 'application/json' },
    }).then(async (response) => {
      if (!response.ok) throw new ApiError(response.status, 'request_failed');
      const parsed = importsContracts.errors.response.parse(await response.json());
      if (active) setData(parsed);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [id, fetcher, offset, retry]);
  return <section aria-label={pipeline('errors')} className="space-y-2">
    {failed ? <Alert>{pipeline('requestFailed')} <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>{label('retryErrors')}</Button></Alert>
      : !data ? <p>{pipeline('loading')}</p> : <>
        <ul>{data.data.map((issue, index) => <li key={index}>{pipeline('row')} {issue.rowNumber}: {issue.message}</li>)}</ul>
        <div className="flex gap-3"><Button variant="outline" disabled={offset === 0} onClick={() => setOffset(offset - 50)}>{pipeline('previous')}</Button>
          <Button variant="outline" disabled={offset + 50 >= data.pagination.total} onClick={() => setOffset(offset + 50)}>{pipeline('next')}</Button></div>
      </>}
  </section>;
}
