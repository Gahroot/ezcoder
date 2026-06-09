// provider-selector Stimulus controller
//
// Populates the model <select> based on the selected provider and keeps
// hidden form inputs in sync so the backend receives the current choice.
//
// Usage (Stimulus):
//   import { Controller } from "@hotwired/stimulus"
//   export default class extends Controller { ... }
//
// Usage (vanilla / no asset pipeline — self-initializing):
//   The IIFE below finds every [data-controller="provider-selector"] element
//   and wires it up automatically, so it works without a Stimulus runtime.

(function () {
  "use strict";

  function connectController(el) {
    var modelsByProvider = JSON.parse(
      el.getAttribute("data-provider-selector-models-by-provider-value") || "{}"
    );
    var providerSelect = el.querySelector(
      "[data-provider-selector-target='provider']"
    );
    var modelSelect = el.querySelector(
      "[data-provider-selector-target='model']"
    );
    if (!providerSelect || !modelSelect) return;

    // Walk up to the nearest form so we can update hidden inputs.
    var form = el.closest("form");

    function hiddenInput(name) {
      return form ? form.querySelector("input[name='" + name + "']") : null;
    }

    function modelsForProvider(provider) {
      return modelsByProvider[provider] || [];
    }

    function populateModels(provider, preserveSelection) {
      var models = modelsForProvider(provider);
      var prevValue = modelSelect.value;
      modelSelect.innerHTML = "";

      models.forEach(function (model) {
        var opt = document.createElement("option");
        opt.value = model.id;
        opt.textContent = model.name;
        modelSelect.appendChild(opt);
      });

      // Try to keep the previously-selected model if it still exists.
      if (preserveSelection) {
        for (var i = 0; i < modelSelect.options.length; i++) {
          if (modelSelect.options[i].value === prevValue) {
            modelSelect.value = prevValue;
            break;
          }
        }
      }

      syncHiddenInputs();
    }

    function syncHiddenInputs() {
      var pi = hiddenInput("provider");
      var mi = hiddenInput("model");
      if (pi) pi.value = providerSelect.value;
      if (mi) mi.value = modelSelect.value;
    }

    providerSelect.addEventListener("change", function () {
      populateModels(providerSelect.value, false);
    });

    modelSelect.addEventListener("change", function () {
      syncHiddenInputs();
    });

    // Initial population — preserve the server-rendered default model when possible.
    populateModels(providerSelect.value, true);
  }

  function init() {
    var els = document.querySelectorAll(
      "[data-controller='provider-selector']"
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
