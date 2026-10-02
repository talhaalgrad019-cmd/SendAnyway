(function () {
  "use strict";

  const { findByStoreName, findByProps } = vendetta.metro;
  const { after } = vendetta.patcher;

  // SEND_MESSAGES permission bit (1 << 11). Works for both Number and BigInt.
  const SEND_MESSAGES = 2048;

  // Set to true to log permission checks in the debug console
  const DEBUG = false;

  const unpatches = [];
  const patched = new Set();

  function isSendMessages(perm) {
    try {
      return perm == SEND_MESSAGES;
    } catch (e) {
      return false;
    }
  }

  function patchCan(target, label) {
    if (!target || typeof target.can !== "function" || patched.has(target)) return;
    patched.add(target);
    unpatches.push(
      after("can", target, function (args, ret) {
        if (isSendMessages(args && args[0])) {
          if (DEBUG) console.log("[SendAnyway] forced SEND_MESSAGES via", label);
          return true;
        }
        return ret;
      })
    );
  }

  function applyPatches() {
    try {
      patchCan(findByStoreName("PermissionStore"), "PermissionStore");
    } catch (e) {
      console.error("[SendAnyway] PermissionStore patch failed", e);
    }

    try {
      patchCan(findByProps("can", "computePermissions"), "PermissionUtils");
    } catch (e) {
      console.error("[SendAnyway] PermissionUtils patch failed", e);
    }

    if (!patched.size) console.error("[SendAnyway] no permission module found");
  }

  return {
    default: {
      onLoad: function () {
        applyPatches();
      },
      onUnload: function () {
        unpatches.forEach(function (u) {
          try { u(); } catch (e) {}
        });
        unpatches.length = 0;
        patched.clear();
      },
    },
    __esModule: true,
  };
})();
