import fs from 'fs';
import { describe, expect, it } from 'vitest';

// HF1 (notes/HF1.md): the shipped pages and gateway configs, read as data. Without the admin login a request reaches
// only /guild, /auth, or the member page's own files under /assets/ (GET and HEAD at Authelia).

const repo = new URL('../../', import.meta.url);
const read = (rel: string) => fs.readFileSync(new URL(rel, repo), 'utf-8');
const exists = (rel: string) => fs.existsSync(new URL(rel, repo));
const PUBLIC = 'src/webui/public/';

const MEMBER_FILES = [
  'styles.css',
  'utils/guildApi.js',
  'utils/uiHelpers.jsx',
  'components/panels/PanelComponents.jsx',
  'components/panels/PanelRenderer.jsx',
  'components/panels/PanelViewer.jsx',
  'components/panels/PanelList.jsx',
  'components/guild/OAuthLogin.jsx',
  'components/guild/GuildSelector.jsx',
  'components/guild/GuildPanelsPanel.jsx',
  'components/guild/GuildSubscriptionPanel.jsx',
  'guildApp.jsx',
];

const localLoads = (html: string) => [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)]
  .map(m => m[1]).filter(u => !/^https?:\/\//.test(u));

function walk(rel: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(new URL(rel, repo), { withFileTypes: true })) {
    const child = `${rel}${e.name}`;
    if (e.isDirectory()) walk(`${child}/`, out); else out.push(child);
  }
  return out;
}

