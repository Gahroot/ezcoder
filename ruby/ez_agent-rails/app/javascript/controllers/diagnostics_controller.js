// diagnostics Stimulus controller
//
// Toggles the diagnostics body panel open/closed when the user clicks the
// "Diagnostics" button (with Lucide bar-chart-3 icon).
//
// Usage (Stimulus):
//   import { Controller } from "@hotwired/stimulus"
//   export default class extends Controller { ... }
//
// Usage (vanilla / no asset pipeline — self-initializing):
//   The IIFE below finds every [data-controller="diagnostics"] element
//   and wires it up automatically, so it works without a Stimulus runtime.

(function () {
  "use strict";

  var COLLAPSED_CLASS = "ez-agent-diagnostics--collapsed";

  function connectController(el) {
    var body = el.querySelector("[data-diagnostics-target='body']");
    if (!body) return;

    // Start collapsed.
    el.classList.add(COLLAPSED_CLASS);

    // Expose toggle so the data-action wiring can find it.
    el._diagnosticsToggle = function () {
      el.classList.toggle(COLLAPSED_CLASS);
    };

    // Wire up any toggle buttons inside the controller element.
    var buttons = el.querySelectorAll(
      "[data-action*='click->diagnostics#toggle']"
    );
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", el._diagnosticsToggle);
    }
  }

  function init() {
    var els = document.querySelectorAll(
      "[data-controller='diagnostics']"
    );
    for (var i = 0; i < els.length; i++) {
      connectController(els[i]);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
