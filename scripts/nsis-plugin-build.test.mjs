import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDependencyAcquisition } from './native-installer-audit.mjs';

test('isolated NSIS acquisition preserves source and locks, rejecting source/config changes and the wrong pnpm', () => {
  const child = spawnSync('python', ['-c', String.raw`
import importlib.util, json, tempfile
from pathlib import Path
import sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('nsis_build', sys.argv[1])
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
def rejected(call, message):
    try:
        call()
    except RuntimeError as error:
        assert message in str(error), str(error)
    else:
        raise AssertionError('Expected rejection: ' + message)
with tempfile.TemporaryDirectory(prefix='nsis acquisition 日本語 & ') as directory:
    root = Path(directory)
    build.WORKSPACE = root
    (root / 'package.json').write_text(json.dumps({'packageManager': 'pnpm@12.4.2'}))
    source = root / 'source'
    (source / '.cargo').mkdir(parents=True)
    (source / 'Cargo.toml').write_text('[workspace]\n')
    (source / 'Cargo.lock').write_bytes(b'locked upstream bytes\r\n')
    config = source / '.cargo/config.toml'
    config.write_text('[build]\ntarget = "i686-pc-windows-msvc"\n')
    original = build.inventory(source)
    rejected(lambda: build.prepare_acquisition(root, '12.3.4'), 'packageManager pin')
    assert not (root / 'dependency-acquisition').exists()
    acquisition = build.prepare_acquisition(root, '12.4.2')
    receipt = {'sourceFiles': original, 'dependencyAcquisition': acquisition}
    assert not (root / 'dependency-acquisition/package.json').exists()
    assert (root / 'dependency-acquisition/Cargo.lock').read_bytes() == (source / 'Cargo.lock').read_bytes()
    build.validate_acquisition(root, receipt)
    copied_config = root / 'dependency-acquisition/.cargo/config.toml'
    copied_config.write_text(config.read_text() + '\n# >>> pnpm-managed cargo sources >>>\n[source.crates-io]\nreplace-with = "pnpm"\n# <<< pnpm-managed cargo sources <<<\n')
    build.validate_acquisition(root, receipt)
    assert build.inventory(source) == original
    copied_config.write_text(copied_config.read_text().replace('i686', 'x86_64'))
    rejected(lambda: build.validate_acquisition(root, receipt), 'upstream Cargo settings')
    copied_config.write_text(config.read_text())
    copied_lock = root / 'dependency-acquisition/Cargo.lock'
    copied_lock.write_bytes(b'changed')
    rejected(lambda: build.validate_acquisition(root, receipt), 'locked upstream source')
    copied_lock.write_bytes((source / 'Cargo.lock').read_bytes())
    (source / 'Cargo.lock').write_bytes(b'changed original')
    rejected(lambda: build.validate_acquisition(root, receipt), 'Prepared source tree changed')
print(json.dumps(acquisition))
`, fileURLToPath(new URL('./nsis-plugin-build.py', import.meta.url))], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  validateDependencyAcquisition({ dependencyAcquisition: JSON.parse(child.stdout), dependencyInstallLogSha256: 'a'.repeat(64) }, 'pnpm@12.4.2');
});
