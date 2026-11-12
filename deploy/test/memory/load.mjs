// SPDX-License-Identifier: AGPL-3.0-only
// The workload of the memory check, run in a short-lived container on the stack's network (run.mjs starts it, with a CPU
// cap and a time limit): `setup` completes the setup wizard through the API (including encrypted backups to the
// stand-in bucket), `seed` adds members and a 20-page waiver, `load` drives concurrent API traffic and waiver PDFs.
//
// Environment: GYM_HOST (the gym's hostname, which Caddy serves), PROXY_HOST (where to connect), SETUP_TOKEN, S3_ENDPOINT,
// S3_ACCESS_KEY, S3_SECRET_KEY, STATE_FILE, LOAD_SECONDS, LOAD_WORKERS.
import { Agent, request as httpsRequest } from 'node:https';
import { readFileSync, writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { waiverPdf } from './waiver-pdf.mjs';

const env = (name, fallback) => process.env[name] ?? fallback ?? (() => { throw new Error('Missing ' + name); })();
const gymHost = env('GYM_HOST', 'gym.localhost'), proxyHost = env('PROXY_HOST', 'caddy');
const stateFile = env('STATE_FILE', '/out/state.json');
const password = 'memory-check-password-' + createHash('sha256').update(env('SETUP_TOKEN', 'x')).digest('hex').slice(0, 12);
const email = 'owner@example.invalid';
const agent = new Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false });

class Client {
  cookie = '';
  constructor(headers = {}) { this.headers = headers; }
  request(path, method = 'GET', body) {
    const binary = Buffer.isBuffer(body);
    const payload = binary ? body : body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = httpsRequest({ agent, hostname: proxyHost, port: 443, servername: gymHost, path, method, timeout: 60_000,
        headers: { host: gymHost, origin: 'https://' + gymHost, ...(path.startsWith('/api') ? {} : { accept: 'text/html' }), ...(this.cookie ? { cookie: this.cookie } : {}),
          ...(payload === undefined ? {} : { 'content-type': binary ? 'application/pdf' : 'application/json', 'content-length': Buffer.byteLength(payload) }), ...this.headers },
      }, (res) => {
        const chunks = [];
        res.on('error', reject);
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const bytes = Buffer.concat(chunks), text = bytes.toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* not JSON */ }
          resolve({ status: res.statusCode, json, text, bytes, headers: res.headers, cookies: res.headers['set-cookie'] ?? [] });
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error(`Timed out: ${method} ${path}`)));
      req.end(payload);
    });
  }
  async ok(path, method = 'GET', body) {
    const response = await this.request(path, method, body);
    if (response.status < 200 || response.status >= 300) throw new Error(`${method} ${path} answered ${response.status}: ${response.text.slice(0, 300)}`);
    return response.json;
  }
  async login() {
    const response = await this.request('/api/auth/sign-in/email', 'POST', { email, password });
    if (response.status !== 200) throw new Error('Sign-in answered ' + response.status);
    this.cookie = response.cookies.map((value) => value.split(';')[0]).join('; ');
  }
}

/** A small valid PNG scribble for the signature. */
function signaturePng() {
  const width = 240, height = 80;
  const chunk = (name, data) => {
    const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 15; x < width - 15; x++) if (Math.abs(y - (40 + 20 * Math.sin(x / 12))) < 2) raw.fill(20, y * (width * 3 + 1) + 1 + x * 3, y * (width * 3 + 1) + 4 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const readState = () => { try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; } };
const writeState = (state) => writeFileSync(stateFile, JSON.stringify(state));
/** Run `task` over `items`, at most `width` at a time. */
async function pool(items, width, task) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => { while (next < items.length) await task(items[next++]); }));
}

