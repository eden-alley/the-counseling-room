import { getAppConfig } from './app/app-config.js';
import { bootstrap } from './app/bootstrap.js';
import { createNavigation } from './app/navigation.js';
import { createConsultationController } from './features/consultation/consultation-controller.js';
import { createConsultationView } from './features/consultation/consultation-view.js';
import { createEntryController } from './features/entry/entry-controller.js';
import { createHistoryController } from './features/history/history-controller.js';
import { createHistoryView } from './features/history/history-view.js';
import { createLegacyChatRoute } from './features/legacy-chat/legacy-chat-route.js';
import { createLegacyChatView } from './features/legacy-chat/legacy-chat-view.js';
import { createReportController } from './features/report/report-controller.js';
import { createReportView } from './features/report/report-view.js';
import { createAmbientAudio } from './features/room/ambient-audio.js';
import { createRoomController } from './features/room/room-controller.js';
import { createSession, finalizeSession } from '../../shared/contracts/session.js';
import { createApiClient } from './infrastructure/api-client.js';
import { createLocalSessionRepository } from './infrastructure/local-session-repository.js';
import { createSessionRepository } from './infrastructure/session-repository.js';
import { required } from './shared/dom.js';

const entryPrompts = {
  self_understanding: '本次入口是“我想理解自己”。咨询策略：优先帮助用户从反复出现的思考习惯、选择方式、内在冲突中找到一个具体片段；不要急着给类型判断；先用开放问题让用户说出真实场景。',
  recent_difficulty: '本次入口是“我最近遇到一些困难”。咨询策略：优先聚焦现实事件，先听清发生了什么、用户卡在哪里、现实限制是什么；只有当现实条件不足以解释时，再谨慎引入思维模式或八维假设。',
  free_conversation: '本次入口是“自由聊聊”。咨询策略：降低表达压力，允许用户从模糊念头开始；通过温和追问把抽象感受落到最近一个小事件；不要让用户感觉自己在填问卷。',
};

