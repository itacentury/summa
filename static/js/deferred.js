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
 * @param {(init: RequestInit) => Promise<Response | (Response | null)[]>} options.send -
 *   Issues the request(s); pass `init` through to `fetch`. A `null` entry is a
 *   request that never got an answer and counts as refused.
 * @param {() => void} options.onUndo - Reverts the optimistic change; also run
 *   when the commit fails.
 * @param {string} options.errorText - Error toast shown when the commit fails.
 * @param {() => void} [options.onSuccess] - Runs after every request succeeded
 *   (or, with `onPartialFailure`, after some did), before the list is reconciled.
 * @param {(refused: number[]) => void} [options.onPartialFailure] - Reverts only
 *   the part sent by the refused requests (their indexes in `send`'s array) when
 *   others succeeded; without it any refusal reverts the whole change.
 * @param {string} [options.partialErrorText] - Error toast for a partial failure.
 */
export function deferCommit(
  message,
  {
    send,
    onUndo,
    errorText,
    onSuccess = null,
    onPartialFailure = null,
    partialErrorText = errorText,
  },
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
      const refused = responses.flatMap((response, index) =>
        response?.ok ? [] : [index],
      );
      if (refused.length === responses.length) {
        fail();
        return;
      }
      if (refused.length > 0) {
        if (!onPartialFailure) {
          fail();
          return;
        }
        showErrorToast(partialErrorText);
        onPartialFailure(refused);
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
