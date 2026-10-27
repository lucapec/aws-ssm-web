'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { runAws } = require('./aws');

// IdP-initiated sign-in URL of the AWS SAML app in your identity provider
// (Entra ID, Okta, Keycloak, Google Workspace, ...). See README.
const SSO_LOGIN_URL = process.env.SSO_LOGIN_URL || '';

// Optional { "<account id>": "<friendly name>" } map, only used to show
// readable names in the role picker. Not committed (see
// accounts-map.example.json).
const ACCOUNTS_MAP_FILE = process.env.ACCOUNTS_MAP_FILE || path.join(__dirname, 'accounts-map.json');
let ACCOUNTS_MAP = {};
try {
  ACCOUNTS_MAP = JSON.parse(fs.readFileSync(ACCOUNTS_MAP_FILE, 'utf8'));
} catch {
  /* optional */
}

// In-memory only: nothing written to disk. One global session since this
// tool is single-user/localhost-only. roleCreds are cached per-ARN until
// they expire (assume-role-with-saml creds, ~1h by default).
const state = {
  session: null, // { samlAssertion: base64, roles: [...], loggedInAt }
  roleCreds: new Map(), // arn -> { AccessKeyId, SecretAccessKey, SessionToken, Expiration }
};

// Most IdPs put MFA, conditional access and/or federation in front of the
// SAML app, so there is no username/password form we could post to.
// Instead we drive a real Chromium via playwright-core (the system browser,
// nothing downloaded): open the IdP-initiated sign-in URL, let the user do
// their normal login + MFA in that window, and intercept the SAMLResponse
// POST before it reaches AWS, so we can exchange it for STS credentials
// ourselves via sts:assume-role-with-saml instead of letting the browser
// land on the AWS console.
const AWS_ACS_URL = 'https://signin.aws.amazon.com/saml';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

