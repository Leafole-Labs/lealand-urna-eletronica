// SEL-Lealand: remoção do GIF de Libras (intérprete) do motor VOTA.
//
// O motor empilha animações GIF em `#uenux-gif-layer` (fotos JPEG de
// candidatos vão direto ao canvas — verificado por screenshot: telas de
// confirmação exibem as fotos com a camada vazia). Este módulo, 100% camada
// de apresentação (nenhum arquivo do motor é alterado):
//  1. trava `acessibilidade=nao` antes do adaptador iniciar, para o motor
//     nunca entrar no modo Libras/áudio (Lealand não oferece essa etapa);
//  2. observa `#uenux-gif-layer` e remove todo <img> que o motor inserir,
//     sem tocar no canvas nem no teclado.
// Contador em `window.__selLibrasRemovidos` para verificação em testes.
(function () {
  'use strict';

  var LAYER_ID = 'uenux-gif-layer';

  try {
    localStorage.setItem('acessibilidade', 'nao');
  } catch (_) {
    // Sem armazenamento: a guarda do item 2 continua ativa.
  }

  function sweep(layer) {
    var imgs = layer.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].remove();
      window.__selLibrasRemovidos = (window.__selLibrasRemovidos || 0) + 1;
    }
  }

  function watch(layer) {
    sweep(layer);
    new MutationObserver(function () {
      sweep(layer);
    }).observe(layer, { childList: true });
  }

  function boot() {
    var layer = document.getElementById(LAYER_ID);
    if (layer) {
      watch(layer);
      return;
    }
    // O motor cria a camada depois do boot: espera por ela sem polling cego.
    new MutationObserver(function (mutations, observer) {
      var found = document.getElementById(LAYER_ID);
      if (found) {
        observer.disconnect();
        watch(found);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
