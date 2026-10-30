// SPDX-License-Identifier: AGPL-3.0-only
// A small, stateful stand-in for the Stripe API calls the demo install makes, plus a minimal hosted
// Checkout page. It exists only in the e2e stack, which reaches it as api.stripe.com over a test CA.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const secretKey = process.env.STRIPE_SECRET_KEY, checkoutOrigin = process.env.CHECKOUT_ORIGIN;
if (!secretKey || !checkoutOrigin) throw new Error('STRIPE_SECRET_KEY and CHECKOUT_ORIGIN are required');
const objects = new Map(), replies = new Map();
const newId = (prefix) => prefix + '_' + randomBytes(12).toString('hex');
const now = () => Math.floor(Date.now() / 1000);
// Underscored fields are this fake's own state and never leave it.
const visible = (object) => Object.fromEntries(Object.entries(object).filter(([name]) => !name.startsWith('_')));
const store = (object) => { objects.set(object.id, object); return object; };
const find = (prefix, id) => { const object = objects.get(id); return object?.id.startsWith(prefix + '_') ? object : undefined; };

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

function list(prefix, query, filter = () => true) {
  const created = query.created ?? {}, limit = Math.min(Number(query.limit ?? 10), 100);
  let rows = [...objects.values()].filter((object) => object.id.startsWith(prefix + '_') && filter(object)
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
function paymentMethod(customer, details, metadata = {}) {
  return store({ id: newId('pm'), object: 'payment_method', type: 'card', created: now(), livemode: false, customer, metadata,
    card: { brand: details.brand, last4: details.last4, exp_month: 12, exp_year: new Date().getUTCFullYear() + 5 }, _fails: details.fails });
}
function succeed(intent) {
  const charge = store({ id: newId('ch'), object: 'charge', created: now(), livemode: false, amount: intent.amount,
    currency: intent.currency, customer: intent.customer, payment_intent: intent.id, status: 'succeeded', paid: true });
  Object.assign(intent, { status: 'succeeded', latest_charge: charge.id, last_payment_error: null, amount_received: intent.amount });
  return intent;
}

const routes = [
  ['POST', /^\/v1\/customers$/, (body) => store({ id: newId('cus'), object: 'customer', created: now(), livemode: false,
    email: body.email ?? null, name: body.name ?? null, metadata: body.metadata ?? {} })],
  ['GET', /^\/v1\/customers$/, (_body, query) => list('cus', query, (customer) => !query.email || customer.email === query.email)],
  ['GET', /^\/v1\/customers\/(\w+)$/, (_body, _query, id) => find('cus', id) ?? missing(id)],
  ['POST', /^\/v1\/customers\/(\w+)$/, (body, _query, id) => {
    const customer = find('cus', id); if (!customer) return missing(id);
    if (body.name !== undefined) customer.name = body.name;
    if (body.email !== undefined) customer.email = body.email || null;
    if (body.metadata) customer.metadata = { ...customer.metadata, ...body.metadata };
    return customer;
  }],
  ['POST', /^\/v1\/payment_methods$/, (body) => paymentMethod(null, card(body.card?.token), body.metadata)],
  ['GET', /^\/v1\/payment_methods\/(\w+)$/, (_body, _query, id) => find('pm', id) ?? missing(id)],
  ['POST', /^\/v1\/payment_methods\/(\w+)\/attach$/, (body, _query, id) => {
    const method = find('pm', id); if (!method) return missing(id);
    if (!find('cus', body.customer)) return missing(body.customer);
    method.customer = body.customer; return method;
  }],
  ['POST', /^\/v1\/payment_methods\/(\w+)\/detach$/, (_body, _query, id) => {
    const method = find('pm', id); if (!method) return missing(id);
    if (!method.customer) throw invalid('The payment method is not attached to a customer');
    method.customer = null; return method;
  }],
  ['POST', /^\/v1\/payment_intents$/, (body) => {
    if (!find('cus', body.customer)) return missing(body.customer);
    if (body.payment_method && !find('pm', body.payment_method)) return missing(body.payment_method);
    return store({ id: newId('pi'), object: 'payment_intent', created: now(), livemode: false, amount: integer(body.amount, 'amount'),
      currency: body.currency, customer: body.customer, payment_method: body.payment_method ?? null, metadata: body.metadata ?? {},
      status: body.payment_method ? 'requires_confirmation' : 'requires_payment_method', latest_charge: null, last_payment_error: null,
      setup_future_usage: body.setup_future_usage ?? null });
  }],
  ['GET', /^\/v1\/payment_intents$/, (_body, query) => list('pi', query)],
  ['GET', /^\/v1\/payment_intents\/(\w+)$/, (_body, _query, id) => find('pi', id) ?? missing(id)],
  ['POST', /^\/v1\/payment_intents\/(\w+)\/confirm$/, (_body, _query, id) => {
    const intent = find('pi', id); if (!intent) return missing(id);
    if (!['requires_confirmation', 'requires_payment_method'].includes(intent.status)) throw invalid('This PaymentIntent cannot be confirmed');
    const method = find('pm', intent.payment_method ?? '');
    if (!method?._fails) return succeed(intent);
    Object.assign(intent, { status: 'requires_payment_method',
      last_payment_error: { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline', message: 'Your card was declined.' } });
    throw new StripeError(402, { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline',
      message: 'Your card was declined.', payment_intent: visible(intent) });
  }],
  ['POST', /^\/v1\/payment_intents\/(\w+)\/cancel$/, (_body, _query, id) => {
    const intent = find('pi', id); if (!intent) return missing(id);
    if (intent.status === 'succeeded') throw invalid('This PaymentIntent has already succeeded');
    intent.status = 'canceled'; return intent;
  }],
  ['GET', /^\/v1\/charges\/(\w+)$/, (_body, _query, id) => find('ch', id) ?? missing(id)],
  ['POST', /^\/v1\/checkout\/sessions$/, (body) => {
    if (!find('cus', body.customer)) return missing(body.customer);
    if (!['payment', 'setup'].includes(body.mode)) throw invalid('Unsupported Checkout mode');
    const id = newId('cs_test'), item = body.line_items?.[0]?.price_data;
    return store({ id, object: 'checkout.session', created: now(), livemode: false, mode: body.mode, status: 'open',
      payment_status: 'unpaid', url: `${checkoutOrigin}/pay/${id}`, customer: body.customer, metadata: body.metadata ?? {},
      success_url: body.success_url, cancel_url: body.cancel_url, payment_intent: null, setup_intent: null,
      expires_at: body.expires_at === undefined ? now() + 86_400 : integer(body.expires_at, 'expires_at'),
      currency: item?.currency ?? null, amount_total: item ? integer(item.unit_amount, 'unit_amount') * integer(body.line_items[0].quantity, 'quantity') : null,
      _intentData: body.payment_intent_data ?? {}, _setupData: body.setup_intent_data ?? {} });
  }],
  ['GET', /^\/v1\/checkout\/sessions\/(\w+)$/, (_body, _query, id) => find('cs', id) ?? missing(id)],
  ['POST', /^\/v1\/checkout\/sessions\/(\w+)\/expire$/, (_body, _query, id) => {
    const session = find('cs', id); if (!session) return missing(id);
    if (session.status !== 'open') throw invalid('Only open Checkout sessions can be expired');
    session.status = 'expired'; return session;
  }],
  ['GET', /^\/v1\/setup_intents\/(\w+)$/, (_body, _query, id) => find('seti', id) ?? missing(id)],
  ['POST', /^\/v1\/refunds$/, (body) => {
    const intent = find('pi', body.payment_intent ?? ''); if (!intent) return missing(body.payment_intent);
    return store({ id: newId('re'), object: 'refund', created: now(), livemode: false, amount: integer(body.amount ?? intent.amount, 'amount'),
      currency: intent.currency, payment_intent: intent.id, charge: intent.latest_charge, status: 'succeeded', metadata: body.metadata ?? {} });
  }],
  ['GET', /^\/v1\/refunds$/, (_body, query) => list('re', query, (refund) => !query.payment_intent || refund.payment_intent === query.payment_intent)],
  ['GET', /^\/v1\/refunds\/(\w+)$/, (_body, _query, id) => find('re', id) ?? missing(id)],
  // Disputes and events never occur in this stand-in; change feeds read them as empty pages.
  ['GET', /^\/v1\/disputes$/, (_body, query) => list('dp', query)],
  ['GET', /^\/v1\/disputes\/(\w+)$/, (_body, _query, id) => missing(id)],
  ['GET', /^\/v1\/events$/, (_body, query) => list('evt', query)],
];

/** Completes an open session as Stripe's hosted page would after the visitor pays with the test card. */
function complete(session, number) {
  if (session.status !== 'open') throw invalid('This Checkout session is no longer open');
  if (number.replace(/\s+/g, '') !== '4242424242424242') throw new StripeError(402, { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' });
  const method = paymentMethod(session.customer, card('tok_visa'));
  if (session.mode === 'payment') {
    const intent = store({ id: newId('pi'), object: 'payment_intent', created: now(), livemode: false, amount: session.amount_total,
      currency: session.currency, customer: session.customer, payment_method: method.id, metadata: session._intentData.metadata ?? {},
      setup_future_usage: session._intentData.setup_future_usage ?? null, latest_charge: null, last_payment_error: null, status: 'processing' });
    succeed(intent);
    Object.assign(session, { payment_intent: intent.id, payment_status: 'paid' });
  } else {
    const setup = store({ id: newId('seti'), object: 'setup_intent', created: now(), livemode: false, status: 'succeeded',
      customer: session.customer, payment_method: method.id, metadata: session._setupData.metadata ?? {}, last_setup_error: null });
    Object.assign(session, { setup_intent: setup.id, payment_status: 'no_payment_required' });
  }
  session.status = 'complete';
  return session.success_url.replace('{CHECKOUT_SESSION_ID}', session.id);
}
const escape = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
function page(session, message = '') {
  const amount = session.amount_total === null ? '' : `<p>${escape((session.amount_total / 100).toFixed(2))} ${escape(session.currency.toUpperCase())}</p>`;
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
      const session = find('cs', hosted[1]);
      if (!session) return send(response, 404, 'Unknown session', 'text/plain');
      if (request.method === 'GET') return send(response, 200, page(session), 'text/html; charset=utf-8');
      try {
        const location = complete(session, new URLSearchParams(text).get('card') ?? '');
        response.writeHead(303, { location }); return response.end();
      } catch (error) {
        if (error instanceof StripeError) return send(response, error.status, page(session, error.message), 'text/html; charset=utf-8');
        throw error;
      }
    }
    if (request.headers.authorization !== 'Bearer ' + secretKey)
      return send(response, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
    const idempotency = request.method === 'POST' && request.headers['idempotency-key'];
    const replayKey = idempotency && `${request.method} ${url.pathname} ${idempotency}`;
    if (replayKey && replies.has(replayKey)) {
      // As Stripe does, a key replays its first response only for the same parameters.
      const [first, status, body] = replies.get(replayKey);
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
        const [found, handle] = match, result = handle(parseForm(text), parseForm(url.search), found[1]);
        if (result instanceof StripeError) throw result;
        body = visible(result);
      } catch (error) {
        if (!(error instanceof StripeError)) throw error;
        status = error.status; body = { error: error.body };
      }
    }
    if (replayKey) replies.set(replayKey, [text, status, body]);
    send(response, status, body);
  } catch (error) {
    console.error(error);
    send(response, 500, { error: { type: 'api_error', message: 'Fake Stripe failure' } });
  }
}).listen(12111, () => console.log('Fake Stripe listening on 12111'));
