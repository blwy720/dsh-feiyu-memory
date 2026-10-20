import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
let checked = 0;
for (const dir of ['lib','scripts','test']) {
  for (const file of readdirSync(join(root,dir))) {
    if (!file.endsWith('.js')) continue;
    const result = spawnSync(process.execPath,['--check',join(root,dir,file)],{encoding:'utf8'});
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode=1; }
    checked++;
  }
}
console.log(`Syntax checked ${checked} JavaScript files.`);
