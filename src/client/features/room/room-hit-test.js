const MAILBOX_BOUNDS = { left: .37, top: .23, right: .51, bottom: .46 };
const OBJECT_BOUNDS = {
  book: { left: .375, top: .585, right: .495, bottom: .70 },
  wallArt: { left: .013, top: .094, right: .109, bottom: .304 },
};

/** @param {{ x: number, y: number }} point */
export function roomObjectAtPoint({ x, y }) {
  for (const [name, bounds] of Object.entries({ mailbox: MAILBOX_BOUNDS, ...OBJECT_BOUNDS })) {
    if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) return name;
  }
  return null;
}
