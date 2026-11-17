import { isValidMessages } from '../../../../shared/contracts/session.js';

/** @param {{ repository: any, setSession: (session: any) => void, navigation: { show: (screen: string) => void }, api?: any, view?: any, buildMessages?: (session: any) => any, now?: () => string }} dependencies */
export function createLegacyChatRoute({ repository, setSession, navigation, api, view, buildMessages = session => session.messages, now = () => new Date().toISOString() }) {
  /** @type {any} */ let currentSession = null;
  let selection=0;
  /** @type {{controller:AbortController,finished:Promise<void>,finish:()=>void}|null} */ let request=null;
  async function cancelPending() {
    const target=currentSession;const active=request;active?.controller.abort();if(request===active)request=null;
    if(repository.cancelPending){await active?.finished;await repository.cancelPending(target);}
    if(currentSession===target&&!request)view?.setBusy?.(false);
  }
  /** @param {string} sessionId @param {()=>boolean} [externalIsCurrent] */
  async function resumeHistoricalSession(sessionId,externalIsCurrent=()=>true) {
    if(!externalIsCurrent())return;
    const token=++selection;const isCurrent=()=>token===selection&&externalIsCurrent();
    await cancelPending();if(!isCurrent())return;
    const item = repository.resumeSession ? await repository.resumeSession(sessionId) : (await repository.listHistory()).find(/** @param {any} session */ session => session.id === sessionId);
    if (!isCurrent() || !item) return;
    const resumed = item.pendingRequestId ? {...item} : { ...item, endedAt: null, updatedAt: now() };
    if (resumed.storage === 'server' && !resumed.pendingRequestId && repository.updateMetadata) await repository.updateMetadata(resumed,{endedAt:null,updatedAt:resumed.updatedAt},{cache:false});
    if(!isCurrent())return;await repository.saveCurrentSession(resumed);if(!isCurrent())return;
    currentSession = resumed;setSession(resumed);navigation.show('chatScreen');view?.render(resumed);view?.restoreComposer?.(repository.getUnsentDraft?.(resumed));
    if(resumed.pendingRequestId)view?.renderMessage?.('assistant','上次回复仍在处理中，请等待后再次查看；不会重复生成。',resumed);
  }
  /** @param {string} text */ async function sendMessage(text) {
    if (!currentSession || request || !text.trim() || !api) return;
    text=text.trim();const session=currentSession;
    const retry=session.storage === 'server' && ['failed','interrupted'].includes(session.lastTurn?.status) && [...session.messages].reverse().find(m=>m.role==='user')?.content === text;
    const candidate=retry ? session : {...session,messages:[...session.messages,{role:'user',content:text}]};
    const messages=buildMessages(candidate);
    if(Array.from(text).length>8000||!isValidMessages(messages)||messages.length>=60){view?.renderMessage?.('assistant','内容超过 8000 字或本次 60 条上限；输入已保留，请先保存并结束咨询。',session);return;}
    const active={controller:new AbortController(),finished:/** @type {Promise<void>} */(Promise.resolve()),finish:()=>{}};
    active.finished=new Promise(resolve=>{active.finish=resolve;});request=active;
    const isCurrent=()=>request===active&&currentSession===session&&!active.controller.signal.aborted;
    view?.setBusy?.(true);
    try {
      if(repository.submitMessage){
        let accepted=false;
        await repository.submitMessage(session,text,{signal:active.controller.signal,buildMessages,onAccepted:()=>{if(isCurrent()){accepted=true;view?.clearComposer?.();view?.render(session);}}});
        if(isCurrent()){if(!accepted)view?.clearComposer?.();view?.render(session);}
      } else {
        session.messages.push({role:'user',content:text});session.updatedAt=now();
        try {await repository.saveCurrentSession(session);} catch(error) {session.messages.pop();throw error;}
        if(!isCurrent())return;view?.clearComposer?.();view?.renderMessage?.('user',text,session);
        const reply=await api.sendChat(buildMessages(session),active.controller.signal);
        if(!isCurrent())return;session.messages.push({role:'assistant',content:reply});session.updatedAt=now();await repository.saveCurrentSession(session);view?.renderMessage?.('assistant',reply,session);
      }
    } catch(error) {
      if(isCurrent()){view?.render(session);view?.renderMessage?.('assistant',`发送未完成：${/** @type {any} */(error).message} 已接收的原文仍保留；失败或中断后可明确再次发送同样内容。`,session);}
    } finally {active.finish();if(request===active){request=null;view?.setBusy?.(false);}}
  }
  function bind() { view?.bind?.({ onSendMessage: sendMessage }); }
  return { bind, resumeHistoricalSession, sendMessage, cancelPending };
}
