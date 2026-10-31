// Executed inside the installed app by WebKitWebDriver or Playwright.
// Native actions and file fingerprints are supplied by the host test driver.
const CANVAS_PHOTO =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIABADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAcJ/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABQBAQAAAAAAAAAAAAAAAAAAAAX/xAAbEQACAQUAAAAAAAAAAAAAAAAAB0RFgoPCw//aAAwDAQACEQMRAD8Ak7QsBTpp+XmHLaXZuf/Z";

export async function runDialogScenarios({ backupPath }) {
  const state = (window.__nativeDialogTest = {
    results: [],
    request: null,
    done: false,
  });
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assert = (ok, message) => {
    if (!ok) throw new Error(message);
  };
  const call = (command, request) =>
    window.__TAURI_INTERNALS__.invoke(
      command,
      request === undefined ? {} : { request },
    );
  let serial = 0;
  const host = async (action, title = "", value = "") => {
    const id = ++serial;
    state.request = { id, action, title, value };
    for (let i = 0; i < 600; i++) {
      if (state.reply?.id === id) {
        state.request = null;
        if (state.reply.error) throw new Error(state.reply.error);
        return state.reply.value;
      }
      await pause(100);
    }
    throw new Error(`Native driver timed out: ${action} ${title}`);
  };
  const dialog = async (command, request, title, action, value = "") => {
    let settled = false,
      result,
      error;
    const operation = (state.operation = { command, title, settled: false });
    const pending = call(command, request).then(
      (r) => {
        settled = true;
        operation.settled = true;
        operation.outcome =
          typeof r === "boolean" || r === null ? r : "returned value";
        result = r;
      },
      (e) => {
        settled = true;
        operation.settled = true;
        operation.error = e;
        error = e;
      },
    );
    // If the host cannot operate the dialog, the outer runner terminates the
    // owned app. Awaiting pending on that failure would hang on the same dialog;
    // state.operation retains its settlement details for diagnosis.
    const evidence = await host(action, title, value);
    await pause(700);
    // Some Linux configurations leave Enter/Space on selectable message text.
    // That is safe if no operation completes; dismiss it explicitly afterwards.
    const dismissedByKey = settled;
    if (!settled && ["enter", "space"].includes(action))
      await host("escape", title);
    for (let i = 0; !settled && i < 300; i++) await pause(100);
    assert(settled, `Native operation did not finish: ${title} ${action}`);
    await pending;
    if (error) throw new Error(JSON.stringify(error));
    state.results.push({ title, action, dismissedByKey, evidence });
    return result;
  };
  const fingerprint = () => host("fingerprint");
  const unchanged = async (before, label) =>
    assert(
      JSON.stringify(await fingerprint()) === JSON.stringify(before),
      `Vault files changed after ${label}`,
    );
  const password = "quartz otter lantern cactus velvet 729!";
  const create = () =>
    call("vault_create", {
      passphrase: password,
      initialProfileName: "FAKE Native dialog test",
    });
  // Starting again sets the vault aside (#71), and is offered only on the
  // unlock screen, so the vault is locked when it is asked.
  const setAsideTitle = "Set this myCarlos vault aside and start again?";
  const setAside = { confirmation: "RESET MYCARLOS VAULT" };
  const cases = [
    ["enter", ""],
    ["space", ""],
    ["escape", ""],
    ["close", ""],
    ["button", "Cancel"],
    ["button", "KEEP"],
  ];
  // A photo saved through the real IPC, as the camera window sends it (#73):
  // one body, the target's length (4 bytes, big-endian), the target as JSON,
  // then the JPEG. A FAKE canvas JPEG, the Rust tests' canvas-photo.jpg.
  const savePhoto = async () => {
    const jpeg = Uint8Array.from(atob(CANVAS_PHOTO), (c) => c.charCodeAt(0));
    const profileId = (await call("vault_snapshot")).profiles[0].id;
    const target = new TextEncoder().encode(
      JSON.stringify({
        profileId,
        folderIds: [],
        name: "Photo, 1 Jan 2026, 9.00 AM.jpg",
      }),
    );
    const request = new Uint8Array(4 + target.length + jpeg.length);
    new DataView(request.buffer).setUint32(0, target.length);
    request.set(target, 4);
    request.set(jpeg, 4 + target.length);
    let saved;
    try {
      saved = await window.__TAURI_INTERNALS__.invoke(
        "vault_save_photo",
        request,
      );
    } catch (error) {
      // The code alone says which part did not arrive; nothing else is shown.
      throw new Error(`Photo not saved: ${error?.code ?? "unknown"}`);
    }
    assert(saved.imported.length === 1, "Photo not saved: nothing imported");
  };
  try {
    assert(
      (await call("vault_status")) === "absent",
      "Refusing to test an existing vault",
    );
    await create();
    await savePhoto();
    await call("vault_lock");
    for (const [action, value] of cases) {
      const before = await fingerprint();
      assert(
        (await dialog(
          "vault_reset",
          setAside,
          setAsideTitle,
          action,
          value === "KEEP" ? "Keep this vault" : value,
        )) === false,
        `Setting the vault aside was authorized by ${action}`,
      );
      await unchanged(before, `set aside ${action}`);
    }
    assert(
      (await dialog(
        "vault_reset",
        setAside,
        setAsideTitle,
        "button",
        "Set it aside",
      )) === true,
      "Explicitly setting the vault aside did not succeed",
    );
    assert(
      (await call("vault_status")) === "absent",
      "The vault set aside is still in use",
    );
    await create();
    const groups = (key) => ({
      groups: key.split("-").map((value, index) => ({ index, value })),
    });
    const original = await call("vault_recovery_key_begin", {
      passphrase: password,
    });
    await call("vault_recovery_key_confirm", groups(original));
    const snapshot = await call("vault_snapshot");
    const { capture: initialCapture, ...initialContents } = snapshot;
    const validCapture = (capture) =>
      typeof capture?.epoch === "string" &&
      capture.epoch.length > 0 &&
      Number.isSafeInteger(capture.sequence) &&
      capture.sequence > 0;
    assert(
      validCapture(initialCapture),
      "Initial key snapshot capture is invalid",
    );
    let previousCapture = initialCapture;
    const replacement = await call("vault_recovery_key_begin", {
      passphrase: password,
    });
    const replacementRequest = groups(replacement);
    const keyTitle = "Replace your recovery key?";
    for (const [action, value] of cases) {
      const before = await fingerprint();
      assert(
        (await dialog(
          "vault_recovery_key_confirm",
          replacementRequest,
          keyTitle,
          action,
          value === "KEEP" ? "Keep current key" : value,
        )) === null,
        `Key replacement was authorized by ${action}`,
      );
      await unchanged(before, `key replacement ${action}`);
      const { capture, ...contents } = await call("vault_snapshot");
      assert(
        validCapture(capture),
        "Cancelled key snapshot capture is invalid",
      );
      assert(
        capture.epoch === initialCapture.epoch &&
          capture.sequence > previousCapture.sequence,
        "Cancelled key snapshot capture did not advance in the same runtime",
      );
      assert(
        JSON.stringify(contents) === JSON.stringify(initialContents),
        "Current key snapshot contents changed on cancellation",
      );
      previousCapture = capture;
    }
    const replaced = await dialog(
      "vault_recovery_key_confirm",
      replacementRequest,
      keyTitle,
      "button",
      "Replace key",
    );
    assert(
      replaced?.recoveryKeyLabel &&
        replaced.recoveryKeyLabel !== snapshot.recoveryKeyLabel,
      "Explicit replacement did not change key",
    );
    const saveId = await dialog(
      "vault_backup_pick",
      {},
      "FILE_SAVE",
      "file",
      backupPath,
    );
    assert(saveId, "Backup save was cancelled");
    const saved = (state.savedBackup = await call("vault_backup_picked", {
      pickId: saveId,
    }));
    assert(
      saved?.name === backupPath.split(/[\\/]/).pop() && saved.bytes > 0,
      "Backup was not saved with the requested filename and nonempty contents",
    );
    await call("vault_create_profile", {
      displayName: "FAKE Added after backup",
    });
    await call("vault_lock");
    const restoreTitle = "Replace the vault on this device?";
    for (const [action, value] of [
      ...cases,
      ["button", "Replace with backup"],
    ]) {
      const pickId = await dialog(
        "vault_restore_pick",
        undefined,
        "FILE_OPEN",
        "file",
        backupPath,
      );
      assert(pickId, "Backup open was cancelled");
      const request = { pickId, passphrase: password, replace: true };
      await call("vault_restore_inspect", request);
      const before = await fingerprint();
      const result = await dialog(
        "vault_restore",
        request,
        restoreTitle,
        action,
        value === "KEEP" ? "Keep this vault" : value,
      );
      if (value === "Replace with backup")
        assert(result === true, "Explicit restore did not succeed");
      else {
        assert(result === false, `Restore was authorized by ${action}`);
        await unchanged(before, `restore ${action}`);
      }
      const after = await call("vault_unlock", { passphrase: password });
      const hasAddedProfile = after.profiles.some(
        (p) => p.displayName === "FAKE Added after backup",
      );
      assert(
        hasAddedProfile === (value !== "Replace with backup"),
        "Restore contents do not match confirmation",
      );
      await call("vault_lock");
    }
    assert(
      (await dialog(
        "vault_reset",
        setAside,
        setAsideTitle,
        "button",
        "Set it aside",
      )) === true,
      "Final test vault cleanup failed",
    );
    assert(
      (await call("vault_status")) === "absent",
      "Test vault remains after cleanup",
    );
  } catch (error) {
    state.error = error?.message
      ? `${error.message}\n${error.stack || ""}`
      : JSON.stringify(error);
  } finally {
    state.request = null;
    state.done = true;
  }
}
