(function () {
  "use strict";

  const { findByProps, findByStoreName } = vendetta.metro;
  const { instead, after, before } = vendetta.patcher;
  const React = vendetta.metro.common.React;
  const RN = vendetta.metro.common.ReactNative;

  const SEND_MESSAGES = 2048; // permission bit (1 << 11)
  const PRESS_KEY = /^on(press|click|tap|select)$/i;
  const BAR_TEXT = /done reading|permission to send|cannot send|can't send|read.?only/i;

  const unpatches = [];
  const unlocked = {}; // channelId -> true
  const status = {};
  let lastSummary = null;
  let PermissionStore = null;
  let SelectedChannelStore = null;

  // set while ChatInputGuard renders, so we can tell if it drew the blocking bar
  let armed = false;
  let barSeen = false;

  function toast(msg) {
    try { vendetta.ui.toasts.showToast(msg); } catch (e) {}
  }

  function copy(text) {
    try {
      const cb = findByProps("setString");
      if (cb && cb.setString) cb.setString(text);
    } catch (e) {}
  }

  function summarize(v, depth) {
    depth = depth || 0;
    if (v == null) return v;
    const t = typeof v;
    if (t === "string") return v.slice(0, 80);
    if (t === "number" || t === "boolean") return v;
    if (t === "bigint") return String(v) + "n";
    if (t === "function") return "[fn " + (v.name || "") + "]";
    if (depth > 3) return "[deep]";
    if (React.isValidElement && React.isValidElement(v)) {
      const ty = v.type;
      return {
        "<el>": typeof ty === "string" ? ty : (ty && (ty.displayName || ty.name)) || "?",
        props: summarize(v.props, depth + 1),
      };
    }
    if (Array.isArray(v)) return v.slice(0, 6).map(function (x) { return summarize(x, depth + 1); });
    if (t === "object") {
      const o = {};
      Object.keys(v).slice(0, 15).forEach(function (k) {
        try { o[k] = summarize(v[k], depth + 1); } catch (e) {}
      });
      return o;
    }
    return String(v);
  }

  function currentChannelId() {
    try {
      return SelectedChannelStore && SelectedChannelStore.getChannelId();
    } catch (e) {
      return null;
    }
  }

  // Tapping the bar itself does nothing (no jump to the other channel)
  function blockTap() {}

  function unlockChannel() {
    const id = currentChannelId();
    if (!id) {
      toast("SendAnyway: no channel found");
      return;
    }
    unlocked[id] = true;
    try {
      if (PermissionStore && PermissionStore.emitChange) PermissionStore.emitChange();
    } catch (e) {}
    toast("Chat box unlocked. If it doesn't show, leave and re-enter the channel.");
    copy(JSON.stringify({ status: status, channel: id, guard: lastSummary }, null, 1));
  }

  function withUnlockButton(out) {
    if (!RN || !RN.View || !RN.TouchableOpacity || !RN.Text) return out;
    return React.createElement(
      RN.View,
      { style: { flexDirection: "row", alignItems: "center" } },
      React.createElement(RN.View, { style: { flex: 1 } }, out),
      React.createElement(
        RN.TouchableOpacity,
        {
          onPress: unlockChannel,
          style: {
            marginHorizontal: 8,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 8,
            backgroundColor: "#5865F2",
          },
        },
        React.createElement(RN.Text, { style: { color: "#FFFFFF", fontWeight: "600" } }, "Unlock")
      )
    );
  }

  function isPlain(v) {
    return v && typeof v === "object" && !Array.isArray(v) &&
      !(React.isValidElement && React.isValidElement(v)) &&
      Object.getPrototypeOf(v) === Object.prototype;
  }

  function overrideProps(obj, depth) {
    if (!isPlain(obj) || depth > 2) return obj;
    const out = Object.assign({}, obj);
    Object.keys(obj).forEach(function (k) {
      const v = obj[k];
      if (PRESS_KEY.test(k) && typeof v === "function") out[k] = blockTap;
      else if (isPlain(v)) out[k] = overrideProps(v, depth + 1);
    });
    return out;
  }

  function rewriteElement(node, depth) {
    if (node == null || depth > 12) return node;
    if (Array.isArray(node)) return node.map(function (n) { return rewriteElement(n, depth + 1); });
    if (!(React.isValidElement && React.isValidElement(node))) return node;
    const p = node.props || {};
    const np = {};
    let changed = false;
    Object.keys(p).forEach(function (k) {
      const v = p[k];
      if (PRESS_KEY.test(k) && typeof v === "function") {
        np[k] = blockTap;
        changed = true;
      } else if (k === "children") {
        const c = rewriteElement(v, depth + 1);
        if (c !== v) {
          np.children = c;
          changed = true;
        }
      }
    });
    return changed ? React.cloneElement(node, np) : node;
  }

  // Detects the bar's text being created while ChatInputGuard is rendering
  function textOf(c) {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      let s = "";
      for (let i = 0; i < c.length && i < 6; i++) if (typeof c[i] === "string") s += c[i];
      return s;
    }
    return "";
  }

  function markBar(props, rest) {
    if (!armed || barSeen) return;
    let t = props ? textOf(props.children) : "";
    if (!t && rest && rest.length) t = textOf(rest);
    if (t && BAR_TEXT.test(t)) barSeen = true;
  }

  function installBarDetector() {
    try {
      const JSX = findByProps("jsx", "jsxs");
      if (JSX) {
        ["jsx", "jsxs"].forEach(function (k) {
          if (typeof JSX[k] === "function") {
            unpatches.push(before(k, JSX, function (args) { markBar(args[1]); }));
          }
        });
      }
      if (React && typeof React.createElement === "function") {
        unpatches.push(
          before("createElement", React, function (args) {
            markBar(args[1], Array.prototype.slice.call(args, 2));
          })
        );
      }
    } catch (e) {
      status.detector = "error: " + e;
    }
  }

  // Finds the module that exports a function with the given name
  function findHolder(name) {
    const modules = vendetta.metro.modules;
    for (const id in modules) {
      const mod = modules[id];
      if (!mod || !mod.isInitialized) continue;
      let exp;
      try {
        exp = mod.publicModule && mod.publicModule.exports;
      } catch (e) {
        continue;
      }
      if (!exp) continue;
      try {
        const d = exp.default;
        if (typeof d === "function" && (d.displayName || d.name) === name) {
          return { holder: exp, key: "default", id: id };
        }
        if (typeof exp === "object") {
          const keys = Object.keys(exp);
          for (let i = 0; i < keys.length; i++) {
            const v = exp[keys[i]];
            if (typeof v === "function" && (v.displayName || v.name) === name) {
              return { holder: exp, key: keys[i], id: id };
            }
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function applyPatches() {
    try {
      PermissionStore = findByStoreName("PermissionStore");
      SelectedChannelStore = findByStoreName("SelectedChannelStore");
    } catch (e) {}

    // 1) Permission check: only fake SEND_MESSAGES in channels the user unlocked
    try {
      if (PermissionStore && typeof PermissionStore.can === "function") {
        unpatches.push(
          after("can", PermissionStore, function (args, ret) {
            try {
              if (args[0] == SEND_MESSAGES) {
                const ch = args[1];
                const id = ch && (ch.id || ch);
                if (id && unlocked[id]) return true;
              }
            } catch (e) {}
            return ret;
          })
        );
        status.perm = "patched";
      } else {
        status.perm = "PermissionStore.can not found";
      }
    } catch (e) {
      status.perm = "error: " + e;
    }

    installBarDetector();

    // 2) ChatInputGuard: draws the "Done reading?" bar instead of the chat box
    try {
      let found = findHolder("ChatInputGuard");
      if (!found) {
        const m = vendetta.metro.findByName("ChatInputGuard", false);
        if (m) found = { holder: m, key: "default", id: "findByName" };
      }
      if (found) {
        unpatches.push(
          instead(found.key, found.holder, function (args, orig) {
            const props = args[0];
            lastSummary = summarize(props);
            const wasArmed = armed;
            armed = true;
            barSeen = false;
            let out;
            try {
              out = orig.apply(this, args);
            } finally {
              armed = wasArmed;
            }
            const blocked = barSeen;
            barSeen = false;
            if (!blocked) return out;

            const id = currentChannelId();
            if (id && unlocked[id]) {
              // permission patch didn't remove the bar: show the real chat box ourselves
              if (props && props.children != null) return props.children;
              return out;
            }
            return withUnlockButton(rewriteElement(out, 0));
          })
        );
        status.guard = "patched";
      } else {
        status.guard = "ChatInputGuard not found";
      }
    } catch (e) {
      status.guard = "error: " + e;
    }

    toast("SendAnyway: guard=" + status.guard + ", perm=" + status.perm);
  }

  return {
    default: {
      onLoad: function () {
        applyPatches();
      },
      onUnload: function () {
        armed = false;
        unpatches.forEach(function (u) {
          try { u(); } catch (e) {}
        });
        unpatches.length = 0;
        Object.keys(unlocked).forEach(function (k) { delete unlocked[k]; });
      },
    },
    __esModule: true,
  };
})();
