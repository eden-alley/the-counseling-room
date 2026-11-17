import { createConsultationState } from './consultation-state.js';
import { isValidMessages } from '../../../../shared/contracts/session.js';

/** @param {any} dependencies */
export function createConsultationController({ repository, api, view, getSession, setSession, buildMessages, prepareForHistory = () => {}, onStartReport, onReturnToRoom, onOpenHistory }) {
  const state = createConsultationState();
  /** @type {{ id: symbol, controller: AbortController, session: any, finished?: Promise<void>, finish?:()=>void } | null} */
  let request = null;
  let operation=0;
  /** @param {any} session */ const beginOperation=session=>({token:++operation,session});
  /** @param {{token:number,session:any}} run */ const operationIsCurrent=run=>state.get().visibility === 'open' && run.token === operation && getSession() === run.session;
  /** @param {any} session */ const sessionIsCurrent=session=>state.get().visibility === 'open' && getSession() === session;
  /** @param {any} session */ const save = session => repository.saveCurrentSession(session);
  /** @param {any} session */ const history = session => repository.upsertHistory(session);
  const render = () => view.renderDraft(getSession());
  function openAtStart() {
    state.openAtStart(); view.open('start'); render();
    const session=getSession();const run=beginOperation(session);
    if (session?.storage === 'server' && repository.recoverSession) {
      state.setRequestStatus('sending');view.setBusy(true);
      void repository.recoverSession(session).then(() => {if (operationIsCurrent(run)) {render();view.restoreComposer?.(repository.getUnsentDraft?.(session));if(session.pendingRequestId)view.toast('上次回复仍在处理中，请稍后再次查看。');}}).catch((/** @type {any} */ error)=>{if(operationIsCurrent(run))view.toast(`恢复未完成：${error.message}`);}).finally(()=>{if(operationIsCurrent(run)){state.setRequestStatus('idle');view.setBusy(false);}});
    }
  }
  /** @param {string} section */ async function selectSection(section) {
    if(section === 'consultation-history' && onOpenHistory){
      const run=beginOperation(getSession());
      try{await cancelActiveRequest(run);if(operationIsCurrent(run))await onOpenHistory();}catch(error){if(operationIsCurrent(run))view.toast(`历史记录未能打开：${/** @type {any} */(error).message}`);}return;
    }
    state.openConversation(section);view.selectSection(section);
  }
  /** @param {symbol} id */ function requestIsActive(id) { return request?.id === id && state.get().visibility === 'open' && getSession() === request.session; }
  /** @param {{token:number,session:any}} run */
  async function cancelActiveRequest(run) {
    const active=request?.session === run.session ? request : null;
    active?.controller.abort();if(active && request === active)request=null;
    if(operationIsCurrent(run))view.removeStreaming?.();
    if (repository.cancelPending) {await active?.finished;await repository.cancelPending(run.session);}
    if(operationIsCurrent(run)){state.setRequestStatus('idle');view.setBusy(false);}
  }
  async function prepareToLeave() {
    if(state.get().visibility !== 'open')return;
    const run=beginOperation(getSession());await cancelActiveRequest(run);
  }
  /** @param {string} text */ async function sendMessage(text) {
    text = text.trim();
    if (!text || state.get().visibility !== 'open' || state.get().requestStatus !== 'idle') return;
    if (Array.from(text).length > 8000) { view.toast('单条内容不能超过 8000 字，请缩短后再发送。输入已保留。'); return; }
    const session = getSession();
    if (!session) return;
    const retry=session.storage === 'server' && ['failed','interrupted'].includes(session.lastTurn?.status) && [...session.messages].reverse().find(m=>m.role==='user')?.content === text;
    const candidate = retry ? session : { ...session, messages: [...session.messages, { role: 'user', content: text }] };
    const messages = buildMessages ? buildMessages(candidate) : candidate.messages;
    // Reserve one reply so the complete conversation still fits the report API.
    if (!isValidMessages(messages) || messages.length >= 60) { view.toast('本次对话已达到提交上限，或含有过长内容。请先保存并结束咨询；输入已保留。'); return; }
    operation+=1;
    if (repository.submitMessage) {
      const active = { id: Symbol('chat-request'), controller: new AbortController(), session, finished: /** @type {Promise<void>|undefined} */(undefined), finish: () => {} };
      active.finished=new Promise(resolve=>{active.finish=resolve;});request=active;
      state.setRequestStatus('sending');view.setBusy(true);
      try {
        let preview='';let accepted=false;
        await repository.submitMessage(session,text,{signal:active.controller.signal,buildMessages,
          onAccepted:()=>{if(requestIsActive(active.id)&&!active.controller.signal.aborted){accepted=true;view.clearComposer?.();render();}},
          onDelta:(/** @type {string} */ delta)=>{if(requestIsActive(active.id)&&!active.controller.signal.aborted){preview+=delta;view.updateStreaming?.(preview);}},
        });
        if(requestIsActive(active.id)&&!active.controller.signal.aborted){view.removeStreaming?.();if(!accepted)view.clearComposer?.();render();}
      } catch(error) {
        const failure=/** @type {any} */(error);
        if(requestIsActive(active.id)&&failure?.name!=='AbortError'){render();view.toast(`发送未完成：${failure.message} 已接收的原文仍保留；失败或中断后可明确再次发送同样内容。`);}
      } finally {
        active.finish();
        if(request?.id===active.id){request=null;if(sessionIsCurrent(session)){view.removeStreaming?.();state.setRequestStatus('idle');view.setBusy(false);}}
      }
      return;
    }
    session.messages.push({ role: 'user', content: text });
    try { await save(session); }
    catch { session.messages.pop(); if(sessionIsCurrent(session))view.toast('本地保存失败，尚未发送。输入已保留，请检查浏览器存储后重试。'); return; }
    if(!sessionIsCurrent(session))return;
    view.clearComposer?.(); view.renderMessage('user', text); state.setRequestStatus('sending'); view.setBusy(true);
    const active = { id: Symbol('chat-request'), controller: new AbortController(), session };
    request = active;
    try {
      let preview = '';
      const reply = api.streamChat
        ? await api.streamChat(messages, (/** @type {string} */ delta) => { if (requestIsActive(active.id) && !active.controller.signal.aborted) { preview += delta; view.updateStreaming?.(preview); } }, active.controller.signal)
        : await api.sendChat(messages, active.controller.signal);
      if (!requestIsActive(active.id) || active.controller.signal.aborted) return;
      view.removeStreaming?.(); session.messages.push({ role: 'assistant', content: reply });
      try { await save(session); }
      catch { if(requestIsActive(active.id))view.toast('回复已收到，但本地保存失败。请先复制重要内容，不要刷新或关闭页面。'); }
      if(requestIsActive(active.id))view.renderMessage('assistant', reply);
    }
    catch (error) { const failure = /** @type {any} */ (error); if (requestIsActive(active.id)) { view.removeStreaming?.(); if (failure?.name !== 'AbortError') view.renderMessage('assistant', `连接没有成功：${failure.message}`); } }
    finally { if (request?.id !== active.id) return; request = null; if(sessionIsCurrent(session)){view.removeStreaming?.();state.setRequestStatus('idle');view.setBusy(false);} }
  }
  function requestEnd() { operation+=1;state.openEndDialog(); view.openDialog('end'); }
  function continueConsultation() { operation+=1;state.closeDialog(); view.closeDialog('end'); }
  async function saveAndStartReport() {
    const session = getSession(); if (!session?.messages?.some(/** @param {any} message */ message => message.role === 'user')) { view.toast('请先完成一些对话'); return; }
    const run=beginOperation(session);let candidate;
    try {
      await cancelActiveRequest(run);if(!operationIsCurrent(run))return;
      candidate = { ...session, messages: [...session.messages] };prepareForHistory(candidate);
      await history(candidate);if(!operationIsCurrent(run))return;
      await save(candidate);if(!operationIsCurrent(run))return;
    } catch { if(operationIsCurrent(run))view.toast('本地保存未完成，当前对话已保留。请检查浏览器存储后重试。'); return; }
    Object.assign(session, candidate);state.closeDialog();view.closeDialog('end');onStartReport(session);
  }
  function requestExit() { operation+=1;state.openExitDialog(); view.openDialog('exit'); }
  function closeExitDialog() { operation+=1;state.closeDialog(); view.closeDialog('exit'); }
  async function discardAndExit() {
    const session=getSession();const run=beginOperation(session);
    try {
      await cancelActiveRequest(run);if(!operationIsCurrent(run))return;
      if (repository.discardCurrentSession) await repository.discardCurrentSession(session); else await repository.removeCurrentSession(session?.id);
      if(!operationIsCurrent(run))return;
    } catch { if(operationIsCurrent(run))view.toast('本地草稿未能移除，当前对话已保留。请重试。'); return; }
    setSession(null);state.close();view.close();onReturnToRoom();
  }
  async function saveAndExit() {
    const session = getSession();const run=beginOperation(session);
    try {
      await cancelActiveRequest(run);if(!operationIsCurrent(run))return;
      if (session) {const candidate = { ...session, messages: [...session.messages] };prepareForHistory(candidate);await history(candidate);if(!operationIsCurrent(run))return;}
      await repository.removeCurrentSession(session?.id);if(!operationIsCurrent(run))return;
    } catch { if(operationIsCurrent(run))view.toast('本地保存未完成，当前对话已保留。请检查浏览器存储后重试。'); return; }
    setSession(null);state.close();view.close();onReturnToRoom();
  }
  async function abortRequest() {
    if (state.get().requestStatus !== 'sending') return;
    const run=beginOperation(getSession());
    try {await cancelActiveRequest(run);if(operationIsCurrent(run))render();} catch(error) {if(operationIsCurrent(run))view.toast(`停止未完成：${/** @type {any} */(error).message}`);}
  }
  return { prepareToLeave, state, openAtStart, selectSection, sendMessage, requestEnd, continueConsultation, saveAndStartReport, requestExit, closeExitDialog, discardAndExit, saveAndExit, abortRequest };
}
