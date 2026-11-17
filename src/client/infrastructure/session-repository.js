import { CURRENT_SESSION_KEY, isMessage, normalizeSession } from '../../../shared/contracts/session.js';

const STATE_KEY = 'ape-v2-server-session-state';
const METADATA = ['startedAt','endedAt','updatedAt','entryType','entryLabel','title','durationSeconds','messageCount','promptContext','summaryMarkdown'];
/** @param {any} session */
function metadata(session) { return Object.fromEntries(METADATA.filter(key => session[key] !== undefined).map(key => [key,session[key]])); }
/** Never send server bookkeeping or normalize away invalid original content. @param {any} session */
function legacyPayload(session) {
  if (!session || typeof session.id !== 'string' || !Array.isArray(session.messages) || !session.messages.every(isMessage) || session.messages.length + (session.promptContext ? 1 : 0) > 60) throw Error('旧记录格式不正确或超过 8000 字 / 60 条上限，原记录已保留。');
  const ids=session.messages.filter((/** @type {any} */ m)=>m.id !== undefined).map((/** @type {any} */ m)=>m.id);
  if(ids.some((/** @type {any} */ id)=>typeof id !== 'string'||!id)||new Set(ids).size !== ids.length)throw Error('旧记录消息标识格式不正确或重复，原记录已保留。');
  return {id:session.id,...metadata(session),messages:session.messages.map((/** @type {any} */ m) => ({role:m.role,content:m.content,...(typeof m.id === 'string' ? {id:m.id} : {})}))};
}
/** @param {{storage:any,localRepository:any,api:any,requestId?:()=>string}} options */
export function createSessionRepository({storage,localRepository:local,api,requestId = () => globalThis.crypto.randomUUID()}) {
  /** @type {Promise<boolean>|null} */ let capability = null;
  let selectedId=local.loadCurrentSession()?.id || null;
  /** @returns {{mappings:Record<string,{serverId:string,deleted?:boolean}>,pending:Record<string,any>,drafts:Record<string,string>}} */
  function readState() { try { const data = JSON.parse(storage.getItem(STATE_KEY)||'{}'); return {mappings:Object.assign(Object.create(null),data.mappings),pending:Object.assign(Object.create(null),data.pending),drafts:Object.assign(Object.create(null),data.drafts)}; } catch { return {mappings:Object.create(null),pending:Object.create(null),drafts:Object.create(null)}; } }
  /** @param {ReturnType<typeof readState>} value */ function writeState(value) {storage.setItem(STATE_KEY,JSON.stringify(value));}
  /** @param {string} id @param {ReturnType<typeof readState>} [state] */
  function mappingFor(id,state=readState()) {return state.mappings[id] || Object.values(state.mappings).find(mapping=>mapping.serverId === id);}
  /** A retained local original never regains authority after migration. @param {any} value */
  function requireUnmigrated(value) {
    const mapping=mappingFor(typeof value === 'string' ? value : value?.id);
    if(mapping?.deleted)throw Error('该咨询已经删除，保留的本地原件不能恢复。');
    if(mapping || value?.storage === 'server')throw Error('当前服务不支持已迁移咨询，请连接原本机后端。');
  }
  function enabled() { if (!capability) capability=Promise.resolve().then(()=>api.health()).then(health => health?.capabilities?.sessions_v1 === true).catch(error=>{capability=null;throw error;});return capability; }
  /** @param {any} session */
  function saveCurrentSession(session) {
    if(session?.storage !== 'server')requireUnmigrated(session);
    selectedId=session?.id || null;
    if (session?.storage !== 'server') return local.saveCurrentSession(session);
    storage.setItem(CURRENT_SESSION_KEY,JSON.stringify({id:session.id,storage:'server',revision:session.revision,saved:session.saved,pendingRequestId:session.pendingRequestId,hasSavedSnapshot:session.hasSavedSnapshot,lastTurn:session.lastTurn ? {request_id:session.lastTurn.request_id,status:session.lastTurn.status,revision:session.lastTurn.revision,user_message_id:session.lastTurn.user_message_id} : null}));
  }
  /** Preserve controller identity while replacing the authoritative public snapshot. @param {any} target @param {any} value @param {boolean} [cache] */
  function adopt(target,value,cache=true) {
    if (!value || value.deleted) throw Error('该咨询已经删除或丢弃，请开始新的咨询。');
    const normalized=normalizeSession(value);if (!normalized || value.storage !== 'server') throw Error('会话响应格式不正确。');
    const selected=cache && selectedId === target.id;
    Object.assign(target,normalized);if(selected)saveCurrentSession(target);return target;
  }
  /** @param {string} id @param {string} rid */
  function clearPending(id,rid) {const state=readState();if (state.pending[id]?.request_id === rid) {delete state.pending[id];writeState(state);}}
  /** @param {any} session @param {string} rid @param {boolean} [cache] */
  async function queryTurn(session,rid,cache=true) {
    const result=await api.getTurn(session.id,rid);adopt(session,result.session,cache);
    if (result.turn?.status !== 'pending') clearPending(session.id,rid);
    return result.turn;
  }
  /** @param {any} session @param {{cache?:boolean}} [options] */
  async function recoverSession(session,{cache=true}={}) {
    if (session?.storage !== 'server') return session;
    if(!(await enabled()))requireUnmigrated(session);adopt(session,await api.getSession(session.id),cache);
    const rid=readState().pending[session.id]?.request_id || session.pendingRequestId;
    if (rid) {
      try {await queryTurn(session,rid,cache);} catch(error) {if (/** @type {any} */(error)?.status !== 404) throw error;}
    }
    return session;
  }
  /** @param {any} session */
  async function ensureServer(session) {
    const mapping=mappingFor(session.id);if(mapping?.deleted)throw Error('该咨询已经删除。');
    if (session.storage === 'server') return session;
    if(mapping)return adopt(session,await api.getSession(mapping.serverId));
    const raw=local.loadRawCurrentSession?.();
    const original=raw?.id === session.id ? raw : session;
    const payload=legacyPayload(original);
    const value=payload.messages.length ? await api.importSession(payload) : await api.createSession(payload);
    if(payload.messages.length){const state=readState();state.mappings[session.id]={serverId:value.id};writeState(state);}
    return adopt(session,value);
  }
  /** @param {any} session @param {string} text @param {{signal?:AbortSignal,onDelta?:(text:string)=>void,onAccepted?:(session:any)=>void,buildMessages?:(session:any)=>any}} [options] */
  async function submitMessage(session,text,{signal,onDelta=()=>{},onAccepted=()=>{},buildMessages=s=>s.messages}={}) {
    if(selectedId === null)selectedId=session.id;
    if (!(await enabled())) {
      requireUnmigrated(session);
      session.messages.push({role:'user',content:text});
      try {await local.saveCurrentSession(session);} catch(error) {session.messages.pop();throw error;}
      onAccepted(session);
      const reply=api.streamChat ? await api.streamChat(buildMessages(session),onDelta,signal) : await api.sendChat(buildMessages(session),signal);
      signal?.throwIfAborted();session.messages.push({role:'assistant',content:reply});await local.saveCurrentSession(session);return session;
    }
    await ensureServer(session);signal?.throwIfAborted();
    const state=readState();let payload=state.pending[session.id];
    const rid=payload?.request_id || session.pendingRequestId;
    if (rid) {
      try {
        const turn=await queryTurn(session,rid);
        if (turn.status === 'pending') throw Error('这条消息仍在处理中，请等待后再次查看；不会重复生成。');
        if (turn.status === 'completed' && [...session.messages].reverse().find(m=>m.role==='user')?.content === text) {onAccepted(session);return session;}
        payload=null;
      } catch(error) {
        if (/** @type {any} */(error)?.status !== 404) throw error;
        // A user send after a genuinely unknown result may replay only the identical request.
        if (!payload?.message || payload.message !== text) throw Error('上次请求是否接收仍未确定，请先用相同内容重试。');
      }
    }
    if (!payload) {
      const last=session.lastTurn;
      const previousUser=[...session.messages].reverse().find(m=>m.role==='user');
      const retryOf=last && ['failed','interrupted'].includes(last.status) && previousUser?.content === text ? last.request_id : null;
      payload={request_id:requestId(),expected_revision:session.revision,message:text,...(retryOf ? {retry_of:retryOf} : {})};
      state.pending[session.id]=payload;delete state.drafts[session.id];writeState(state);
    }
    let completed=false;
    try {
      await api.streamTurn(session.id,payload,(/** @type {any} */ event)=>{
        if (signal?.aborted) return;
        if (event.session) adopt(session,event.session);
        if (event.type === 'accepted') {
          const cache=readState();if (cache.pending[session.id]?.request_id === payload.request_id) {cache.pending[session.id]={request_id:payload.request_id,accepted:true};writeState(cache);}onAccepted(session);
        }
        if (event.type === 'delta') onDelta(event.text);
        if (event.type === 'done') {completed=true;clearPending(session.id,payload.request_id);}
      },signal);
      signal?.throwIfAborted();
      if (!completed) throw Error('回复结果未确认。');
      return session;
    } catch(error) {
      if (signal?.aborted) throw error;
      let turn;
      try {turn=await queryTurn(session,payload.request_id);} catch(queryError) {
        if (/** @type {any} */(queryError)?.status === 404) {
          if(/** @type {any} */(error)?.requestRejected === true){const cache=readState();delete cache.pending[session.id];cache.drafts[session.id]=text;writeState(cache);adopt(session,await api.getSession(session.id));throw error;}
          throw Error('暂未查到这条请求；内容已保留，再次发送相同内容会沿用原请求编号。');
        }
        throw queryError;
      }
      onAccepted(session);
      if (turn.status === 'completed') return session;
      if (turn.status === 'pending') throw Error('这条消息仍在处理中，请等待后再次查看；不会重复生成。');
      throw error;
    }
  }
  /** @param {any} session */
  async function cancelPending(session) {
    if (session?.storage !== 'server') return;
    const rid=readState().pending[session.id]?.request_id || session.pendingRequestId;if (!rid) return;
    let result;
    try { result=await api.cancelTurn(session.id,rid); }
    catch(error) {
      if (/** @type {any} */(error)?.status !== 404) throw error;
      // Cancellation can race registration: query before deciding it was never accepted.
      try {await queryTurn(session,rid);} catch(queryError) {if (/** @type {any} */(queryError)?.status === 404) throw Error('原请求是否接收尚未确认，当前内容与请求编号已保留。请用相同内容明确重试后再退出。');throw queryError;}
    }
    if (result?.session) adopt(session,result.session);
    const turn=await queryTurn(session,rid);
    if (turn.status === 'pending') throw Error('回复尚未停止，当前内容已保留。请稍后重试退出。');
  }
  /** @param {string} id */
  async function resumeSession(id) {
    const state=readState();const mapping=mappingFor(id,state);
    if (mapping?.deleted) throw Error('该咨询已经删除。');
    if (!(await enabled())) {requireUnmigrated(id);const value=local.listHistory().find((/** @type {any} */ s)=>s.id===id);if(value)requireUnmigrated(value);return value ? {...value} : null;}
    let value;
    if (mapping) value=await api.getSession(mapping.serverId);
    else {
      const original=local.listRawHistory().find((/** @type {any} */ s)=>s?.id===id);
      if (original) {value=await api.importSession(legacyPayload(original));state.mappings[id]={serverId:value.id};writeState(state);}
      else value=await api.getSession(id);
    }
    const session=adopt({},value,false);await recoverSession(session,{cache:false});return session;
  }
  async function listHistory() {
    if (!(await enabled())) return local.listHistory().filter((/** @type {any} */ session)=>session.storage !== 'server'&&!mappingFor(session.id));
    const state=readState();const remote=await api.listSessions();const removed=new Set(Object.values(state.mappings).filter(m=>m.deleted).map(m=>m.serverId));
    const localOnly=local.listHistory().filter((/** @type {any} */ s)=>!mappingFor(s.id,state) && !remote.some((/** @type {any} */ r)=>r.id===s.id));
    return [...remote.filter((/** @type {any} */ s)=>(s.hasSavedSnapshot ?? s.saved) === true&&!s.deleted&&!removed.has(s.id)).map(normalizeSession).filter(Boolean),...localOnly];
  }
  /** @param {any} session */
  async function upsertHistory(session) {
    if (!(await enabled())) {requireUnmigrated(session);return local.upsertHistory(session);}
    await ensureServer(session);await cancelPending(session);
    adopt(session,await api.saveSession(session.id,session.revision,metadata(session)));
  }
  /** @param {any} session */
  async function discardCurrentSession(session) {
    if(!session)return;
    const expectedId=session.id;const mapped=mappingFor(expectedId);
    if(mapped?.deleted)throw Error('该咨询已经删除。');
    if (session.storage === 'server' || mapped) {
      if(!(await enabled()))requireUnmigrated(session);
      await ensureServer(session);await cancelPending(session);const result=await api.discardSession(session.id,session.revision);
      if (result.deleted) {const state=readState();state.mappings[session.id]={serverId:session.id,deleted:true};writeState(state);}
      else adopt(session,result);
    }
    removeCurrentSession(expectedId);
  }
  /** @param {string} id */
  async function deleteHistorySession(id) {
    const state=readState();const mapped=mappingFor(id,state);
    if(mapped?.deleted)throw Error('该咨询已经删除。');
    if (!(await enabled())) {requireUnmigrated(id);return local.deleteHistorySession(id);}const original=local.listRawHistory().some((/** @type {any} */ s)=>s?.id===id);
    // Deleting an unmigrated local record does not import it.
    let session;
    if(original&&!mapped){
      try {session=await api.getSession(id);} catch(error) {if(/** @type {any} */(error)?.status === 404)return local.deleteHistorySession(id);throw error;}
    } else session=await api.getSession(mapped?.serverId||id);await cancelPending(session);await api.deleteSession(session.id,session.revision);
    state.mappings[id]={serverId:session.id,deleted:true};writeState(state);
  }
  /** @param {any} session @param {any} changes @param {{cache?:boolean}} [options] */
  async function updateMetadata(session,changes,{cache=true}={}) {
    if(session.storage === 'server'||mappingFor(session.id)){if(!(await enabled()))requireUnmigrated(session);await ensureServer(session);adopt(session,await api.updateSessionMetadata(session.id,session.revision,changes),cache);}else Object.assign(session,changes);
  }
  /** @param {string | null} [expectedId] */
  function removeCurrentSession(expectedId=selectedId) {if(selectedId !== expectedId)return;local.removeCurrentSession();selectedId=null;}
  /** @param {any} session */ function getUnsentDraft(session) {const state=readState();const cached=session&&state.pending[session.id];return typeof cached?.message === 'string' ? cached.message : session ? state.drafts[session.id] || '' : '';}
  return {getUnsentDraft,updateMetadata,loadCurrentSession:local.loadCurrentSession,saveCurrentSession,removeCurrentSession,listHistory,upsertHistory,deleteHistorySession,resumeSession,recoverSession,submitMessage,cancelPending,discardCurrentSession,isServerEnabled:enabled};
}
