import { roomObjectAtPoint } from './room-hit-test.js';

/** @param {any} options */
export function createRoomController({ elements, openConsultationAtStart, openMailbox, openWallArt }) {
  /** @type {number | null} */
  let closeTimer = null;
  /** @type {number | null} */
  let openTimer = null;
  /** @type {any} */
  let modalTrigger = null;

  /** @param {PointerEvent | MouseEvent} event */
  function pointFromEvent(event) {
    const rect = elements.roomScreen.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }

  function isReady() {
    return elements.roomScreen.dataset.sceneState === 'room';
  }

  /** @param {string} state */
  function setSceneState(state) {
    elements.roomScreen.dataset.sceneState = state;
  }

  /** @param {string} state */
  function isScene(state) {
    return elements.roomScreen.dataset.sceneState === state;
  }

  /** @param {any} object @param {boolean} active */
  function setObjectHover(object, active) {
    if (active) object.dataset.roomObjectHover = 'true';
    else delete object.dataset.roomObjectHover;
  }

  /** @param {boolean} active */
  function setMailboxHover(active) {
    if (active) elements.mailboxHotspot.dataset.mailboxHover = 'true';
    else delete elements.mailboxHotspot.dataset.mailboxHover;
  }

  function pressMailbox() {
    if (!isReady() || elements.roomArtworkModal.dataset.roomModalState !== 'closed') return;
    elements.mailboxHotspot.dataset.mailboxState = 'opening';
  }

  /** @param {any} object */
  function pressObject(object) {
    if (!isReady()) return;
    object.dataset.roomObjectState = 'opening';
  }

  /** @param {'mailbox' | 'wallArt'} kind */
  function openArtworkModal(kind) {
    if (!isReady() || elements.roomArtworkModal.dataset.roomModalState !== 'closed') return;
    if (closeTimer) clearTimeout(closeTimer);
    modalTrigger = kind === 'mailbox' ? elements.mailboxHotspot : elements.wallArtHotspot;
    if (kind === 'mailbox') pressMailbox();
    else pressObject(elements.wallArtHotspot);
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (openTimer) clearTimeout(openTimer);
    openTimer = window.setTimeout(() => {
      elements.roomArtworkModal.dataset.roomModalKind = kind;
      elements.roomArtworkModal.dataset.roomModalState = 'opening';
      elements.roomArtworkModal.setAttribute('aria-hidden', 'false');
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        elements.roomArtworkModal.dataset.roomModalState = 'open';
        if (kind === 'mailbox') elements.mailboxHotspot.dataset.mailboxState = 'open';
        else elements.wallArtHotspot.dataset.roomObjectState = 'open';
        openTimer = null;
      }));
    }, reducedMotion ? 1 : 160);
    if (kind === 'mailbox') openMailbox();
    else openWallArt();
  }

  function closeArtworkModal() {
    const state = elements.roomArtworkModal.dataset.roomModalState;
    if (state === 'closed' || state === 'closing') return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (openTimer) clearTimeout(openTimer);
    elements.roomArtworkModal.dataset.roomModalState = 'closing';
    elements.roomArtworkModal.setAttribute('aria-hidden', 'true');
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      elements.roomArtworkModal.dataset.roomModalState = 'closed';
      elements.roomArtworkModal.dataset.roomModalKind = '';
      elements.mailboxHotspot.dataset.mailboxState = 'closed';
      elements.wallArtHotspot.dataset.roomObjectState = 'closed';
      modalTrigger?.focus({ preventScroll: true });
      modalTrigger = null;
      closeTimer = null;
    }, reducedMotion ? 1 : 240);
  }

  /** @param {any} event */
  function handleMailboxCanvasPointerMove(event) {
    if (!isReady()) return;
    setMailboxHover(roomObjectAtPoint(pointFromEvent(event)) === 'mailbox');
  }

  /** @param {any} event */
  function handleMailboxCanvasClick(event) {
    if (event.target === elements.mailboxHotspot || event.target.closest?.('#mailboxHotspot')) return;
    if (isReady() && roomObjectAtPoint(pointFromEvent(event)) === 'mailbox') openArtworkModal('mailbox');
  }

  /** @param {any} event */
  function handleObjectCanvasPointerMove(event) {
    if (!isReady()) return;
    const object = roomObjectAtPoint(pointFromEvent(event));
    setObjectHover(elements.bookHotspot, object === 'book');
    setObjectHover(elements.wallArtHotspot, object === 'wallArt');
  }

  /** @param {any} event */
  function handleObjectCanvasClick(event) {
    if (event.target.closest?.('.room-object-hotspot')) return;
    if (!isReady()) return;
    const object = roomObjectAtPoint(pointFromEvent(event));
    if (object === 'book') openConsultationAtStart();
    else if (object === 'wallArt') openArtworkModal('wallArt');
  }

  function beginConsultation() {
    pressObject(elements.bookHotspot);
    elements.bookHotspot.disabled = true;
  }

  function endConsultation() {
    elements.bookHotspot.disabled = false;
    elements.bookHotspot.focus({ preventScroll: true });
  }

  function bind() {
    elements.mailboxHotspot.addEventListener('pointerdown', pressMailbox);
    elements.mailboxHotspot.addEventListener('pointerenter', () => setMailboxHover(true));
    elements.mailboxHotspot.addEventListener('pointerleave', () => setMailboxHover(false));
    elements.mailboxHotspot.addEventListener('click', () => openArtworkModal('mailbox'));
    elements.bookHotspot.addEventListener('pointerdown', () => pressObject(elements.bookHotspot));
    elements.wallArtHotspot.addEventListener('pointerdown', () => pressObject(elements.wallArtHotspot));
    elements.bookHotspot.addEventListener('pointerenter', () => setObjectHover(elements.bookHotspot, true));
    elements.bookHotspot.addEventListener('pointerleave', () => setObjectHover(elements.bookHotspot, false));
    elements.wallArtHotspot.addEventListener('pointerenter', () => setObjectHover(elements.wallArtHotspot, true));
    elements.wallArtHotspot.addEventListener('pointerleave', () => setObjectHover(elements.wallArtHotspot, false));
    elements.bookHotspot.addEventListener('click', openConsultationAtStart);
    elements.wallArtHotspot.addEventListener('click', () => openArtworkModal('wallArt'));
    elements.roomScreen.addEventListener('pointermove', handleMailboxCanvasPointerMove);
    elements.roomScreen.addEventListener('click', handleMailboxCanvasClick);
    elements.roomScreen.addEventListener('pointermove', handleObjectCanvasPointerMove);
    elements.roomScreen.addEventListener('click', handleObjectCanvasClick);
    elements.roomModalCloseButton.addEventListener('click', closeArtworkModal);
  }

  return { bind, isReady, isScene, setSceneState, beginConsultation, endConsultation, closeArtworkModal, openArtworkModal };
}
