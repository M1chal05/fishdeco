// Local test double for Discord. This file is used only by verification scripts.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

export function createDiscordFixture() {
  const codes = new Map();
  const tokens = new Map();
  const config = {
    clientId: '123456789012345678',
    clientSecret: 'fixture-client-secret-only',
    redirectUri: 'http://127.0.0.1:3000/api/auth/discord/callback',
    authorizeUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://test-discord.invalid/token',
    userUrl: 'https://test-discord.invalid/users/@me',
    async fetch(input, init = {}) {
      const url = String(input);
      if (url === config.tokenUrl) {
        const form = new URLSearchParams(init.body);
        assert.equal(form.get('client_id'), config.clientId);
        assert.equal(form.get('client_secret'), config.clientSecret);
        assert.equal(form.get('redirect_uri'), config.redirectUri);
        assert.equal(form.get('grant_type'), 'authorization_code');
        const entry = codes.get(form.get('code'));
        if (!entry) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        codes.delete(form.get('code'));
        const challenge = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        assert.equal(challenge, entry.challenge);
        const token = crypto.randomBytes(24).toString('hex');
        tokens.set(token, entry.profile);
        return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 600, scope: 'identify' });
      }
      if (url === config.userUrl) {
        const headers = new Headers(init.headers);
        const token = headers.get('authorization')?.replace(/^Bearer /, '');
        const profile = tokens.get(token);
        if (!profile) return Response.json({ error: 'unauthorized' }, { status: 401 });
        return Response.json(profile);
      }
      throw new Error('Verification tried to call an unexpected upstream URL.');
    },
  };

  async function install(page, base, profile) {
    await page.route('https://discord.com/oauth2/authorize**', async (route) => {
      const url = new URL(route.request().url());
      assert.equal(url.searchParams.get('scope'), 'identify');
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
      const state = url.searchParams.get('state');
      assert.ok(state && state.length >= 32);
      const code = crypto.randomUUID();
      codes.set(code, { profile, challenge: url.searchParams.get('code_challenge') });
      const callback = new URL('/api/auth/discord/callback', base);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      callback.searchParams.set('iss', 'https://discord.com');
      await route.fulfill({ status: 302, headers: { location: callback.href } });
    });
  }

  async function login(page, clubPassword) {
    await page.locator('#login-view').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#discord-login').isVisible(), false);
    await page.locator('#login-clubpass').fill(clubPassword);
    await page.locator('#club-verify').click();
    await page.locator('#discord-login').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#login-clubpass').inputValue(), '');
    await page.locator('#discord-login').click();
    await page.locator('#app').waitFor({ state: 'visible' });
  }
  return { config, install, login };
}