function parseRolesFromSaml(xml) {
  const attrBlock = xml.match(
    /<(?:[\w-]+:)?Attribute\s+[^>]*Name="https:\/\/aws\.amazon\.com\/SAML\/Attributes\/Role"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Attribute>/
  );
  const block = attrBlock ? attrBlock[1] : xml;
  const valueRe = /<(?:[\w-]+:)?AttributeValue\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?AttributeValue>/g;
  const roles = [];
  let m;
  while ((m = valueRe.exec(block))) {
    const parts = m[1].trim().split(',').map((s) => s.trim());
    const arn = parts.find((p) => /:role\//.test(p));
    const principalArn = parts.find((p) => /:saml-provider\//.test(p));
    if (!arn || !principalArn) continue;
    const accountId = (arn.match(/::(\d+):/) || [])[1];
    const roleName = arn.split('/').slice(1).join('/');
    roles.push({ arn, principalArn, accountId, roleName, accountName: ACCOUNTS_MAP[accountId] || null });
  }
  roles.sort((a, b) => (a.accountName || a.accountId).localeCompare(b.accountName || b.accountId));
  return roles;
}

// We deliberately do NOT use the user's real browser profile. Tried it
// (launchPersistentContext on ~/.config/microsoft-edge) and it went wrong
// for two fundamental reasons:
//   1. launchPersistentContext exposes a single context for the whole
//      browser - there is no "close our tab", context.close() closes the
//      ENTIRE window with everything the user had open.
//   2. Playwright launches the browser with flags meant for throwaway
//      testing (--disable-extensions, --disable-sync,
//      --password-store=basic with a fake keychain, etc.) - applied to the
//      user's real profile, that changes their actual browser while the
//      session lasts.
// The fix is a DEDICATED profile owned by this tool that never touches the
// user's real browser: no locks to fight (runs alongside their normal
// browser), nothing of theirs to close by mistake, and automation flags
// affect nothing real. The only cost is that the first login is a full IdP
// login (MFA included); cookies persist in this dedicated profile between
// runs, so later logins can go straight through while that session lives.
const AUTOMATION_PROFILE_DIR = process.env.SSO_BROWSER_USER_DATA_DIR || path.join(__dirname, '.browser-profile');

const BROWSER_PATHS = [
  process.env.SSO_BROWSER_PATH,
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

function findBrowser() {
  return BROWSER_PATHS.find((p) => fs.existsSync(p)) || null;
}

// A second click on "Sign in" while the browser is still open would launch
// another browser on the same profile and fail on its lock, so concurrent
// callers share the login in progress.
let loginInFlight = null;

function login() {
  if (!loginInFlight) {
    loginInFlight = doLogin().finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

async function doLogin() {
  if (!SSO_LOGIN_URL) {
    throw new Error(
      'SSO is not configured: set SSO_LOGIN_URL to the IdP-initiated sign-in URL of your AWS SAML app (see README).'
    );
  }
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error('No Chromium-based browser found (Edge/Chrome/Chromium). Set SSO_BROWSER_PATH.');
  }

  fs.mkdirSync(AUTOMATION_PROFILE_DIR, { recursive: true });

  let context;
  try {
    context = await chromium.launchPersistentContext(AUTOMATION_PROFILE_DIR, {
      executablePath: browserPath,
      headless: false,
    });
  } catch (err) {
    throw new Error(`Could not open the browser for the login: ${err.message}`);
  }

  let resolveAssertion;
  let rejectAssertion;
  const assertionPromise = new Promise((resolve, reject) => {
    resolveAssertion = resolve;
    rejectAssertion = reject;
  });

  let settled = false;
  const settle = (fn, val) => {
    if (settled) return;
    settled = true;
    fn(val);
  };

  context.on('close', () => {
    settle(rejectAssertion, new Error('The browser was closed before the login completed.'));
  });

  const timeout = setTimeout(() => {
    settle(rejectAssertion, new Error('Timed out waiting for the login (5 min).'));
  }, LOGIN_TIMEOUT_MS);

  try {
    await context.route(AWS_ACS_URL, async (route) => {
      const postData = route.request().postData() || '';
      const samlResponse = new URLSearchParams(postData).get('SAMLResponse');
      if (samlResponse) settle(resolveAssertion, samlResponse);
      await route.continue();
    });

    // Always a new tab - the profile may restore a previous session with
    // other tabs already open, and we don't want to clobber any of them.
    const page = await context.newPage();
    // Errors on this initial navigation are ignored: the real flow goes
    // through several cross-domain redirects (IdP -> upstream IdP -> IdP ->
    // AWS) and Playwright may report the first one as aborted; what matters
    // is the interception above, which has its own timeout.
    await page.goto(SSO_LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

    const samlResponseB64 = await assertionPromise;
    clearTimeout(timeout);

    const xml = Buffer.from(samlResponseB64, 'base64').toString('utf8');
    const roles = parseRolesFromSaml(xml);
    if (roles.length === 0) {
      throw new Error('Login OK, but the SAML assertion has no AWS roles for this user.');
    }

    state.roleCreds.clear();
    state.session = { samlAssertion: samlResponseB64, roles, loggedInAt: Date.now() };
    return roles;
  } finally {
    clearTimeout(timeout);
    // Always close the browser we launched, success or not: if left open,
    // the NEXT login would collide with the same profile lock.
    context.close().catch(() => {});
  }
}

function logout() {
  state.session = null;
  state.roleCreds.clear();
}

function currentRoles() {
  return state.session ? state.session.roles : null;
}

async function assumeRole(arn) {
  if (!state.session) {
    throw new Error('No active SSO session, sign in again.');
  }
  const cached = state.roleCreds.get(arn);
  if (cached && new Date(cached.Expiration).getTime() - Date.now() > 60_000) {
    return cached;
  }
  const role = state.session.roles.find((r) => r.arn === arn);
  if (!role) {
    throw new Error('That role ARN is not part of the current SSO session.');
  }

  let stdout;
  try {
    stdout = await runAws([
      'sts',
      'assume-role-with-saml',
      '--role-arn',
      role.arn,
      '--principal-arn',
      role.principalArn,
      '--saml-assertion',
      state.session.samlAssertion,
      '--output',
      'json',
    ]);
  } catch (err) {
    throw new Error(
      `Could not assume the role (the cached SAML assertion may have expired, try signing in again): ${err.message}`
    );
  }

  const parsed = JSON.parse(stdout);
  const creds = {
    AccessKeyId: parsed.Credentials.AccessKeyId,
    SecretAccessKey: parsed.Credentials.SecretAccessKey,
    SessionToken: parsed.Credentials.SessionToken,
    Expiration: parsed.Credentials.Expiration,
  };
  state.roleCreds.set(arn, creds);
  return creds;
}

module.exports = { login, logout, currentRoles, assumeRole };
