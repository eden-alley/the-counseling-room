/** @param {{ toggle: any, audio: any, onUnavailable: () => void }} options */
export function createAmbientAudio({ toggle, audio, onUnavailable }) {
  audio.volume = .32;
  audio.playbackRate = .75;

  /** @param {boolean} available */
  function setAvailable(available) {
    toggle.hidden = !available;
  }

  function togglePlayback() {
    const isOn = toggle.dataset.musicState === 'on';
    if (isOn) audio.pause();
    else audio.play().catch(onUnavailable);
    toggle.dataset.musicState = isOn ? 'off' : 'on';
    toggle.setAttribute('aria-pressed', String(!isOn));
    toggle.setAttribute('aria-label', isOn ? '开启背景音乐' : '关闭背景音乐');
  }

  function bind() {
    toggle.addEventListener('click', togglePlayback);
  }

  return { setAvailable, togglePlayback, bind };
}
