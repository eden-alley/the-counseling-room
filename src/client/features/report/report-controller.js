import { deriveTitle } from '../../shared/format.js';

/** @typedef {{ questions: string[], answers: { question: string, answer: string }[], index: number, status: string, error: string }} ReportState */
/** @typedef {{ token: symbol, session: any, sessionId: string, messages: readonly any[], state: ReportState, abortController: AbortController | null }} ReportRun */

/** @param {{ api: any, repository: any, view: any, getSession: () => any, setSession: (session: any) => void, buildMessages: (session: any) => any, now?: () => string }} dependencies */
export function createReportController({ api, repository, view, getSession, setSession, buildMessages, now = () => new Date().toISOString() }) {
  /** @returns {ReportState} */
  function emptyState() { return { questions: [], answers: [], index: 0, status: 'idle', error: '' }; }
  let state = emptyState();
  /** @type {ReportRun | null} */ let pending = null;

  /** @param {ReportRun} run */
  function isCurrent(run) { const session = getSession(); return pending?.token === run.token && session === run.session && session?.id === run.sessionId; }

  function cancelPending() {
    const previous = pending;
    const restore = previous && isCurrent(previous);
    pending = null;
    previous?.abortController?.abort();
    state = emptyState();
    if (restore) view.restore(previous.session.summaryMarkdown);
  }

  function openSummary() {
    const session = getSession();
    if (!session?.messages?.length) { view.toast('请先完成一些对话'); return false; }
    cancelPending();
    view.open(session);
    return true;
  }

  /** @returns {ReportRun | null} */
  function beginRun() {
    if (pending && isCurrent(pending)) return null;
    cancelPending();
    const session = getSession();
    if (!session?.messages?.length) { view.toast('请先完成一些对话'); return null; }
    try {
      const messages = buildMessages(session);
      if (!Array.isArray(messages) || !messages.length || messages.some(message => !message || typeof message.content !== 'string')) throw new Error('对话内容格式不正确，暂时无法提交总结。');
      if (messages.length > 60) throw new Error('包含入口上下文的对话超过 60 条，暂时无法提交总结；原对话已保留。');
      if (messages.some(message => Array.from(message.content).length > 8000)) throw new Error('单条对话超过 8000 字，暂时无法提交总结；原内容已保留。');
      pending = {
        token: Symbol('report'), session, sessionId: session.id,
        messages: Object.freeze(messages.map(message => Object.freeze({ ...message }))),
        state, abortController: typeof AbortController === 'undefined' ? null : new AbortController(),
      };
      return pending;
    } catch (reason) {
      state.error = reason instanceof Error ? reason.message : String(reason);
      view.error(state.error);
      return null;
    }
  }

  /** @param {ReportRun} run @param {unknown} reason */
  function fail(run, reason) {
    if (!isCurrent(run)) return;
    pending = null;
    run.state.status = 'idle';
    run.state.error = reason instanceof Error ? reason.message : String(reason);
    view.restore(run.session.summaryMarkdown);
    view.error(run.state.error);
  }

  async function startReport() {
    const run = beginRun();
    if (!run) return;
    run.state.status = 'auditing';
    view.loading('audit');
    try {
      const questions = await api.auditReport(run.messages, run.abortController?.signal);
      if (!isCurrent(run)) return;
      run.state.questions = [...questions];
      if (!questions.length) await generateForRun(run);
      else { run.state.status = 'questioning'; showQuestion(run); }
    } catch (reason) { fail(run, reason); }
  }

  /** @param {ReportRun} run */
  function showQuestion(run) { view.question(run.state.questions[run.state.index], run.state.index + 1, run.state.questions.length); }

  /** @param {string} answer */
  async function answerCurrentQuestion(answer) {
    const run = pending;
    if (!run || !isCurrent(run) || run.state.status !== 'questioning') return;
    if (answer.length > 4000) { view.toast('回答不能超过 4000 字，请缩短后再继续；当前内容已保留。'); return; }
    const value = answer.trim();
    if (!value) { view.toast('请输入回答，或选择跳过'); return; }
    await advance(run, value);
  }

  async function skipCurrentQuestion() {
    const run = pending;
    if (!run || !isCurrent(run) || run.state.status !== 'questioning') return;
    await advance(run, '');
  }

  /** @param {ReportRun} run @param {string} answer */
  async function advance(run, answer) {
    run.state.answers.push({ question: run.state.questions[run.state.index], answer });
    run.state.index += 1;
    if (run.state.index < run.state.questions.length) showQuestion(run);
    else await generateForRun(run);
  }

  /** @param {ReportRun} run */
  async function generateForRun(run) {
    if (!isCurrent(run) || run.state.status === 'generating') return;
    run.state.status = 'generating';
    view.loading('generate');
    try {
      const report = await api.generateReport(run.messages, run.state.answers.map(answer => ({ ...answer })), run.abortController?.signal);
      if (!isCurrent(run)) return;
      const endedAt = now();
      const updated = {
        ...run.session, summaryMarkdown: report, endedAt, updatedAt: endedAt,
        title: deriveTitle(report, run.session.entryLabel),
        messageCount: run.session.messages.filter(/** @param {any} message */ message => message.role === 'user').length,
        durationSeconds: Math.max(0, Math.floor((new Date(endedAt).getTime() - new Date(run.session.startedAt).getTime()) / 1000)),
      };
      await repository.upsertHistory(updated);
      if (!isCurrent(run)) return;
      await repository.saveCurrentSession(updated);
      if (!isCurrent(run)) return;
      Object.assign(run.session,updated);
      setSession(run.session);
      pending = null;
      run.state.status = 'idle';
      view.render(report);
      view.toast('总结已保存到历史');
    } catch (reason) { fail(run, reason); }
  }

  async function generateReport() { const run = beginRun(); if (run) await generateForRun(run); }

  function downloadSummary() { const session = getSession(); if (!session?.summaryMarkdown) return; view.download(`咨询总结-${session.endedAt ? session.endedAt.slice(0, 10) : now().slice(0, 10)}.md`, session.summaryMarkdown); view.toast('总结已导出'); }
  return { openSummary, startReport, answerCurrentQuestion, skipCurrentQuestion, generateReport, cancelPending, downloadSummary, getState: () => ({ ...state, questions: [...state.questions], answers: state.answers.map(answer => ({ ...answer })) }) };
}