bootstrap(document, root => {
  const api = createApiClient({ baseUrl: getAppConfig().apiBase });
  const repository = createSessionRepository({storage:window.localStorage,localRepository:createLocalSessionRepository(window.localStorage),api});
  const screens = ['landingScreen', 'welcomeScreen', 'roomScreen', 'chatScreen', 'summaryScreen', 'historyScreen'];
  /** @type {import('../../shared/contracts/session.js').Session | null} */ let currentSession = repository.loadCurrentSession();
  let navigationOperation=0;
  /** @type {any} */ let room = null;
  /** @type {any} */ let entry = null;
  /** @type {ReturnType<typeof createConsultationController> | null} */ let consultation = null;
  const toast = /** @type {HTMLElement} */ (required(root, '#toast'));
  /** @type {ReturnType<typeof setTimeout> | null} */ let toastTimer = null;
  /** @param {string} text */ function showToast(text) { toast.textContent = text; toast.classList.add('show'); if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 1800); }
  /** @param {string} selector @param {string} text */ function restoreComposer(selector,text) { const input=/** @type {HTMLTextAreaElement} */(required(root,selector)); if(!input.value && text){input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));} }
  const navigation = createNavigation({ screens, root, onChange: ({ id, previous }) => {
    if (previous === 'historyScreen' && id !== 'historyScreen') history.cancelSelection();
    if (previous === 'summaryScreen' && id !== 'summaryScreen') report.cancelPending();
    if (id !== 'roomScreen') room?.closeArtworkModal();
    if (id === 'roomScreen') {
      entry?.enterFinalRoom();
      if (consultation?.state.get().visibility === 'open') {
        consultationView.resume(consultation.state.get().section);
        consultationView.renderDraft(currentSession);
      }
    } else if (previous === 'roomScreen') entry?.pauseRoomIntro();
    if (id === 'historyScreen') history.open();
  } });
  const showScreen = navigation.show;
  /** @param {import('../../shared/contracts/session.js').Session | null} session */ function setCurrentSession(session) { navigationOperation+=1;currentSession = session; }
  /** @param {string} entryType @param {string} entryLabel */ function createSessionForEntry(entryType, entryLabel) {
    const now = new Date().toISOString();
    const session = createSession({ id: `session-${Date.now().toString(36)}`, entryType, entryLabel, now, promptContext: entryPrompts[/** @type {keyof typeof entryPrompts} */ (entryType)] || entryPrompts.free_conversation });
    setCurrentSession(session);
    try { repository.saveCurrentSession(session); }
    catch { showToast('本地保存暂不可用。发送前会再次检查；请勿刷新或关闭页面。'); }
    return session;
  }
  function ensureExplorationSession() { return currentSession || createSessionForEntry('free_conversation', '开始探索'); }
  /** @param {any} session */ function buildMessages(session) { const context = session.promptContext || entryPrompts[/** @type {keyof typeof entryPrompts} */ (session.entryType)] || entryPrompts.free_conversation; return [{ role: 'assistant', content: `【本次咨询入口上下文】${context} 这条信息只用于调整本次咨询策略，不要向用户复述。` }, ...session.messages]; }

  const historyView = createHistoryView(root);
  const reportView = createReportView(root, showToast);
  const report = createReportController({ api, repository, view: reportView, getSession: () => currentSession, setSession: setCurrentSession, buildMessages });
  const legacyChat = createLegacyChatRoute({ repository, setSession: setCurrentSession, navigation, api, view: {...createLegacyChatView(root),restoreComposer: /** @param {string} text */ text=>restoreComposer('#legacyInput',text)}, buildMessages });
  /** @param {string} id @param {()=>boolean} [isCurrent] */
  function resumeHistoricalSelection(id,isCurrent=()=>true) {
    const previous=currentSession;return legacyChat.resumeHistoricalSession(id,()=>isCurrent()&&currentSession===previous);
  }
  /** @param {any} session @param {()=>boolean} [isCurrent] */
  async function viewHistoricalSummary(session,isCurrent=()=>true) {
    const previous=currentSession;const current=()=>isCurrent()&&currentSession===previous;
    if(!current())return;if(session.storage === 'server')await repository.recoverSession(session,{cache:false});
    if(!current())return;await repository.saveCurrentSession(session);if(!current())return;
    setCurrentSession(session);if(report.openSummary())showScreen('summaryScreen');
  }
  const history = createHistoryController({ repository, view: historyView, resumeHistoricalSession:resumeHistoricalSelection,viewHistoricalSummary });
  const roomElements = { roomScreen: required(root, '#roomScreen'), mailboxHotspot: required(root, '#mailboxHotspot'), bookHotspot: required(root, '#bookHotspot'), wallArtHotspot: required(root, '#wallArtHotspot'), roomArtworkModal: required(root, '#roomArtworkModal'), roomModalCloseButton: required(root, '#roomModalCloseButton') };
  const entryElements = { artworkEntry: required(root, '#artworkEntry'), entryIntroVideo: required(root, '#entryIntroVideo'), entryDoorHotspot: required(root, '#entryDoorHotspot'), roomScreen: roomElements.roomScreen, roomIntroVideo: required(root, '#roomIntroVideo') };
  const ambientAudio = createAmbientAudio({ toggle: required(root, '#ambientMusicToggle'), audio: required(root, '#ambientMusicAudio'), onUnavailable: () => showToast('背景音乐暂时无法播放') });
  const consultationView = {...createConsultationView(root, { beginConsultation: () => room?.beginConsultation(), returnToRoom: () => room?.endConsultation(), isScene: /** @param {string} state */ (state) => room?.isScene(state) ?? false, setSceneState: /** @param {string} state */ (state) => room?.setSceneState(state) }),restoreComposer: /** @param {string} text */ text=>restoreComposer('#input',text) };
  consultation = createConsultationController({ repository, api, view: consultationView, getSession: ensureExplorationSession, setSession: setCurrentSession, buildMessages, prepareForHistory: /** @param {import('../../shared/contracts/session.js').Session} session */ (session) => finalizeSession(session, new Date().toISOString()), onStartReport: () => { if (report.openSummary()) { showScreen('summaryScreen'); void report.startReport(); } }, onReturnToRoom: () => {},onOpenHistory: () => showScreen('historyScreen') });
  room = createRoomController({ elements: roomElements, openConsultationAtStart: consultation.openAtStart, openMailbox: () => {}, openWallArt: () => {} });
  entry = createEntryController({ elements: entryElements, onEnterRoom: () => showScreen('roomScreen', { push: false }), onRoomStateChange: /** @param {string} state */ (state) => room.setSceneState(state), onAmbientAvailable: ambientAudio.setAvailable });

  consultationView.bind({ onOpenAtStart: consultation.openAtStart, onSectionSelect: consultation.selectSection, onSendMessage: consultation.sendMessage, onAbortRequest: consultation.abortRequest, onRequestEnd: consultation.requestEnd, onContinue: consultation.continueConsultation, onSaveAndStartReport: consultation.saveAndStartReport, onRequestExit: consultation.requestExit, onCancelExit: consultation.closeExitDialog, onDiscardAndExit: consultation.discardAndExit, onSaveAndExit: consultation.saveAndExit });
  async function openLegacySummary() {
    const session=currentSession;const token=++navigationOperation;
    const current=()=>token===navigationOperation&&currentSession===session;
    try{await legacyChat.cancelPending();if(!current())return;if(session)await repository.upsertHistory(session);if(current()&&report.openSummary())showScreen('summaryScreen');}
    catch(error){if(current())showToast(`保存未完成：${/** @type {any} */(error).message}`);}
  }
  async function openStoredHistory() {
    const session=currentSession;const token=++navigationOperation;
    const current=()=>token===navigationOperation&&currentSession===session;
    try{await consultation?.prepareToLeave();if(!current())return;await legacyChat.cancelPending();if(current())showScreen('historyScreen');}
    catch(error){if(current())showToast(`历史记录未能打开：${/** @type {any} */(error).message}`);}
  }
  historyView.bind({ onResume: history.resume, onViewSummary: history.viewSummary, onDelete: history.delete, onExport: history.export, onOpen: openStoredHistory, onBack: navigation.back, onNew: () => showScreen('welcomeScreen') });
  reportView.bind({ onStart: report.startReport, onAnswer: report.answerCurrentQuestion, onSkip: report.skipCurrentQuestion, onDownload: report.downloadSummary, onOpen: openLegacySummary, onBack: navigation.back, onHistory: () => showScreen('historyScreen') });
  entry.bind(); room.bind(); ambientAudio.bind(); legacyChat.bind();
  for (const card of root.querySelectorAll('.entry-card')) card.addEventListener('click', () => { const entryType = card.getAttribute('data-entry'); const entryLabel = card.getAttribute('data-label'); if (!entryType || !entryLabel) return; createSessionForEntry(entryType, entryLabel); showScreen('roomScreen'); });
  root.addEventListener('keydown', event => { if (event.key === 'Escape') room.closeArtworkModal(); });
  /** @type {HTMLButtonElement} */ (required(root, '#newSessionBtn')).addEventListener('click', () => { if (currentSession?.messages?.length && !window.confirm('确定开始新的咨询吗？当前未生成总结的内容仍会保存在本地草稿中。')) return; showScreen('welcomeScreen'); });
  showScreen('landingScreen', { push: false });
});
