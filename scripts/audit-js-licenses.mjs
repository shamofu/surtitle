import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, lstatSync, cpSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const allowed = new Set(['MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0', 'Unlicense', '0BSD', 'BlueOak-1.0.0', 'Python-2.0', 'CC-BY-4.0', 'MPL-2.0', '(MIT OR Apache-2.0)', '(MIT AND Zlib)', 'BSD-3-Clause AND MIT']);
const packages = [];
const notices = [];
const sourceTarget = process.argv[2];
if (sourceTarget) mkdirSync(sourceTarget, { recursive: true });
const root = 'node_modules/.pnpm';
const modulesRoot = realpathSync('node_modules');
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'node_modules') continue;
  const inner = join(root, entry.name, 'node_modules');
  if (!existsSync(inner)) continue;
  for (const name of readdirSync(inner)) {
    const candidates = name.startsWith('@') ? readdirSync(join(inner, name)).map(n => join(name, n)) : [name];
    for (const candidate of candidates) {
      const file = join(inner, candidate, 'package.json');
      if (!existsSync(file)) continue;
      const p = JSON.parse(readFileSync(file, 'utf8'));
      if (packages.some(x => x.name === p.name && x.version === p.version)) continue;
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(p.name) || !/^[a-z0-9.+_-]+$/i.test(p.version)) throw new Error('Unsafe package identity');
      // pnpm dependency entries may be symlinks encountered before the store's
      // real package. Resolve only this root, then omit nested dependency links.
      const packageRoot = realpathSync(join(inner, candidate));
      const packageRelative = relative(modulesRoot, packageRoot);
      if (packageRelative.startsWith('..') || isAbsolute(packageRelative)) throw new Error(`Package resolves outside node_modules: ${p.name}`);
      let license = typeof p.license === 'object' ? p.license.type : p.license;
      if (p.name === 'css-value' && p.version === '0.0.1' && !license) {
        const notice = readFileSync(join(inner, candidate, 'Readme.md'));
        if (createHash('sha256').update(notice).digest('hex') !== '8899717e6304c84d9d45ecc565ef462cb850c47076632f77e16761a3b39560b8') throw new Error('css-value reviewed MIT notice changed');
        license = 'MIT';
      }
      const alternatives = typeof license === 'string' ? license.replace(/^\((.*)\)$/, '$1').split(' OR ') : [];
      const separateDataPackage = p.name === 'spdx-exceptions' && p.version === '2.5.0' && license === 'CC-BY-3.0';
      if (!allowed.has(license) && !alternatives.some(l => allowed.has(l)) && !separateDataPackage) throw new Error(`Review required: ${p.name}@${p.version} license ${JSON.stringify(license)}`);
      packages.push({ name: p.name, version: p.version, license, repository: p.repository });
      let noticeFiles = readdirSync(packageRoot).filter(n => /^(licen[sc]e|copying|notice|copyright)/i.test(n) && lstatSync(join(packageRoot, n)).isFile());
      if (!noticeFiles.length) noticeFiles = readdirSync(packageRoot).filter(n => /^readme/i.test(n) && lstatSync(join(packageRoot, n)).isFile());
      notices.push(`\n${'='.repeat(72)}\n${p.name} ${p.version}\n${license}\n${JSON.stringify(p.repository || '')}\n${noticeFiles.map(n => `\n${n}\n${readFileSync(join(packageRoot, n), 'utf8')}`).join('\n')}`);
      if (sourceTarget) cpSync(packageRoot, join(sourceTarget, `${p.name.replaceAll('/', '__')}@${p.version}`), { recursive: true, dereference: false, filter: source => !lstatSync(source).isSymbolicLink() && (source === packageRoot || !source.slice(packageRoot.length + 1).split(/[\\/]/).includes('node_modules')) });
    }
  }
}
if (!packages.length) throw new Error('Install dependencies before auditing licenses.');
mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/js-licenses.json', JSON.stringify(packages, null, 2));
mkdirSync('src-tauri/resources/notices', { recursive: true });
writeFileSync('src-tauri/resources/notices/javascript.txt', 'Surtitle JavaScript dependency notices. Development-only test dependencies are included in the separate source archive.\n' + notices.join('\n'));
writeFileSync('artifacts/js-sbom.cdx.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components: packages.map(p => ({ type: 'library', name: p.name, version: p.version, purl: `pkg:npm/${p.name.replace('@','%40')}@${p.version}`, licenses: [{ expression: p.license }] })) }, null, 2));
console.log(`Audited ${packages.length} installed JavaScript dependencies. Source notices are retained in the source bundle.`);
