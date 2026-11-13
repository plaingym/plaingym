// SPDX-License-Identifier: AGPL-3.0-only
/** Deterministic mixed-quality export: shared families, singletons, duplicates and invalid cells. */
export function richPeople(rows: number, order: 'mixed' | 'dmy' = 'mixed') {
  let state = 20261101;
  const rand = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)]!;
  const cell = (value: string) => /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  const header = ['Member ID', 'Household External ID', 'First Name', 'Last Name', 'Email', 'Date of Birth', 'Status', 'Phone',
    'Household Name', 'Billing Day', 'Email Opt Out', 'Tags', 'Stripe Customer ID', 'Stripe Payment Method ID', 'Medical Notes', 'Notes'];
  const first = ['Ari', 'Lea', 'Kai', 'Mina', 'Jo', 'Sam', 'Noor', 'Émile', 'Zoë', 'Ola', 'Ren', 'Tae', 'ﬁona', 'Iris', 'Max', 'Uma'];
  const statuses = ['Active', 'active', 'Trial', 'Free Trial', 'Frozen', 'On Hold', 'Cancelled', 'inactive', 'Guest', 'Lead', 'Bogus', ''];
  const tags = ['Adults', 'Kids', 'Morning; Adults', 'kids, KIDS', 'Comp|Team', '', '', 'x'.repeat(120)];
  function date(i: number) {
    const y = 1950 + (i % 70), m = 1 + (i % 12), d = 1 + (i % 28), kind = order === 'mixed' ? i % 7 : order === 'dmy' ? 2 : 3;
    const p = (n: number) => String(n).padStart(2, '0');
    if (kind === 0 || kind === 1) return `${y}-${p(m)}-${p(d)}`;
    if (kind === 2) return `${p(d)}/${p(m)}/${y}`;
    if (kind === 3) return `${p(m)}/${p(d)}/${y}`;
    if (kind === 4) return i % 3 ? `${y}.${m}.${d}` : '2099-01-01';
    if (kind === 5) return i % 2 ? '31/02/2001' : '';
    return `${p(m)}-${p(m)}-${y}`;
  }
  const lines = [header.join(',')], seed = [header.slice(0, 15).join(',')];
  let family = 0, members = 0;
  for (let i = 0; members < rows; i++) {
    const size = pick([1, 1, 1, 2, 2, 3, 4, 6]), last = `Fam${family % 9000}${pick(['', '', 'son'])}`, kind = rand();
    const customer = kind < 0.4 ? `cus_F${family}` : kind < 0.45 ? `cus_F${family - 1}` : kind < 0.5 ? `cus_Shared${family % 50}` : '';
    const anchor = `M${family}-0`, byHousehold = kind < 0.6, customerOnly = kind >= 0.6 && kind < 0.7;
    for (let k = 0; k < size && members < rows; k++, members++) {
      const n = members, name = pick(first), dup = rand() < 0.03 && n > 10;
      const row: Record<string, string> = {
        'Member ID': customerOnly ? (k ? `M${family}-${k}` : '') : rand() < 0.9 ? `M${family}-${k}` : '',
        'Household External ID': byHousehold && k ? pick([anchor, anchor, `H${family}`, '']) : byHousehold && rand() < 0.3 ? `H${family}` : '',
        'First Name': rand() < 0.01 ? '' : dup ? 'Dup' : name, 'Last Name': rand() < 0.01 ? '  ' : dup ? `Fam${(family - 1) % 9000}` : last,
        Email: rand() < 0.2 ? '' : rand() < 0.02 ? 'not-an-email' : dup ? `dup${family - 1}@example.test` : `${last.toLowerCase()}${family}@example.test`,
        'Date of Birth': rand() < 0.15 ? '' : date(n), Status: pick(statuses), Phone: rand() < 0.5 ? '' : `555-${String(n % 10000).padStart(4, '0')}`,
        'Household Name': rand() < 0.5 ? '' : rand() < 0.05 ? `Other ${family}` : `${last} household`,
        'Billing Day': rand() < 0.6 ? '' : pick(['1', '15', '15', '28', '31', '32', 'x', '07']),
        'Email Opt Out': pick(['', '', 'Yes', 'no', 'TRUE', '0', 'maybe']), Tags: pick(tags),
        'Stripe Customer ID': customer && (k === 0 || rand() < 0.3) ? (rand() < 0.03 ? `cus_Other${n}` : customer) : rand() < 0.01 ? 'bad_customer' : '',
        'Stripe Payment Method ID': rand() < 0.2 ? (rand() < 0.1 ? `pm_Shared${n % 20}` : `pm_${n}`) : '',
        'Medical Notes': rand() < 0.02 ? 'Asthma' : '', Notes: 'n'.repeat(Math.floor(rand() * 40)),
      };
      lines.push(header.map((column) => cell(row[column]!)).join(','));
      // Existing members: two adjacent rows in every 200 have an earlier copy in the gym (about 1,000 seed rows for 100,000), each in
      // its own household unless they share one. Seeded customers and payment methods make the file's families conflict with them.
      const seedCustomer = n % 600 === 5 || n % 400 === 5 ? `cus_Seed${n}` : n % 400 === 205 ? customer : '';
      if ((n % 200 === 5 || n % 200 === 6) && row['First Name'] && row['Last Name']!.trim()) seed.push(header.slice(0, 15).map((column) => cell(
        column === 'Member ID' ? `S${n}` : column === 'Household External ID' ? (n % 400 === 5 ? `SH${family}` : '')
          : column === 'Stripe Customer ID' ? seedCustomer : column === 'Stripe Payment Method ID' ? (n % 600 === 5 ? `pm_Shared${n % 20}` : '')
            : column === 'Status' || column === 'Medical Notes' || column === 'Email Opt Out' || column === 'Tags' || column === 'Billing Day' || column === 'Household Name' ? ''
              : row[column]!)).join(','));
    }
    family++;
  }

  return { csv: lines.join('\r\n') + '\r\n', seed: seed.join('\n') + '\n' };
}
/** Seed rows accepted by the reference importer; every value is synthetic. */
export const seedMembers = new Set([
  6, 405, 406, 806, 1006, 1206, 1406, 1605, 1606, 1806, 2005, 2006, 2205, 2206, 2406, 2605,
  2606, 2806, 3205, 3206, 3406, 3606, 3805, 3806, 4005, 4206, 4605, 4606, 5005, 5006, 5206, 5606,
  5806, 6006, 6205, 6206, 6405, 6406, 6606, 6805, 6806, 7006, 7405, 7406, 7605, 7606, 7806, 8005,
  8006, 8205, 8206, 8406, 8606, 8805, 8806, 9205, 9206, 9406, 9806, 10005, 10006, 10206, 10405, 10406,
  10605, 10606, 10806, 11005, 11006, 11206, 11605, 11606, 11805, 11806, 12006, 12205, 12206, 12405, 12406, 12606,
  13005, 13006, 13405, 13406, 13606, 14006, 14205, 14206, 14406, 14605, 14606, 14805, 14806, 15006, 15205, 15206,
  15406, 15805, 15806, 16005, 16006, 16206, 16405, 16406, 16605, 16806, 17206, 17605, 17606, 17805, 17806, 18206,
  18405, 18606, 18805, 18806, 19005, 19006, 19206, 19405, 19406, 19606, 20005, 20006, 20205, 20206, 20406, 20605,
  20606, 20805, 21006, 21205, 21405, 21406, 21805, 21806, 22006, 22406, 22605, 22606, 22806, 23005, 23006, 23205,
  23206, 23406, 23605, 23606, 23805, 23806, 24205, 24206, 24405, 24406, 24606, 24805, 24806, 25005, 25206, 25605,
  25606, 26005, 26006, 26205, 26206, 26606, 26805, 26806, 27006, 27205, 27206, 27405, 27406, 27606, 27805, 27806,
  28005, 28006, 28405, 28406, 28605, 28806, 29005, 29006, 29205, 29406, 29605, 29805, 29806, 30205, 30206, 30806,
  31005, 31006, 31206, 31405, 31406, 31605, 31806, 32005, 32006, 32206, 32406, 32605, 32606, 32805, 32806, 33006,
  33205, 33206, 33405, 33606, 34005, 34405, 34406, 34606, 34806, 35006, 35205, 35206, 35406, 35605, 35606, 35805,
  35806, 36006, 36205, 36206, 36406, 36805, 36806, 37005, 37006, 37206, 37405, 37406, 37605, 37606, 37806, 38205,
  38206, 38605, 38606, 38806, 39206, 39405, 39606, 39805, 39806, 40005, 40006, 40206, 40405, 40406, 40605, 40606,
  41005, 41006, 41205, 41206, 41406, 41605, 41606, 41805, 42006, 42405, 42406, 42805, 42806, 43006, 43406, 43605,
  43606, 43806, 44005, 44006, 44205, 44206, 44406, 44605, 44606, 44806, 45205, 45206, 45405, 45406, 45606, 45806,
  46005, 46206, 46405, 46605, 46606, 47005, 47006, 47206, 47605, 47606, 47805, 47806, 48006, 48205, 48206, 48405,
  48606, 48805, 48806, 49006, 49405, 49406, 49605, 49606, 49806, 50005, 50006, 50205, 50406, 50805, 50806, 51205,
  51206, 51406, 51806, 52005, 52006, 52206, 52405, 52406, 52605, 52606, 53005, 53006, 53206, 53406, 53605, 53606,
  53805, 54006, 54205, 54206, 54405, 54606, 55005, 55006, 55405, 55406, 55605, 55606, 56006, 56205, 56206, 56406,
  56605, 56606, 56805, 56806, 57006, 57205, 57206, 57405, 57406, 57805, 57806, 58005, 58006, 58206, 58405, 58406,
  58605, 58806, 59005, 59205, 59206, 59605, 59806, 60206, 60405, 60406, 60606, 60805, 60806, 61005, 61006, 61206,
  61405, 61406, 61606, 62005, 62006, 62205, 62406, 62605, 62606, 62805, 63006, 63405, 63406, 63805, 63806, 64006,
  64406, 64605, 64606, 64806, 65005, 65006, 65205, 65206, 65406, 65605, 65606, 65806, 66006, 66205, 66206, 66405,
  66406, 66805, 66806, 67005, 67206, 67605, 67606, 68005, 68006, 68206, 68605, 68606, 68806, 69006, 69205, 69206,
  69405, 69406, 69606, 69805, 69806, 70006, 70405, 70605, 70606, 70806, 71005, 71006, 71205, 71406, 71805, 71806,
  72006, 72205, 72206, 72405, 72406, 72806, 73005, 73006, 73206, 73405, 73406, 73605, 73606, 73806, 74005, 74006,
  74206, 74605, 74606, 74805, 74806, 75006, 75205, 75206, 75405, 75606, 76005, 76006, 76405, 76406, 76606, 77006,
  77205, 77206, 77406, 77605, 77606, 77805, 77806, 78006, 78205, 78206, 78405, 78406, 78805, 78806, 79006, 79206,
  79405, 79406, 79605, 79806, 80205, 80206, 80605, 80606, 80806, 81206, 81405, 81406, 81606, 81805, 82006, 82206,
  82405, 82406, 82606, 83005, 83006, 83205, 83206, 83406, 83605, 83606, 83805, 83806, 84006, 84406, 84805, 84806,
  85006, 85406, 85605, 85606, 85806, 86005, 86006, 86205, 86406, 86605, 86606, 86806, 87205, 87206, 87405, 87406,
  87805, 87806, 88005, 88206, 88605, 88606, 89005, 89006, 89205, 89206, 89606, 89805, 89806, 90006, 90205, 90206,
  90405, 90406, 90606, 90805, 90806, 91005, 91006, 91405, 91406, 91605, 91606, 91806, 92005, 92006, 92605, 92805,
  92806, 93205, 93206, 93406, 93806, 94005, 94006, 94206, 94405, 94406, 94605, 94606, 94806, 95005, 95006, 95605,
  95805, 95806, 96006, 96205, 96206, 96405, 96806, 97005, 97006, 97405, 97406, 97606, 98006, 98205, 98406, 98605,
  98606, 98806, 99006, 99205, 99405, 99406, 99805, 99806,
]);
