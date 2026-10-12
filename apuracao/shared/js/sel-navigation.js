// Navegação institucional do Supremo Eleitoral de Lealand (SEL).
// Substitui o fluxo de 4 etapas do simulador brasileiro (escolha/turno,
// candidatos, acessibilidade, votação): Lealand tem eleição única para Gerente.
(function () {
  "use strict";

  var steps = [
    { number: 1, label: "Início — Supremo Eleitoral de Lealand", href: "index.html" },
    { number: 2, label: "Urna — Votar para Gerente", href: "urna/index.html" }
  ];

  function renderNavigation(navigation) {
    var currentStep = Number(navigation.dataset.currentStep);
    var root = navigation.dataset.root || "";
    var list = document.createElement("ol");
    list.className = "progress-container sel-steps";

    steps.forEach(function (step) {
      var item = document.createElement("li");
      item.className = "progress-panel";
      var control;
      if (step.number === currentStep) {
        item.classList.add("is-current");
        control = document.createElement("span");
        control.setAttribute("aria-current", "step");
      } else if (step.number < currentStep || currentStep === 0) {
        item.classList.add("is-unlocked");
        control = document.createElement("a");
        control.href = root + step.href;
      } else {
        item.classList.add("is-locked");
        control = document.createElement("span");
        control.setAttribute("aria-disabled", "true");
      }
      control.className = "progress-link";
      control.setAttribute("aria-label", "Etapa " + step.number + ": " + step.label);
      var number = document.createElement("span");
      number.className = "progress-number";
      number.setAttribute("aria-hidden", "true");
      number.textContent = String(step.number);
      var label = document.createElement("span");
      label.className = "progress-label";
      label.textContent = step.label;
      control.append(number, label);
      item.append(control);
      list.append(item);
    });

    navigation.replaceChildren(list);
  }

  function renderBrand() {
    var brandRow = document.querySelector(".brand-row");
    if (!brandRow || brandRow.querySelector(".sel-brand")) return;
    var wrap = document.createElement("div");
    wrap.className = "sel-brand";
    var img = document.createElement("img");
    img.src = (window.SEL_ASSETS !== undefined ? window.SEL_ASSETS : "") + "brand-coat.png";
    img.alt = "Brasão de Lealand";
    img.width = 56;
    img.height = 56;
    var texts = document.createElement("div");
    texts.className = "sel-brand-texts";
    var over = document.createElement("div");
    over.className = "sel-brand-over";
    over.textContent = "Supremo Eleitoral de Lealand";
    var under = document.createElement("div");
    under.className = "sel-brand-under";
    under.textContent = "Urna Eletrônica de Lealand";
    texts.append(over, under);
    wrap.append(img, texts);
    brandRow.prepend(wrap);
  }

  function renderAll() {
    document
      .querySelectorAll(".progress-navigation[data-current-step]")
      .forEach(renderNavigation);
    renderBrand();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", renderAll);
  } else {
    renderAll();
  }
})();
