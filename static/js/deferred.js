/**
 * The commit half of every deferred invoice change: the list already shows the
 * change, and the request goes out only once its undo window closes without an
 * undo (see toast.js).
 */

import { reloadCurrentPage } from "./api.js";
import { hasPendingToast, showErrorToast, showUndoToast } from "./toast.js";

/**
 * Offer an undo for an optimistic change and send it when the window closes.
 *
 * @param {string} message - Toast text, e.g. "Invoice deleted".
 * @param {object} options
 * @param {(init: RequestInit) => Promise<Response | Response[]>} options.send -
 *   Issues the request(s); pass `init` through to `fetch`.
 * @param {() => void} options.onUndo - Reverts the optimistic change; also run
 *   when the commit fails.
 * @param {string} options.errorText - Error toast shown when the commit fails.
 * @param {() => void} [options.onSuccess] - Runs after every request succeeded,
 *   before the list is reconciled.
 */
export function deferCommit(
  message,
  { send, onUndo, errorText, onSuccess = null },
) {
  const fail = () => {
    showErrorToast(errorText);
    onUndo();
  };

  const commit = async () => {
    try {
      // keepalive: a commit fired by page unload must still reach the server.
      const sent = await send({ keepalive: true });
      const responses = Array.isArray(sent) ? sent : [sent];
      if (!responses.every((response) => response.ok)) {
        fail();
        return;
      }
      onSuccess?.();
      // A newer deferred action still pending reconciles on its own commit;
      // reloading now would cut its undo window short and flicker its rows back.
      if (!hasPendingToast()) reloadCurrentPage();
    } catch {
      fail();
    }
  };

  showUndoToast(message, { onUndo, onCommit: commit });
}
