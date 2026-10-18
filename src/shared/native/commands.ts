// SPDX-License-Identifier: GPL-3.0-or-later
import { commandArguments, commandResults } from './command-registry';
import { isChangeDomain, isRecord, type ChangeDomain } from '../contracts/synchronization';
export type CommandName = keyof typeof commandArguments;
type Schema = typeof commandArguments;
type Value<T> = T extends `${infer Kind}?` ? Value<Kind> | null : T extends 'string' ? string : T extends 'number' ? number : T extends 'boolean' ? boolean : T extends 'strings' ? string[] : T extends 'domains' ? ChangeDomain[] : T extends 'array' ? unknown[] : object;
type OptionalKeys<K extends CommandName> = { [P in keyof Schema[K]]: Schema[K][P] extends `${string}?` ? P : never }[keyof Schema[K]];
type RequiredKeys<K extends CommandName> = Exclude<keyof Schema[K], OptionalKeys<K>>;
export type CommandArgs<K extends CommandName> = { [P in RequiredKeys<K>]: Value<Schema[K][P]> } & { [P in OptionalKeys<K>]?: Value<Schema[K][P]> };
export type CommandCall = { [K in CommandName]: RequiredKeys<K> extends never ? [command: K, args?: CommandArgs<K>] : [command: K, args: CommandArgs<K>] }[CommandName];
/** Reject drift before IPC; Rust serde/use cases retain nested DTO and semantic validation. */
export function validateCommand(command: string, args: unknown) {
  if (!Object.hasOwn(commandArguments, command)) throw new Error(`Unknown native command: ${command}`);
  const schema = commandArguments[command as CommandName] as Record<string, string>;
  const value = args === undefined ? {} : args;
  if (!isRecord(value) || Object.keys(value).some(key => !Object.hasOwn(schema, key))) throw new Error(`Invalid arguments for ${command}`);
  for (const [key, definition] of Object.entries(schema)) {
    const field = value[key], optional = definition.endsWith('?'), kind = definition.replace(/\?$/, '');
    if (optional && field == null) continue;
    const valid = kind === 'number' ? typeof field === 'number' && Number.isFinite(field)
      : kind === 'string' || kind === 'boolean' ? typeof field === kind
      : kind === 'strings' ? Array.isArray(field) && field.every(item => typeof item === 'string')
      : kind === 'domains' ? Array.isArray(field) && field.every(isChangeDomain)
      : kind === 'array' ? Array.isArray(field) : isRecord(field);
    if (!valid) throw new Error(`Invalid ${command}.${key}`);
  }
}

/** Validate native return envelopes before typed consumers see them. Nested DTO
 * semantics remain with native serde and use cases; protocol fixtures cover the wire mapping. */
export function validateCommandResult(command: CommandName, value: unknown) {
  function valid(rust: string, item: unknown): boolean {
    if (rust.startsWith('Option<')) return item === null || valid(rust.slice(7, -1), item);
    if (rust.startsWith('Vec<')) return Array.isArray(item) && item.every(value => valid(rust.slice(4, -1), value));
    if (rust === '()') return item === null || item === undefined;
    if (rust === 'String') return typeof item === 'string';
    if (rust === 'bool') return typeof item === 'boolean';
    if (rust === 'RestoreResult') return isRecord(item) && Array.isArray(item.warnings) && item.warnings.every(warning => typeof warning === 'string');
    return isRecord(item);
  }
  if (!valid(commandResults[command], value)) throw new Error(`Invalid native result: ${command}`);
}
