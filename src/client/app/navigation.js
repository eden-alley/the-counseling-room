/** @param {{ screens: string[], root?: Document, onChange?: (change: { id: string, previous: string | null }) => void }} options */
export function createNavigation({ screens, root = document, onChange = () => {} }) {
  /** @type {string | null} */
  let current = null;
  /** @type {string[]} */
  const stack = [];

  /** @param {string} id @param {{ push?: boolean }} [options] */
  function show(id, { push = true } = {}) {
    const previous = current;
    if (push && current && current !== id) stack.push(current);
    current = id;
    for (const screenId of screens) {
      const screen = root.querySelector(`#${screenId}`);
      if (screen instanceof HTMLElement) screen.hidden = screenId !== id;
    }
    onChange({ id, previous });
  }

  function back() {
    const previous = stack.pop();
    show(previous || 'landingScreen', { push: false });
  }

  return { show, back, getCurrent: () => current };
}
