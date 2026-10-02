(function () {
  "use strict";

  const modules = vendetta.metro.modules;
  const PATTERN = /done.?reading|next.?channel|read.?only/i;
  const MAX_RESULTS = 8;

  function check(exp, id, key, results) {
    if (typeof exp !== "function" || results.length >= MAX_RESULTS) return;
    let src;
    try {
      src = Function.prototype.toString.call(exp);
    } catch (e) {
      return;
    }
    const m = src.match(PATTERN);
    if (!m) return;
    const start = Math.max(0, m.index - 100);
    results.push({
      module: id,
      export: key,
      name: exp.displayName || exp.name || "",
      match: m[0],
      snippet: src.slice(start, start + 260),
    });
  }

  function scan() {
    const results = [];
    try {
      for (const id in modules) {
        if (results.length >= MAX_RESULTS) break;
        const mod = modules[id];
        if (!mod || !mod.isInitialized) continue;
        let exp;
        try {
          exp = mod.publicModule && mod.publicModule.exports;
        } catch (e) {
          continue;
        }
        if (!exp) continue;
        check(exp, id, "module", results);
        try { if (exp.default) check(exp.default, id, "default", results); } catch (e) {}
        if (typeof exp === "object") {
          let keys = [];
          try { keys = Object.keys(exp); } catch (e) {}
          for (const k of keys) {
            if (k === "default") continue;
            try { check(exp[k], id, k, results); } catch (e) {}
          }
        }
      }
    } catch (e) {
      console.error("[ChatBarFinder] scan failed", e);
    }

    console.log("[ChatBarFinder] found " + results.length + " candidates:\n" + JSON.stringify(results, null, 2));
    try {
      vendetta.ui.toasts.showToast("ChatBarFinder: " + results.length + " candidates (see debug console)");
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
