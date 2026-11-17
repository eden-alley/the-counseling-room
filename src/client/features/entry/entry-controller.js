/** @param {any} options */
export function createEntryController({ elements, onEnterRoom, onRoomStateChange, onAmbientAvailable }) {
  let roomIntroCompleted = false;
  /** @type {number | null} */
  let roomTransitionTimer = null;

  /** @param {string} state */
  function setRoomState(state) {
    elements.roomScreen.dataset.sceneState = state;
    onRoomStateChange(state);
  }

  async function startArtworkEntry() {
    if (elements.artworkEntry.dataset.entryState !== 'ready') return;
    elements.artworkEntry.dataset.entryState = 'playing';
    elements.entryDoorHotspot.disabled = true;
    elements.entryIntroVideo.currentTime = 0;
    try {
      await elements.entryIntroVideo.play();
    } catch {
      elements.artworkEntry.dataset.entryState = 'ready';
      elements.entryDoorHotspot.disabled = false;
    }
  }

  function finishArtworkEntry() {
    elements.artworkEntry.dataset.entryState = 'ended';
    onAmbientAvailable(true);
    onEnterRoom();
  }

  function prepareRoomEntry() {
    if (roomIntroCompleted) {
      setRoomState('room');
      return;
    }
    elements.roomIntroVideo.hidden = false;
    if (elements.roomIntroVideo.readyState >= 3) setRoomState('ready');
    else {
      setRoomState('loading');
      elements.roomIntroVideo.load();
    }
  }

  function markRoomIntroReady() {
    if (!roomIntroCompleted && elements.roomScreen.dataset.sceneState === 'loading') setRoomState('ready');
  }

  async function startRoomIntro() {
    if (elements.roomScreen.dataset.sceneState !== 'ready') return;
    if (roomTransitionTimer) clearTimeout(roomTransitionTimer);
    roomTransitionTimer = null;
    elements.roomIntroVideo.currentTime = 0;
    elements.roomIntroVideo.hidden = false;
    setRoomState('playing');
    try {
      await elements.roomIntroVideo.play();
    } catch {
      setRoomState('ready');
    }
  }

  function handleRoomIntroTimeUpdate() {
    if (elements.roomScreen.dataset.sceneState !== 'playing' || !Number.isFinite(elements.roomIntroVideo.duration)) return;
    if (elements.roomIntroVideo.duration - elements.roomIntroVideo.currentTime <= .5) prepareRoomTransition();
  }

  function prepareRoomTransition() {
    if (elements.roomScreen.dataset.sceneState !== 'playing') return;
    setRoomState('transitioning');
    if (roomTransitionTimer) clearTimeout(roomTransitionTimer);
    roomTransitionTimer = window.setTimeout(completeRoomTransition, 600);
  }

  function completeRoomTransition() {
    if (roomIntroCompleted) return;
    if (elements.roomScreen.dataset.sceneState !== 'transitioning') {
      prepareRoomTransition();
      return;
    }
    if (roomTransitionTimer) clearTimeout(roomTransitionTimer);
    roomTransitionTimer = null;
    roomIntroCompleted = true;
    setRoomState('room');
    cleanupIntroVideo();
  }

  function cleanupIntroVideo() {
    elements.roomIntroVideo.pause();
    elements.roomIntroVideo.removeAttribute('src');
    elements.roomIntroVideo.load();
    elements.roomIntroVideo.hidden = true;
  }

  function pauseRoomIntro() {
    if (roomIntroCompleted) return;
    if (roomTransitionTimer) clearTimeout(roomTransitionTimer);
    roomTransitionTimer = null;
    elements.roomIntroVideo.pause();
    elements.roomIntroVideo.currentTime = 0;
    setRoomState(elements.roomIntroVideo.readyState >= 3 ? 'ready' : 'loading');
  }

  function enterFinalRoom() {
    roomIntroCompleted = true;
    if (roomTransitionTimer) clearTimeout(roomTransitionTimer);
    roomTransitionTimer = null;
    elements.roomIntroVideo.pause();
    elements.roomIntroVideo.hidden = true;
    elements.roomIntroVideo.removeAttribute('src');
    elements.roomIntroVideo.load();
    setRoomState('room');
  }

  function bind() {
    elements.entryDoorHotspot.addEventListener('click', startArtworkEntry);
    elements.entryIntroVideo.addEventListener('ended', finishArtworkEntry);
    elements.roomIntroVideo.addEventListener('canplay', markRoomIntroReady);
    elements.roomIntroVideo.addEventListener('timeupdate', handleRoomIntroTimeUpdate);
    elements.roomIntroVideo.addEventListener('ended', completeRoomTransition);
  }

  return {
    startArtworkEntry,
    prepareRoomEntry,
    startRoomIntro,
    pauseRoomIntro,
    enterFinalRoom,
    bind,
  };
}
