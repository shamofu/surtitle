// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const sha = 'a'.repeat(40);
const script = readFileSync(new URL('./native-ci-build.sh', import.meta.url));
const cacheNames = ['compiler', 'source-cache', 'ort-archives'];
const cacheTargets = ['/build/compiler-cache', '/build/source-cache', '/build/ort-corresponding/archives'];
let bash = 'bash';
if (process.platform === 'win32') {
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  bash = resolve(git.stdout?.trim() ?? '', '../../../bin/bash.exe');
  if (git.status !== 0 || !existsSync(bash)) throw new Error('Git Bash is required to execute the native CI wrapper tests');
}

function fixture(t, { populated = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'surtitle-native-wrapper 日本語 & '));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, data, executable = false) => {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, data);
    if (executable) chmodSync(destination, 0o755);
  };
  write('scripts/native-ci-build.sh', script);
  write('scripts/native-ort-fixture.py', 'fixture');
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'cache'));
  if (populated) for (const name of cacheNames) write(`cache/${name}/old-cache.dat`, name);
  // Exported functions preserve Bash's command status and traps without starting
  // another Git Bash process for every simulated Git, Node or Docker command.
  write('scripts/mocks.sh', String.raw`
mock_log() {
  printf '%s\t' "$@" >> "$SURTITLE_TEST_LOG"
  printf '\n' >> "$SURTITLE_TEST_LOG"
}
git() {
  mock_log git "$@"
  printf '%s\n' "$GITHUB_SHA"
}
node() {
  mock_log node "$@"
  if [[ "${'$'}{2:-}" == seal ]]; then
    [[ -f "$3/payload-fixture" ]] || return 91
    return "${'$'}{SURTITLE_TEST_SEAL_STATUS:-0}"
  fi
  return 0
}
docker() {
  mock_log docker "$@"
  case "${'$'}{1:-}" in
    image)
      if [[ "${'$'}{3:-}" == --format ]]; then printf '%s\n' "$GITHUB_SHA"; else printf '[]\n'; fi
      ;;
    inspect) printf '[]\n' ;;
    exec)
      if [[ "${'$'}{3:-}" == python3 ]]; then return "${'$'}{SURTITLE_TEST_ACQUIRE_STATUS:-0}"; fi
      if [[ "${'$'}{3:-}" == bash ]]; then return "${'$'}{SURTITLE_TEST_BUILD_STATUS:-0}"; fi
      ;;
    cp)
      case "$2" in
        *:/out/ci-artifact/.) printf 'fresh payload' > "$3/payload-fixture" ;;
        *:/build/*/.) printf 'fresh reusable data' > "$3/new-cache.dat" ;;
      esac
      ;;
  esac
  return 0
}
export -f mock_log git node docker
`);
  const run = ({ cacheRelative = 'cache', disable, sealStatus = '0', acquireStatus = '0', buildStatus = '0' } = {}) => {
    const env = { ...process.env, GITHUB_SHA: sha, SURTITLE_TEST_SEAL_STATUS: sealStatus,
      SURTITLE_TEST_ACQUIRE_STATUS: acquireStatus, SURTITLE_TEST_BUILD_STATUS: buildStatus };
    delete env.CCACHE_DISABLE;
    delete env.SURTITLE_NATIVE_CACHE_DIR;
    if (disable !== undefined) env.CCACHE_DISABLE = disable;
    if (cacheRelative !== null) env.SURTITLE_TEST_CACHE_RELATIVE = cacheRelative;
    else delete env.SURTITLE_TEST_CACHE_RELATIVE;
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', String.raw`
export PATH="$PWD/bin:$PATH"
export SURTITLE_TEST_LOG="$PWD/commands.log"
source scripts/mocks.sh
if [[ ${'$'}{SURTITLE_TEST_CACHE_RELATIVE+x} ]]; then
  export SURTITLE_NATIVE_CACHE_DIR="$PWD/$SURTITLE_TEST_CACHE_RELATIVE"
fi
exec bash scripts/native-ci-build.sh --prebuilt-image
`], { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(result.error, undefined);
    const commands = existsSync(join(root, 'commands.log')) ? readFileSync(join(root, 'commands.log'), 'utf8').trim().split('\n').map(line => {
      const [path, ...args] = line.split('\t');
      return [path.split('/').at(-1), ...args.filter((value, index) => value || index !== args.length - 1)];
    }) : [];
    return { ...result, commands };
  };
  return { root, bash, write, run };
}

const imports = commands => commands.filter(args => args[0] === 'docker' && args[1] === 'cp' && /\/cache\/(compiler|source-cache|ort-archives)\/\.$/.test(args[2]));
const exports = commands => commands.filter(args => args[0] === 'docker' && args[1] === 'cp' && args[2].includes(':/build/'));
const noContainer = result => assert.equal(result.commands.some(args => args[0] === 'docker' && ['create', 'exec'].includes(args[1])), false);

test('native wrapper imports only three reusable caches before acquisition and exports replacements after a successful seal', t => {
  const f = fixture(t);
  for (const name of ['objects', 'prefix', 'sources', 'out']) f.write(`cache/${name}/must-not-restore`, 'stale build tree');
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const restored = imports(result.commands), saved = exports(result.commands);
  assert.equal(restored.length, 3);
  assert.equal(saved.length, 3);
  const acquiredAt = result.commands.findIndex(args => args[0] === 'docker' && args[1] === 'exec' && args[3] === 'python3');
  const sealAt = result.commands.findIndex(args => args[0] === 'node' && args[2] === 'seal');
  for (let index = 0; index < 3; index++) {
    assert.equal(restored[index][3], `surtitle-native-ci-${sha.slice(0, 12)}:${cacheTargets[index]}/`);
    assert.ok(result.commands.indexOf(restored[index]) < acquiredAt);
    assert.equal(saved[index][2], `surtitle-native-ci-${sha.slice(0, 12)}:${cacheTargets[index]}/.`);
    assert.ok(result.commands.indexOf(saved[index]) > sealAt);
    assert.deepEqual(readdirSync(join(f.root, 'cache', cacheNames[index])), ['new-cache.dat']);
    assert.equal(readFileSync(join(f.root, 'cache', 'previous-' + cacheNames[index], 'old-cache.dat'), 'utf8'), cacheNames[index]);
  }
  const hostRestores = result.commands.filter(args => args[0] === 'docker' && args[1] === 'cp' && args[2].includes('/cache/'));
  assert.deepEqual(hostRestores, restored);
  const create = result.commands.find(args => args[0] === 'docker' && args[1] === 'create');
  assert.ok(!create.some(arg => ['--env', '--mount', '--volume', '-v'].includes(arg)));
  assert.equal(result.commands.at(-1)[1], 'rm');
});

test('missing cache subdirectories are cold misses and a run without cache configuration does no cache transfer', t => {
  for (const configured of [true, false]) {
    const f = fixture(t, { populated: false });
    const result = f.run({ cacheRelative: configured ? 'cache' : null });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(imports(result.commands).length, 0);
    assert.equal(exports(result.commands).length, configured ? 3 : 0);
    if (configured) for (const name of cacheNames) assert.ok(result.stdout.includes('Native cache miss: ' + name));
  }
});

test('CCACHE_DISABLE is absent by default, forwards only explicit 1, and rejects every other supplied value before creating a container', t => {
  const disabled = fixture(t).run({ disable: '1' });
  assert.equal(disabled.status, 0, disabled.stderr);
  const create = disabled.commands.find(args => args[0] === 'docker' && args[1] === 'create');
  assert.equal(create[create.indexOf('--env') + 1], 'CCACHE_DISABLE=1');
  for (const disable of ['', '0', 'true']) {
    const result = fixture(t).run({ disable });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Use CCACHE_DISABLE=1/);
    noContainer(result);
  }
});

test('existing artifact output, non-directory caches, hard links and partial downloads fail before container creation or acquisition', t => {
  for (const invalid of ['output', 'cache-file', 'hard-link', 'partial']) {
    const f = fixture(t, { populated: false });
    if (invalid === 'output') f.write('work/native-ci-artifact/stale.dll', 'must remain unchanged');
    if (invalid === 'cache-file') f.write('cache/compiler', 'not a directory');
    if (invalid === 'hard-link') {
      f.write('outside', 'must remain unchanged');
      mkdirSync(join(f.root, 'cache/compiler'));
      linkSync(join(f.root, 'outside'), join(f.root, 'cache/compiler/linked-cache.dat'));
    }
    if (invalid === 'partial') f.write('cache/source-cache/nested/archive.tar.gz.partial', 'incomplete download');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fresh path|regular directory|hard-linked file|incomplete source download/);
    noContainer(result);
    if (invalid === 'hard-link') assert.equal(readFileSync(join(f.root, 'outside'), 'utf8'), 'must remain unchanged');
  }
});

test('acquisition, compilation or seal failure never exports reusable caches and always removes the disposable container', t => {
  for (const options of [{ acquireStatus: '21' }, { buildStatus: '22' }, { sealStatus: '23' }]) {
    const f = fixture(t), result = f.run(options);
    assert.equal(result.status, Number(Object.values(options)[0]), result.stderr);
    assert.equal(exports(result.commands).length, 0);
    for (const name of cacheNames) {
      assert.deepEqual(readdirSync(join(f.root, 'cache', name)), ['old-cache.dat']);
      assert.equal(existsSync(join(f.root, 'cache', 'previous-' + name)), false);
    }
    assert.deepEqual(result.commands.at(-1).slice(0, 3), ['docker', 'rm', '--force']);
  }
});

test.skipIf(process.platform === 'win32')('symlink cache roots, nested partial symlinks and FIFOs are rejected before any container exists', t => {
  for (const invalid of ['root-link', 'partial-link', 'fifo']) {
    const f = fixture(t, { populated: false });
    mkdirSync(join(f.root, 'cache/source-cache'));
    if (invalid === 'root-link') symlinkSync(join(f.root, 'cache'), join(f.root, 'cache-link'), 'dir');
    if (invalid === 'partial-link') {
      f.write('outside', 'untrusted target');
      symlinkSync(join(f.root, 'outside'), join(f.root, 'cache/source-cache/source.partial'));
    }
    if (invalid === 'fifo') {
      const mkfifo = spawnSync('mkfifo', [join(f.root, 'cache/source-cache/fifo')], { encoding: 'utf8' });
      assert.equal(mkfifo.status, 0, mkfifo.stderr);
    }
    const result = f.run({ cacheRelative: invalid === 'root-link' ? 'cache-link' : 'cache' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /regular directory|symlink or special file/);
    noContainer(result);
  }
});

test('filesystem inspection errors fail closed before creating or acquiring a native builder', t => {
  const f = fixture(t);
  f.write('bin/find', '#!/usr/bin/env bash\nprintf "inspection failed\\n" >&2\nexit 34\n', true);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inspection failed/);
  noContainer(result);
});
