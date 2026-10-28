'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { spawn: spawnProc } = require('child_process');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { runAws } = require('./aws');
const sso = require('./sso');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || 4177;
const DEFAULT_REGION = 'us-east-1';

const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);

// Local tool, no auth of its own - the only thing standing between an
// arbitrary website open in the same browser and these endpoints (which can
// list infra / open SSM sessions / use cached SSO creds) is checking that
// the request actually originated from this app's own page, not some other
// tab doing a cross-origin fetch() against localhost.
function isAllowedOrigin(origin) {
  return !origin || ALLOWED_ORIGINS.has(origin);
}

// Browsers don't send Origin on same-origin GETs, so the check above alone
// doesn't stop DNS rebinding (evil.example re-resolving to 127.0.0.1 and
// reading /api/* as "same origin"). The Host header still says
// evil.example in that case, so only accept our own.
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function isAllowedHost(host) {
  return ALLOWED_HOSTS.has(String(host || '').toLowerCase());
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host)) {
    return res.status(403).json({ error: 'Host not allowed' });
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
// xterm is served from node_modules rather than a CDN: this page drives
// shells with live credentials, so no third-party script should run in it.
app.use('/vendor/xterm', express.static(path.join(__dirname, 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, 'node_modules', '@xterm', 'addon-fit')));

// ---- profile discovery -----------------------------------------------

function parseProfileNames(filePath, stripPrefix) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const names = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*\[(.+?)\]\s*$/);
    if (!m) continue;
    let name = m[1].trim();
    if (stripPrefix && name.startsWith('profile ')) {
      name = name.slice('profile '.length).trim();
    }
    names.push(name);
  }
  return names;
}