describe('the member page loads only files under /assets/', () => {
  const loads = localLoads(read(`${PUBLIC}guild.html`));

  it('names each of its twelve files once, by its /assets/ path, and nothing else', () => {
    expect([...loads].sort()).toEqual(MEMBER_FILES.map(f => `/assets/${f}`).sort());
  });

  it('finds every one of them under public/assets/', () => {
    for (const f of MEMBER_FILES) expect(exists(`${PUBLIC}assets/${f}`), f).toBe(true);
  });

  it('keeps no copy of a moved file at its old path', () => {
    for (const f of MEMBER_FILES) expect(exists(`${PUBLIC}${f}`), f).toBe(false);
  });

  it('holds only the member files under public/assets/', () => {
    expect(walk(`${PUBLIC}assets/`).map(f => f.slice(`${PUBLIC}assets/`.length)).sort()).toEqual([...MEMBER_FILES].sort());
  });

  it('none of the member files names a static path outside /assets/', () => {
    const staticPath = /["'`](\/[^"'`\s?]*\.(?:js|jsx|css|png|ico|svg|jpg|jpeg|gif|woff|woff2|ttf|eot|json|html))["'`?]/g;
    for (const f of MEMBER_FILES) {
      const named = [...read(`${PUBLIC}assets/${f}`).matchAll(staticPath)].map(m => m[1]);
      expect(named.filter(p => !p.startsWith('/assets/')), f).toEqual([]);
    }
  });
});

describe('the admin page', () => {
  const loads = localLoads(read(`${PUBLIC}index.html`));

  it('finds every file it loads (build-info.js is written at start)', () => {
    for (const u of loads) {
      if (u === '/build-info.js') continue;
      expect(exists(`${PUBLIC}${u.slice(1)}`), u).toBe(true);
    }
  });

  it('loads the files it shares with the member page from /assets/', () => {
    const shared = MEMBER_FILES.filter(f => loads.includes(`/assets/${f}`));
    expect(shared.sort()).toEqual(['styles.css', 'utils/uiHelpers.jsx', 'components/panels/PanelComponents.jsx',
      'components/panels/PanelRenderer.jsx', 'components/panels/PanelViewer.jsx', 'components/panels/PanelList.jsx'].sort());
  });

  it('no file in the web UI names a moved file by its old path', () => {
    const files = walk(PUBLIC).filter(f => /\.(js|jsx|html|css)$/.test(f)).concat('src/webui/server.ts');
    for (const file of files) {
      const text = read(file);
      for (const f of MEMBER_FILES) {
        const stale = [...text.matchAll(new RegExp(`(.{0,7})/${f.replace(/[.]/g, '\\.')}\\b`, 'g'))]
          .filter(m => !m[1].endsWith('/assets'));
        expect(stale.map(m => m[0]), `${file} names /${f}`).toEqual([]);
      }
    }
  });
});

describe('the bot mounts the path guard before every route', () => {
  const server = read('src/webui/server.ts');
  const at = (needle: string) => {
    const i = server.indexOf(needle);
    expect(i, needle).toBeGreaterThanOrEqual(0);
    return i;
  };

  it('imports it and mounts it once, after the security headers and before the webhook, the parsers and every route', () => {
    expect(server.match(/app\.use\(pathGuard\)/g)).toHaveLength(1);
    const guard = at('app.use(pathGuard)');
    expect(guard).toBeGreaterThan(at("res.setHeader('Permissions-Policy'"));
    for (const later of ["'/webhook/:providerId'", 'app.use(express.json(', "app.use('/api/', apiLimiter)", "app.use('/auth'",
      "app.use('/guild/api/panels'", "app.use('/api/managed'", 'app.use(express.static(', "app.get('/', requireAuth",
      "app.get('/guild', guildHtmlHandler)", "app.get('*', requireAuth"]) {
      expect(guard, later).toBeLessThan(at(later));
    }
    expect(server).toMatch(/^import \{ adminPageFallback, pathGuard, pathMiss \} from '\.\/middleware\/pathGuard';$/m);
  });

  it('answers 404 for a path no route under /auth or /assets matched, after express.static and before the admin catch-all', () => {
    expect(server.match(/app\.use\(\['\/auth', '\/assets'\], pathMiss\)/g)).toHaveLength(1);
    const miss = at("app.use(['/auth', '/assets'], pathMiss)");
    expect(miss).toBeGreaterThan(at('app.use(express.static('));
    expect(miss).toBeGreaterThan(at("app.use('/auth', requireGuildWebUIEnabled, oauthRoutes)"));
    expect(miss).toBeLessThan(at("app.get('*', requireAuth"));
  });

  it('ends its routes with the admin catch-all, adminPageFallback, and names the admin page elsewhere only at / (delta round 3)', () => {
    expect(server.match(/app\.get\('\*', requireAuth, adminPageFallback\(publicDir\)\);/g)).toHaveLength(1);
    const after = server.slice(at("app.get('*', requireAuth, adminPageFallback(publicDir));"));
    expect(after.match(/app\.(?:use|get|post|put|delete|patch|all)\(/g)).toEqual(['app.get(', 'app.use(']);
    expect(after).toMatch(/\n {2}app\.use\(\(err: Error, req: Request, res: Response, next: any\) => \{/);
    expect(server.match(/index\.html/g)).toHaveLength(1);
    expect(server.indexOf('index.html')).toBeGreaterThan(at("app.get('/', requireAuth"));
    expect(server.indexOf('index.html')).toBeLessThan(at("app.get('/guild', guildHtmlHandler)"));
  });
});

describe('the CasaOS gateway lets through only /guild, /auth and /assets without the login', () => {
  const compose = read('docker-compose.yml');

  it('sets ALLOWED_PATHS to exactly /guild, /auth and /assets', () => {
    const lines = compose.split('\n').filter(l => /^\s*ALLOWED_PATHS:/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\s*ALLOWED_PATHS: "\/guild,\/auth,\/assets"(\s+#.*)?$/);
  });

  it('sets no ALLOWED_EXTENSIONS', () => {
    expect(compose).not.toMatch(/ALLOWED_EXTENSIONS/);
  });
});

describe("setup.sh loads Authelia's rules on every run", () => {
  it('rebuilds the bot from the pulled code on every run', () => {
    const ups = read('setup.sh').split('\n').filter(l => l.includes('docker compose -f "$COMPOSE_FILE" up -d'));
    expect(ups).toHaveLength(1);
    expect(ups[0]).toMatch(/up -d --build\b/);
  });

  it('gives the same update steps by hand in the remote compose header', () => {
    const header = read('docker-compose.remote.yml').split('\nname:')[0];
    expect(header).toMatch(/^# {3}5\. docker compose -f docker-compose\.remote\.yml up -d --build$/m);
    expect(header).toMatch(/^# {3}docker compose -f docker-compose\.remote\.yml up -d --build\n# {3}docker compose -f docker-compose\.remote\.yml restart authelia$/m);
  });

  it('tells a self-hosted operator to rerun setup.sh for the public Linux stack', () => {
    expect(read('updaters/updater_local/index.ts')).toMatch(/sudo \.\/setup\.sh/);
  });

  it('restarts Authelia after the stack comes up, whether or not the password changed', () => {
    const setup = read('setup.sh');
    const up = setup.indexOf('docker compose -f "$COMPOSE_FILE" up -d');
    const restart = setup.indexOf('docker compose -f "$COMPOSE_FILE" restart authelia', up);
    expect(up).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(up);
    expect(setup.slice(up, setup.lastIndexOf('\n', restart))).not.toMatch(/\bif\b|\bfi\b/);
  });
});

describe('the /auth routes answer GET only, as the Authelia rule for them assumes', () => {
  it('registers only GET routes', () => {
    const methods = [...read('src/webui/auth/oauthRoutes.ts').matchAll(/\brouter\.(\w+)\(/g)].map(m => m[1]);
    expect(methods.length).toBeGreaterThanOrEqual(5);
    expect([...new Set(methods)]).toEqual(['get']);
  });
});

interface Rule { policy?: string; methods: string[]; resources: string[]; subject: string[]; domain?: string }

function autheliaRules(text: string): Rule[] {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^access_control:\s*$/.test(l));
  expect(start).toBeGreaterThanOrEqual(0);
  const rules: Rule[] = [];
  let list: string[] | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^ {4}- (\w+):\s*(.*)$/.exec(line);
    const key = /^ {6}(\w+):\s*(.*)$/.exec(line);
    const value = /^ {8}- (.*)$/.exec(line);
    const unquote = (v: string) => v.trim().replace(/^'(.*)'$/, '$1');
    if (item || key) {
      if (item) rules.push({ methods: [], resources: [], subject: [] });
      const [, k, v] = (item ?? key)!;
      const rule = rules[rules.length - 1];
      list = null;
      if (k === 'methods' || k === 'resources' || k === 'subject') {
        expect(v, `${k} is written as a block list`).toBe('');
        list = rule[k];
      } else if (k === 'policy' || k === 'domain') rule[k] = unquote(v);
    } else if (value && list) list.push(unquote(value[1]));
    else if (!/^ {2}(default_policy|rules):/.test(line)) throw new Error(`unexpected access_control line: ${line}`);
  }
  return rules;
}

describe("the remote stack's Authelia bypasses only the member routes", () => {
  const config = read('authelia/configuration.yml');
  const rules = autheliaRules(config);

  it('keeps default deny', () => {
    expect(config).toMatch(/^ {2}default_policy: 'deny'$/m);
  });

  it('holds exactly the guild bypass, the GET and HEAD bypass for /auth and /assets/, then the admin rule', () => {
    expect(rules.map(r => ({ policy: r.policy, methods: r.methods, resources: r.resources, subject: r.subject }))).toEqual([
      { policy: 'bypass', methods: [], resources: ['^/guild([/?].*)?$'], subject: [] },
      { policy: 'bypass', methods: ['GET', 'HEAD'], resources: ['^/auth([/?].*)?$', '^/assets/[^?]*$'], subject: [] },
      { policy: '{{ env "ACCESS_POLICY" }}', methods: [], resources: [], subject: ['group:admins'] },
    ]);
    for (const r of rules) expect(r.domain).toBe('{{ env "PUBLIC_HOST" }}');
  });

  const bypassFor = (method: string, url: string) => {
    for (const r of rules) {
      if (r.methods.length && !r.methods.includes(method)) continue;
      if (r.resources.length && !r.resources.some(re => new RegExp(re).test(url))) continue;
      return r.policy === 'bypass';
    }
    return false;
  };

  it.each([
    ['GET', '/assets/styles.css', true],
    ['HEAD', '/assets/components/guild/OAuthLogin.jsx', true],
    ['POST', '/assets/styles.css', false],
    ['GET', '/assets/styles.css?x=1', false],
    ['GET', '/auth/discord/callback?code=1', true],
    ['POST', '/auth/discord', false],
    ['DELETE', '/guild/api/panels/1/x', true],
    ['GET', '/guild?x=1', true],
    ['GET', '/api/bot/status.js', false],
    ['GET', '/styles.css', false],
    ['GET', '/utils/api.js', false],
    ['GET', '/', false],
    ['GET', '/guildx', false],
    ['GET', '/assetsx/a.css', false],
  ])('%s %s bypasses the login: %s', (method, url, expected) => {
    expect(bypassFor(method as string, url as string)).toBe(expected);
  });
});
