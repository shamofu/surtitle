// SPDX-License-Identifier: GPL-3.0-or-later
// Match the public wdio executable's environment and argument handling.
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'test';
const { run } = await import('@wdio/cli');
await run();
