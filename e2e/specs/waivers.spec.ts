// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, Client, demoClient, gymOrigin, localCa, loopback, type Person, type RecordId } from '../support.js';
import { claimPortal, signaturePng } from '../portal.js';
import { mailIds, mailLink, multiGyms } from '../multi/support.js';
import { accessibleLayout } from '../responsive.js';
import { waiverPdf } from '../../deploy/test/memory/waiver-pdf.mjs';

type Document = { key: string; hash: string; pages: number; bytes: number };
type Template = { id: string; name: string; version: number; document?: Document };
type Signature = { id: string; templateId: string; snapshot: string; snapshotHash: string };
type Image = { signatureImageKey: string; signatureImageHash: string };
type Admitted = Image & { templateId: string; templateVersion: number };
const source = waiverPdf({ pages: 2, bytes: 8192, imageSide: 32 });
const pngBase64 = signaturePng().toString('base64');
const signer = { kind: 'self', name: 'Waiver Signer' };
const docPath = (id: string) => `/api/waivers/templates/${id}/document`;
// Links are bearer credentials; assertions below never print their complete URLs.
test.use({ trace: 'off', screenshot: 'off' });

async function upload(owner: Client) {
  return (await owner.json<{ data: Document }>('/api/waivers/template-documents', 'POST', source, { 'content-type': 'application/pdf' })).data;
}
async function template(owner: Client, document: Document) {
  return (await owner.json<{ data: Template }>('/api/waivers/templates', 'POST', { name: 'PDF ' + randomUUID(), kind: 'waiver', document })).data;
}
/** Follow the capability through Caddy, preserving bytes, TLS SNI and response headers. */
function download(href: string) {
  const url = new URL(href);
  return new Promise<{ status: number; bytes: Buffer; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const request = httpsRequest({ hostname: loopback, port: 443, servername: url.hostname, ca: localCa(),
      path: url.pathname + url.search, headers: { host: url.host }, timeout: 30_000 }, response => {
      const chunks: Buffer[] = [];
      response.on('error', reject); response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, bytes: Buffer.concat(chunks), headers: response.headers }));
    });
    request.on('error', reject); request.on('timeout', () => request.destroy(new Error('Document download timed out'))); request.end();
  });
}
/** The fixture's S3 endpoint is internal; fetch its signed copies inside that stack.
 * Send the bearer URL on stdin, keeping it out of command arguments and failures. */
async function signedS3Copy(href: string) {
  expect(new URL(href).origin).toBe('http://multi-s3:7070');
  const code = "try { let href = ''; for await (const chunk of process.stdin) href += chunk; "
    + "const response = await fetch(href, { signal: AbortSignal.timeout(15000) }); const bytes = Buffer.from(await response.arrayBuffer()); "
    + "console.log(JSON.stringify({ status: response.status, pdf: bytes.subarray(0, 5).toString() === '%PDF-', bytes: bytes.length })); "
    + "} catch { process.exitCode = 1; }";
  return new Promise<{ status: number; pdf: boolean; bytes: number }>((resolve, reject) => {
    const child = execFile('docker', ['compose', '--project-name', process.env.E2E_COMPOSE_PROJECT!, '--file', 'compose.yaml',
      'exec', '-T', 'multi', 'node', '--input-type=module', '--eval', code],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), windowsHide: true, timeout: 30_000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) { reject(new Error('Internal S3 signed-copy download failed')); return; }
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('Invalid S3 download evidence')); }
    });
    child.stdin!.on('error', () => reject(new Error('Internal S3 download input failed')));
    child.stdin!.end(href);
  });
}
async function original(client: Client, path: string, checkBytes = true) {
  const issued = await client.json<{ data: { url: string; expiresAt: string } }>(path);
  const remaining = Date.parse(issued.data.expiresAt) - Date.now();
  // The server's clock (in Docker) can run a second or so ahead of the test host's, so
  // allow 5 s of skew above the 300 s lifetime.
  expect(remaining).toBeGreaterThan(240_000); expect(remaining).toBeLessThanOrEqual(305_000);
  // Several authorized surfaces can issue the same document. Download once here;
  // the browser previews below also consume the real per-client download budget.
  if (!checkBytes) return issued.data.url;
  const response = await download(issued.data.url);
  expect(response.status).toBe(200); expect(response.bytes.equals(source)).toBe(true);
  expect(response.headers['content-type']).toContain('application/pdf');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['content-security-policy']).toContain('sandbox');
  expect(response.headers['content-security-policy']).toContain("frame-ancestors 'self'");
  return issued.data.url;
}
async function sign(client: Client, memberId: string, document: Template, base = '/api/waivers') {
  const image = (await client.json<{ data: Image }>(base + '/signature-images', 'POST', { memberId, pngBase64 })).data;
  return (await client.json<{ data: Signature }>(base + (base === '/api/waivers' ? '/signatures' : ''), 'POST',
    { memberId, templateId: document.id, templateVersion: document.version, signer, consent: true, ...image })).data;
}
async function preview(page: Page, info: TestInfo, label: string) {
  await expect(page.getByRole('link', { name: 'Open the document', exact: true }).first()).toBeVisible();
  const frame = page.locator('iframe[title]').first();
  await expect(frame).toHaveAttribute('src', /(?:\/api\/waivers\/template-document\?token=|\/api\/public\/waivers\/[^/]+\/document\?view=1|\/l\/[^/]+\/documents\/)/);
  await expect(page.locator('input[type=checkbox][required]').first()).toHaveCount(1);
  await accessibleLayout(page, info, label);
}
function watchDocuments(page: Page) {
  const statuses: number[] = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname === '/api/waivers/template-document') statuses.push(response.status());
  });
  return () => { expect(statuses.length).toBeGreaterThan(0); expect(statuses).toEqual(statuses.map(() => 200)); };
}

