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

    carregarPacote({"data":"lealand-gerente.data","remote_package_size":514484,"files":[{"filename":"/cenario.json","start":0,"end":587},{"filename":"/dsk/fi/estatico/0000100010001-lo.dat","start":587,"end":673},{"filename":"/dsk/fi/estatico/0000100010001-lo.vsc","start":673,"end":673},{"filename":"/dsk/fi/estatico/infomidia-fv-2-t.dat","start":673,"end":845},{"filename":"/dsk/fi/estatico/infomidia-fv-2-t.vsc","start":845,"end":845},{"filename":"/dsk/fi/estatico/scueconf-t2.dat","start":845,"end":923},{"filename":"/dsk/fi/estatico/scueconf-t2.vsc","start":923,"end":923},{"filename":"/dsk/fi/estatico/t00000br-pu.dat","start":923,"end":2344},{"filename":"/dsk/fi/estatico/t00000br-pu.pid","start":2344,"end":2396},{"filename":"/dsk/fi/estatico/t00000br-pu.vsc","start":2396,"end":17049},{"filename":"/dsk/fi/estatico/t02400-cp.dat","start":17049,"end":17217},{"filename":"/dsk/fi/estatico/t02400-cp.pid","start":17217,"end":17263},{"filename":"/dsk/fi/estatico/t02400-cp.vsc","start":17263,"end":36774},{"filename":"/dsk/fi/estatico/t02400ac-mme.dat","start":36774,"end":36801},{"filename":"/dsk/fi/estatico/t02400ac-mme.pid","start":36801,"end":36854},{"filename":"/dsk/fi/estatico/t02400ac-mme.vsc","start":36854,"end":56373},{"filename":"/dsk/fi/estatico/t02400ac-mu.dat","start":56373,"end":56479},{"filename":"/dsk/fi/estatico/t02400ac-mu.vsc","start":56479,"end":56479},{"filename":"/dsk/fi/estatico/t02400ac-mz.dat","start":56479,"end":56538},{"filename":"/dsk/fi/estatico/t02400ac-mz.pid","start":56538,"end":56590},{"filename":"/dsk/fi/estatico/t02400ac-mz.vsc","start":56590,"end":80969},{"filename":"/dsk/fi/estatico/t02400ac-pu.dat","start":80969,"end":82390},{"filename":"/dsk/fi/estatico/t02400ac-pu.pid","start":82390,"end":82442},{"filename":"/dsk/fi/estatico/t02400ac-pu.vsc","start":82442,"end":97095},{"filename":"/dsk/fi/estatico/t02400ac000010001-el.pid","start":97095,"end":97162},{"filename":"/dsk/fi/estatico/t02400ac000010001-el.vsc","start":97162,"end":170368},{"filename":"/dsk/fi/estatico/t02400ac000010001-imp.pid","start":170368,"end":170436},{"filename":"/dsk/fi/estatico/t02400ac000010001-imp.vsc","start":170436,"end":243650},{"filename":"/dsk/fi/estatico/t02400ac000010001-se.dat","start":243650,"end":243800},{"filename":"/dsk/fi/estatico/t02400ac000010001-se.pid","start":243800,"end":243867},{"filename":"/dsk/fi/estatico/t02400ac000010001-se.vsc","start":243867,"end":243867},{"filename":"/dsk/fi/estatico/t02400ac000010001-tte.pid","start":243867,"end":243935},{"filename":"/dsk/fi/estatico/t02400ac000010001-tte.vsc","start":243935,"end":317143},{"filename":"/dsk/fi/estatico/t02400ac0000100010001-el.dat","start":317143,"end":317263},{"filename":"/dsk/fi/estatico/t02400ac0000100010001-el.vsc","start":317263,"end":317263},{"filename":"/dsk/fi/estatico/t02400ac0000100010001-imp.dat","start":317263,"end":317329},{"filename":"/dsk/fi/estatico/t02400ac0000100010001-imp.vsc","start":317329,"end":317329},{"filename":"/dsk/fi/estatico/t02400ac0000100010001-tte.dat","start":317329,"end":317371},{"filename":"/dsk/fi/estatico/t02400ac0000100010001-tte.vsc","start":317371,"end":317371},{"filename":"/dsk/fi/estatico/t02420ac-cfm.dat","start":317371,"end":317625},{"filename":"/dsk/fi/estatico/t02420ac-cfm.vsc","start":317625,"end":317625},{"filename":"/dsk/fi/estatico/t02420ac-cm.dat","start":317625,"end":317699},{"filename":"/dsk/fi/estatico/t02420ac-cm.pid","start":317699,"end":317751},{"filename":"/dsk/fi/estatico/t02420ac-cm.vsc","start":317751,"end":337267},{"filename":"/dsk/fi/estatico/t02420ac-ste.dat","start":337267,"end":337312},{"filename":"/dsk/fi/estatico/t02420ac-ste.pid","start":337312,"end":337365},{"filename":"/dsk/fi/estatico/t02420ac-ste.vsc","start":337365,"end":361749},{"filename":"/dsk/fi/estatico/t02421ac-ce.dat","start":361749,"end":361968},{"filename":"/dsk/fi/estatico/t02421ac-ce.pid","start":361968,"end":362020},{"filename":"/dsk/fi/estatico/t02421ac-ce.vsc","start":362020,"end":381537},{"filename":"/dsk/fi/estatico/t02421ac00001-ca.dat","start":381537,"end":381987},{"filename":"/dsk/fi/estatico/t02421ac00001-ca.pid","start":381987,"end":382047},{"filename":"/dsk/fi/estatico/t02421ac00001-ca.vsc","start":382047,"end":430790},{"filename":"/dsk/fi/estatico/t02421ac00001-co.dat","start":430790,"end":430831},{"filename":"/dsk/fi/estatico/t02421ac00001-co.vsc","start":430831,"end":430831},{"filename":"/dsk/fi/estatico/t02421ac00001-fe.dat","start":430831,"end":430856},{"filename":"/dsk/fi/estatico/t02421ac00001-fe.vsc","start":430856,"end":430856},{"filename":"/dsk/fi/estatico/t02421ac00001-fo.dat","start":430856,"end":494622},{"filename":"/dsk/fi/estatico/t02421ac00001-fo.pid","start":494622,"end":494682},{"filename":"/dsk/fi/estatico/t02421ac00001-fo.vsc","start":494682,"end":514216},{"filename":"/dsk/fi/estatico/t02421ac00001-le.dat","start":514216,"end":514257},{"filename":"/dsk/fi/estatico/t02421ac00001-le.vsc","start":514257,"end":514257},{"filename":"/dsk/fi/estatico/t02421ac00001-pa.dat","start":514257,"end":514420},{"filename":"/dsk/fi/estatico/t02421ac00001-pa.vsc","start":514420,"end":514420},{"filename":"/dsk/fi/estatico/t02421ac00001-pi.dat","start":514420,"end":514447},{"filename":"/dsk/fi/estatico/t02421ac00001-pi.vsc","start":514447,"end":514447},{"filename":"/dsk/fi/estatico/t02421ac00001-rdj.dat","start":514447,"end":514476},{"filename":"/dsk/fi/estatico/t02421ac00001-rdj.vsc","start":514476,"end":514476},{"filename":"/dsk/fi/serialv.dat","start":514476,"end":514484}]});
})();
