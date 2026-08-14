import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Watch mode for the collector.
 *
 * The obvious script — `node --experimental-strip-types src/index.ts` — cannot
 * work here, and never could on any version of Node. The sources import
 * `./battle/loop.js`, which is what `NodeNext` requires them to write for the
 * *compiled* output, and Node's type stripping does not rewrite `.js` back to
 * `.ts`. It looks for a file that is not on disk and stops.
 *
 * So the collector is compiled and then run, both watching. That needs two
 * processes at once, and there is no portable way to say that in an npm script:
 * `&` backgrounds on sh and means something else entirely on cmd.exe. This file
 * costs less than a dependency, and less than telling everyone to open two
 * terminals for the command the README documents as one.
 */

const require = createRequire(import.meta.url);

let stopping = false;
const children = [];

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill();
}

/**
 * Spawn `node <argv…>` with this process's stdio.
 *
 * Through `process.execPath` rather than a shell, because this repository can
 * live at a path with a space in it and `.bin/tsc` is a `.cmd` shim on Windows
 * that only a shell can start.
 */
function run(label, argv) {
  const child = spawn(process.execPath, argv, { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    // Either half dying takes the other with it. A watcher left running against
    // a dead process is the worst of both: it looks alive and rebuilds nothing
    // anybody is serving.
    if (stopping) return;
    console.error(
      `[dev] ${label} exited (${signal ?? code}) — stopping the other half`,
    );
    stop(typeof code === 'number' ? code : 1);
  });
  children.push(child);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));

// `--preserveWatchOutput` keeps tsc from clearing the screen on every rebuild,
// which would take the collector's own log with it.
run('tsc', [
  require.resolve('typescript/bin/tsc'),
  '--build',
  'tsconfig.build.json',
  '--watch',
  '--preserveWatchOutput',
]);

// Watching the output rather than the source: tsc owns the rebuild, node owns
// the restart. On a cold clone `dist/` does not exist yet — node reports the
// missing entry and keeps watching, then starts for real once tsc emits.
run('collector', [
  '--env-file-if-exists=../../.env',
  '--watch',
  '--watch-preserve-output',
  'dist/index.js',
]);
