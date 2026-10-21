import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../scripts/cli.js', import.meta.url));
test('CLI runs offline through capture, search, original read, review and retention', () => {
  const dir = mkdtempSync(join(tmpdir(),'feiyu-cli-test-'));
  try {
    const data = join(dir,'data');
    const run = (command, flags=[], expected=0) => {
      const result = spawnSync(process.execPath,[cli,command,'--data',data,'--instance','cli-test',...flags],{encoding:'utf8'});
      assert.equal(result.status,expected,result.stderr || result.stdout);
      return expected===0 ? JSON.parse(result.stdout) : result;
    };
    run('init');
    const rawPath = join(dir,'raw.json');
    writeFileSync(rawPath,JSON.stringify({id:'cli-original',sessionId:'cli-session',pool:'a',role:'user',text:'如果我中了800万，我就买房。',recordedAt:'2000-01-03T10:00:00Z',occurredAt:'1999-12-01T00:00:00Z'}));
    run('append',['--input',rawPath]);
    const found = run('search',['--query','800万','--from','1999-12-01','--to','1999-12-01','--axis','occurred']);
    assert.ok(found.candidates.some(c=>c.id==='cli-original'));
    assert.match(JSON.stringify(run('read',['--id','cli-original'])),/如果我中了800万/);
    const preview = run('slide');
    assert.equal(preview.removed,0);
    assert.ok(preview.blocked>=1);
    const reviewPath = join(dir,'review.json');
    writeFileSync(reviewPath,JSON.stringify({ids:['cli-original'],decision:'retain',reason:'保存原始证据'}));
    run('review',['--input',reviewPath]);
    const applied = run('slide',['--apply']);
    assert.equal(applied.removed,1);
    assert.match(JSON.stringify(run('read',['--id','cli-original'])),/如果我中了800万/);
    const mismatch = spawnSync(process.execPath,[cli,'read','--data',data,'--instance','wrong-instance','--id','cli-original'],{encoding:'utf8'});
    assert.notEqual(mismatch.status,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('CLI rejects unknown commands and missing identity without starting host', () => {
  for (const args of [['unknown'],['init','--data','unused']]) {
    const result = spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});
    assert.equal(result.status,1);
    assert.ok(JSON.parse(result.stderr.split('\n').find(l=>l.startsWith('{'))).error);
  }
});

test('CLI exposes read pages, historical versions and rebuilds missing day/wake projections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feiyu-cli-recovery-'));
  const data = join(dir, 'data');
  try {
    const run = (command, flags = []) => {
      const result = spawnSync(process.execPath, [cli, command, '--data', data, '--instance', 'cli-pages', ...flags], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    };
    const input = join(dir, 'input.json');
    writeFileSync(input, JSON.stringify({ id: 'pages-raw', pool: 'a', role: 'user', sessionId: 'synthetic', text: '第一页第二页第三页', recordedAt: '2026-09-03T10:00:00Z' }));
    run('append', ['--input', input]);
    const page = run('read', ['--id', 'pages-raw', '--offset', '3', '--limit', '3']);
    assert.equal(page.text, '第二页');
    assert.equal(page.hasMore, true);
    assert.equal(page.nextOffset, 6);
    for (const [recordedAt, text] of [['2026-09-03T10:00:00Z', '九月旧版'], ['2026-10-03T10:00:00Z', '十月新版']]) {
      writeFileSync(input, JSON.stringify({ id: 'versioned', statementType: 'fact', kind: 'memory', text, recordedAt, sources: [] }));
      run('write', ['--input', input]);
    }
    assert.equal(run('list', ['--date', '2026-09-03', '--type', 'memory']).candidates[0].version, 1);
    assert.equal(run('search', ['--type', 'memory', '--include-history']).total, 2);
    const day = join(data, 'a', '2026', '09', '03', '_day.md');
    const wake = join(data, '_wake.md');
    run('day-end', ['--date', '2026-09-03']);
    rmSync(day);
    rmSync(wake);
    const rebuilt = run('rebuild');
    assert.equal(rebuilt.projectionPending, false);
    assert.equal(existsSync(day), true);
    assert.equal(existsSync(wake), true);
    assert.match(readFileSync(day, 'utf8'), /pages-raw/);
    assert.equal(run('doctor').moduleVersion, '0.5.2');
    writeFileSync(input, JSON.stringify({ ids: ['pages-raw'], decision: 'discard', reason: 'synthetic deletion recovery' }));
    run('review', ['--input', input]);
    run('slide', ['--apply']);
    run('rebuild');
    run('doctor');
    assert.equal(existsSync(day), true);
    assert.ok(!readFileSync(day, 'utf8').includes('第一页'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
