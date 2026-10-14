import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'plugins', 'research-canvas');
const project = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const banner = { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" };
await mkdir(path.join(plugin, 'server'), { recursive: true });
for (const [entry, name] of [['integrations/mcp.ts', 'mcp'], ['server/index.ts', 'canvas']]) {
  await build({ absWorkingDir: root, entryPoints: [entry], outfile: path.join(plugin, 'server', name + '.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node20.12', external: ['vite'], banner });
}
await rm(path.join(plugin, 'web'), { recursive: true, force: true });
await cp(path.join(root, 'dist'), path.join(plugin, 'web'), { recursive: true });
const launch = { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server/mcp.mjs'], cwd: '${PLUGIN_ROOT}' };
await writeFile(path.join(plugin, 'mcp.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { 'research-canvas': launch } }, null, 2) + '\n');
await writeFile(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { 'research-canvas': launch } }, null, 2) + '\n');
for (const manifestPath of ['plugin.json', '.codex-plugin/plugin.json']) {
  const filename = path.join(plugin, manifestPath);
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  manifest.version = project.version;
  await writeFile(filename, JSON.stringify(manifest, null, 2) + '\n');
}
await cp(path.join(root, 'LICENSE'), path.join(plugin, 'LICENSE'));

// Include notices for the complete production closure, including browser code.
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const dependencies = [];
for (const [relative, metadata] of Object.entries(lock.packages)) {
  if (!relative.startsWith('node_modules/') || metadata.dev || metadata.optional && metadata.os && !metadata.os.includes(process.platform)) continue;
  const directory = path.join(root, relative);
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); } catch { continue; }
  const licenses = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)(\.|$)/i.test(name)).sort();
  if (!licenses.length) throw new Error(`Missing third-party license text: ${manifest.name}`);
  dependencies.push({ name: manifest.name, version: manifest.version, license: manifest.license || metadata.license || 'See license text', texts: await Promise.all(licenses.map(async name => ({ name, text: await readFile(path.join(directory, name), 'utf8') }))) });
}
dependencies.sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
await writeFile(path.join(plugin, 'THIRD_PARTY_NOTICES.txt'), 'Research Canvas bundled production dependency notices\n\n' + dependencies.map(dep => `${'='.repeat(72)}\n${dep.name}@${dep.version}\nDeclared license: ${typeof dep.license === 'string' ? dep.license : JSON.stringify(dep.license)}\n\n` + dep.texts.map(file => `--- ${file.name} ---\n${file.text}`).join('\n\n')).join('\n\n') + '\n');
await writeFile(path.join(plugin, 'DEPENDENCIES.json'), JSON.stringify(dependencies.map(({ texts, ...metadata }) => metadata), null, 2) + '\n');

const marketplacePath=path.join(root,'.agents','plugins','marketplace.json');
const marketplace=JSON.stringify({ name: 'research-canvas-local', interface: { displayName: 'Research Canvas 本地开发' }, plugins: [{ name: 'research-canvas', source: { source: 'local', path: './plugins/research-canvas' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] }, null, 2)+'\n';
const existingMarketplace=await readFile(marketplacePath,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error});
if(existingMarketplace===null){
  await mkdir(path.dirname(marketplacePath),{recursive:true});await writeFile(marketplacePath,marketplace);
}else if(JSON.stringify(JSON.parse(existingMarketplace))!==JSON.stringify(JSON.parse(marketplace))){
  throw new Error('Existing repo marketplace differs; merge the Research Canvas entry manually to preserve its other plugins.');
}
console.log(`Built portable Research Canvas ${project.version}: ${plugin}`);
