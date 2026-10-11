// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { commandRegistry, registrySource } from './generate-ipc-contract.mjs';

it('keeps generated IPC envelopes in sync with every registered native command', () => {
  expect(readFileSync(new URL('../src/shared/native/command-registry.ts', import.meta.url), 'utf8')).toBe(registrySource());
  const entrypoint = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const handler = entrypoint.match(/generate_handler!\[([\s\S]*?)\]/)?.[1];
  expect(handler).toBeDefined();
  const registered = [...handler.matchAll(/commands::\w+::(\w+)/g)].map(match => match[1]).sort();
  expect(Object.keys(commandRegistry()).sort()).toEqual(registered);
  expect(commandRegistry().start_url_import).not.toHaveProperty('App');
});
