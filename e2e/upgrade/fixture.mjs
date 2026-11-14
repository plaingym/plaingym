// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { argon2Sync, createCipheriv, randomBytes } from 'node:crypto';
import { digest, ident, quote } from './history.mjs';

// One deliberately connected row in EVERY historical table. No constraints or triggers are disabled.
export function fixture(tables, key) {
  const ids = Object.fromEntries(tables.map((table, index) => [table.name, `01900000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`]));
  const now = new Date().toISOString(), future = '2099-01-01T00:00:00.000Z';
  const password = randomBytes(24).toString('hex'), salt = randomBytes(16);
  const hash = argon2Sync('argon2id', { message: password, nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32 });
  const passwordHash = `$argon2id$v=19$m=19456,t=2,p=1$${salt.toString('base64').replace(/=+$/, '')}$${hash.toString('base64').replace(/=+$/, '')}`;
  const secrets = [];
  const encrypted = (version, secretClass, column) => {
    const plaintext = randomBytes(32).toString('base64url'), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    cipher.setAAD(Buffer.from(version === 'v1' ? secretClass : JSON.stringify(['plaingym-secret-v2', secretClass, 'gyms', column, ids.gyms])));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    secrets.push({ column, version, secretClass, owner: ids.gyms, plaintext });
    return [version, iv.toString('base64url'), ciphertext.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  };
  const imageKey = `${ids.gyms}/signatures/upgrade.png`, imageHash = digest('upgrade signature fixture');
  const snapshot = JSON.stringify({ template: { id: ids.waiver_templates, name: 'Upgrade waiver', kind: 'waiver', version: 1, body: 'Historical waiver text.' },
    member: { id: ids.members, firstName: 'Upgrade', lastName: 'Member', dateOfBirth: '1990-01-01' },
    signer: { kind: 'self', name: 'Upgrade Member' }, signedAt: now, signatureImage: { key: imageKey, hash: imageHash } });
  const overrides = {
    gyms: { name: 'Upgrade Gym', slug: 'upgrade', settings: { setup: { completed: true } },
      qr_key_encrypted: encrypted('v1', 'qr_key', 'qr_key_encrypted'),
      backup_blob_key_encrypted: encrypted('v2', 'backup_blob_key', 'backup_blob_key_encrypted') },
    gym_domains: { hostname: 'gym.localhost' },
    auth_user: { name: 'Upgrade Owner', email: 'owner@example.test', email_verified: true },
    auth_account: { account_id: ids.auth_user, provider_id: 'credential', password: passwordHash },
    auth_session: { token: randomBytes(32).toString('hex'), expires_at: future },
    auth_verification: { identifier: 'upgrade-fixture', value: 'historical verification', expires_at: future },
    auth_rate_limit: { key: 'upgrade-fixture', count: 1, last_request: Date.now() },
    household_users: { scope: 'payer' },
    households: { name: 'Upgrade Household', email: 'member@example.test' },
    members: { first_name: 'Upgrade', last_name: 'Member', status: 'active', date_of_birth: '1990-01-01' },
    staff_profiles: { display_name: 'Upgrade Owner', user_id: ids.auth_user },
    staff_roles: { role: 'owner' },
    installed_packs: { pack_id: 'bjj', version: 1 },
    programs: { name: 'Upgrade Program', rank_system_id: ids.rank_systems },
    ranks: { name: 'White', position: 0 },
    attendances: { source: 'coach', session_id: ids.class_sessions, program_id: ids.programs },
    class_bookings: { booked_by_kind: 'staff' },
    class_sessions: { name: 'Upgrade Class', starts_at: '2099-01-01T10:00:00Z', ends_at: '2099-01-01T11:00:00Z' },
    class_templates: { name: 'Upgrade Class', weekday: 1, local_start_time: '10:00', duration_minutes: 60 },
    charge_types: { name: 'Upgrade charge' },
    invoices: { kind: 'one_off', status: 'paid', number: 1, paid_at: now, due_on: '2026-10-01' },
    invoice_sequences: { next_number: 2 },
    invoice_line_items: { kind: 'charge', description: 'Historical membership', charge_type_id: ids.charge_types },
    memberships: { status: 'active', interval: 'monthly', next_due_on: '2099-01-01', starts_on: '2026-10-01' },
    plans: { name: 'Upgrade Plan', interval: 'monthly' },
    payment_methods: { processor_id: 'pm_upgrade', brand: 'visa', last4: '4242', expiry_month: 12, expiry_year: 2099 },
    payment_attempts: { status: 'succeeded', saved_payment_method: 'pm_upgrade', stripe_customer_id: 'cus_upgrade', attempt_number: 1 },
    payments: { method: 'cash', paid_at: now },
    refunds: { status: 'succeeded', amount_cents: 100 },
    tax_rates: { name: 'Upgrade tax', rate_millionths: 0 },
    waiver_templates: { name: 'Upgrade waiver', version: 1, body: 'Historical waiver text.' },
    waiver_signatures: { snapshot, snapshot_hash: digest(snapshot), signature_image_key: imageKey, signature_image_hash: imageHash, signed_at: now, ip_address: '127.0.0.1' },
    kiosk_devices: { name: 'Upgrade kiosk', token_hash: digest('upgrade kiosk') },
    link_campaigns: { name: 'Upgrade campaign', purpose: 'update_card', completed_at: now },
    signed_links: { purpose: 'update_card', token_hash: digest('upgrade link'), expires_at: future },
    backup_runs: { kind: 'manual', status: 'succeeded', started_at: now, completed_at: now, object_prefix: 'upgrade' },
    jobs: { name: 'upgrade-fixture', status: 'succeeded', run_at: future, idempotency_key: 'upgrade-fixture' },
    stripe_events: { event_id: 'evt_upgrade', type: 'upgrade.fixture', payload: {}, processed_at: now },
    audit_events: { actor_kind: 'system', action: 'member.created', target_type: 'member', target_id: ids.members, occurred_at: now },
    email_outbox: { recipient: 'member@example.test', subject: 'Upgrade fixture', html: '<p>Historical mail</p>', text: 'Historical mail', sent_at: now },
    import_runs: { input: {}, actor: { kind: 'system' }, timezone: 'UTC', dry_run: true, status: 'failed', total_rows: 1, updated_at: now },
    import_chunks: { position: 0, row_count: 1 },
    export_runs: { datasets: ['members'], status: 'failed', updated_at: now },
    email_deliveries: { key: 'upgrade-fixture', state: 'accepted', updated_at: now },
    job_schedule_cursors: { name: 'upgrade-fixture', expression: '0 0 * * *', timezone: 'UTC', last_occurrence: now },
  };
  // Refuse silently unseeded tables when a gate changes.
  const generic = new Set(['member_tag_links', 'member_tags', 'member_ranks', 'rank_systems', 'class_session_programs', 'class_session_tags',
    'class_tags', 'class_template_programs', 'class_template_tags', 'charge_type_tax_rates', 'plan_tax_rates']);
  const rows = new Map();
  for (const table of tables) {
    assert.ok(overrides[table.name] || generic.has(table.name), `Missing fixture for ${table.name}`);
    const values = { id: ids[table.name] };
    if (table.columns.gym_id) values.gym_id = ids.gyms;
    for (const column of Object.values(table.columns)) {
      if (Object.hasOwn(values, column.name) || !column.notNull || column.default !== undefined) continue;
      if (column.name === 'currency') values[column.name] = 'USD';
      else if (column.name === 'amount_cents') values[column.name] = 1200;
      else if (column.type === 'uuid') values[column.name] = ids[table.name]; // Replaced by FK targets below.
      else if (['integer', 'bigint'].includes(column.type)) values[column.name] = 1;
      else if (column.type === 'boolean') values[column.name] = false;
      else if (column.type === 'jsonb') values[column.name] = {};
      else if (column.type.startsWith('timestamp')) values[column.name] = now;
      else if (column.type === 'date') values[column.name] = '2026-10-01';
      else values[column.name] = `Upgrade ${table.name}`;
    }
    Object.assign(values, Object.fromEntries(Object.entries(overrides[table.name] ?? {}).filter(([column]) => table.columns[column])));
    for (const fk of Object.values(table.foreignKeys)) {
      if (fk.columnsFrom.every(column => values[column] !== undefined)) {
        for (let i = 0; i < fk.columnsFrom.length; i++) {
          const from = fk.columnsFrom[i], to = fk.columnsTo[i];
          if (to === 'id') values[from] = ids[fk.tableTo];
          else if (to === 'gym_id') values[from] = ids.gyms;
          else if (to === 'household_id') values[from] = ids.households;
          else if (to === 'rank_system_id') values[from] = ids.rank_systems;
          else if (to === 'currency') values[from] = 'USD';
          else throw new Error(`Missing fixture FK target ${fk.tableTo}.${to}`);
        }
      }
    }
    rows.set(table.name, { table, values });
  }
  const statements = [], inserted = new Set();
  while (rows.size) {
    let progress = false;
    for (const [name, { table, values }] of rows) {
      const dependencies = Object.values(table.foreignKeys).filter(fk => fk.columnsFrom.every(column => values[column] !== undefined));
      if (dependencies.some(fk => fk.tableTo !== name && !inserted.has(fk.tableTo))) continue;
      const columns = Object.keys(values);
      statements.push(`INSERT INTO ${ident(name)} (${columns.map(ident).join(',')}) VALUES (${columns.map(column => {
        const value = values[column];
        return quote(typeof value === 'object' ? JSON.stringify(value) : value);
      }).join(',')});`);
      inserted.add(name); rows.delete(name); progress = true;
    }
    assert.ok(progress, `Fixture FK cycle: ${[...rows.keys()].join(', ')}`);
  }
  return { sql: statements.join('\n'), ids, password, secrets, signatureHash: digest(snapshot) };
}
