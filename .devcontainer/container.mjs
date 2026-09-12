// The same mounts/environment as devcontainer.json, without editor-injected mounts.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContainer, assertDefinition, maskedDirectories, workspace } from './isolation.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(readFileSync(resolve(root, '.devcontainer/devcontainer.json'), 'utf8'));
assertDefinition(config, ['.devcontainer/Dockerfile', 'native/build/Dockerfile'].map(path => readFileSync(resolve(root, path), 'utf8')), readFileSync(resolve(root, '.dockerignore'), 'utf8'));
const args = process.argv.slice(2);
const viaWsl = args.includes('--wsl');
const [command, name = 'surtitle-devcontainer-check'] = args.filter(arg => arg !== '--wsl');
if (!/^[a-z0-9][a-z0-9_.-]+$/.test(name)) throw new Error('Invalid container name');
const source = viaWsl ? root.replace(/^([A-Za-z]):[\\/]/, (_, drive) => '/mnt/' + drive.toLowerCase() + '/').replaceAll('\\', '/') : root;
const image = 'surtitle-devcontainer:local-check';
function docker(arguments_, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(viaWsl ? 'wsl' : 'docker', viaWsl ? ['-d', 'Ubuntu', '-u', 'root', '--', 'docker', ...arguments_] : arguments_, {
    cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error('Docker failed (' + result.status + '): ' + (result.stderr ?? 'see command output'));
  return result;
}
function inspect() {
  const value = JSON.parse(docker(['inspect', name], { capture: true }).stdout);
  assertContainer(value, source);
  return value;
}
function resume() {
  const [container] = inspect();
  if (!container.State?.Running) docker(['start', name]);
}
function inside(code, extra = []) {
  return docker(['exec', '--user', config.remoteUser, '--workdir', workspace, name, 'node', '--input-type=module', '-e', code, ...extra], { capture: true }).stdout;
}
function probe() {
  inspect();
  const filename = '.surtitle-isolation-probe-' + randomUUID();
  const sourceProbe = resolve(root, '.devcontainer', filename);
  const sourceRelative = '.devcontainer/' + filename;
  const outputPaths = maskedDirectories.map(directory => directory + '/' + filename);
  if (outputPaths.some(path => existsSync(resolve(root, path)))) throw new Error('Probe path unexpectedly exists');
  writeFileSync(sourceProbe, 'host-source', { flag: 'wx' });
  try {
    inside('import { readFileSync, writeFileSync, mkdirSync } from "node:fs"; import { dirname } from "node:path"; const [source, ...outputs] = process.argv.slice(1); if (readFileSync(source, "utf8") !== "host-source") throw Error("Host source not shared"); writeFileSync(source, "container-source"); for (const path of outputs) { mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, "container-only", {flag:"wx"}); }', [sourceRelative, ...outputPaths]);
    if (readFileSync(sourceProbe, 'utf8') !== 'container-source') throw new Error('Container source change not visible on host');
    for (const path of outputPaths) if (existsSync(resolve(root, path))) throw new Error('Container output leaked into host: ' + path);
    const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), sourceSharedBothDirections: true, outputMasksChecked: maskedDirectories, hostOutputWrites: 0, namedVolumes: 0 };
    inside('import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("artifacts", {recursive:true}); mkdirSync("/opt/surtitle-build/evidence", {recursive:true}); for(const path of ["artifacts/container-isolation.json", "/opt/surtitle-build/evidence/container-isolation.json"]) writeFileSync(path, process.argv[1]);', [JSON.stringify(report, null, 2)]);
    console.log(JSON.stringify(report));
  } finally {
    unlinkSync(sourceProbe);
    inside('import { unlinkSync } from "node:fs"; for (const path of process.argv.slice(1)) { try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; } }', outputPaths);
  }
}
switch (command) {
  case 'build': docker(['build', '-f', '.devcontainer/Dockerfile', '-t', image, source]); break;
  case 'start': {
    const run = ['run', '--detach', '--name', name, '--label', 'app.surtitle.purpose=development-verification', '--user', config.remoteUser, '--workdir', workspace,
      '--mount', 'type=bind,source=' + source + ',target=' + workspace];
    run.push(...config.runArgs);
    for (const [key, value] of Object.entries(config.containerEnv)) run.push('--env', key + '=' + value);
    docker([...run, image, 'sleep', 'infinity']);
    inspect();
    probe();
    break;
  }
  case 'check': resume(); probe(); break;
  case 'verify': {
    resume(); probe();
    const result = docker(['exec', '--user', config.remoteUser, '--workdir', workspace, name, 'bash', '-lc', 'bash .devcontainer/verify.sh > /opt/surtitle-build/verification.log 2>&1'], { allowFailure: true });
    docker(['exec', name, 'tail', '-n', '80', '/opt/surtitle-build/verification.log']);
    if (result.status !== 0) throw new Error('Container verification failed; full log stays at /opt/surtitle-build/verification.log');
    probe();
    break;
  }
  default: throw new Error('Usage: node .devcontainer/container.mjs build|start|check|verify [container-name] [--wsl]');
}
