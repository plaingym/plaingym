// SPDX-License-Identifier: AGPL-3.0-only
// A small, stateful stand-in for the Stripe API calls the demo install makes, plus a minimal hosted
// Checkout page. It exists only in the e2e stack, which reaches it as api.stripe.com over a test CA.
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const secretKey = process.env.STRIPE_SECRET_KEY, restrictedKey = process.env.STRIPE_RESTRICTED_KEY, checkoutOrigin = process.env.CHECKOUT_ORIGIN;
if (!secretKey || !restrictedKey || !checkoutOrigin) throw new Error('STRIPE_SECRET_KEY, STRIPE_RESTRICTED_KEY and CHECKOUT_ORIGIN are required');
// Only the keys issued to this run have accounts. Gym keys use the same derivation as multi/support.ts.
const keys = [secretKey, restrictedKey, ...['alpha', 'beta'].map(slug =>
  'rk_test_' + createHash('sha256').update(`${restrictedKey}:${slug}`).digest('hex').slice(0, 32))];
const accounts = new Map(keys.map(key => [key, { objects: new Map(), replies: new Map() }]));
const accountOf = (key) => accounts.get(key);
const newId = (prefix) => prefix + '_' + randomBytes(12).toString('hex');
const now = () => Math.floor(Date.now() / 1000);
// Underscored fields are this fake's own state and never leave it.
const visible = (object) => Object.fromEntries(Object.entries(object).filter(([name]) => !name.startsWith('_')));
const store = (account, object) => { account.objects.set(object.id, object); return object; };
const find = (account, prefix, id) => { const object = account.objects.get(id); return object?.id.startsWith(prefix + '_') ? object : undefined; };

class StripeError extends Error {
  constructor(status, body) { super(body.message); this.status = status; this.body = body; }
}
const missing = (id) => new StripeError(404, { type: 'invalid_request_error', code: 'resource_missing', message: `No such object: '${id}'` });
const invalid = (message) => new StripeError(400, { type: 'invalid_request_error', message });

/** Stripe's bracket encoding: a[b][0]=c. Objects whose keys are 0..n-1 become arrays. */
function parseForm(search) {
  const root = {};
  for (const [name, value] of new URLSearchParams(search)) {
    const path = name.replace(/\]/g, '').split('[');
    let node = root;
    for (const [index, part] of path.entries()) {
      if (index === path.length - 1) node[part] = value;
      else node = node[part] ??= {};
    }
  }
  const arrays = (value) => {
    if (!value || typeof value !== 'object') return value;
    const keys = Object.keys(value);
    for (const key of keys) value[key] = arrays(value[key]);
    return keys.length && keys.every((key, index) => key === String(index)) ? keys.map((key) => value[key]) : value;
  };
  return arrays(root);
}
const integer = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw invalid(`Invalid integer: ${name}`);
  return number;
};

/** As Stripe does, `expand` replaces each named top-level ID with the object it names. */
function expanded(account, body, ...params) {
  for (const param of params) for (const name of Object.values(param.expand ?? {})) {
    const target = typeof body[name] === 'string' ? account.objects.get(body[name]) : undefined;
    if (target) body[name] = visible(target);
  }
  return body;
}

function list(account, prefix, query, filter = () => true) {
  const created = query.created ?? {}, limit = Math.min(Number(query.limit ?? 10), 100);
  let rows = [...account.objects.values()].filter((object) => object.id.startsWith(prefix + '_') && filter(object)
    && (created.gte === undefined || object.created >= Number(created.gte)) && (created.lte === undefined || object.created <= Number(created.lte)))
    .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
  if (query.starting_after) rows = rows.slice(rows.findIndex((object) => object.id === query.starting_after) + 1);
  return { object: 'list', data: rows.slice(0, limit).map(visible), has_more: rows.length > limit, url: '/v1/' + prefix };
}