test('staff upload, review and sign a PDF; later text versions preserve the original signed record', async ({ install, sandboxes, page, context }, info) => {
  test.setTimeout(180_000);
  const assertDocuments = watchDocuments(page);
  const owner = install.clients.owner, desk = install.clients.front_desk, demo = await demoClient(sandboxes[0]!, 'owner');
  expect((await desk.request('/api/waivers/template-documents', 'POST', source, { 'content-type': 'application/pdf' })).status).toBe(403);
  const refused = await demo.request('/api/waivers/template-documents', 'POST', source, { 'content-type': 'application/pdf' });
  expect(refused.status).toBe(403); expect(refused.text).toContain('Uploads are disabled in the demo');
  const document = await upload(owner), current = await template(owner, document);
  expect(document).toMatchObject({ hash: createHash('sha256').update(source).digest('hex'), pages: 2, bytes: source.length });
  let version = 1;
  try {
    const href = await original(desk, docPath(current.id));
    expect((await new Client(gymOrigin).request(docPath(current.id))).status).toBe(401);
    expect((await demo.request(docPath(current.id))).status).toBe(404);
    const copied = new URL(href); copied.hostname = new URL(demo.origin).hostname;
    expect((await download(copied.href)).status).toBe(404);
    const tampered = new URL(href); tampered.searchParams.set('token', 'invalid');
    expect((await download(tampered.href)).status).toBe(404);

    await owner.browser(context);
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(gymOrigin + '/admin/waivers');
      await page.locator('li').filter({ has: page.getByRole('heading', { name: current.name, exact: true }) }).getByRole('button', { name: 'Edit template', exact: true }).click();
      await expect(page.getByLabel('Document format', { exact: true })).toHaveValue('pdf');
      await accessibleLayout(page, info, 'pdf-editor-' + width);
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();
    }
    const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'PDF signer' })).data;
    const person = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Waiver', lastName: 'Signer', dateOfBirth: '1990-01-01' })).data;
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${gymOrigin}/admin/members/${person.id}#memberTabs.waivers`);
      await page.locator('li').filter({ hasText: current.name }).getByRole('button', { name: 'Review and sign', exact: true }).click();
      await preview(page, info, 'staff-pdf-' + width);
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();
    }
    assertDocuments();
    const signed = await sign(owner, person.id, current);
    expect(JSON.parse(signed.snapshot).template.document).toEqual(document);
    const before = (await owner.json<{ data: { url: string } }>(`/api/waivers/signatures/${signed.id}/pdf`)).data;
    expect((await download(before.url)).status).toBe(200);
    await owner.json(`/api/waivers/templates/${current.id}/versions`, 'POST', { name: current.name, kind: 'waiver', expectedVersion: 1, body: 'Replacement text terms.' });
    version = 2;
    expect((await new Client(gymOrigin).request(`/api/public/waivers/${current.id}/document`)).status).toBe(404);
    await original(owner, docPath(current.id));
    const records = (await owner.json<{ data: Signature[] }>(`/api/waivers/signatures?memberId=${person.id}`)).data;
    expect(records.find(row => row.id === signed.id)).toMatchObject({ snapshot: signed.snapshot, snapshotHash: signed.snapshotHash });
    const after = (await owner.json<{ data: { url: string } }>(`/api/waivers/signatures/${signed.id}/pdf`)).data;
    expect((await download(after.url)).status).toBe(200);
    const latest = (await owner.json<{ data: Template[] }>('/api/waivers/templates')).data.find(row => row.name === current.name)!;
    expect(JSON.parse((await sign(owner, person.id, latest)).snapshot).template.document).toBeUndefined();
  } finally { await owner.json(`/api/waivers/templates/${current.id}/retire`, 'POST', { expectedVersion: version }); }
});

