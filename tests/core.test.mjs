import test from 'node:test';
import assert from 'node:assert/strict';
import { Runner, makePlan, isPassed } from '../src/core.mjs';

const p = (name = 'DC01PE21', eid = 1) => ({ pname: name, eid, pass: false });
function fixture(options = {}) {
  const rows = options.rows || [p()];
  const calls = []; const saved = []; let judged = false; let reads = 0;
  const api = {
    async catalog() { calls.push('catalog'); reads++;
      return rows.map(row => ({ ...row, pass: row.pass || (judged && options.catalogPass !== false) })); },
    async detail(eid) { calls.push('detail'); return { questionFullName: '第1章-DC01PE21', kind: 0, language: 1, ...options.detail }; },
    async compile() { calls.push('compile'); if (options.compileError) throw Error('timeout');
      return { result: options.compileResult ?? '编译成功' }; },
    async judge() { calls.push('judge'); if (options.judgeError) throw Error('unknown outcome');
      judged = true; return options.judgeResult || { passed: true, output: 'OK' }; }
  };
  const runner = new Runner({ api, bank: options.bank || { DC01PE21: 'code' },
    previous: options.previous || [], sleep: async () => {},
    save: async state => saved.push(structuredClone(state)), onChange: options.onChange });
  return { runner, calls, saved, rows };
}
test('scope and numeric ordering; ambiguous pass values never count', () => {
  const plan = makePlan([p('DC06PE01', 3), p('DC02PE05', 2), p(), { ...p('DC01PE22', 4), pass: 'true' }], { DC01PE21: 'c', DC02PE05: 'c' });
  assert.deepEqual(plan.map(x => x.pname), ['DC01PE21', 'DC01PE22', 'DC02PE05']);
  assert.equal(plan[1].status, 'no_bank'); assert.equal(isPassed({ pass: 'false' }), false);
});
test('duplicate identity fails closed', () => assert.throws(() => makePlan([p(), p()], {})));
test('completion requires compile, judge and server confirmation', async () => {
  const { runner, calls, saved } = fixture(); const result = await runner.start();
  assert.equal(result.state, 'completed'); assert.equal(result.records[0].status, 'passed');
  assert.equal(calls.filter(x => x === 'judge').length, 1);
  assert.ok(saved.some(x => x.records[0]?.status === 'judging'));
});
test('already passed questions never receive compile or judge POST', async () => {
  const { runner, calls } = fixture({ rows: [{ ...p(), pass: true }] });
  await runner.start(); assert.ok(!calls.includes('compile')); assert.ok(!calls.includes('judge'));
});
test('local passed record never substitutes for server result', async () => {
  const { runner, calls } = fixture({ previous: [{ pname:'DC01PE21', status:'passed' }] });
  await runner.start(); assert.ok(calls.includes('judge'));
});
test('judge success without catalog confirmation remains uncertain', async () => {
  const { runner, calls } = fixture({ catalogPass: false }); const result = await runner.start();
  assert.equal(result.state, 'uncertain'); assert.equal(result.records[0].status, 'uncertain');
  assert.equal(calls.filter(x => x === 'judge').length, 1);
});
test('judge failure pauses without retrying or starting next problem', async () => {
  const { runner, calls } = fixture({ rows: [p(), p('DC01PE22', 2)], judgeResult: { passed: false, output:'ERROR' } });
  const result = await runner.start(); assert.equal(result.state, 'failed');
  assert.equal(calls.filter(x => x === 'judge').length, 1); assert.equal(result.records.length, 1);
});
test('unknown judge outcome is persisted and cannot be automatically resubmitted', async () => {
  const { runner, calls } = fixture({ judgeError: true });
  await runner.start(); const before = calls.length; const result = await runner.start();
  assert.equal(result.state, 'uncertain'); assert.ok(!calls.slice(before).includes('judge'));
});
test('unknown compilation outcome cannot be retried automatically', async () => {
  const { runner, calls } = fixture({ compileError: true });
  await runner.start(); const before = calls.length; await runner.start();
  assert.ok(!calls.slice(before).includes('compile'));
});
test('compiler error never judges', async () => {
  const { runner, calls } = fixture({ compileResult: '编译失败' });
  const result = await runner.start(); assert.equal(result.state, 'compile_failed'); assert.ok(!calls.includes('judge'));
});
test('wrong question identity never compiles', async () => {
  const { runner, calls } = fixture({ detail: { questionFullName:'第2章-DC02PE05' } });
  const result = await runner.start(); assert.equal(result.state, 'protocol_error'); assert.ok(!calls.includes('compile'));
});
test('stop between compilation and judging sends no judge POST', async () => {
  const { runner, calls } = fixture();
  runner.onChange = state => { if (state.records[0]?.status === 'compiling') runner.stopRequested = true; };
  const result = await runner.start(); assert.equal(result.state, 'stopped'); assert.ok(!calls.includes('judge'));
});
test('missing answer pauses without writes', async () => {
  const { runner, calls } = fixture({ bank: {} });
  const result = await runner.start(); assert.equal(result.state, 'no_bank'); assert.ok(!calls.includes('compile'));
});
test('a previously uncertain request reconciles as passed without another write', async () => {
  const { runner, calls } = fixture({ rows: [{ ...p(), pass: true }], previous:[{pname:'DC01PE21',status:'uncertain'}] });
  const result = await runner.start(); assert.equal(result.state, 'completed'); assert.ok(!calls.includes('judge'));
});
test('out-of-scope single question is rejected', async () => {
  const { runner } = fixture(); await assert.rejects(runner.start({only:'DC06PE01'}));
});
test('malformed judge response cannot become passed', async () => {
  const { runner } = fixture({ judgeResult: { passed:'true' } });
  const result = await runner.start(); assert.equal(result.state, 'uncertain');
});