function card(token) {
  if (token === 'tok_visa') return { brand: 'visa', last4: '4242', fails: false };
  if (token === 'tok_chargeCustomerFail') return { brand: 'visa', last4: '0341', fails: true };
  throw invalid('Unsupported test token');
}
function paymentMethod(account, customer, details, metadata = {}) {
  return store(account, { id: newId('pm'), object: 'payment_method', type: 'card', created: now(), livemode: false, customer, metadata,
    card: { brand: details.brand, last4: details.last4, exp_month: 12, exp_year: new Date().getUTCFullYear() + 5 }, _fails: details.fails });
}
function succeed(account, intent) {
  const charge = store(account, { id: newId('ch'), object: 'charge', created: now(), livemode: false, amount: intent.amount,
    currency: intent.currency, customer: intent.customer, payment_intent: intent.id, status: 'succeeded', paid: true });
  Object.assign(intent, { status: 'succeeded', latest_charge: charge.id, last_payment_error: null, amount_received: intent.amount });
  return intent;
}

const routes = [
  ['POST', /^\/v1\/customers$/, (account, body) => store(account, { id: newId('cus'), object: 'customer', created: now(), livemode: false,
    email: body.email ?? null, name: body.name ?? null, metadata: body.metadata ?? {} })],
  ['GET', /^\/v1\/customers$/, (account, _body, query) => list(account, 'cus', query, (customer) => !query.email || customer.email === query.email)],
  ['GET', /^\/v1\/customers\/(\w+)$/, (account, _body, _query, id) => find(account, 'cus', id) ?? missing(id)],
  ['POST', /^\/v1\/customers\/(\w+)$/, (account, body, _query, id) => {
    const customer = find(account, 'cus', id); if (!customer) return missing(id);
    if (body.name !== undefined) customer.name = body.name;
    if (body.email !== undefined) customer.email = body.email || null;
    if (body.metadata) customer.metadata = { ...customer.metadata, ...body.metadata };
    return customer;
  }],
  ['POST', /^\/v1\/payment_methods$/, (account, body) => paymentMethod(account, null, card(body.card?.token), body.metadata)],
  ['GET', /^\/v1\/payment_methods\/(\w+)$/, (account, _body, _query, id) => find(account, 'pm', id) ?? missing(id)],
  ['POST', /^\/v1\/payment_methods\/(\w+)\/attach$/, (account, body, _query, id) => {
    const method = find(account, 'pm', id); if (!method) return missing(id);
    if (!find(account, 'cus', body.customer)) return missing(body.customer);
    method.customer = body.customer; return method;
  }],
  ['POST', /^\/v1\/payment_methods\/(\w+)\/detach$/, (account, _body, _query, id) => {
    const method = find(account, 'pm', id); if (!method) return missing(id);
    if (!method.customer) throw invalid('The payment method is not attached to a customer');
    method.customer = null; return method;
  }],
  ['POST', /^\/v1\/payment_intents$/, (account, body) => {
    if (!find(account, 'cus', body.customer)) return missing(body.customer);
    if (body.payment_method && !find(account, 'pm', body.payment_method)) return missing(body.payment_method);
    return store(account, { id: newId('pi'), object: 'payment_intent', created: now(), livemode: false, amount: integer(body.amount, 'amount'),
      currency: body.currency, customer: body.customer, payment_method: body.payment_method ?? null, metadata: body.metadata ?? {},
      status: body.payment_method ? 'requires_confirmation' : 'requires_payment_method', latest_charge: null, last_payment_error: null,
      setup_future_usage: body.setup_future_usage ?? null });
  }],
  ['GET', /^\/v1\/payment_intents$/, (account, _body, query) => list(account, 'pi', query)],
  ['GET', /^\/v1\/payment_intents\/(\w+)$/, (account, _body, _query, id) => find(account, 'pi', id) ?? missing(id)],
  ['POST', /^\/v1\/payment_intents\/(\w+)\/confirm$/, (account, _body, _query, id) => {
    const intent = find(account, 'pi', id); if (!intent) return missing(id);
    if (!['requires_confirmation', 'requires_payment_method'].includes(intent.status)) throw invalid('This PaymentIntent cannot be confirmed');
    const method = find(account, 'pm', intent.payment_method ?? '');
    if (!method?._fails) return succeed(account, intent);
    Object.assign(intent, { status: 'requires_payment_method',
      last_payment_error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' } });
    throw new StripeError(402, { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline',
      message: 'Your card was declined.', payment_intent: visible(intent) });
  }],
  ['POST', /^\/v1\/payment_intents\/(\w+)\/cancel$/, (account, _body, _query, id) => {
    const intent = find(account, 'pi', id); if (!intent) return missing(id);
    if (intent.status === 'succeeded') throw invalid('This PaymentIntent has already succeeded');
    intent.status = 'canceled'; return intent;
  }],
  ['GET', /^\/v1\/charges\/(\w+)$/, (account, _body, _query, id) => find(account, 'ch', id) ?? missing(id)],
  ['POST', /^\/v1\/checkout\/sessions$/, (account, body) => {
    if (!find(account, 'cus', body.customer)) return missing(body.customer);
    if (!['payment', 'setup'].includes(body.mode)) throw invalid('Unsupported Checkout mode');
    const id = newId('cs_test'), item = body.line_items?.[0]?.price_data;
    return store(account, { id, object: 'checkout.session', created: now(), livemode: false, mode: body.mode, status: 'open',
      payment_status: 'unpaid', url: `${checkoutOrigin}/pay/${id}`, customer: body.customer, metadata: body.metadata ?? {},
      success_url: body.success_url, cancel_url: body.cancel_url, payment_intent: null, setup_intent: null,
      expires_at: body.expires_at === undefined ? now() + 86_400 : integer(body.expires_at, 'expires_at'),
      currency: item?.currency ?? null, amount_total: item ? integer(item.unit_amount, 'unit_amount') * integer(body.line_items[0].quantity, 'quantity') : null,
      _intentData: body.payment_intent_data ?? {}, _setupData: body.setup_intent_data ?? {} });
  }],
  ['GET', /^\/v1\/checkout\/sessions\/(\w+)$/, (account, _body, _query, id) => find(account, 'cs', id) ?? missing(id)],
  ['POST', /^\/v1\/checkout\/sessions\/(\w+)\/expire$/, (account, _body, _query, id) => {
    const session = find(account, 'cs', id); if (!session) return missing(id);
    if (session.status !== 'open') throw invalid('Only open Checkout sessions can be expired');
    session.status = 'expired'; return session;
  }],
  ['GET', /^\/v1\/setup_intents\/(\w+)$/, (account, _body, _query, id) => find(account, 'seti', id) ?? missing(id)],
  ['POST', /^\/v1\/refunds$/, (account, body) => {
    const intent = find(account, 'pi', body.payment_intent ?? ''); if (!intent) return missing(body.payment_intent);
    return store(account, { id: newId('re'), object: 'refund', created: now(), livemode: false, amount: integer(body.amount ?? intent.amount, 'amount'),
      currency: intent.currency, payment_intent: intent.id, charge: intent.latest_charge, status: 'succeeded', metadata: body.metadata ?? {} });
  }],
  ['GET', /^\/v1\/refunds$/, (account, _body, query) => list(account, 're', query, (refund) => !query.payment_intent || refund.payment_intent === query.payment_intent)],
  ['GET', /^\/v1\/refunds\/(\w+)$/, (account, _body, _query, id) => find(account, 're', id) ?? missing(id)],
  // The listings a gym's permission check reads when it saves its key.
  ['GET', /^\/v1\/checkout\/sessions$/, (account, _body, query) => list(account, 'cs', query)],
  ['GET', /^\/v1\/setup_intents$/, (account, _body, query) => list(account, 'seti', query)],
  ['GET', /^\/v1\/payment_methods$/, (account, _body, query) => list(account, 'pm', query, (method) => !query.customer || method.customer === query.customer)],
  ['GET', /^\/v1\/charges$/, (account, _body, query) => list(account, 'ch', query)],
  // Webhook endpoints: a gym registers one when it saves its key. Only creation returns the signing secret, as Stripe does.
  ['POST', /^\/v1\/webhook_endpoints$/, (account, body) => {
    const secret = 'whsec_' + randomBytes(16).toString('hex');
    const endpoint = store(account, { id: newId('we'), object: 'webhook_endpoint', created: now(), livemode: false, url: body.url,
      api_version: body.api_version ?? null, enabled_events: body.enabled_events ?? [], metadata: body.metadata ?? {}, status: 'enabled', _secret: secret });
    return { ...visible(endpoint), secret };
  }],
  ['GET', /^\/v1\/webhook_endpoints$/, (account, _body, query) => list(account, 'we', query)],
  ['GET', /^\/v1\/webhook_endpoints\/(\w+)$/, (account, _body, _query, id) => find(account, 'we', id) ?? missing(id)],
  ['POST', /^\/v1\/webhook_endpoints\/(\w+)$/, (account, body, _query, id) => {
    const endpoint = find(account, 'we', id); if (!endpoint) return missing(id);
    if (body.enabled_events) endpoint.enabled_events = body.enabled_events;
    return endpoint;
  }],
  ['DELETE', /^\/v1\/webhook_endpoints\/(\w+)$/, (account, _body, _query, id) => {
    const endpoint = find(account, 'we', id); if (!endpoint) return missing(id);
    account.objects.delete(id); return { id, object: 'webhook_endpoint', deleted: true };
  }],
  // Disputes and events never occur in this stand-in; change feeds read them as empty pages.
  ['GET', /^\/v1\/disputes$/, (account, _body, query) => list(account, 'dp', query)],
  ['GET', /^\/v1\/disputes\/(\w+)$/, (account, _body, _query, id) => missing(id)],
  ['GET', /^\/v1\/events$/, (account, _body, query) => list(account, 'evt', query)],
];

/** Completes an open session as Stripe's hosted page would after the visitor pays with the test card. */
function complete(account, session, number) {
  if (session.status !== 'open') throw invalid('This Checkout session is no longer open');
  if (number.replace(/\s+/g, '') !== '4242424242424242') throw new StripeError(402, { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' });
  const method = paymentMethod(account, session.customer, card('tok_visa'));
  if (session.mode === 'payment') {
    const intent = store(account, { id: newId('pi'), object: 'payment_intent', created: now(), livemode: false, amount: session.amount_total,
      currency: session.currency, customer: session.customer, payment_method: method.id, metadata: session._intentData.metadata ?? {},
      setup_future_usage: session._intentData.setup_future_usage ?? null, latest_charge: null, last_payment_error: null, status: 'processing' });
    succeed(account, intent);
    Object.assign(session, { payment_intent: intent.id, payment_status: 'paid' });
  } else {
    const setup = store(account, { id: newId('seti'), object: 'setup_intent', created: now(), livemode: false, status: 'succeeded',
      customer: session.customer, payment_method: method.id, metadata: session._setupData.metadata ?? {}, last_setup_error: null });
    Object.assign(session, { setup_intent: setup.id, payment_status: 'no_payment_required' });
  }
  session.status = 'complete';
  return session.success_url.replace('{CHECKOUT_SESSION_ID}', session.id);
}
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
function page(session, message = '') {
  const amount = session.amount_total === null ? '' : `<p>${escape(String(session.amount_total))} ${escape(session.currency.toUpperCase())} (minor units, as sent)</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test checkout</title></head><body style="font-family:sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem">
<main><h1>Test checkout</h1>${amount}${message ? `<p role="alert">${escape(message)}</p>` : ''}
<form method="post"><label for="card">Card number</label><br><input id="card" name="card" autocomplete="cc-number" inputmode="numeric"
style="font-size:1.25rem;min-height:44px;width:100%;box-sizing:border-box"><br><br><button style="min-height:44px;min-width:44px;font-size:1.25rem">Pay</button></form>
<p><a href="${escape(session.cancel_url)}">Back</a></p></main></body></html>`;
}

async function read(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
function send(response, status, body, type = 'application/json') {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(type === 'application/json' ? JSON.stringify(body) : body);
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://stripe'), text = await read(request);
    if (url.pathname === '/health') return send(response, 200, { ok: true });
    const hosted = url.pathname.match(/^\/pay\/(cs_test_\w+)$/);
    if (hosted) {
      // The hosted page is reached by the Checkout session's own URL, whichever account made it.
      const owner = [...accounts.values()].find((account) => account.objects.has(hosted[1]));
      const session = owner && find(owner, 'cs', hosted[1]);
      if (!session) return send(response, 404, 'Unknown session', 'text/plain');
      if (request.method === 'GET') return send(response, 200, page(session), 'text/html; charset=utf-8');
      try {
        const location = complete(owner, session, new URLSearchParams(text).get('card') ?? '');
        response.writeHead(303, { location }); return response.end();
      } catch (error) {
        if (error instanceof StripeError) return send(response, error.status, page(session, error.message), 'text/html; charset=utf-8');
        throw error;
      }
    }
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    // Test control, for the specs only (they hold the install's secret key): signs a webhook body as Stripe would for the account
    // of `key`, with the signing secret returned when that account's endpoint was created.
    if (url.pathname === '/test/sign-webhook' && request.method === 'POST') {
      if (bearer !== secretKey) return send(response, 401, { error: { message: 'Invalid API Key provided' } });
      const { key, body } = JSON.parse(text), account = accountOf(key);
      const endpoints = account ? [...account.objects.values()].filter((object) => object.object === 'webhook_endpoint' && object.status === 'enabled') : [];
      const endpoint = endpoints.sort((a, b) => b.created - a.created)[0];
      if (!endpoint) return send(response, 404, { error: { message: 'No webhook endpoint registered for this key' } });
      const created = now();
      return send(response, 200, { endpointId: endpoint.id, url: endpoint.url, signature: `t=${created},v1=${createHmac('sha256', endpoint._secret).update(`${created}.${body}`).digest('hex')}` });
    }
    const account = accountOf(bearer);
    if (!account) return send(response, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
    const idempotency = request.method === 'POST' && request.headers['idempotency-key'];
    const replayKey = idempotency && `${request.method} ${url.pathname} ${idempotency}`;
    if (replayKey && account.replies.has(replayKey)) {
      // As Stripe does, a key replays its first response only for the same parameters.
      const [first, status, body] = account.replies.get(replayKey);
      if (first !== text) return send(response, 400, { error: { type: 'idempotency_error',
        message: 'Keys for idempotent requests can only be used with the same parameters they were first used with.' } });
      return send(response, status, body);
    }
    const match = routes.map(([method, pattern, handle]) => [method === request.method && url.pathname.match(pattern), handle]).find(([found]) => found);
    let status = 200, body;
    if (!match) {
      console.log(JSON.stringify({ event: 'stripe_fake.unhandled', method: request.method, path: url.pathname }));
      status = 404; body = { error: { type: 'invalid_request_error', message: `Unrecognized request URL (${request.method}: ${url.pathname})` } };
    } else {
      try {
        const [found, handle] = match, form = parseForm(text), query = parseForm(url.search), result = handle(account, form, query, found[1]);
        if (result instanceof StripeError) throw result;
        body = expanded(account, visible(result), form, query);
      } catch (error) {
        if (!(error instanceof StripeError)) throw error;
        status = error.status; body = { error: error.body };
      }
    }
    if (replayKey) account.replies.set(replayKey, [text, status, body]);
    send(response, status, body);
  } catch (error) {
    console.error(error);
    send(response, 500, { error: { type: 'api_error', message: 'Fake Stripe failure' } });
  }
}).listen(12111, () => console.log('Fake Stripe listening on 12111'));
