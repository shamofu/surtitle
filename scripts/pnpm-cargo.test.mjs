// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { execute } from './run-required-rust-tests.mjs';

const marker = 'SURTITLE_PNPM_ARGUMENTS=';
const packageScripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;

async function fixture(t) {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, 'surtitle pnpm 日本語 & '));
  t.onTestFinished(() => {
    assert.equal(dirname(root), parent, 'Only remove the temporary fixture subtree');
    rmSync(root, { recursive: true, force: true });
  });
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // Exercise the real repository scripts without triggering dependency setup or
  // package-manager downloads in the standalone fixture.
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: packageScripts }));
  copyFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), join(root, 'pnpm-workspace.yaml'));
  writeFileSync(join(root, 'empty.npmrc'), '');
  writeFileSync(join(bin, 'report.mjs'), `
const [command, ...args] = process.argv.slice(2);
console.log(${JSON.stringify(marker)} + JSON.stringify({ command, args }));
process.exitCode = Number(process.env.SURTITLE_PNPM_TEST_EXIT);
`);
  if (process.platform === 'win32') {
    // Native executables avoid adding a batch-file argument parser that Cargo
    // and Tauri do not use. The Windows .NET Framework compiler is preinstalled.
    const source = join(bin, 'report.cs');
    writeFileSync(source, String.raw`
using System;
using System.IO;
using System.Text;
class Report {
  static string Quote(string value) {
    return "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
  }
  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    string command = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]);
    Console.WriteLine("SURTITLE_PNPM_ARGUMENTS={\"command\":" + Quote(command) +
      ",\"args\":[" + string.Join(",", Array.ConvertAll(args, Quote)) + "]}");
    return int.Parse(Environment.GetEnvironmentVariable("SURTITLE_PNPM_TEST_EXIT"));
  }
}
`);
    const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const compiled = await execute(compiler, ['/nologo', '/target:exe', '/out:' + join(bin, 'cargo.exe'), source],
      { cwd: root, env: process.env, timeoutMs: 6_000, showStdout: false });
    assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr);
    copyFileSync(join(bin, 'cargo.exe'), join(bin, 'tauri.exe'));
  } else {
    for (const command of ['cargo', 'tauri']) {
      const launcher = join(bin, command);
      writeFileSync(launcher, `#!/bin/sh\nexec "$SURTITLE_PNPM_TEST_NODE" "$SURTITLE_PNPM_TEST_REPORT" ${command} "$@"\n`);
      chmodSync(launcher, 0o755);
    }
  }
  // Windows environment keys are case-insensitive, but Node can inherit both
  // Path and PATH. Keep one spelling so the fake tools always take precedence.
  const replaced = new Set(['path', 'npm_config_userconfig', 'xdg_cache_home', 'xdg_state_home', 'xdg_config_home', 'xdg_data_home',
    'pnpm_config_shell_emulator', 'npm_config_shell_emulator', 'pnpm_config_script_shell', 'npm_config_script_shell',
    'pnpm_config_verify_deps_before_run']);
  const inheritedPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !replaced.has(key.toLowerCase()))),
    PATH: bin + delimiter + inheritedPath,
    npm_config_userconfig: join(root, 'empty.npmrc'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    COREPACK_ENABLE_NETWORK: '0',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'never',
    SURTITLE_PNPM_TEST_NODE: process.execPath,
    SURTITLE_PNPM_TEST_REPORT: join(bin, 'report.mjs'),
  };
  return { root, env };
}

async function runScript(f, name, args = [], exitCode = 0) {
  const pnpmArgs = ['run', name, ...args];
  const env = { ...f.env, SURTITLE_PNPM_TEST_EXIT: String(exitCode), SURTITLE_PNPM_TEST_ARGS: JSON.stringify(pnpmArgs) };
  let command = 'pnpm', commandArgs = pnpmArgs;
  if (process.platform === 'win32') {
    // pnpm may be an executable, npm .cmd shim or PowerShell script. Resolve it
    // in PowerShell and pass an argument array, never interpolated shell text.
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$pnpm = (Get-Command pnpm -ErrorAction Stop).Source
$arguments = @(ConvertFrom-Json $env:SURTITLE_PNPM_TEST_ARGS)
& $pnpm @arguments
exit $LASTEXITCODE
`;
    command = 'pwsh';
    commandArgs = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  }
  const result = await execute(command, commandArgs, { cwd: f.root, env, timeoutMs: 6_000, showStdout: false });
  const lines = result.stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
  assert.equal(lines.length, 1, `Expected one fake-tool invocation.\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null);
  return { code: result.code, invocation: JSON.parse(lines[0].slice(marker.length)) };
}

test('pnpm forwards native paths and Rust separators and preserves command failure', async t => {
  const f = await fixture(t);
  const data = join(f.root, '学習 data & profile');
  const media = join(f.root, '動画 media & clip.mp4');
  const seed = await runScript(f, 'seed:fixtures', [data, media]);
  assert.equal(seed.code, 0);
  assert.deepEqual(seed.invocation, {
    command: 'cargo', args: ['run', '-p', 'surtitle-core', '--example', 'seed_fixture', '--locked', '--', data, media],
  });

  const packaged = await runScript(f, 'package:app');
  assert.equal(packaged.code, 0);
  assert.deepEqual(packaged.invocation, { command: 'tauri', args: ['build', '--bundles', 'nsis', '--', '--locked'] });

  const args = ['test', '-p', 'surtitle-core', '--locked', 'module::filtered_test', '--', '--ignored', '--exact', '--nocapture',
    '--skip', String.raw`module::literal_\d+"quoted"&$value`];
  const failed = await runScript(f, 'rust', args, 23);
  assert.deepEqual(failed.invocation, { command: 'cargo', args });
  assert.equal(failed.code, 23, 'pnpm must preserve the Rust command failure exit code');
}, 35_000);
