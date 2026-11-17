/** @param {Document} root @param {(root: Document) => void} start */
export function bootstrap(root, start) {
  if (root.readyState === 'loading') {
    root.addEventListener('DOMContentLoaded', () => start(root), { once: true });
    return;
  }
  start(root);
}
