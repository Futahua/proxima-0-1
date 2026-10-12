/* Reused from AYG file-pane marquee controller. */
(function(root){
/** Owns the drag-marquee selection gesture. It keeps only pointer/drag state,
 * capture, the movement threshold, rectangle/tile math, the overlay DOM, and
 * the blank-click-suppression result. All session mutation and persistence
 * delegate to the marquee commands. */
function createMarqueeController({
  elements,
  commands,
  itemsIntersectingMarquee,
  itemSelector = '.icon-item',
}) {
  let drag = null;

  function marqueeBounds(startX, startY, endX, endY) {
    return {
      left: Math.min(startX, endX),
      top: Math.min(startY, endY),
      right: Math.max(startX, endX),
      bottom: Math.max(startY, endY),
    };
  }

  function showMarquee(bounds) {
    const explorerBounds = elements.explorer.getBoundingClientRect();
    elements.marquee.hidden = false;
    elements.marquee.style.left = `${bounds.left - explorerBounds.left}px`;
    elements.marquee.style.top = `${bounds.top - explorerBounds.top}px`;
    elements.marquee.style.width = `${bounds.right - bounds.left}px`;
    elements.marquee.style.height = `${bounds.bottom - bounds.top}px`;
  }

  function updateMarqueeSelection(bounds) {
    const tiles = [...elements.grid.querySelectorAll(itemSelector)]
      .map((tile) => {
        const rectangle = tile.getBoundingClientRect();
        return {
          id: tile.dataset.id,
          left: rectangle.left,
          top: rectangle.top,
          right: rectangle.right,
          bottom: rectangle.bottom,
          // Ancestor tiles are breadcrumbs, not selection targets — the
          // same exclusion visibleItemIds applies to select-all and
          // shift-ranges.
          ancestor: tile.classList?.contains('ancestor-item') === true,
        };
      })
      .filter((tile) => tile.right > tile.left && tile.bottom > tile.top && !tile.ancestor);
    commands.updateMarqueeSelection([
      ...drag.baseSelection,
      ...itemsIntersectingMarquee(tiles, bounds),
    ]);
  }

  function isActive(pointerId) {
    return drag !== null && drag.pointerId === pointerId;
  }

  /** Begins a marquee gesture on blank workspace space. preserveSelection
   * comes from Ctrl being held; the command keeps or clears the selection. */
  function start({ pointerId, clientX, clientY, preserveSelection }) {
    drag = {
      pointerId,
      startX: clientX,
      startY: clientY,
      baseSelection: commands.beginMarqueeSelection({ preserveSelection }),
      moved: false,
    };
    elements.grid.setPointerCapture(pointerId);
  }

  function move({ pointerId, clientX, clientY }) {
    if (!isActive(pointerId)) return;
    const bounds = marqueeBounds(drag.startX, drag.startY, clientX, clientY);
    if (!drag.moved && bounds.right - bounds.left < 3 && bounds.bottom - bounds.top < 3) return;
    drag.moved = true;
    showMarquee(bounds);
    updateMarqueeSelection(bounds);
  }

  /** Ends the gesture; returns whether it actually moved, or null if the
   * pointer did not belong to an active marquee. */
  function finish(pointerId) {
    if (!isActive(pointerId)) return null;
    if (elements.grid.hasPointerCapture(pointerId)) {
      elements.grid.releasePointerCapture(pointerId);
    }
    const moved = drag.moved;
    drag = null;
    commands.finishMarqueeSelection({ moved });
    elements.marquee.hidden = true;
    return moved;
  }

  /** 018X2 item 9: cancels an active marquee WITHOUT finalizing selection.
   * Releases pointer capture, hides the overlay and resets the gesture state,
   * so a later captured pointerup cannot call the finish command after a
   * handoff begins. Normal gestures are unaffected (start/move/finish
   * unchanged). */
  function cancel() {
    if (!drag) return;
    if (elements.grid.hasPointerCapture(drag.pointerId)) {
      elements.grid.releasePointerCapture(drag.pointerId);
    }
    drag = null;
    elements.marquee.hidden = true;
  }

  return { isActive, start, move, finish, cancel };
}

root.createMarqueeController=createMarqueeController;
})(globalThis);