async function setup() {
  const guest = new Client(), setupClient = new Client({ 'x-setup-token': env('SETUP_TOKEN') }), owner = new Client();
  for (let attempt = 0; ; attempt++) {
    const status = await guest.request('/api/setup');
    if (status.status === 200) break;
    if (attempt > 30) throw new Error('Setup is not available: ' + status.status);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await setupClient.ok('/api/setup/start', 'POST', { choice: 'fresh' });
  await setupClient.ok('/api/setup/owner', 'POST', { name: 'Memory Owner', email, password });
  await owner.login();
  const revision = async () => (await owner.ok('/api/setup')).data.revision;
  await owner.ok('/api/setup/gym', 'PUT', { name: 'Memory academy', timezone: 'UTC', currency: 'USD', address: {}, branding: { logoKey: null, primaryColor: null }, revision: await revision() });
  await owner.ok('/api/setup/packs', 'POST', { packs: [{ packId: 'bjj', version: 1 }], revision: await revision() });
  await owner.ok('/api/setup/website', 'PUT', { websiteEnabled: false, existingSiteUrl: null, revision: await revision() });
  await owner.ok('/api/setup/smtp', 'PUT', { choice: 'skip', revision: await revision() });
  await owner.ok('/api/setup/stripe', 'PUT', { choice: 'skip', revision: await revision() });
  const key = (await owner.ok('/api/setup/backups', 'POST', { revision: await revision(), destination: {
    endpoint: env('S3_ENDPOINT'), region: 'auto', bucket: 'plaingym', accessKeyId: env('S3_ACCESS_KEY'), secretAccessKey: env('S3_SECRET_KEY') } })).data;
  await owner.ok('/api/setup/backups/confirm', 'POST', { revision: await revision(), privateKey: key.privateKey });
  await owner.ok('/api/setup/finish', 'POST', { choice: 'fresh', revision: await revision() });
  console.log(JSON.stringify({ step: 'setup', done: true }));
}

async function seed() {
  const owner = new Client();
  await owner.login();
  const households = Array.from({ length: 100 }, (_, index) => index);
  const members = [];
  await pool(households, 8, async (index) => {
    const home = (await owner.ok('/api/households', 'POST', { name: `Household ${index + 1}` })).data;
    for (let child = 0; child < 3; child++) {
      members.push((await owner.ok('/api/members', 'POST', { householdId: home.id, firstName: `Member${index + 1}x${child + 1}`, lastName: `Surname${index + 1}`, dateOfBirth: '1990-01-01' })).data.id);
    }
  });
  const source = waiverPdf();
  const document = (await owner.ok('/api/waivers/template-documents', 'POST', source)).data;
  if (document.pages !== 20 || document.bytes !== 10 * 1024 ** 2 || document.hash !== createHash('sha256').update(source).digest('hex'))
    throw new Error('Uploaded document fixture differs');
  const template = (await owner.ok('/api/waivers/templates', 'POST', { name: 'Participation (20 pages)', kind: 'waiver',
    document })).data;
  const png = signaturePng(), hash = createHash('sha256').update(png).digest('hex');
  const signatures = [];
  for (const memberId of members.slice(0, 6)) {
    const image = (await owner.ok('/api/waivers/signature-images', 'POST', { memberId, pngBase64: png.toString('base64') })).data;
    if (image.signatureImageHash !== hash) throw new Error('Signature image hash differs');
    signatures.push((await owner.ok('/api/waivers/signatures', 'POST', { memberId, templateId: template.id, templateVersion: template.version,
      signer: { kind: 'self', name: 'Memory Signer' }, signatureImageKey: image.signatureImageKey, signatureImageHash: image.signatureImageHash, consent: true })).data.id);
  }
  writeState({ members, signatures, document: { pages: document.pages, bytes: document.bytes, hash: document.hash } });
  console.log(JSON.stringify({ step: 'seed', members: members.length, signatures: signatures.length, documentPages: document.pages, documentBytes: document.bytes }));
}

async function load() {
  const owner = new Client(), state = readState();
  await owner.login();
  const seconds = Number(env('LOAD_SECONDS', '45')), workers = Number(env('LOAD_WORKERS', '20'));
  const paths = ['/api/members?limit=100', '/api/households?limit=100', '/api/health', '/api/programs?limit=100',
    '/api/waivers/signatures?limit=50', '/api/waivers/templates', '/portal', '/admin'];
  const stopAt = Date.now() + seconds * 1000, started = Date.now();
  const counts = {}, byPath = {}, count = (status, path) => { counts[status] = (counts[status] ?? 0) + 1; const key = path + ' ' + status; byPath[key] = (byPath[key] ?? 0) + 1; };
  const timings = [];
  const pdfs = { ok: 0, failed: 0 };
  const worker = async (index) => {
    for (let n = index; Date.now() < stopAt; n++) {
      const began = Date.now();
      const path = paths[n % paths.length];
      try { count((await owner.request(path)).status, path); } catch { count('error', path); }
      timings.push(Date.now() - began);
    }
  };
  // The PDF queue holds one active render and two waiting per gym, and answers 429 with Retry-After beyond that, so a
  // client asks again after the wait it names.
  const requestPdf = async (path) => {
    for (let attempt = 0; ; attempt++) {
      const response = await owner.request(path);
      if (response.status !== 429 || attempt >= 60) return response;
      await new Promise((resolve) => setTimeout(resolve, Math.min(5, Number(response.headers['retry-after']) || 1) * 1000));
    }
  };
  // Six merged PDFs requested at once, twice, while the API traffic and the backup run.
  const renderPdfs = async () => {
    await Promise.all(state.signatures.map(async (id) => {
      try {
        const response = await requestPdf(`/api/waivers/signatures/${id}/pdf`);
        if (response.status !== 200 || !response.json?.data?.url) throw new Error('Missing signed copy');
        const url = new URL(response.json.data.url);
        if (url.origin !== 'https://' + gymHost) throw new Error('Unexpected signed-copy origin');
        const copy = await requestPdf(url.pathname + url.search);
        if (copy.status !== 200 || copy.bytes.length < state.document.bytes * 0.99 || copy.bytes.subarray(0, 5).toString() !== '%PDF-')
          throw new Error('Merged copy did not retain the document');
        pdfs.ok++;
      } catch { pdfs.failed++; }
    }));
  };
  const pdfTimer = (afterMs) => new Promise((resolve) => setTimeout(() => (Date.now() < stopAt ? renderPdfs() : Promise.resolve()).then(resolve), afterMs));
  console.log(JSON.stringify({ step: 'load', startedAt: started }));
  await Promise.all([...Array.from({ length: workers }, (_, index) => worker(index)), pdfTimer(8_000), pdfTimer(Math.min(25_000, seconds * 600))]);
  timings.sort((a, b) => a - b);
  const total = Object.values(counts).reduce((a, b) => a + b, 0), good = counts[200] ?? 0;
  console.log(JSON.stringify({ step: 'load', done: true, requests: total, statuses: counts, byPath, pdfs, p50Ms: timings[Math.floor(timings.length / 2)], p95Ms: timings[Math.floor(timings.length * 0.95)] }));
  // A run whose traffic mostly failed measured nothing representative.
  if (total < workers * 5 || good / total < 0.98 || pdfs.failed > 0 || pdfs.ok === 0) process.exitCode = 3;
}

const command = process.argv[2];
const commands = { setup, seed, load };
if (!commands[command]) throw new Error('Usage: load.mjs setup|seed|load');
try { await commands[command](); }
finally { agent.destroy(); }
