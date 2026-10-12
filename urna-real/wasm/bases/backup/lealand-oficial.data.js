var Module = typeof Module != 'undefined' ? Module : {};

if (!Module['expectedDataFileDownloads']) Module['expectedDataFileDownloads'] = 0;
Module['expectedDataFileDownloads']++;

(function() {
  async function carregarPacote(metadata) {
    var nomePacote = metadata['data'];
    var nomeRemoto = Module['locateFile'] ? Module['locateFile'](nomePacote, '') : nomePacote;
    var dependencia = 'datafile_' + nomePacote;

    function criarDiretorios(arquivo) {
      var partes = arquivo.split('/').filter(Boolean);
      var atual = '/';
      for (var indice = 0; indice < partes.length - 1; ++indice) {
        try {
          Module['FS_createPath'](atual, partes[indice], true, true);
        } catch (_) {
          // O diretorio pode ja existir quando varios arquivos compartilham o mesmo caminho.
        }
        atual += (atual === '/' ? '' : '/') + partes[indice];
      }
    }

    function montarArquivos(arrayBuffer) {
      var bytes = new Uint8Array(arrayBuffer);
      for (var arquivo of metadata['files']) {
        criarDiretorios(arquivo['filename']);
        Module['FS_createDataFile'](
          arquivo['filename'],
          null,
          bytes.subarray(arquivo['start'], arquivo['end']),
          true,
          true,
          true
        );
      }
      if (!Module['preloadResults']) Module['preloadResults'] = {};
      Module['preloadResults'][nomePacote] = {fromCache: false};
    }

    Module['addRunDependency'] && Module['addRunDependency'](dependencia);
    try {
      var resposta = await fetch(nomeRemoto);
      if (!resposta.ok) {
        throw new Error(resposta.status + ': ' + resposta.url);
      }
      montarArquivos(await resposta.arrayBuffer());
      Module['removeRunDependency'] && Module['removeRunDependency'](dependencia);
    } catch (erro) {
      console.error('Falha ao carregar pacote de dados ' + nomeRemoto, erro);
      throw erro;
    }
  }

    carregarPacote({"data":"lealand-oficial.data","remote_package_size":514463,"files":[{"filename":"/cenario.json","start":0,"end":568},{"filename":"/dsk/fi/estatico/0000100010001-lo.dat","start":568,"end":654},{"filename":"/dsk/fi/estatico/0000100010001-lo.vsc","start":654,"end":654},{"filename":"/dsk/fi/estatico/infomidia-fv-2-o.dat","start":654,"end":826},{"filename":"/dsk/fi/estatico/infomidia-fv-2-t.vsc","start":826,"end":826},{"filename":"/dsk/fi/estatico/scueconf-o2.dat","start":826,"end":904},{"filename":"/dsk/fi/estatico/scueconf-t2.vsc","start":904,"end":904},{"filename":"/dsk/fi/estatico/o00000br-pu.dat","start":904,"end":2325},{"filename":"/dsk/fi/estatico/t00000br-pu.pid","start":2325,"end":2377},{"filename":"/dsk/fi/estatico/t00000br-pu.vsc","start":2377,"end":17030},{"filename":"/dsk/fi/estatico/o02400-cp.dat","start":17030,"end":17196},{"filename":"/dsk/fi/estatico/t02400-cp.pid","start":17196,"end":17242},{"filename":"/dsk/fi/estatico/t02400-cp.vsc","start":17242,"end":36753},{"filename":"/dsk/fi/estatico/o02400ac-mme.dat","start":36753,"end":36780},{"filename":"/dsk/fi/estatico/t02400ac-mme.pid","start":36780,"end":36833},{"filename":"/dsk/fi/estatico/t02400ac-mme.vsc","start":36833,"end":56352},{"filename":"/dsk/fi/estatico/o02400ac-mu.dat","start":56352,"end":56458},{"filename":"/dsk/fi/estatico/t02400ac-mu.vsc","start":56458,"end":56458},{"filename":"/dsk/fi/estatico/o02400ac-mz.dat","start":56458,"end":56517},{"filename":"/dsk/fi/estatico/t02400ac-mz.pid","start":56517,"end":56569},{"filename":"/dsk/fi/estatico/t02400ac-mz.vsc","start":56569,"end":80948},{"filename":"/dsk/fi/estatico/o02400ac-pu.dat","start":80948,"end":82369},{"filename":"/dsk/fi/estatico/t02400ac-pu.pid","start":82369,"end":82421},{"filename":"/dsk/fi/estatico/t02400ac-pu.vsc","start":82421,"end":97074},{"filename":"/dsk/fi/estatico/t02400ac000010001-el.pid","start":97074,"end":97141},{"filename":"/dsk/fi/estatico/t02400ac000010001-el.vsc","start":97141,"end":170347},{"filename":"/dsk/fi/estatico/t02400ac000010001-imp.pid","start":170347,"end":170415},{"filename":"/dsk/fi/estatico/t02400ac000010001-imp.vsc","start":170415,"end":243629},{"filename":"/dsk/fi/estatico/o02400ac000010001-se.dat","start":243629,"end":243779},{"filename":"/dsk/fi/estatico/t02400ac000010001-se.pid","start":243779,"end":243846},{"filename":"/dsk/fi/estatico/t02400ac000010001-se.vsc","start":243846,"end":243846},{"filename":"/dsk/fi/estatico/t02400ac000010001-tte.pid","start":243846,"end":243914},{"filename":"/dsk/fi/estatico/t02400ac000010001-tte.vsc","start":243914,"end":317122},{"filename":"/dsk/fi/estatico/o02400ac0000100010001-el.dat","start":317122,"end":317242},{"filename":"/dsk/fi/estatico/t02400ac0000100010001-el.vsc","start":317242,"end":317242},{"filename":"/dsk/fi/estatico/o02400ac0000100010001-imp.dat","start":317242,"end":317308},{"filename":"/dsk/fi/estatico/t02400ac0000100010001-imp.vsc","start":317308,"end":317308},{"filename":"/dsk/fi/estatico/o02400ac0000100010001-tte.dat","start":317308,"end":317350},{"filename":"/dsk/fi/estatico/t02400ac0000100010001-tte.vsc","start":317350,"end":317350},{"filename":"/dsk/fi/estatico/o02420ac-cfm.dat","start":317350,"end":317604},{"filename":"/dsk/fi/estatico/t02420ac-cfm.vsc","start":317604,"end":317604},{"filename":"/dsk/fi/estatico/o02420ac-cm.dat","start":317604,"end":317678},{"filename":"/dsk/fi/estatico/t02420ac-cm.pid","start":317678,"end":317730},{"filename":"/dsk/fi/estatico/t02420ac-cm.vsc","start":317730,"end":337246},{"filename":"/dsk/fi/estatico/o02420ac-ste.dat","start":337246,"end":337291},{"filename":"/dsk/fi/estatico/t02420ac-ste.pid","start":337291,"end":337344},{"filename":"/dsk/fi/estatico/t02420ac-ste.vsc","start":337344,"end":361728},{"filename":"/dsk/fi/estatico/o02421ac-ce.dat","start":361728,"end":361947},{"filename":"/dsk/fi/estatico/t02421ac-ce.pid","start":361947,"end":361999},{"filename":"/dsk/fi/estatico/t02421ac-ce.vsc","start":361999,"end":381516},{"filename":"/dsk/fi/estatico/o02421ac00001-ca.dat","start":381516,"end":381966},{"filename":"/dsk/fi/estatico/t02421ac00001-ca.pid","start":381966,"end":382026},{"filename":"/dsk/fi/estatico/t02421ac00001-ca.vsc","start":382026,"end":430769},{"filename":"/dsk/fi/estatico/o02421ac00001-co.dat","start":430769,"end":430810},{"filename":"/dsk/fi/estatico/t02421ac00001-co.vsc","start":430810,"end":430810},{"filename":"/dsk/fi/estatico/o02421ac00001-fe.dat","start":430810,"end":430835},{"filename":"/dsk/fi/estatico/t02421ac00001-fe.vsc","start":430835,"end":430835},{"filename":"/dsk/fi/estatico/o02421ac00001-fo.dat","start":430835,"end":494601},{"filename":"/dsk/fi/estatico/t02421ac00001-fo.pid","start":494601,"end":494661},{"filename":"/dsk/fi/estatico/t02421ac00001-fo.vsc","start":494661,"end":514195},{"filename":"/dsk/fi/estatico/o02421ac00001-le.dat","start":514195,"end":514236},{"filename":"/dsk/fi/estatico/t02421ac00001-le.vsc","start":514236,"end":514236},{"filename":"/dsk/fi/estatico/o02421ac00001-pa.dat","start":514236,"end":514399},{"filename":"/dsk/fi/estatico/t02421ac00001-pa.vsc","start":514399,"end":514399},{"filename":"/dsk/fi/estatico/o02421ac00001-pi.dat","start":514399,"end":514426},{"filename":"/dsk/fi/estatico/t02421ac00001-pi.vsc","start":514426,"end":514426},{"filename":"/dsk/fi/estatico/o02421ac00001-rdj.dat","start":514426,"end":514455},{"filename":"/dsk/fi/estatico/t02421ac00001-rdj.vsc","start":514455,"end":514455},{"filename":"/dsk/fi/serialv.dat","start":514455,"end":514463}]});
})();
