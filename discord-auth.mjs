import crypto from 'node:crypto';

const AUTH_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const USER_URL = 'https://discord.com/api/v10/users/@me';
const TTL = 10 * 60 * 1000;
const b64hash = (value) => crypto.createHash('sha256').update(value).digest('base64url');
const safeText = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : fallback;

function validRedirect(value) {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))
      && !u.username && !u.password && u.pathname === '/api/auth/discord/callback' && !u.search && !u.hash;
  } catch { return false; }
}

export function createDiscordAuth({ db, discord = {}, cookieSecure, issueSession, passwordHash, verifySecret, authAttemptAllowed, resetAuthAttempt }) {
  const enabled = typeof discord.clientId === 'string' && !!discord.clientId.trim()
    && typeof discord.clientSecret === 'string' && !!discord.clientSecret
    && validRedirect(discord.redirectUri);
  const authorizeUrl = discord.authorizeUrl ?? AUTH_URL;
  const tokenUrl = discord.tokenUrl ?? TOKEN_URL;
  const userUrl = discord.userUrl ?? USER_URL;
  const fetcher = discord.fetch ?? globalThis.fetch;
  const states = new Map();
  const getAccount = db.prepare('SELECT discord_id, username, display_name FROM discord_accounts WHERE user_id = ?');
  const getByDiscord = db.prepare('SELECT u.id, u.name, d.user_id FROM discord_accounts d JOIN users u ON u.id=d.user_id WHERE d.discord_id = ?');
  const updateProfile = db.prepare('UPDATE discord_accounts SET username=?, display_name=? WHERE discord_id=?');
  const insertAccount = db.prepare('INSERT INTO discord_accounts (user_id, discord_id, username, display_name) VALUES (?, ?, ?, ?)');
  const userNorm = db.prepare('SELECT id FROM users WHERE name_norm=?');

  function cookie(value, maxAge) {
    return `discord_oauth=${value}; HttpOnly; Path=/api/auth/discord; SameSite=Lax; Max-Age=${maxAge}` + (cookieSecure ? '; Secure' : '');
  }
  function setCookie(res, value, maxAge) { res.setHeader('Set-Cookie', cookie(value, maxAge)); }
  function config(user) {
    if (!user) return { enabled, linked: false };
    const link = getAccount.get(user.id);
    return link ? { enabled, linked: true, username: link.username, displayName: link.display_name } : { enabled, linked: false };
  }
  function requireEnabled() {
    if (!enabled) { const e = new Error('Přihlášení přes Discord není nastavené.'); e.status = 503; throw e; }
  }
  async function start(req, res, body) {
    requireEnabled();
    const mode = body?.mode;
    if (mode !== 'login') { const e = new Error('Neplatný způsob přihlášení přes Discord.'); e.status=400; throw e; }
    const ip = req.socket.remoteAddress || '';
    if (!authAttemptAllowed(`discord|${ip}`)) { const e = new Error('Příliš mnoho pokusů. Zkuste to později.'); e.status=429; throw e; }
    if (typeof body?.clubPassword !== 'string' || !await verifySecret(body.clubPassword, passwordHash())) {
      const e = new Error('Neplatná klubová pozvánka.'); e.status=403; throw e;
    }
    resetAuthAttempt(`discord|${ip}`);
    for (const [key, value] of states) if (value.expires <= Date.now()) states.delete(key);
    if (states.size >= 1000) { const e = new Error('Příliš mnoho probíhajících přihlášení.'); e.status=429; throw e; }
    const state = crypto.randomBytes(32).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const binding = crypto.randomBytes(32).toString('base64url');
    states.set(b64hash(state), { verifier, bindingHash: b64hash(binding), expires: Date.now()+TTL });
    setCookie(res, binding, 600);
    const url = new URL(authorizeUrl);
    url.search = new URLSearchParams({ client_id: discord.clientId, response_type: 'code', redirect_uri: discord.redirectUri, scope: 'identify', state, code_challenge: b64hash(verifier), code_challenge_method: 'S256' }).toString();
    return { url: url.toString() };
  }
  function redirect(res, key) {
    res.writeHead(303, { Location: key === 'linked' ? '/?discord=linked' : `/?discord_error=${key}`, 'Set-Cookie': cookie('', 0) });
    res.end();
  }
  async function timedFetch(url, init) {
    return fetcher(url, { ...init, signal: AbortSignal.timeout(10000), redirect: 'error' });
  }
  async function callback(req, res, url) {
    if (!enabled) return redirect(res, 'disabled');
    const state = url.searchParams.get('state');
    const record = state && states.get(b64hash(state));
    if (state) states.delete(b64hash(state));
    const cookieValue = String(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('discord_oauth='))?.slice('discord_oauth='.length);
    if (!record || record.expires <= Date.now()) return redirect(res, 'expired');
    if (!cookieValue || b64hash(cookieValue) !== record.bindingHash) return redirect(res, 'failed');
    if (url.searchParams.has('error')) return redirect(res, 'cancelled');
    const issuer = url.searchParams.get('iss');
    if (issuer && issuer !== 'https://discord.com') return redirect(res, 'failed');
    const code = url.searchParams.get('code');
    if (!code || code.length > 2048) return redirect(res, 'failed');
    try {
      const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: discord.redirectUri, client_id: discord.clientId, client_secret: discord.clientSecret, code_verifier: record.verifier });
      const tokenRes = await timedFetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
      if (!tokenRes.ok) return redirect(res, 'failed');
      const tokenData = await tokenRes.json();
      if (typeof tokenData.access_token !== 'string' || !tokenData.access_token || tokenData.access_token.length > 4096) return redirect(res, 'failed');
      const profileRes = await timedFetch(userUrl, { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
      if (!profileRes.ok) return redirect(res, 'failed');
      const profile = await profileRes.json();
      if (typeof profile.id !== 'string' || !/^\d{5,30}$/.test(profile.id) || profile.bot === true
        || typeof profile.username !== 'string' || !profile.username.trim() || profile.username.length > 80
        || (profile.global_name != null && (typeof profile.global_name !== 'string' || profile.global_name.length > 80))) return redirect(res, 'failed');
      const username = safeText(profile.username, '');
      const displayName = safeText(profile.global_name, username);
      const linked = getByDiscord.get(profile.id);
      let appUser;
      if (linked) {
        appUser = { id: linked.id, name: linked.name };
        updateProfile.run(username, displayName, profile.id);
      } else {
        let name = displayName;
        let norm = name.toLowerCase();
        if (userNorm.get(norm)) { name = `${displayName} (@${username})`.slice(0,80); norm=name.toLowerCase(); }
        if (userNorm.get(norm)) { name = `${name.slice(0, 66)} ${profile.id.slice(-12)}`; norm=name.toLowerCase(); }
        const id = crypto.randomUUID();
        db.exec('BEGIN');
        try {
          db.prepare('INSERT INTO users (id,name,name_norm,pin_hash,created_at) VALUES (?,?,?,?,?)').run(id,name,norm,'discord-only',Date.now());
          insertAccount.run(id,profile.id,username,displayName);
          db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); if (/unique/i.test(err.message)) return redirect(res,'already_linked'); throw err; }
        appUser={id,name};
      }
      issueSession(res, appUser);
      // Keep both independent HttpOnly cookies.
      const sidCookie = res.getHeader('Set-Cookie');
      res.setHeader('Set-Cookie', [cookie('',0), sidCookie]);
      res.writeHead(303, { Location: '/?discord=linked' }); res.end();
    } catch { redirect(res, 'failed'); }
  }
  return { config, start, callback };
}
