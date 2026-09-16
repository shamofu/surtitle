// The same mounts/environment as devcontainer.json, without editor-injected mounts.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertContainer, assertDefinition, maskedDirectories, runtimeUserForHost, workspace } from './isolation.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const config = JSON.parse(readFileSync(resolve(root, '.devcontainer/devcontainer.json'), 'utf8'));
assertDefinition(config, ['.devcontainer/Dockerfile', 'native/build/Dockerfile'].map(path => readFileSync(resolve(root, path), 'utf8')), readFileSync(resolve(root, '.dockerignore'), 'utf8'));
const args = process.argv.slice(2);
const viaWsl = args.includes('--wsl');
const [command, name = 'surtitle-devcontainer-check'] = args.filter(arg => arg !== '--wsl');
if (!/^[a-z0-9][a-z0-9_.-]+$/.test(name)) throw new Error('Invalid container name');
const source = viaWsl ? root.replace(/^([A-Za-z]):[\\/]/, (_, drive) => '/mnt/' + drive.toLowerCase() + '/').replaceAll('\\', '/') : root;
const image = 'surtitle-devcontainer:local-check';
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}
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
  if (!container.State?.Running) {
    log('Resuming development container ' + name);
    docker(['start', name]);
  }
}
function inside(code, extra = []) {
  return docker(['exec', '--user', config.remoteUser, '--workdir', workspace, name, 'node', '--input-type=module', '-e', code, ...extra], { capture: true }).stdout;
}
function probe() {
  log('Checking source sharing and dependency/output isolation');
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
  case 'build':
    log('Building the development container image');
    docker(['build', '-f', '.devcontainer/Dockerfile', '-t', image, source]);
    break;
  case 'start': {
    const runtimeUser = runtimeUserForHost({ platform: process.platform, viaWsl, remoteUser: config.remoteUser, uid: process.getuid?.(), gid: process.getgid?.() });
    // Start unprivileged with the host IDs, leaving the image user's old UID free
    // while its account and container-only directories are aligned below.
    const run = ['run', '--detach', '--name', name, '--label', 'app.surtitle.purpose=development-verification', '--user', runtimeUser.user, '--workdir', workspace,
      '--mount', 'type=bind,source=' + source + ',target=' + workspace];
    run.push(...config.runArgs);
    for (const [key, value] of Object.entries(config.containerEnv)) run.push('--env', key + '=' + value);
    if (runtimeUser.home) run.push('--env', 'HOME=' + runtimeUser.home);
    log('Starting development container ' + name);
    docker([...run, image, 'sleep', 'infinity']);
    inspect();
    if (runtimeUser.home) {
      log('Aligning the container account with the host UID/GID');
      docker(['exec', '--user', 'root', '--workdir', '/', name, 'bash', workspace + '/.devcontainer/align-user.sh',
        config.remoteUser, String(runtimeUser.uid), String(runtimeUser.gid)]);
    }
    probe();
    break;
  }
  case 'check': resume(); probe(); break;
  case 'verify': {
    resume(); probe();
    log('Running Linux checks and native E2E; streaming output to /opt/surtitle-build/verification.log');
    const result = docker(['exec', '--user', config.remoteUser, '--workdir', workspace, name, 'bash', '-o', 'pipefail', '-lc', 'bash .devcontainer/verify.sh 2>&1 | tee /opt/surtitle-build/verification.log'], { allowFailure: true });
    if (result.status !== 0) throw new Error('Container verification failed (exit ' + result.status + '); full log stays at /opt/surtitle-build/verification.log');
    probe();
    log('Full container verification passed');
    break;
  }
  default: throw new Error('Usage: node .devcontainer/container.mjs build|start|check|verify [container-name] [--wsl]');
}
