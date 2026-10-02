(function () {
  "use strict";

  const modules = vendetta.metro.modules;
  const NAME_PATTERN = /chat.?input|text.?area|guard|next.?channel|done.?reading|channel.?suggest|can.?send|no.?permission|locked|chat.?bar|slow.?mode|read.?only.?channel/i;
  const NOISE = /^(DOMRectReadOnly|ReadOnly(Node|Element|CharacterData|Text)|_readOnlyError|computeIsReadOnlyThread)$/;
  const MAX_NAMES = 60;

  function fnName(f) {
    try {
      return typeof f === "function" ? f.displayName || f.name || "" : "";
    } catch (e) {
      return "";
    }
  }

  function scanNames() {
    const found = [];
    const seen = {};

    function add(id, key, name) {
      if (!name || NOISE.test(name) || !NAME_PATTERN.test(name)) return;
      const sig = id + ":" + name;
      if (seen[sig] || found.length >= MAX_NAMES) return;
      seen[sig] = true;
      found.push({ module: id, export: key, name: name });
    }

    try {
      for (const id in modules) {
        if (found.length >= MAX_NAMES) break;
        const mod = modules[id];
        if (!mod || !mod.isInitialized) continue;
        let exp;
        try {
          exp = mod.publicModule && mod.publicModule.exports;
        } catch (e) {
          continue;
        }
        if (!exp) continue;

        add(id, "module", fnName(exp));
        try { if (exp.default) add(id, "default", fnName(exp.default)); } catch (e) {}

        if (typeof exp === "object") {
          let keys = [];
          try { keys = Object.keys(exp); } catch (e) {}
          for (const k of keys) {
            if (k === "default") continue;
            add(id, k, k);
            try { add(id, k, fnName(exp[k])); } catch (e) {}
          }
        }
      }
    } catch (e) {
      console.error("[ChatBarFinder] name scan failed", e);
    }
    return found;
  }

  function scanStrings() {
    const out = [];
    try {
      const i18n = vendetta.metro.common.i18n;
      const msgs = i18n && (i18n.Messages || (i18n.default && i18n.default.Messages));
      if (msgs) {
        const keys = Object.keys(msgs);
        for (let i = 0; i < keys.length && out.length < 10; i++) {
          let v;
          try {
            v = msgs[keys[i]];
            if (typeof v === "function") v = v();
          } catch (e) {
            continue;
          }
          if (typeof v === "string" && /done reading|check out/i.test(v)) {
            out.push(keys[i] + ": " + v.slice(0, 80));
          }
        }
      }
    } catch (e) {}
    return out;
  }

  function scan() {
    const names = scanNames();
    const strings = scanStrings();
    const text =
      "[ChatBarFinder v2] " + names.length + " names, " + strings.length + " strings\n" +
      JSON.stringify({ names: names, strings: strings }, null, 1);
    console.log(text);

    let copied = false;
    try {
      const cb = vendetta.metro.findByProps("setString");
      if (cb && cb.setString) {
        cb.setString(text);
        copied = true;
      }
    } catch (e) {}

    try {
      vendetta.ui.toasts.showToast(
        "ChatBarFinder: " + names.length + " names, " + strings.length + " strings" + (copied ? ", copied" : "")
      );
    } catch (e) {}
  }

  let timer;

  return {
    default: {
      onLoad: function () {
        timer = setTimeout(scan, 1500);
      },
      onUnload: function () {
        clearTimeout(timer);
      },
    },
    __esModule: true,
  };
})();
