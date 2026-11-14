// SPDX-License-Identifier: AGPL-3.0-only
// Aggregate payload queues by proxy leg without recording addresses or connection identifiers.
export function tcpQueues(tables) {
  const legs = { downstream: { sockets: 0, sendBytes: 0, receiveBytes: 0 }, upstream: { sockets: 0, sendBytes: 0, receiveBytes: 0 } };
  for (const line of tables.flatMap(table => table.trim().split('\n').slice(1))) {
    const fields = line.trim().split(/\s+/);
    if (fields[3] !== '01') continue; // established sockets only
    const local = Number.parseInt(fields[1].split(':').at(-1), 16);
    const remote = Number.parseInt(fields[2].split(':').at(-1), 16);
    const leg = local === 443 ? legs.downstream : remote === 3000 ? legs.upstream : null;
    if (!leg) continue;
    const [send, receive] = fields[4].split(':').map(value => Number.parseInt(value, 16));
    leg.sockets++; leg.sendBytes += send; leg.receiveBytes += receive;
  }
  return legs;
}
