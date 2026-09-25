import { beforeEach, describe, expect, it, vi } from "vitest";

const undoToast = vi.hoisted(() => ({ onUndo: null, onCommit: null }));
const pending = vi.hoisted(() => ({ value: false }));
vi.mock("../../static/js/toast.js", () => ({
  showUndoToast: vi.fn((message, { onUndo, onCommit }) => {
    undoToast.onUndo = onUndo;
    undoToast.onCommit = onCommit;
  }),
  showErrorToast: vi.fn(),
  hasPendingToast: () => pending.value,
}));
vi.mock("../../static/js/api.js", () => ({ reloadCurrentPage: vi.fn() }));

import { deferCommit } from "../../static/js/deferred.js";
import { showErrorToast, showUndoToast } from "../../static/js/toast.js";
import { reloadCurrentPage } from "../../static/js/api.js";

const ok = { ok: true };
const refused = { ok: false };

/** Defer a change whose request resolves to `sent`, returning the spies. */
function defer(sent) {
  const spies = {
    send: vi.fn(() => Promise.resolve(sent)),
    onUndo: vi.fn(),
    onSuccess: vi.fn(),
  };
  deferCommit("Invoice deleted", { ...spies, errorText: "Failed to delete" });
  return spies;
}

beforeEach(() => {
  vi.clearAllMocks();
  pending.value = false;
});

describe("deferCommit", () => {
  it("sends nothing until the undo window closes", () => {
    const { send } = defer(ok);

    expect(showUndoToast).toHaveBeenCalledWith(
      "Invoice deleted",
      expect.objectContaining({ onUndo: expect.any(Function) }),
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("sends with keepalive, runs onSuccess and reconciles the list", async () => {
    const { send, onSuccess, onUndo } = defer(ok);

    await undoToast.onCommit();

    expect(send).toHaveBeenCalledWith({ keepalive: true });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(reloadCurrentPage).toHaveBeenCalledOnce();
    expect(onUndo).not.toHaveBeenCalled();
  });

  it("leaves the reload to a newer pending action", async () => {
    defer(ok);
    pending.value = true;

    await undoToast.onCommit();

    expect(reloadCurrentPage).not.toHaveBeenCalled();
  });

  it("reverts and reports a refused request", async () => {
    const { onSuccess, onUndo } = defer(refused);

    await undoToast.onCommit();

    expect(showErrorToast).toHaveBeenCalledWith("Failed to delete");
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(reloadCurrentPage).not.toHaveBeenCalled();
  });

  it("reverts when any of several requests is refused", async () => {
    const { onUndo } = defer([ok, refused]);

    await undoToast.onCommit();

    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("reverts and reports a failed request", async () => {
    const send = vi.fn(() => Promise.reject(new TypeError("offline")));
    const onUndo = vi.fn();
    deferCommit("Invoice deleted", {
      send,
      onUndo,
      errorText: "Failed to delete",
    });

    await undoToast.onCommit();

    expect(showErrorToast).toHaveBeenCalledWith("Failed to delete");
    expect(onUndo).toHaveBeenCalledOnce();
  });
});