function listProfiles() {
  const home = os.homedir();
  const fromConfig = parseProfileNames(path.join(home, '.aws', 'config'), true);
  const fromCreds = parseProfileNames(path.join(home, '.aws', 'credentials'), false);
  const set = new Set([...fromConfig, ...fromCreds]);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

app.get('/api/profiles', (req, res) => {
  try {
    res.json({ profiles: listProfiles() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---- SSO (IdP SAML -> assume-role-with-saml) ----------------------------

app.post('/api/sso/login', async (req, res) => {
  try {
    // Blocks until the user finishes the login (IdP + MFA) in the browser
    // window it opens; no credentials ever pass through here.
    const roles = await sso.login();
    res.json({ roles });
  } catch (err) {
    res.status(401).json({ error: String(err.message || err) });
  }
});

app.post('/api/sso/logout', (req, res) => {
  sso.logout();
  res.json({ ok: true });
});

app.get('/api/sso/roles', (req, res) => {
  const roles = sso.currentRoles();
  if (!roles) return res.status(401).json({ error: 'No active SSO session' });
  res.json({ roles });
});

// ---- instance listing ---------------------------------------------------

const PROFILE_RE = /^[A-Za-z0-9_.@-]+$/;
const REGION_RE = /^[a-z0-9-]+$/;
const ROLE_ARN_RE = /^arn:aws:iam::\d+:role\/\S+$/;

function stsCredsToEnv(creds) {
  return {
    AWS_ACCESS_KEY_ID: creds.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
    AWS_SESSION_TOKEN: creds.SessionToken,
  };
}

// Resolves either a local --profile or an SSO role ARN (assumed via
// sts:assume-role-with-saml, see sso.js) into { authArgs, authEnv } to
// splice into an aws-cli invocation.
async function resolveAuth(query) {
  const roleArn = String(query.roleArn || '');
  if (roleArn) {
    if (!ROLE_ARN_RE.test(roleArn)) throw new Error('Invalid role ARN');
    const creds = await sso.assumeRole(roleArn);
    return { authArgs: [], authEnv: stsCredsToEnv(creds) };
  }
  const profile = String(query.profile || '');
  if (!PROFILE_RE.test(profile)) throw new Error('Invalid profile name');
  return { authArgs: ['--profile', profile], authEnv: {} };
}

app.get('/api/instances', async (req, res) => {
  const region = String(req.query.region || DEFAULT_REGION);
  if (!REGION_RE.test(region)) {
    return res.status(400).json({ error: 'Invalid region' });
  }

  try {
    const { authArgs, authEnv } = await resolveAuth(req.query);
    // In parallel: SSM agent status. If it fails (e.g. no
    // ssm:DescribeInstanceInformation permission) we still return the instances.
    const [out, ssmStatus] = await Promise.all([
      runAws(['ec2', 'describe-instances', ...authArgs, '--region', region, '--output', 'json'], authEnv),
      runAws(
        ['ssm', 'describe-instance-information', ...authArgs, '--region', region, '--output', 'json',
          '--query', 'InstanceInformationList[].[InstanceId,PingStatus]'],
        authEnv
      ).then((o) => new Map(JSON.parse(o) || []), () => null),
    ]);
    const data = JSON.parse(out);
    const instances = [];
    for (const reservation of data.Reservations || []) {
      for (const inst of reservation.Instances || []) {
        const nameTag = (inst.Tags || []).find((t) => t.Key === 'Name');
        const asgTag = (inst.Tags || []).find(
          (t) => t.Key === 'aws:autoscaling:groupName'
        );
        instances.push({
          id: inst.InstanceId,
          name: nameTag ? nameTag.Value : '',
          state: inst.State ? inst.State.Name : '',
          type: inst.InstanceType,
          az: inst.Placement ? inst.Placement.AvailabilityZone : '',
          privateIp: inst.PrivateIpAddress || '',
          asg: asgTag ? asgTag.Value : '',
          platform: inst.PlatformDetails || '',
          // 'Online' | 'ConnectionLost' | 'Inactive' | 'NotRegistered', or null if it couldn't be queried
          ssm: ssmStatus ? ssmStatus.get(inst.InstanceId) || 'NotRegistered' : null,
        });
      }
    }
    instances.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    res.json({ instances });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---- instance power actions ---------------------------------------------

const INSTANCE_ID_RE = /^i-[a-f0-9]+$/;
const INSTANCE_ACTIONS = {
  start: { cmd: 'start-instances', key: 'StartingInstances' },
  stop: { cmd: 'stop-instances', key: 'StoppingInstances' },
  reboot: { cmd: 'reboot-instances', key: null }, // reboot returns no state
};

// POST (not GET) on purpose: together with the Origin check, another tab
// can't trigger this with an <img src> or a link.
app.post('/api/instances/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const spec = INSTANCE_ACTIONS[action];
  const body = req.body || {};
  const region = String(body.region || DEFAULT_REGION);
  if (!spec) return res.status(400).json({ error: 'Invalid action' });
  if (!INSTANCE_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid instance id' });
  if (!REGION_RE.test(region)) return res.status(400).json({ error: 'Invalid region' });

  try {
    const { authArgs, authEnv } = await resolveAuth(body);
    const out = await runAws(
      ['ec2', spec.cmd, ...authArgs, '--region', region, '--instance-ids', id, '--output', 'json'],
      authEnv
    );
    let state = null;
    if (spec.key && out.trim()) {
      const changes = JSON.parse(out)[spec.key] || [];
      state = changes[0] && changes[0].CurrentState ? changes[0].CurrentState.Name : null;
    }
    res.json({ ok: true, state });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---- port forwarding (SSM tunnels) --------------------------------------
//
// session-manager-plugin always binds the local port on 127.0.0.1, which
// can't be published to the host from inside Docker. So the plugin listens on
// an ephemeral internal port and we expose the requested port on HOST with a
// TCP proxy: works the same on the host (HOST=127.0.0.1) and in the container
// (HOST=0.0.0.0, published only on 127.0.0.1 by docker-compose).

const [TUNNEL_PORT_MIN, TUNNEL_PORT_MAX] = (process.env.TUNNEL_PORT_RANGE || '15000-15099')
  .split('-')
  .map(Number);
const REMOTE_HOST_RE = /^[A-Za-z0-9.-]{1,253}$/;
const tunnels = new Map(); // id -> tunnel

function isPort(n) {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function freeInternalPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function listenProxy(localPort, internalPort) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      const upstream = net.connect(internalPort, '127.0.0.1');
      sock.pipe(upstream).pipe(sock);
      const destroy = () => {
        sock.destroy();
        upstream.destroy();
      };
      sock.on('error', destroy);
      upstream.on('error', destroy);
    });
    srv.once('error', reject);
    srv.listen(localPort, HOST, () => resolve(srv));
  });
}

// Closed tunnels stay listed (so their error can be shown) until removed,
// but their port is free again.
function livePorts() {
  return new Set([...tunnels.values()].filter((t) => t.status !== 'closed').map((t) => t.localPort));
}

// Binds the proxy on the requested port, or on the first port of the range
// that isn't taken by one of our tunnels nor by any other process.
async function openProxy(requestedPort, internalPort) {
  if (requestedPort) {
    try {
      return { server: await listenProxy(requestedPort, internalPort), localPort: requestedPort };
    } catch (err) {
      if (err.code === 'EADDRINUSE') throw new Error(`Local port ${requestedPort} is already in use`);
      throw err;
    }
  }
  const used = livePorts();
  for (let p = TUNNEL_PORT_MIN; p <= TUNNEL_PORT_MAX; p++) {
    if (used.has(p)) continue;
    try {
      return { server: await listenProxy(p, internalPort), localPort: p };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`No free ports in ${TUNNEL_PORT_MIN}-${TUNNEL_PORT_MAX}`);
}

function publicTunnel(t) {
  const { child, server, ...rest } = t;
  return rest;
}

// aws runs session-manager-plugin as a child: kill the whole process group
// (spawned detached) so the plugin isn't left orphaned holding the port.
function closeTunnel(t) {
  try { process.kill(-t.child.pid, 'SIGTERM'); } catch { /* already dead */ }
  try { t.server.close(); } catch { /* already closed */ }
}

app.get('/api/tunnels', (req, res) => {
  res.json({
    tunnels: [...tunnels.values()].map(publicTunnel),
    portRange: [TUNNEL_PORT_MIN, TUNNEL_PORT_MAX],
  });
});

app.post('/api/tunnels', async (req, res) => {
  const body = req.body || {};
  const region = String(body.region || DEFAULT_REGION);
  const instanceId = String(body.instanceId || '');
  const remotePort = Number(body.remotePort);
  const remoteHost = String(body.remoteHost || '').trim();
  if (!REGION_RE.test(region)) return res.status(400).json({ error: 'Invalid region' });
  if (!INSTANCE_ID_RE.test(instanceId)) return res.status(400).json({ error: 'Invalid instance id' });
  if (!isPort(remotePort)) return res.status(400).json({ error: 'Invalid remote port' });
  if (remoteHost && !REMOTE_HOST_RE.test(remoteHost)) return res.status(400).json({ error: 'Invalid remote host' });

  let server;
  try {
    const requestedPort = body.localPort ? Number(body.localPort) : null;
    if (requestedPort !== null && (!isPort(requestedPort) || requestedPort < TUNNEL_PORT_MIN || requestedPort > TUNNEL_PORT_MAX)) {
      throw new Error(`The local port must be in ${TUNNEL_PORT_MIN}-${TUNNEL_PORT_MAX}`);
    }
    if (requestedPort !== null && livePorts().has(requestedPort)) {
      throw new Error(`Local port ${requestedPort} is already used by another tunnel`);
    }
    const { authArgs, authEnv } = await resolveAuth(body);
    const internalPort = await freeInternalPort();
    let localPort;
    ({ server, localPort } = await openProxy(requestedPort, internalPort));

    const params = remoteHost
      ? { host: [remoteHost], portNumber: [String(remotePort)], localPortNumber: [String(internalPort)] }
      : { portNumber: [String(remotePort)], localPortNumber: [String(internalPort)] };
    const child = spawnProc(
      'aws',
      ['ssm', 'start-session', ...authArgs, '--region', region, '--target', instanceId,
        '--document-name', remoteHost ? 'AWS-StartPortForwardingSessionToRemoteHost' : 'AWS-StartPortForwardingSession',
        '--parameters', JSON.stringify(params)],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...authEnv }, detached: true }
    );

    const t = {
      id: crypto.randomUUID(),
      instanceId,
      instanceName: String(body.instanceName || '').slice(0, 200),
      region,
      remoteHost,
      remotePort,
      localPort,
      status: 'starting', // starting | open | closed
      error: '',
      createdAt: new Date().toISOString(),
      child,
      server,
    };
    tunnels.set(t.id, t);

    let stderr = '';
    child.stdout.on('data', (d) => {
      if (/Waiting for connections/i.test(String(d))) t.status = 'open';
    });
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.on('error', (err) => (t.error = err.message));
    child.on('close', (code) => {
      t.status = 'closed';
      if (code && !t.error) t.error = stderr.trim() || `aws exited with code ${code}`;
      try { server.close(); } catch { /* already closed */ }
    });

    res.json({ tunnel: publicTunnel(t) });
  } catch (err) {
    if (server) server.close();
    res.status(400).json({ error: String(err.message || err) });
  }
});

app.delete('/api/tunnels/:id', (req, res) => {
  const t = tunnels.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Tunnel not found' });
  closeTunnel(t);
  tunnels.delete(t.id);
  res.json({ ok: true });
});

// In the container we are PID 1: without this 'docker stop' waits 10s and
// the aws/session-manager-plugin children are never closed.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const t of tunnels.values()) closeTunnel(t);
    process.exit(0);
  });
}

// ---- SSM session over websocket -----------------------------------------

const server = app.listen(PORT, HOST, () => {
  console.log(`aws-ssm-web listening on http://${HOST}:${PORT}`);
});

const wss = new WebSocketServer({
  server,
  path: '/ws/ssm',
  verifyClient: (info) => isAllowedHost(info.req.headers.host) && isAllowedOrigin(info.origin),
});

function isTermSize(n) {
  return Number.isInteger(n) && n >= 1 && n <= 1000;
}

function handleTerminalMessage(shell, msg) {
  let parsed;
  try {
    parsed = JSON.parse(msg.toString());
  } catch {
    parsed = { type: 'input', data: msg.toString() };
  }
  if (!parsed || typeof parsed !== 'object') return;
  // node-pty throws once the process has exited; an exception escaping a
  // ws event handler would take the whole server down.
  try {
    if (parsed.type === 'resize' && isTermSize(parsed.cols) && isTermSize(parsed.rows)) {
      shell.resize(parsed.cols, parsed.rows);
    } else if (parsed.type === 'input' && typeof parsed.data === 'string') {
      shell.write(parsed.data);
    }
  } catch {
    /* already dead */
  }
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${HOST}`);
  const roleArn = url.searchParams.get('roleArn') || '';
  const profile = url.searchParams.get('profile') || '';
  const region = url.searchParams.get('region') || DEFAULT_REGION;
  const instanceId = url.searchParams.get('instanceId') || '';

  // Listen before the auth below, which can take a while for an SSO role
  // (sts:assume-role-with-saml): the client sends its real size as soon as
  // the socket opens, and that message must not be lost.
  let shell = null;
  let closed = false;
  const pending = [];
  ws.on('message', (msg) => (shell ? handleTerminalMessage(shell, msg) : pending.push(msg)));
  ws.on('close', () => {
    closed = true;
    try {
      if (shell) shell.kill();
    } catch {
      /* already dead */
    }
  });

  if (!REGION_RE.test(region) || !INSTANCE_ID_RE.test(instanceId)) {
    ws.send('\r\n\x1b[31mInvalid parameters.\x1b[0m\r\n');
    ws.close();
    return;
  }

  let authArgs;
  let authEnv;
  try {
    ({ authArgs, authEnv } = await resolveAuth({ roleArn, profile }));
  } catch (err) {
    ws.send(`\r\n\x1b[31m${String(err.message || err)}\x1b[0m\r\n`);
    ws.close();
    return;
  }
  if (closed) return;

  const args = ['ssm', 'start-session', ...authArgs, '--region', region, '--target', instanceId];

  shell = pty.spawn('aws', args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: os.homedir(),
    env: { ...process.env, ...authEnv },
  });

  shell.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  shell.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(`\r\n\x1b[33m[session ended, exit code ${exitCode}]\x1b[0m\r\n`);
      ws.close();
    }
  });

  for (const msg of pending.splice(0)) handleTerminalMessage(shell, msg);
});
