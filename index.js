(function () {
  "use strict";

  const { findByProps, findByStoreName } = vendetta.metro;
  const { instead, after } = vendetta.patcher;
  const React = vendetta.metro.common.React;

  const TAPS_NEEDED = 3;
  const TAP_WINDOW_MS = 2000;
  const SEND_MESSAGES = 2048; // permission bit (1 << 11)
  const PRESS_KEY = /^on(press|click|tap|select)$/i;

  const unpatches = [];
  const unlocked = {}; // channelId -> true
  const status = {};
  let tapCount = 0;
  let tapTimer = null;
  let lastSummary = null;
  let PermissionStore = null;
  let SelectedChannelStore = null;

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

  function onCtaTap() {
    tapCount++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(function () { tapCount = 0; }, TAP_WINDOW_MS);
    if (tapCount < TAPS_NEEDED) return;
    tapCount = 0;

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
    copy(JSON.stringify({ status: status, channel: id, cta: lastSummary }, null, 1));
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
      if (PRESS_KEY.test(k) && typeof v === "function") out[k] = onCtaTap;
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
        np[k] = onCtaTap;
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

    // 2) The "Done reading? Check out #channel" bar: count taps, block navigation
    try {
      const holder = findByProps("TextAreaCta");
      if (holder && typeof holder.TextAreaCta === "function") {
        unpatches.push(
          instead("TextAreaCta", holder, function (args, orig) {
            lastSummary = summarize(args[0]);
            const rest = Array.prototype.slice.call(args, 1);
            const out = orig.apply(this, [overrideProps(args[0], 0)].concat(rest));
            return rewriteElement(out, 0);
          })
        );
        status.cta = "patched";
      } else {
        status.cta = holder ? "TextAreaCta is " + typeof holder.TextAreaCta : "not found";
      }
    } catch (e) {
      status.cta = "error: " + e;
    }

    toast("SendAnyway: cta=" + status.cta + ", perm=" + status.perm);
  }

  return {
    default: {
      onLoad: function () {
        applyPatches();
      },
      onUnload: function () {
        clearTimeout(tapTimer);
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
