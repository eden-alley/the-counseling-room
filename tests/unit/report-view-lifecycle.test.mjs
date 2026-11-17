import assert from 'node:assert/strict';
import test from 'node:test';
import { createReportView } from '../../src/client/features/report/report-view.js';

function setup(toast) {
  const nodes = new Map();
  for (const id of ['reportOutput', 'reportQuestionArea', 'reportProgress', 'reportQuestion', 'reportAnswer', 'reportError', 'generateSummaryBtn', 'downloadSummaryBtn', 'reportNext', 'reportSkip']) {
    nodes.set(`#${id}`, { hidden: false, disabled: false, textContent: '', innerHTML: '', value: '', focus() {} });
  }
  return { view: createReportView({ querySelector: key => nodes.get(key) }, toast), get: id => nodes.get(`#${id}`) };
}

test('audit, follow-up questions, and generation disable restarting the report', () => {
  const { view, get } = setup(); view.open({ summaryMarkdown: '旧总结' });
  view.loading('audit'); assert.equal(get('generateSummaryBtn').disabled, true);
  view.question('问题', 1, 1); assert.equal(get('generateSummaryBtn').disabled, true); assert.equal(get('reportNext').disabled, false);
  view.loading('generate'); assert.equal(get('generateSummaryBtn').disabled, true); assert.equal(get('reportNext').disabled, true); assert.equal(get('reportSkip').disabled, true);
});

for (const action of ['open', 'render', 'restore', 'error']) {
  test(`${action} resets the generation button after a busy report`, () => {
    const { view, get } = setup(); view.loading('generate'); assert.equal(get('generateSummaryBtn').disabled, true);
    view[action](action === 'open' ? { summaryMarkdown: '旧总结' } : '内容');
    assert.equal(get('generateSummaryBtn').disabled, false);
  });
}

test('restore with no prior summary does not expose an empty download', () => {
  const { view, get } = setup(); view.loading('generate'); view.restore('');
  assert.equal(get('downloadSummaryBtn').hidden, true); assert.equal(get('reportQuestionArea').hidden, true);
});

test('report notices reach the visible application toast rather than being silently dropped', () => {
  const notices = []; const { view } = setup(message => notices.push(message));
  view.toast('回答超过 4000 字，内容已保留。');
  assert.deepEqual(notices, ['回答超过 4000 字，内容已保留。']);
});
