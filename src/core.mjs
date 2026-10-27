// The transport is injected; this module never handles login credentials.
export class Halt extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function chapterOf(p) {
  const m = /^DC(\d{2})PE\d+[a-z]?$/i.exec(p.pname || '');
  return m ? Number(m[1]) : null;
}

export function isPassed(p) { return p?.pass === true; }

export function makePlan(catalog, bank) {
  if (!Array.isArray(catalog)) throw new Halt('protocol_error', '目录格式异常');
  const seen = new Set();
  return catalog.filter(p => chapterOf(p) >= 1 && chapterOf(p) <= 5)
    .map(p => {
      if (seen.has(p.pname) || p.eid == null) throw new Halt('protocol_error', '题号重复或缺少 eid');
      seen.add(p.pname);
      return { ...p, chapter: chapterOf(p), status: isPassed(p) ? 'already_passed' :
        (Object.hasOwn(bank, p.pname) ? 'pending' : 'no_bank') };
    }).sort((a, b) => a.pname.localeCompare(b.pname, 'en', { numeric: true }));
}

export class Runner {
  constructor({ api, bank, save, onChange = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), previous = [] }) {
    this.api = api; this.bank = bank; this.save = save; this.onChange = onChange;
    this.sleep = sleep; this.records = previous; this.running = false; this.stopRequested = false;
    this.state = 'idle'; this.current = null;
  }
  stop() { this.stopRequested = true; this.onChange(this.snapshot()); }
  snapshot() { return { version: 1, state: this.state, running: this.running,
    stopRequested: this.stopRequested, current: this.current, message: this.message || '', records: structuredClone(this.records) }; }
  async persist() { await this.save(this.snapshot()); this.onChange(this.snapshot()); }
  checkpoint() { if (this.stopRequested) throw new Halt('stopped', '已停止；不会开始下一次请求'); }
  async plan() { return makePlan(await this.api.catalog(), this.bank); }
  record(p, status, extra = {}) {
    const entry = { pname: p.pname, eid: p.eid, chapter: chapterOf(p), status,
      updatedAt: new Date().toISOString(), ...extra };
    const index = this.records.findIndex(x => x.pname === p.pname);
    if (index >= 0) this.records[index] = entry; else this.records.push(entry);
    return entry;
  }
  async start({ only = null } = {}) {
    if (this.running) throw new Halt('busy', '当前批次仍在运行');
    if (only && !/^DC0[1-5]PE\d+[a-z]?$/i.test(only)) throw new Halt('scope_error', '仅支持第一至第五章');
    this.running = true; this.stopRequested = false; this.state = 'running'; this.message = '';
    try {
      let plan = await this.plan();
      if (only) plan = plan.filter(p => p.pname === only);
      if (!plan.length) throw new Halt('scope_error', '没有匹配的题目');
      for (const planned of plan) {
        this.checkpoint(); this.current = planned.pname;
        // Always reconcile against the server, including after a previous interruption.
        const fresh = (await this.api.catalog()).find(p => p.pname === planned.pname);
        if (!fresh || String(fresh.eid) !== String(planned.eid)) throw new Halt('protocol_error', '目录发生变化');
        if (isPassed(fresh)) {
          this.record(fresh, 'already_passed', { catalogPass: true }); await this.persist(); continue;
        }
        const old = this.records.find(x => x.pname === fresh.pname);
        if (old && ['compiling', 'judging', 'uncertain'].includes(old.status))
          throw new Halt('uncertain', `${fresh.pname} 上次请求结果不明确；请人工核对，禁止自动重发`);
        if (!Object.hasOwn(this.bank, fresh.pname)) {
          this.record(fresh, 'no_bank'); await this.persist(); throw new Halt('no_bank', '缺少题解，已暂停');
        }
        this.checkpoint();
        const detail = await this.api.detail(fresh.eid);
        if (detail.questionFullName !== `第${chapterOf(fresh)}章-${fresh.pname}` ||
            detail.kind == null || detail.language == null)
          throw new Halt('protocol_error', '题目详情、章节或语言与目录不一致');
        this.record(fresh, 'compiling'); await this.persist(); this.checkpoint();
        const compile = await this.api.compile(fresh, detail, this.bank[fresh.pname]);
        if (typeof compile.result !== 'string') throw new Halt('uncertain', '编译结果缺少 result');
        if (!compile.result.includes('编译成功')) {
          this.record(fresh, 'compile_failed', { output: compile.result.slice(0, 8000) });
          await this.persist(); throw new Halt('compile_failed', '编译失败，已暂停');
        }
        this.checkpoint();
        this.record(fresh, 'judging', { compileOk: true }); await this.persist(); this.checkpoint();
        // Exactly one judge POST. Never hide uncertain outcomes behind automatic retries.
        const judged = await this.api.judge(fresh, detail, this.bank[fresh.pname]);
        if (typeof judged.passed !== 'boolean') throw new Halt('uncertain', '判题响应缺少布尔 passed');
        let confirmed = false;
        for (let poll = 0; poll < 4; poll++) {
          if (poll) { this.checkpoint(); await this.sleep(1000); }
          const row = (await this.api.catalog()).find(p => p.pname === fresh.pname);
          if (!row || String(row.eid) !== String(fresh.eid)) throw new Halt('protocol_error', '复核时目录变化');
          confirmed = isPassed(row);
          if (confirmed || !judged.passed) break;
        }
        const output = typeof judged.output === 'string' ? judged.output.slice(0, 8000) : '';
        if (!judged.passed || !confirmed) {
          this.record(fresh, judged.passed ? 'uncertain' : 'failed', {
            compileOk: true, judgePassed: judged.passed, catalogPass: confirmed, output });
          await this.persist(); throw new Halt(judged.passed ? 'uncertain' : 'failed', '尚未双重确认通过，已暂停');
        }
        this.record(fresh, 'passed', { compileOk: true, judgePassed: true, catalogPass: true, output });
        await this.persist();
      }
      // Final authoritative read; absence or false cannot be reported as completion.
      const finalPlan = (await this.plan()).filter(p => !only || p.pname === only);
      if (finalPlan.length !== plan.length || finalPlan.some(p => p.status !== 'already_passed'))
        throw new Halt('uncertain', '最终目录复核未全部通过');
      this.state = 'completed';
    } catch (err) {
      this.state = err instanceof Halt ? err.status : 'uncertain';
      const record = this.records.find(x => x.pname === this.current);
      if (record && ['compiling', 'judging'].includes(record.status) && this.state !== 'stopped') {
        record.status = 'uncertain'; record.updatedAt = new Date().toISOString();
      }
      this.message = err instanceof Halt ? err.message : '请求失败，结果不明确；请核对后继续';
    } finally {
      this.running = false; await this.persist();
    }
    return this.snapshot();
  }
}
