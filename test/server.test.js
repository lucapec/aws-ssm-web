'use strict';

// Integration tests: run the real server against a fake `aws` binary on PATH
// and a throwaway HOME, so no AWS account or session-manager-plugin is needed.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const TUNNEL_MIN = 25100;
const TUNNEL_MAX = 25103;

const FAKE_AWS = `#!/bin/sh
case "$*" in
  *"ec2 describe-instances"*)
    echo '{"Reservations":[{"Instances":[{"InstanceId":"i-0abc","State":{"Name":"running"},"InstanceType":"t3.micro","Tags":[{"Key":"Name","Value":"web"}]}]}]}'
    ;;
  *"ssm describe-instance-information"*)
    echo '[["i-0abc","Online"]]'
    ;;
  *"--target i-0dead"*)
    echo "TargetNotConnected" >&2
    exit 254
    ;;
  *"start-session"*"--document-name"*)
    echo "Waiting for connections..."
    exec sleep 300
    ;;
  *"start-session"*)
    echo ready
    while read -r line; do echo "size=$(stty size)"; done
    ;;
  *)
    echo "unexpected: $*" >&2
    exit 1
    ;;
esac
`;

let tmp;
let server;
let port;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(data ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sameOrigin = () => ({ origin: `http://127.0.0.1:${port}` });

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-ssm-web-test-'));
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'aws'), FAKE_AWS, { mode: 0o755 });
  fs.mkdirSync(path.join(tmp, 'home', '.aws'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'home', '.aws', 'config'), '[default]\n[profile prod]\nregion = eu-west-1\n');
  fs.writeFileSync(path.join(tmp, 'home', '.aws', 'credentials'), '[legacy]\n');

  port = await freePort();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: path.join(tmp, 'home'),
      PATH: `${path.join(tmp, 'bin')}:${process.env.PATH}`,
      PORT: String(port),
      HOST: '127.0.0.1',
      TUNNEL_PORT_RANGE: `${TUNNEL_MIN}-${TUNNEL_MAX}`,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => /listening/.test(String(d)) && resolve());
    server.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});

after(() => {
  if (server) server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- host / origin checks -------------------------------------------------

test('serves the app and xterm from node_modules, no CDN', async () => {
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /vendor\/xterm\/lib\/xterm\.js/);
  assert.doesNotMatch(page.text, /cdn\.jsdelivr|unpkg|cdnjs/);
  for (const p of ['/vendor/xterm/lib/xterm.js', '/vendor/xterm/css/xterm.css', '/vendor/xterm-addon-fit/lib/addon-fit.js']) {
    assert.equal((await request('GET', p)).status, 200, p);
  }
});

test('rejects a foreign Host header (DNS rebinding), even without Origin', async () => {
  const res = await request('GET', '/api/profiles', { headers: { host: `evil.example:${port}` } });
  assert.equal(res.status, 403);
  assert.equal((await request('GET', '/api/profiles', { headers: { host: `localhost:${port}` } })).status, 200);
});

test('rejects a foreign Origin', async () => {
  const res = await request('GET', '/api/profiles', { headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

// ---- profiles / instances ---------------------------------------------------

test('lists profiles from config and credentials', async () => {
  const res = await request('GET', '/api/profiles');
  assert.deepEqual(res.json.profiles, ['default', 'legacy', 'prod']);
});

test('lists instances with SSM status', async () => {
  const res = await request('GET', '/api/instances?profile=prod&region=eu-west-1');
  assert.equal(res.status, 200);
  assert.equal(res.json.instances.length, 1);
  assert.equal(res.json.instances[0].name, 'web');
  assert.equal(res.json.instances[0].ssm, 'Online');
});

test('validates region and profile', async () => {
  assert.equal((await request('GET', '/api/instances?profile=prod&region=EU;rm')).status, 400);
  assert.equal((await request('GET', '/api/instances?profile=a%20b&region=eu-west-1')).status, 502);
});

// ---- websocket terminal -----------------------------------------------------

function openWs(headers) {
  return new WebSocket(`ws://127.0.0.1:${port}/ws/ssm?profile=prod&region=eu-west-1&instanceId=i-0abc`, { headers });
}

test('websocket rejects foreign Origin and Host', async () => {
  for (const headers of [{ origin: 'https://evil.example' }, { host: `evil.example:${port}` }]) {
    const ws = openWs(headers);
    const err = await new Promise((resolve) => ws.on('error', resolve).on('open', () => resolve(null)));
    assert.ok(err, `expected rejection for ${JSON.stringify(headers)}`);
  }
});

test('websocket applies the resize sent on open and survives malformed messages', async () => {
  const ws = openWs(sameOrigin());
  let out = '';
  ws.on('message', (d) => (out += d));
  await new Promise((resolve, reject) => ws.on('open', resolve).on('error', reject));
  // sent immediately, like the browser does: must not be dropped
  ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
  ws.send('null');
  ws.send(JSON.stringify({ type: 'resize', cols: 'x', rows: -1 }));
  ws.send(JSON.stringify({ type: 'resize', cols: 1e9, rows: 1e9 }));
  ws.send(JSON.stringify({ type: 'input', data: 42 }));
  await waitFor(() => out.includes('ready'));
  ws.send(JSON.stringify({ type: 'input', data: 'x\r' }));
  await waitFor(() => /size=40 120/.test(out));
  ws.close();
  assert.equal((await request('GET', '/api/profiles')).status, 200, 'server still up');
});

// ---- tunnels ----------------------------------------------------------------

async function createTunnel(body) {
  return request('POST', '/api/tunnels', {
    headers: sameOrigin(),
    body: { profile: 'prod', region: 'eu-west-1', remotePort: 5432, ...body },
  });
}

async function tunnelById(id) {
  const res = await request('GET', '/api/tunnels');
  return res.json.tunnels.find((t) => t.id === id);
}

test('tunnels skip ports taken by other processes and reuse ports of closed tunnels', async () => {
  // something else on the machine already holds the first port of the range
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(TUNNEL_MIN, '127.0.0.1', r));
  const ids = [];
  try {
    const ok = await createTunnel({ instanceId: 'i-0abc' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.tunnel.localPort, TUNNEL_MIN + 1);
    ids.push(ok.json.tunnel.id);
    await waitFor(async () => (await tunnelById(ok.json.tunnel.id)).status === 'open');

    const dead = await createTunnel({ instanceId: 'i-0dead' });
    assert.equal(dead.status, 200, dead.text);
    assert.equal(dead.json.tunnel.localPort, TUNNEL_MIN + 2);
    ids.push(dead.json.tunnel.id);
    const closed = await waitFor(async () => {
      const t = await tunnelById(dead.json.tunnel.id);
      return t.status === 'closed' && t;
    });
    assert.match(closed.error, /TargetNotConnected/);

    // the closed tunnel is still listed, but its port is free again
    const again = await createTunnel({ instanceId: 'i-0abc' });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.tunnel.localPort, TUNNEL_MIN + 2);
    ids.push(again.json.tunnel.id);

    // an explicit port held by another process gives a clear error
    const busy = await createTunnel({ instanceId: 'i-0abc', localPort: TUNNEL_MIN });
    assert.equal(busy.status, 400);
    assert.match(busy.json.error, /already in use/);

    const taken = await createTunnel({ instanceId: 'i-0abc', localPort: TUNNEL_MIN + 1 });
    assert.equal(taken.status, 400);
    assert.match(taken.json.error, /another tunnel/);
  } finally {
    squatter.close();
    for (const id of ids) await request('DELETE', `/api/tunnels/${id}`, { headers: sameOrigin() });
  }
});
