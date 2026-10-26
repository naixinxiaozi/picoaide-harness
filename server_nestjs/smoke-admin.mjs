// 管理面冒烟：登录 → 逐端点 GET，打印状态码与错误码。
// 用法: node smoke-admin.mjs [base]
const base = process.argv[2] ?? 'http://127.0.0.1:8899';
const username = process.env.SMOKE_USER ?? 'admin';
const password = process.env.SMOKE_PASS ?? '';
if (!password) {
  console.error('SMOKE_PASS is required');
  process.exit(2);
}

const login = await fetch(`${base}/api/server/admin/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password }),
});
const loginBody = await login.json().catch(() => ({}));
console.log(`login ${login.status} ${loginBody?.error?.code ?? 'ok'}`);
const cookie = (login.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(';')[0])
  .join('; ');
const csrf = loginBody?.csrf_token ?? '';

const paths = [
  '/api/server/admin/users',
  '/api/server/admin/departments',
  '/api/server/admin/usage',
  '/api/server/admin/usage/overview',
  '/api/server/admin/usage/requests',
  '/api/server/admin/balance',
  '/api/server/admin/providers',
  '/api/server/admin/models',
  '/api/server/admin/gateway',
  '/api/server/admin/gateway/files',
  '/api/server/admin/skills',
  '/api/server/admin/agents',
  '/api/server/admin/shared-skills',
  '/api/server/admin/agent-presets',
  '/api/server/admin/capabilities/approvals',
  '/api/server/admin/connectors',
  '/api/server/admin/server-info',
  '/api/server/admin/audit',
  '/api/server/admin/channels',
  '/api/server/admin/portal',
  '/api/server/admin/report-subscriptions',
  '/api/server/admin/auth',
];

let bad = 0;
for (const p of paths) {
  const res = await fetch(base + p, { headers: { cookie, 'x-csrf-token': csrf } });
  const text = await res.text();
  let brief = text.slice(0, 160).replace(/\s+/g, ' ');
  if (res.status !== 200) bad++;
  console.log(`${res.status} ${p} ${res.status === 200 ? '' : brief}`);
}
console.log(bad === 0 ? 'ALL OK' : `${bad} FAILED`);
