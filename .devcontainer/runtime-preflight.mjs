import { readFileSync } from 'node:fs';
import { maskTargets, workspace } from './isolation.mjs';

// No Docker socket is exposed to the container. Check the kernel mount inventory
// before package installation, including mounts injected by an editor client.
const decode = text => text.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
const mounts = readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n').map(line => {
  const [left, right] = line.split(' - ');
  const fields = left.split(' ');
  return { target: decode(fields[4]), options: fields[5].split(','), type: right.split(' ')[0] };
});
const source = mounts.find(mount => mount.target === workspace);
if (!source?.options.includes('rw')) throw new Error('The source repository must be a read/write bind mount');
for (const target of maskTargets) {
  const mount = mounts.find(item => item.target === target);
  if (!mount || mount.type !== 'tmpfs' || !mount.options.includes('rw') || mount.options.includes('noexec')) throw new Error('Missing executable temporary output mask: ' + target);
}
const allowedSystem = target => target === '/' || ['/proc', '/sys', '/dev'].some(prefix => target === prefix || target.startsWith(prefix + '/')) || ['/etc/hosts', '/etc/hostname', '/etc/resolv.conf'].includes(target);
for (const mount of mounts) {
  if (mount.target === workspace || maskTargets.includes(mount.target) || allowedSystem(mount.target)) continue;
  throw new Error('Unexpected client/host mount: ' + mount.target + '. Use container.mjs start and attach to that existing container.');
}
console.log('Kernel mount preflight passed: shared source, temporary outputs, no editor-injected mounts.');
