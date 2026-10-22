// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Socket } from 'node:net';

/** Local SMTP capture fixture; never delivers outside this process. */
export async function captureSmtp(auth?: { user: string; pass: string }) {
  const sockets = new Set<Socket>();
  const messages: string[] = [];
  const commands: string[] = [];
  let connections = 0;
  let rejectRecipient = false;
  let rejectData = false;
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.write('220 capture.example.test ESMTP\r\n');
    let buffer = '';
    let data: string[] | undefined;
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\r\n'); newline >= 0; newline = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        if (data) {
          if (line !== '.') { data.push(line.replace(/^\.\./, '.')); continue; }
          if (!rejectData) messages.push(data.join('\r\n'));
          data = undefined;
          socket.write(rejectData ? '451 temporary failure\r\n' : '250 queued\r\n');
          continue;
        }
        const command = line.split(' ')[0]?.toUpperCase();
        commands.push(command ?? '');
        if (command === 'EHLO') socket.write('250-capture.example.test\r\n' +
          (auth ? '250-AUTH PLAIN\r\n' : '') + '250 SIZE 1000000\r\n');
        else if (command === 'AUTH') {
          const credentials = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString();
          socket.write(auth && credentials === `\0${auth.user}\0${auth.pass}`
            ? '235 authenticated\r\n' : '535 authentication failed\r\n');
        } else if (command === 'MAIL') socket.write('250 sender ok\r\n');
        else if (command === 'RCPT') socket.write(rejectRecipient ? '550 rejected\r\n' : '250 recipient ok\r\n');
        else if (command === 'DATA') { data = []; socket.write('354 send data\r\n'); }
        else if (command === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('500 unsupported\r\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP fixture did not bind');
  return {
    port: address.port, messages, commands,
    get connections() { return connections; },
    rejectRecipient(value: boolean) { rejectRecipient = value; },
    rejectData(value: boolean) { rejectData = value; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
