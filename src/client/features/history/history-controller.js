import { dateSlug, sessionExportText } from '../../shared/format.js';

/** @param {{ repository: any, view: any, resumeHistoricalSession: (id: string, isCurrent?:()=>boolean) => any, viewHistoricalSummary?: (session: any, isCurrent?:()=>boolean) => any }} dependencies */
export function createHistoryController({ repository, view, resumeHistoricalSession, viewHistoricalSummary = () => {} }) {
  let selection=0;
  function cancelSelection() {selection+=1;}
  async function sessions() { return [...await repository.listHistory()].sort((first, second) => (Date.parse(second.updatedAt) || 0) - (Date.parse(first.updatedAt) || 0)); }
  /** @param {unknown} error */ const failure=error=>view.toast?.(`记录操作未完成：${error instanceof Error ? error.message : String(error)}`);
  async function open() { try { view.render(await sessions()); } catch(error) {failure(error);} }
  /** @param {string} id */ async function resume(id) {const token=++selection;const isCurrent=()=>token===selection;try {await resumeHistoricalSession(id,isCurrent);} catch(error) {if(isCurrent())failure(error);} }
  /** @param {string} id */ async function viewSummary(id) {const token=++selection;const isCurrent=()=>token===selection;try { const session = (await sessions()).find(item => item.id === id); if (isCurrent()&&session) await viewHistoricalSummary(session,isCurrent); } catch(error) {if(isCurrent())failure(error);} }
  /** @param {string} id */ async function remove(id) {try {await repository.deleteHistorySession(id);await open();} catch(error) {failure(error);} }
  /** @param {string} id */ async function exportSession(id) {try { const session = (await sessions()).find(item => item.id === id); if (!session) return; view.download(`咨询记录-${dateSlug(new Date(session.startedAt))}.md`, sessionExportText(session)); view.toast?.('记录已导出'); } catch(error) {failure(error);} }
  return { open, resume, viewSummary, cancelSelection, delete: remove, export: exportSession };
}