async function portalMember(owner: Client) {
  const email = `pdf-${randomUUID()}@example.invalid`;
  const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'PDF household', email })).data;
  const member = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: home.id, firstName: 'Waiver', lastName: 'Signer', dateOfBirth: '1990-01-01', email })).data;
  const invitation = (await owner.json<{ data: { invitationUrl: string } }>(`/api/households/${home.id}/portal-invitations`, 'POST',
    { email, scope: 'payer', memberId: member.id, delivery: 'print' })).data;
  const before = await mailIds();
  await new Client(owner.origin).json('/api/portal/invitations/accept', 'POST', { token: new URL(invitation.invitationUrl).hash.slice(1) });
  const client = await claimPortal(owner.origin, await mailLink(email, /^\/api\/auth\//, before));
  client.headers['X-Portal-Household'] = home.id;
  return { home, member, client };
}

test('portal, signed-link, join and drop-in surfaces show and sign the PDF while signed copies stay household-private', async ({ page, context }, info) => {
  test.setTimeout(360_000);
  const assertDocuments = watchDocuments(page);
  const [gym, otherGym] = await multiGyms(), owner = gym.owner;
  const document = await upload(owner), current = await template(owner, document);
  try {
    const a = await portalMember(owner), b = await portalMember(owner);
    // Both households may read gym templates, on self and payer surfaces. Neither
    // may read the other's signed record or a template in a different gym.
    for (const household of [a, b]) for (const prefix of ['/api/portal', '/api/portal/household'])
      await original(household.client, `${prefix}/waiver-templates/${current.id}/document`, household === a && prefix === '/api/portal');
    expect((await otherGym.household.request(`/api/portal/household/waiver-templates/${current.id}/document`)).status).toBe(404);
    await a.client.browser(context);
    await context.setExtraHTTPHeaders({ 'x-forwarded-for': a.client.address });
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(gym.origin + '/portal/waivers');
      await page.locator('li').filter({ hasText: current.name }).getByRole('button', { name: 'Review and sign', exact: true }).click();
      await preview(page, info, 'portal-pdf-' + width);
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();
    }
    const signedA = await sign(a.client, a.member.id, current, '/api/portal/waivers');
    const signedB = await sign(b.client, b.member.id, current, '/api/portal/household/waivers');
    for (const [own, foreign] of [[a, signedB], [b, signedA]] as const) for (const prefix of ['/api/portal', '/api/portal/household'])
      expect((await own.client.request(`${prefix}/waivers/${foreign.id}/pdf`)).status).toBe(404);
    for (const [own, signed] of [[a, signedA], [b, signedB]] as const) {
      expect(JSON.parse(signed.snapshot).template.document).toEqual(document);
      const copy = (await own.client.json<{ data: { url: string } }>(`/api/portal/household/waivers/${signed.id}/pdf`)).data;
      const downloaded = await signedS3Copy(copy.url);
      expect(downloaded).toMatchObject({ status: 200, pdf: true });
      expect(downloaded.bytes).toBeGreaterThan(source.length);
    }
    const linkMember = (await owner.json<{ data: Person }>('/api/members', 'POST', { householdId: a.home.id,
      firstName: 'Link', lastName: 'Signer', dateOfBirth: '1990-01-01' })).data;
    const link = (await owner.json<{ data: { token: string } }>('/api/links', 'POST', { purpose: 'sign_waiver', householdId: a.home.id,
      memberId: linkMember.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).data;
    const linked = new Client(gym.origin, { authorization: 'Bearer ' + link.token });
    await original(linked, `/api/links/sign-waiver/templates/${current.id}/document`, false);
    await original(new Client(gym.origin), `/api/public/waivers/${current.id}/document`, false);
    // These are separate readers. Keep each reader's address across widths and signing,
    // rather than spending all four flows' download budgets from the runner's one address.
    const readers = { link: linked, join: new Client(gym.origin), 'drop-in': new Client(gym.origin) };
    const surfaces = [['link', '/l/' + link.token], ['join', '/join?plan=' + gym.planId], ['drop-in', '/drop-in']] as const;
    for (const width of [360, 1280]) for (const [label, path] of surfaces) {
      await context.setExtraHTTPHeaders({ 'x-forwarded-for': readers[label].address });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(gym.origin + path);
      await preview(page, info, label + '-pdf-' + width);
    }
    assertDocuments();
    const image = (await linked.json<{ data: Image }>('/api/links/sign-waiver/signature-images', 'POST', { pngBase64 })).data;
    await linked.json('/api/links/sign-waiver', 'POST', { templateId: current.id, templateVersion: current.version, signer, consent: true, ...image });
    const linkRecords = (await owner.json<{ data: Signature[] }>(`/api/waivers/signatures?memberId=${linkMember.id}`)).data;
    expect(JSON.parse(linkRecords.find(row => row.templateId === current.id)!.snapshot).template.document).toEqual(document);
    // Public intake must sign every current document, including existing text versions.
    for (const surface of ['join', 'drop-in'] as const) {
      const visitor = readers[surface], lastName = 'Pdf' + randomUUID().replaceAll('-', '');
      const member = { firstName: 'Visitor', lastName, dateOfBirth: '1990-01-01' }, contact = { name: 'Visitor ' + lastName, email: `${lastName.toLowerCase()}@example.invalid` };
      const templates = (await visitor.json<{ data: Template[] }>('/api/public/waivers')).data;
      const signer = { kind: 'self', name: contact.name };
      // Join's admission names each signer up front; drop-in's names them when it submits.
      const signatures = templates.map(row => ({ templateId: row.id, templateVersion: row.version, pngBase64, ...(surface === 'join' ? { signer } : {}) }));
      const common = { contact, honeypot: '' };
      const admission = await visitor.json<{ data: Admitted[] | Admitted[][] }>(`/${surface}/signatures`, 'POST', surface === 'join'
        ? { ...common, planId: gym.planId, members: [{ member, signatures }] } : { ...common, member, signatures });
      const images = (surface === 'join' ? admission.data[0] : admission.data) as Admitted[];
      const waivers = images.map(value => ({ ...value, signer, consent: true }));
      await visitor.json(`/api/public/${surface}`, 'POST', surface === 'join'
        ? { ...common, planId: gym.planId, members: [{ member, waivers }] } : { ...common, member, waivers });
      const people = (await owner.json<{ data: Person[] }>('/api/members?search=' + lastName)).data;
      expect(people).toHaveLength(1);
      const signed = (await owner.json<{ data: Signature[] }>(`/api/waivers/signatures?memberId=${people[0]!.id}`)).data;
      expect(JSON.parse(signed.find(row => row.templateId === current.id)!.snapshot).template.document).toEqual(document);
    }
  } finally { await owner.json(`/api/waivers/templates/${current.id}/retire`, 'POST', { expectedVersion: 1 }); }
});
