/** Extract and run the exact runtime ZIP against a fresh, disposable database. */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink, unlink, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, relative, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { assertCleanBaseConfiguration, assertEmptyInstallation, createReviewedReleaseQuestion, completeReleasePaper } from './release-fixture.mjs';

const workspace = resolve(import.meta.dirname, '../..');
const project = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
const argument = process.argv.slice(2).find(value => !value.startsWith('--'));
const zipPath = resolve(argument || join(workspace, 'artifacts/releases', `noetic-atlas-${project.version}-runtime.zip`));
const install = process.argv.includes('--install');
const temporaryRoot = await realpath(tmpdir());
const temporary = await mkdtemp(join(temporaryRoot, 'noetic-release-smoke-'));
const checks = []; let server, dependencyLink;
const crcTable = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1; return n >>> 0; });
function crc32(data) { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
function unzip(data) {
  assert.ok(data.length >= 22, 'ZIP file is truncated');
  let end = data.length - 22; while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= Math.max(0, data.length - 65557), 'ZIP directory is missing');
  const count = data.readUInt16LE(end + 10), centralEnd = data.readUInt32LE(end + 16) + data.readUInt32LE(end + 12);
  let cursor = data.readUInt32LE(end + 16), total = 0; const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(data.readUInt32LE(cursor), 0x02014b50, 'ZIP central record');
    const flags = data.readUInt16LE(cursor + 8), method = data.readUInt16LE(cursor + 10), crc = data.readUInt32LE(cursor + 16), compressedSize = data.readUInt32LE(cursor + 20), size = data.readUInt32LE(cursor + 24), nameLength = data.readUInt16LE(cursor + 28), extraLength = data.readUInt16LE(cursor + 30), commentLength = data.readUInt16LE(cursor + 32), local = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    assert.ok(name && !name.startsWith('/') && !name.includes('\\') && !name.includes('\0') && !/^[a-z]:/i.test(name) && !name.split('/').some(part => part === '..' || part === '.'), 'Unsafe archive path');
    assert.equal(flags & 1, 0, 'Encrypted files are unsupported'); assert.ok(method === 0 || method === 8, 'Unsupported ZIP compression'); assert.ok(!entries.has(name), 'Duplicate ZIP entry');
    total += size; assert.ok(total <= 1024 * 1024 * 1024, 'Runtime ZIP exceeds 1 GiB extraction limit');
    assert.equal(data.readUInt32LE(local), 0x04034b50); const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
    const compressed = data.subarray(start, start + compressedSize); const bytes = method === 8 ? inflateRawSync(compressed, { maxOutputLength: size + 1 }) : compressed;
    assert.equal(bytes.length, size, `ZIP size mismatch: ${name}`); assert.equal(crc32(bytes), crc, `ZIP CRC mismatch: ${name}`); entries.set(name, bytes);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, centralEnd); return entries;
}
function run(binary, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '';
    const append = value => { log = (log + value.toString()).slice(-12000); }; child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', reject); child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`Command failed (${code}): ${log}`)));
  });
}
async function unusedPort() {
  const listener = createServer(); await new Promise((resolvePort, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolvePort); });
  const port = listener.address().port; await new Promise(resolveClose => listener.close(resolveClose)); return port;
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const current = server; await new Promise(resolveStop => { const force = setTimeout(() => current.kill('SIGKILL'), 3000); current.once('exit', () => { clearTimeout(force); resolveStop(); }); current.kill('SIGTERM'); }); server = undefined;
}
try {
  const entries = unzip(await readFile(zipPath)), roots = new Set([...entries.keys()].map(name => name.split('/')[0])); assert.equal(roots.size, 1);
  const prefix = [...roots][0], folder = join(temporary, prefix);
  const manifestName = `${prefix}/release-manifest.json`; const manifest = JSON.parse(entries.get(manifestName)?.toString('utf8') || 'null');
  assert.equal(manifest?.project, 'noetic-atlas'); assert.equal(manifest?.kind, 'runtime'); assert.equal(manifest?.version, project.version);
  assert.equal(manifest.dataBoundary?.installation, 'empty-install');
  assert.equal(manifest.dataBoundary?.includesQuestionData, false);
  for (const name of ['questions', 'domains', 'categories', 'tags']) assert.equal(manifest.counts[name], 0, `Software manifest ${name} must be zero`);
  assert.equal(Object.keys(manifest.files).length + 1, entries.size, 'Manifest must cover every shipped file');
  for (const [name, bytes] of entries) {
    const localName = name.slice(prefix.length + 1); if (name === manifestName) continue;
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files[localName], `Manifest hash mismatch: ${localName}`);
    assert.ok(!/(?:^|\/)(?:\.env[^/]*|local\.properties|node_modules)(?:\/|$)|\.(?:sqlite(?:-[\w]+)?|keystore|jks)$/i.test(localName), 'User files must not ship');
    assert.ok(!/^data(?:\/|$)|(?:^|\/)native-seed\.json$/i.test(localName), 'Software ZIP must not contain question or user data');
  }
  for (const [name, bytes] of entries) { const target = resolve(temporary, name); assert.ok(target.startsWith(temporary + sep)); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes); }
  checks.push('ZIP路径、CRC、文件白名单与SHA256清单完整');
  const defaults = JSON.parse(await readFile(join(folder, 'config/defaults.json'), 'utf8')); assertCleanBaseConfiguration(defaults); checks.push('软件与题库完全分离，仅携带无凭据基础配置');
  const shippedPackage = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')); assert.equal(shippedPackage.name, 'noetic-atlas');
  if (install) {
    const npmCli = [process.env.npm_execpath, resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(candidate => candidate && existsSync(candidate));
    assert.ok(npmCli, 'Use npm run or a Node distribution with npm'); await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--fund=false'], { cwd: folder, env: { ...process.env, NODE_ENV: 'production' } }); checks.push('独立目录真实安装production依赖');
  } else {
    dependencyLink = join(folder, 'node_modules'); await symlink(join(workspace, 'node_modules'), dependencyLink, process.platform === 'win32' ? 'junction' : 'dir'); checks.push('使用本机依赖链接（未验证独立生产依赖安装）');
  }
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`, databasePath = join(temporary, 'storage', 'runtime.sqlite');
  async function api(path, method = 'GET', body) { const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(10000), ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; }
  async function startServer() {
    const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATABASE_PATH: databasePath, NODE_ENV: 'production' };
    delete env.SEED_PATH;
    for (const key of Object.keys(env)) if (/^(?:OPENAI|DEEPSEEK|AI)_(?:API_)?(?:KEY|TOKEN|BASE_URL|MODEL|ENABLED)$/.test(key)) delete env[key];
    server = spawn(process.execPath, ['dist/server/main.js'], { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = ''; const append = value => { log = (log + value.toString()).slice(-12000); }; server.stdout.on('data', append); server.stderr.on('data', append);
    let spawnError; server.once('error', error => { spawnError = error; });
    const until = Date.now() + 20000; while (Date.now() < until) { if (spawnError) throw spawnError; if (server.exitCode !== null) throw new Error(`Runtime exited: ${log}`); try { if ((await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) })).ok) return; } catch {} await new Promise(resolveWait => setTimeout(resolveWait, 150)); }
    throw new Error(`Runtime startup timeout: ${log}`);
  }
  await startServer(); await assertEmptyInstallation(api, defaults); checks.push('零题目、零领域分类标签、零用户记录，基础配置匹配且AI关闭无密钥');
  const home = await fetch(origin + '/'); assert.equal(home.status, 200); assert.match(await home.text(), /认知星图/); const docs = await fetch(origin + '/api/docs/'); assert.equal(docs.status, 200); const openapi = await api('/api/openapi.json'); assert.ok(openapi.paths['/api/papers']); assert.ok(openapi.paths['/api/exams/sync']); checks.push('生产页面、Swagger UI与动态OpenAPI可访问');
  const question = await createReviewedReleaseQuestion(api); const { attempt } = await completeReleasePaper(api, question); checks.push('隔离临时库新增题目、用户审核、创建卷、客观计分和计时闭环正常');
  await stopServer(); await startServer(); assert.equal((await api(`/api/attempts/${encodeURIComponent(attempt.id)}`)).status, 'submitted'); assert.equal((await api('/api/papers')).length, 1); assert.equal((await api('/api/questions?page=1&pageSize=10')).total, 1); checks.push('重启保留临时新增数据且不注入初装题库');
  const output = join(workspace, 'test-results'); await mkdir(output, { recursive: true }); await writeFile(join(output, `release-smoke-${project.version}.json`), JSON.stringify({ version: project.version, artifact: basename(zipPath), installMode: install ? 'production-install' : 'linked-dependencies', checks, passed: checks.length }, null, 2));
  process.stdout.write(JSON.stringify({ version: project.version, passed: checks.length, installMode: install ? 'production-install' : 'linked-dependencies' }) + '\n');
} finally {
  await stopServer();
  if (dependencyLink) await unlink(dependencyLink);
  const resolvedTemporary = resolve(temporary); assert.equal(dirname(resolvedTemporary), temporaryRoot); assert.ok(basename(resolvedTemporary).startsWith('noetic-release-smoke-'));
  await rm(resolvedTemporary, { recursive: true, force: true });
}
