import type { Message } from "../types";
import type { MessageKey } from "./en";

/** Brazilian Portuguese, polite register: the "você" imperative ("use",
 * "escolha") without titles. */
export const ptBR: Record<MessageKey, Message> = {
  "frame.banner.title": "Versão de desenvolvimento com dados fictícios",
  "frame.banner.body": "Não use informações reais de pacientes",
  "frame.window.label": "Cofre privado do myCarlos",
  "frame.state.locked": "Bloqueado",
  "frame.state.locking": "Bloqueando",
  "frame.state.notLocked": "Desbloqueado",
  "frame.state.settingUp": "Configurando",
  "frame.state.opening": "Abrindo",
  "auth.kicker": "Registros privados do myCarlos",

  "passphrase.label": "Frase secreta",
  "passphrase.confirm.label": "Confirmar a frase secreta",
  "passphrase.new.label": "Nova frase secreta",
  "passphrase.confirmNew.label": "Confirmar a nova frase secreta",
  "passphrase.rules":
    "Use pelo menos {min} caracteres. Espaços são permitidos; senhas comuns, nomes e padrões previsíveis são recusados neste dispositivo.",
  "passphrase.mismatch": "As frases secretas não são iguais.",
  "passphrase.tooLong": "Esta frase secreta é longa demais. Encurte-a.",
  "passphrase.tooShort":
    "Esta frase secreta é curta demais. Use pelo menos {min} caracteres.",
  "passphrase.longerThanAny":
    "Este texto é mais longo do que qualquer frase secreta do cofre. Confira o que foi digitado.",

  "passphrase.show": "Mostrar a frase secreta",
  "passphrase.show.inConfirm": "em Confirmar a frase secreta",

  "checklist.heading": "Sua frase secreta precisa ser:",
  "checklist.length": "De pelo menos {min} caracteres",
  "checklist.hardToGuess": "Difícil de adivinhar",
  "checklist.notAName": "Diferente do seu nome",
  "checklist.done": ", atendido",
  "checklist.notYet": ", ainda não",
  "checklist.spaces":
    "Espaços são permitidos, então algumas palavras sem relação entre si formam uma boa frase secreta. O myCarlos verifica essas regras neste computador.",
  "checklist.allMet": "Sua frase secreta atende a todas as regras.",

  "create.title": "Configure o myCarlos neste computador",
  "create.intro":
    "Seus arquivos e os detalhes dos seus registros são criptografados neste dispositivo. Sua frase secreta abre o cofre. Depois, você poderá configurar uma chave de recuperação, caso a esqueça.",
  "create.stays":
    "Seu cofre fica neste dispositivo. Se você criou um em outro dispositivo, ele continua lá e não aparecerá aqui.",
  "create.profile.label": "De quem são os registros que você vai guardar aqui?",
  "create.profile.tooLong": "Este nome é longo demais. Encurte-o.",
  "create.profile.sharedTaken":
    "“{folder}” é onde ficam os arquivos compartilhados. Escolha outro nome.",
  "create.submit": "Criar cofre",

  "unlock.title": "Desbloqueie seu cofre",
  "unlock.autoLock": {
    one: "O cofre é bloqueado após {count} minuto de inatividade e sempre que o myCarlos fica oculto, por exemplo minimizado ou enviado para segundo plano.",
    many: "O cofre é bloqueado após {count} de minutos de inatividade e sempre que o myCarlos fica oculto, por exemplo minimizado ou enviado para segundo plano.",
    other:
      "O cofre é bloqueado após {count} minutos de inatividade e sempre que o myCarlos fica oculto, por exemplo minimizado ou enviado para segundo plano.",
  },
  "unlock.waiting.one":
    "Um arquivo compartilhado está aguardando. Desbloqueie o cofre e ele irá para “{folder}”. Se o myCarlos fechar antes, ele não será mantido: compartilhe-o de novo.",
  "unlock.waiting": {
    one: "{count} arquivo compartilhado está aguardando. Desbloqueie o cofre e ele irá para “{folder}”. Se o myCarlos fechar antes, ele não será mantido: compartilhe-o de novo.",
    many: "{count} arquivos compartilhados estão aguardando. Desbloqueie o cofre e eles irão para “{folder}”. Se o myCarlos fechar antes, eles não serão mantidos: compartilhe-os de novo.",
    other:
      "{count} arquivos compartilhados estão aguardando. Desbloqueie o cofre e eles irão para “{folder}”. Se o myCarlos fechar antes, eles não serão mantidos: compartilhe-os de novo.",
  },
  "unlock.submit": "Desbloquear",
  "unlock.forgot.summary": "Esqueceu sua frase secreta?",
  "unlock.noKey.heading": "Não tem uma chave de recuperação?",
  "unlock.noKey.body":
    "Sem ela, a única forma de voltar a entrar é apagar o myCarlos e começar de novo.",
  "restore.summary": "Restaurar a partir de uma cópia de segurança",

  "reset.plainly":
    "Apagar exclui do myCarlos neste computador todos os seus documentos, pastas e perfis de paciente, e isso não pode ser desfeito. Para confirmar, digite exatamente as palavras abaixo.",
  "reset.type": "Digite {phrase}",
  "reset.submit": "Apagar cofre",

  "recover.intro":
    "Use sua chave de recuperação para abrir o cofre e escolher uma nova frase secreta.",
  "recover.key.label": "Chave de recuperação",
  "recover.key.format":
    "28 letras e números, em 7 grupos de 4, como no seu kit ou como você anotou. Traços, espaços e outros sinais de pontuação não importam.",
  "recover.key.show": "Mostrar a chave de recuperação",
  "recover.submit": "Abrir com a chave de recuperação",

  "secret.count.password": {
    one: "Frase secreta de {count} caractere",
    many: "Frase secreta de {count} de caracteres",
    other: "Frase secreta de {count} caracteres",
  },
  "secret.count.recoveryKey": {
    one: "Chave de recuperação de {count} caractere",
    many: "Chave de recuperação de {count} de caracteres",
    other: "Chave de recuperação de {count} caracteres",
  },
  "secret.count.shown": "{description}, visível",

  "restore.intro":
    "Uma cópia de segurança criptografada abre com a frase secreta usada ao criá-la, ou com a chave de recuperação que o cofre tinha quando a cópia foi salva, se ele tinha uma.",
  "restore.choose": "Escolher arquivo de cópia de segurança…",
  "restore.chooseOther": "Escolher outra cópia de segurança…",
  "restore.chosen": "Cópia de segurança escolhida.",
  "restore.openWith": "Abrir com",
  "restore.method.passphrase": "A frase secreta dela",
  "restore.method.recoveryKey": "A chave de recuperação dela",
  "restore.passphrase.label": "Frase secreta da cópia de segurança",
  "restore.passphrase.show": "Mostrar a frase secreta",
  "restore.tooLong": "Este texto é longo demais. Confira o que foi digitado.",
  "restore.check": "Verificar cópia de segurança",
  "restore.checking": "Verificando a cópia de segurança…",
  "restore.checked": {
    one: "A cópia de segurança contém {count} documento. {consequence}",
    many: "A cópia de segurança contém {count} de documentos. {consequence}",
    other: "A cópia de segurança contém {count} documentos. {consequence}",
  },
  "restore.consequence.nothing":
    "Restaurar coloca este cofre neste dispositivo.",
  "restore.consequence.same":
    "O cofre deste dispositivo contém os mesmos documentos. Restaurar o substitui por esta cópia de segurança.",
  "restore.consequence.differs":
    "O cofre deste dispositivo pode não ser igual a esta cópia de segurança: ele pode ter mudado desde então, ou uma parte dele não pôde ser lida. Restaurar substitui o cofre pela cópia de segurança: tudo o que estiver no cofre e não estiver na cópia é perdido, e a frase secreta e a chave de recuperação passam a ser as da cópia de segurança.",
  "restore.consequence.otherVault":
    "Este dispositivo tem um cofre diferente. Restaurar o apaga permanentemente e coloca a cópia de segurança no lugar dele.",
  "restore.consequence.unreadable":
    "O cofre deste dispositivo não pôde ser lido, então o myCarlos não consegue saber se é aquele de onde esta cópia de segurança veio. Restaurar o apaga permanentemente e coloca a cópia de segurança no lugar dele.",
  "restore.agree.erase":
    "Apagar o cofre deste dispositivo e restaurar a cópia de segurança",
  "restore.agree.replace":
    "Substituir o cofre deste dispositivo por esta cópia de segurança e perder o que mudou desde então",
  "restore.submit": "Restaurar cópia de segurança",
  "restore.restoring":
    "Restaurando a cópia de segurança. Isso pode demorar em um cofre grande…",
  "restore.cancelled": "Restauração cancelada. Nada foi alterado.",

  // Shared
  "common.cancel": "Cancelar",

  // Library sidebar
  "sidebar.label": "Biblioteca de documentos",
  "sidebar.myRecords": "Meus documentos",
  "sidebar.settings": "Configurações",
  "sidebar.preferences": "Preferências",
  "sidebar.storage": "Cofre local criptografado",
  "sidebar.documents": {
    one: "{count} documento",
    many: "{count} de documentos",
    other: "{count} documentos",
  },
  "sidebar.folderCount": {
    one: "{count} pasta",
    many: "{count} de pastas",
    other: "{count} pastas",
  },

  // Text size (Settings > Preferences)
  "textSize.title": "Tamanho do texto",
  "textSize.announce": "Tamanho do texto {percent}",
  "textSize.help":
    "Aumenta ou diminui tudo no myCarlos, de {min}% a {max}%. O myCarlos lembra o tamanho neste computador. Você também pode manter a tecla {modifier} pressionada e pressionar mais, menos ou 0.",
  "textSize.key.command": "Comando",
  "textSize.smaller": "Texto menor",
  "textSize.larger": "Texto maior",
  "textSize.box": "Tamanho do texto em porcentagem",
  "textSize.reset": "Voltar ao tamanho normal",
  "textSize.notNumber": "Digite um número de {min} a {max}.",
  "textSize.smallest": "O menor tamanho é {min}%.",
  "textSize.largest": "O maior tamanho é {max}%.",
  "textSize.between":
    "{typed}% fica entre dois tamanhos, então o tamanho é {size}.",

  // Rename a document or folder
  "rename.title.document": "Renomear documento",
  "rename.title.folder": "Renomear pasta",
  "rename.label.folder": "Nome da pasta",
  "rename.label.document": "Nome do arquivo",
  "rename.help.folder": "A pasta e seu conteúdo continuam no mesmo lugar.",
  "rename.help.document":
    "Isso muda o nome no myCarlos e o nome sugerido ao exportar.",
  "rename.help.documentExtension":
    "Isso muda o nome no myCarlos e o nome sugerido ao exportar. A extensão {extension} continua a mesma.",
  "rename.stemMissing": "Digite um nome antes de {extension}.",
  "rename.gainsExtension":
    "O nome deste documento não tem a extensão .pdf, então não pode terminar em .pdf.",
  "rename.tooLong": "Este nome é longo demais. Encurte-o para salvar.",
  "rename.unsafe":
    "Nomes de documentos não podem conter {characters} nem caracteres de controle invisíveis, nem terminar com ponto.",
  "rename.reserved":
    "“{word}” não pode ser usado como nome de documento, porque o Windows o reserva para uso próprio. Escolha outro nome.",
  "rename.saving": "Salvando…",
  "rename.save": "Salvar nome",

  // Settings > Security
  "security.title": "Segurança",
  "security.subtitle": "Seu cofre criptografado e as configurações de acesso",
  "security.devBuild.title": "Versão de desenvolvimento.",
  "security.devBuild.body": "Use apenas arquivos fictícios.",
  "security.encryption.title": "Criptografia",
  "security.encryption.state": "Ativada — sempre",
  "security.encryption.body":
    "Os arquivos, os nomes, as pastas e os detalhes dos documentos são criptografados neste dispositivo.",
  "security.autoLock.title": "Bloqueio automático",
  "security.autoLock.minutes": {
    one: "{count} minuto",
    many: "{count} de minutos",
    other: "{count} minutos",
  },
  "security.autoLock.body":
    "O cofre é bloqueado após o período escolhido sem atividade do teclado, do ponteiro ou da tela sensível ao toque. Escolha de 1 a 15 minutos.",
  "security.autoLock.label": "Tempo para o bloqueio automático",
  "security.autoLock.shorter": "Tempo menor",
  "security.autoLock.longer": "Tempo maior",
  "security.lockNow": "Bloquear agora",
  "security.recoveryKey.title": "Chave de recuperação",
  "security.recoveryKey.setUpOn": "Configurada em {date}",
  "security.recoveryKey.notSetUp": "Não configurada",
  "security.recoveryKey.body":
    "Abre seu cofre se você esquecer sua frase secreta. Só você a tem: ninguém na sua clínica nem no myCarlos pode abrir seu cofre por você. Ao substituí-la, a antiga deixa de funcionar.",
  "security.recoveryKey.current":
    "Sua chave atual tem a etiqueta {label}. O kit ou a anotação com esta etiqueta é o que funciona; um com outra etiqueta não abre este cofre. Kits e anotações feitos antes de as etiquetas serem exibidas não têm etiqueta: um sem etiqueta ainda pode ser esta chave, configurada em {date}.",
  "security.recoveryKey.replace": "Substituir a chave de recuperação",
  "security.recoveryKey.setUp": "Configurar uma chave de recuperação",
  "security.backup.title": "Cópia de segurança criptografada",
  "security.backup.body":
    "Um único arquivo com todo o seu cofre, ainda criptografado. Guarde-o em outro lugar que não este dispositivo, como um pen drive. Ele abre com a frase secreta ou a chave de recuperação que você tiver ao salvá-lo, e continua abrindo com elas mesmo depois que você as mudar aqui. Para restaurar uma cópia, bloqueie o cofre e escolha Restaurar a partir de uma cópia de segurança.",
  "security.oldBackups.title": "Suas cópias de segurança anteriores",
  "security.oldBackups.intro":
    "O kit de uma chave de recuperação anterior pode ter sido perdido ou visto, e ele ainda abre as cópias de segurança salvas antes de essa chave ser substituída.",
  "security.oldBackups.saveWhenWritable":
    "Quando o cofre voltar a aceitar alterações, salve uma nova cópia de segurança: escolha Salvar cópia de segurança criptografada.",
  "security.oldBackups.saveNow":
    "Salve agora uma nova cópia de segurança: escolha Salvar cópia de segurança criptografada.",
  "security.oldBackups.keepCopy":
    "Guarde-a, ou uma cópia dela, em outro lugar que não este dispositivo, como um pen drive ou um armazenamento na nuvem.",
  "security.oldBackups.thenDelete":
    "Depois, exclua as cópias de segurança anteriores. Quando a nova estiver salva, aqui será explicado como.",
  "security.oldBackups.none": "Não tenho cópias de segurança anteriores",
  "security.oldBackups.named": "Sua nova cópia de segurança é “{name}”.",
  "security.oldBackups.namedWithSize":
    "Sua nova cópia de segurança é “{name}” ({size}).",
  "security.oldBackups.justSaved":
    "Sua nova cópia de segurança é a que você acabou de salvar, em {date} por volta das {time}: seu aplicativo de arquivos mostra quando cada arquivo foi salvo e o tamanho dele.",
  "security.oldBackups.justSavedWithSize":
    "Sua nova cópia de segurança é a que você acabou de salvar, em {date} por volta das {time} ({size}): seu aplicativo de arquivos mostra quando cada arquivo foi salvo e o tamanho dele.",
  "security.oldBackups.deleteOlder":
    "Exclua as cópias de segurança anteriores: os arquivos cujo nome começa com “myCarlos backup” e as que você renomeou, exceto a nova e as cópias dela. Elas estão onde você as salvou: uma pasta, um pen drive ou, no celular, o app Arquivos ou um armazenamento na nuvem.",
  "security.oldBackups.inPlace":
    "Se você a salvou no lugar de uma cópia de segurança anterior, esse arquivo agora é a sua nova cópia de segurança: guarde-o.",
  "security.oldBackups.done": "Terminei com as cópias anteriores",
  "security.backup.save": "Salvar cópia de segurança criptografada…",
  "security.passphrase.title": "Mudar a frase secreta",
  "security.passphrase.rules":
    "Use pelo menos {min} caracteres e evite nomes comuns ou frases previsíveis. Sua chave de recuperação, se você tiver uma, continua funcionando; sem ela, esquecer a nova frase secreta significa apagar o cofre.",
  "security.passphrase.copies":
    "Mudar a frase secreta impede o acesso de quem só conhece a antiga. Se essa pessoa também puder ter uma cópia do seu cofre, como um backup deste dispositivo ou um arquivo de cópia de segurança salvo, uma nova frase secreta não basta: a antiga ainda abre essa cópia, e com essa cópia ela poderia abrir uma mais recente que conseguir depois. Para deixá-la de fora, é preciso um cofre novo, e cuidado para não perder documentos no caminho. Peça ajuda antes de apagar qualquer coisa.",
  "security.passphrase.current": "Frase secreta atual",
  "security.passphrase.currentTooLong":
    "A frase secreta atual é mais longa do que qualquer frase secreta de cofre. Confira o que foi digitado.",
  "security.passphrase.mismatch": "As novas frases secretas não coincidem.",
  "security.passphrase.newTooLong":
    "A nova frase secreta é longa demais. Encurte-a.",
  "security.passphrase.newTooShort":
    "A nova frase secreta é curta demais. Use pelo menos {min} caracteres.",
  "security.passphrase.submit": "Mudar a frase secreta",
  "security.speed.title": "Teste de velocidade, para testadores",
  "security.speed.body":
    "Mede quanto tempo este dispositivo leva para verificar uma frase secreta. Usa uma frase secreta inventada, não a sua, e não muda nada. Leva alguns segundos, mais em um celular antigo. Feche os outros aplicativos antes e fique nesta tela até terminar. Envie o resultado com a marca e o modelo do dispositivo.",
  "security.speed.run": "Fazer o teste de velocidade",
  "security.speed.measuring": "Medindo…",
  "security.copies.title": "Cópias legíveis e capturas de tela",
  "security.copies.body":
    "Exportações e capturas de tela ficam fora da proteção do cofre. Excluir um documento do myCarlos não apaga essas cópias nem o prontuário original da clínica.",
  "security.profiles.title": "Perfis de paciente",
  "security.profiles.body":
    "Mantenha separados os documentos de cada pessoa dentro deste cofre.",
  "security.profiles.label": "Nome do novo perfil",
  "security.profiles.add": "Adicionar perfil",
  "security.erase.title": "Apagar todo o cofre",
  "security.erase.body":
    "Exclui permanentemente todos os documentos, perfis e pastas criptografados. Isso não pode ser desfeito.",
  "security.erase.show": "Mostrar os controles para apagar",
  "security.erase.submit": "Apagar todo o cofre",

  // Recovery key setup, and the printed kit
  "recoveryKey.printUnavailable":
    "Não é possível imprimir aqui. Salve o kit ou anote a chave.",
  "recoveryKey.chooseReason":
    "Escolha por que você está substituindo sua chave de recuperação.",
  "recoveryKey.kitSaved":
    "Kit de recuperação salvo. A chave começa a funcionar quando você terminar a verificação.",
  "recoveryKey.typedCount": {
    one: "Você digitou {count} letra ou número. Sua chave de recuperação tem {total} letras e números: 7 grupos de 4. Confira o que você anotou.",
    many: "Você digitou {count} de letras e números. Sua chave de recuperação tem {total} letras e números: 7 grupos de 4. Confira o que você anotou.",
    other:
      "Você digitou {count} letras e números. Sua chave de recuperação tem {total} letras e números: 7 grupos de 4. Confira o que você anotou.",
  },
  "recoveryKey.notChanged":
    "Sua chave de recuperação não foi alterada. Sua chave atual continua funcionando. Para alterá-la, pressione Verificar e salvar de novo.",
  "recoveryKey.threeMisses":
    "Não coincidiu três vezes. Olhe de novo sua chave de recuperação e depois verifique-a.",
  "recoveryKey.leave.required": "Bloquear o cofre e terminar depois",
  "recoveryKey.leave.offered": "Configurar depois",
  "recoveryKey.title.replace": "Substitua sua chave de recuperação",
  "recoveryKey.title.setUp": "Configure uma chave de recuperação",
  "recoveryKey.title.key": "Sua chave de recuperação",
  "recoveryKey.title.check": "Verifique sua chave de recuperação",
  "recoveryKey.discard.title": "Descartar esta chave de recuperação?",
  "recoveryKey.discard.body":
    "Esta chave de recuperação ainda não está configurada, então nunca vai abrir o cofre. O myCarlos bloqueia o cofre agora. Depois de desbloqueá-lo, você poderá configurar uma nova chave.",
  "recoveryKey.discard.confirm": "Descartar a chave e bloquear",
  "recoveryKey.about.offered":
    "Seu cofre está aberto. Ele ainda não tem chave de recuperação. Sem ela, se você esquecer sua frase secreta, a única forma de voltar a entrar é apagar o cofre.",
  "recoveryKey.about.what":
    "Uma chave de recuperação abre seu cofre se você esquecer sua frase secreta. Só você vai tê-la: ninguém na sua clínica nem no myCarlos pode abrir seu cofre por você.",
  "recoveryKey.about.replacing":
    "Sua chave de recuperação atual deixa de funcionar quando você tiver verificado a nova.",
  "recoveryKey.about.type":
    "Digite sua frase secreta para criar sua chave de recuperação. Ela aparece em seguida: escolha Continuar só quando ninguém mais puder ver sua tela.",
  "recoveryKey.about.typeAgain":
    "Digite sua frase secreta de novo para criar sua chave de recuperação. Ela aparece em seguida: escolha Continuar só quando ninguém mais puder ver sua tela.",
  "recoveryKey.about.typeNew":
    "Digite sua frase secreta para criar sua nova chave de recuperação. Ela aparece em seguida: escolha Continuar só quando ninguém mais puder ver sua tela.",
  "recoveryKey.about.typeAgainNew":
    "Digite sua frase secreta de novo para criar sua nova chave de recuperação. Ela aparece em seguida: escolha Continuar só quando ninguém mais puder ver sua tela.",
  "recoveryKey.reason.legend": "Por que você está substituindo a chave?",
  "recoveryKey.reason.hint": "Se não tiver certeza, escolha a primeira.",
  "recoveryKey.reason.exposed":
    "O kit ou a anotação dela pode ter sido perdido ou visto por outra pessoa",
  "recoveryKey.reason.routine":
    "Só quero uma chave nova: o kit dela está seguro",
  "recoveryKey.continue": "Continuar",
  "recoveryKey.keyboardHint":
    "A tecla Esc sai desta configuração. Na primeira configuração, ela pergunta antes, porque sair bloqueia o cofre e uma chave inacabada não vai funcionar.",
  "recoveryKey.instructions":
    "Anote-a, ou salve ou imprima o kit, e guarde-a em um lugar reservado, longe deste dispositivo. Esta é a única vez que o myCarlos a mostra. Em seguida, você vai digitá-la inteira para verificá-la. Fique no myCarlos até terminar a verificação: sair ou bloquear cancela esta chave.",
  "recoveryKey.hiddenWhileSaving": "Oculta enquanto o kit é salvo.",
  "recoveryKey.group": "Grupo {number}: {characters}",
  "recoveryKey.label":
    "Etiqueta da chave: {label}. Anote-a ao lado da chave. Ela não é secreta: em Segurança, o myCarlos mostra a etiqueta da chave que funciona, para você saber qual kit é o atual.",
  "recoveryKey.saveKit": "Salvar o kit de recuperação…",
  "recoveryKey.printKit": "Imprimir o kit de recuperação",
  "recoveryKey.next": "Próximo: verificar sua chave de recuperação",
  "recoveryKey.check.label": "Sua chave de recuperação",
  "recoveryKey.check.hint":
    "Digite sua chave de recuperação inteira, como você a anotou ou salvou: 7 grupos de 4 letras e números. Traços, espaços e outros sinais de pontuação não importam.",
  "recoveryKey.back": "Voltar: ler sua chave de recuperação",
  "recoveryKey.checkAndSave": "Verificar e salvar",
  "kit.title": "Kit de recuperação do myCarlos",
  "kit.printed": "Impresso em {date}",
  "kit.labelPrinted": "Etiqueta da chave: {label} · Impresso em {date}",
  "kit.labelNote":
    "A etiqueta não é secreta. Em Segurança, o myCarlos mostra a etiqueta da chave de recuperação que funciona agora: um kit com outra etiqueta não abre mais o cofre.",
  "kit.use":
    "Se você esquecer sua frase secreta do myCarlos, esta chave abre seu cofre neste dispositivo e permite escolher uma nova frase secreta. Ela funciona depois que você terminar a verificação no myCarlos.",
  "kit.keep":
    "Guarde-a em um lugar reservado e longe do dispositivo. Qualquer pessoa com esta chave e uma cópia do seu cofre pode abri-lo. Se você configurar uma nova chave de recuperação, esta não abre mais o cofre neste dispositivo.",

  // First setup: comfort settings, before the passphrase
  "comfort.title": "Deixe o myCarlos confortável para você",
  "comfort.intro":
    "Escolha o que for melhor para você antes de configurar. Cada escolha vale na hora.",
  "comfort.sample":
    "É assim que o texto aparece no myCarlos. Pressione − ou + até ficar fácil de ler.",
  "textSize.followsDevice":
    "Aqui, o tamanho do texto segue o seu dispositivo: o ajuste de tamanho do texto dele ou o zoom do navegador.",
  "comfort.autoLock.body":
    "O myCarlos se bloqueia sozinho quando fica sem uso por esse tempo, para que ninguém mais veja seus documentos. Escolha de 1 a 15 minutos.",
  "comfort.later":
    "Você pode mudar isso a qualquer momento em {settings}: {textSize} em {preferences} e {autoLock} em {security}.",
  "comfort.continue": "Continuar",
  "comfort.usual": "Usar as configurações habituais",

  // Notices after vault actions (the app's status line)
  "notice.iosKeepOpen":
    "Mantenha o myCarlos aberto: trocar de app pausa esta transferência.",
  "notice.dropRefused":
    "Para importar PDFs, desbloqueie seu cofre e use {button}. Arrastar e soltar move documentos que já estão no myCarlos.",
  "notice.lockedIdle": {
    one: "Bloqueado após {count} minuto sem uso.",
    many: "Bloqueado após {count} de minutos sem uso.",
    other: "Bloqueado após {count} minutos sem uso.",
  },
  "notice.lockedHidden":
    "Bloqueado porque o myCarlos foi minimizado ou enviado para segundo plano.",
  "notice.locked": "Cofre bloqueado.",
  "notice.autoLockSet": {
    one: "Bloqueio automático definido para {count} minuto.",
    many: "Bloqueio automático definido para {count} de minutos.",
    other: "Bloqueio automático definido para {count} minutos.",
  },
  "notice.backupCutOff":
    "A cópia de segurança parou porque o cofre foi bloqueado. Nenhuma cópia foi salva. Guarde suas cópias mais antigas. {note}",
  "notice.transferUnfinished": "A transferência não foi concluída.",
  "notice.restored":
    "Cópia de segurança restaurada. Desbloqueie o cofre com a frase secreta usada ao criá-lo ou use a chave de recuperação dele.",
  "notice.createdThenLocked":
    "Seu cofre foi criado e depois bloqueado antes que a chave de recuperação pudesse ser gerada. Desbloqueie-o para configurar uma.",
  "notice.created":
    "Cofre criptografado criado. Configure uma chave de recuperação para que esquecer a frase secreta não signifique apagá-lo.",
  "notice.unlockedRecovery":
    "Cofre desbloqueado no modo de recuperação somente leitura. Veja o aviso na biblioteca para saber o que fazer.",
  "notice.unlocked": "Cofre desbloqueado.",
  "notice.recovered":
    "Cofre aberto com sua chave de recuperação. A partir de agora, use sua nova frase secreta.",
  "notice.recoveredReadOnly":
    "Cofre aberto somente para leitura com sua chave de recuperação, e sua frase secreta não mudou. Veja o aviso na biblioteca para saber o que fazer.",
  "notice.eraseCancelled": "O apagamento do cofre foi cancelado. Nada mudou.",

  // What to check after a refusal, and other errors the app words itself
  "box.name": "o nome",
  "box.passphrase": "a frase secreta",
  "box.currentPassphrase": "a frase secreta atual",
  "box.newPassphrase": "a nova frase secreta",
  "box.recoveryKey": "a chave de recuperação",
  "box.typedWords": "as palavras digitadas",
  "box.profileName": "o nome do perfil",
  "box.folderName": "o nome da pasta",
  "error.checkBoxes": "Verifique {boxes} e tente de novo.",
  "error.retryIn": {
    one: "Tente de novo em {count} segundo.",
    many: "Tente de novo em {count} de segundos.",
    other: "Tente de novo em {count} segundos.",
  },
  "error.fallback": "Não foi possível concluir a operação no cofre.",
  "error.damaged":
    "Nenhuma cópia de segurança foi salva: o documento “{name}” ({where}) está danificado e não pode mais ser lido, e uma cópia que o contenha não poderia ser restaurada. Nada foi alterado. Se você tiver esse documento em outro lugar, exclua-o aqui e adicione-o de novo; se não, excluí-lo permite fazer cópia de todo o resto.",
  "error.damaged.where": "adicionado em {date}",
  "error.damaged.whereFor": "adicionado em {date}, nos documentos de {person}",

  // The warning before the automatic lock (#68)
  "lockWarning.title": {
    one: "O myCarlos será bloqueado em {count} segundo para manter seus documentos privados.",
    many: "O myCarlos será bloqueado em {count} de segundos para manter seus documentos privados.",
    other:
      "O myCarlos será bloqueado em {count} segundos para manter seus documentos privados.",
  },
  "lockWarning.help":
    "Para mantê-lo aberto, pressione {keepOpen} ou qualquer tecla.",
  "lockWarning.left": {
    one: "Falta {count} segundo.",
    many: "Faltam {count} de segundos.",
    other: "Faltam {count} segundos.",
  },
  "lockWarning.keepOpen": "Manter aberto",

  // Settings > Preferences, and Appearance (#47)
  "preferences.subtitle": "Como o myCarlos aparece neste computador",
  "appearance.title": "Aparência",
  "appearance.help":
    "{system} segue a aparência clara ou escura do seu dispositivo. O alto contraste segue o seu dispositivo automaticamente.",
  "appearance.system": "Sistema",
  "appearance.light": "Claro",
  "appearance.dark": "Escuro",
  "appearance.error.unreadable":
    "Não foi possível ler a aparência salva. Usando {system} nesta sessão.",
  "appearance.error.notRemembered":
    "A aparência mudou nesta sessão, mas não pôde ser lembrada neste dispositivo.",
  "appearance.error.window":
    "A aparência da janela não pôde seguir esta escolha. Você pode continuar usando o myCarlos.",

  // A document shown as a photo
  "photo.eyebrow": "Foto",
  "photo.alt": "Foto: {name}",
  "photo.area":
    "Foto. Amplie para ver os detalhes; arraste ou role para se mover.",
  "photo.fitted": "Ajustada à janela.",
  "photo.zoomed": "Ampliada para {percent}%.",
  "photo.zoomOut": "Diminuir zoom",
  "photo.zoomIn": "Aumentar zoom",
  "photo.close": "Fechar",

  // The library's folders and documents, as a list or a grid
  "library.items": {
    one: "{count} item visível na biblioteca",
    many: "{count} de itens visíveis na biblioteca",
    other: "{count} itens visíveis na biblioteca",
  },
  "library.column.name": "Nome",
  "library.column.source": "Origem",
  "library.column.added": "Adicionado em",
  "library.folder.label": "Pasta {name}",
  "library.folder.open": "Abrir {name}",
  "library.folder.items": {
    one: "{count} item",
    many: "{count} de itens",
    other: "{count} itens",
  },
  "library.folder.rename": "Renomear a pasta {name}",
  "library.rename": "Renomear",
  "library.document.label": "Documento {name}",
  "library.document.details": "Detalhes de {name}",
  "library.details": "Detalhes",
  "library.select": "Selecionar {name}",
  "library.empty.title": "Este local está vazio",
  "library.empty.help": "Adicione uma pasta ou importe um documento aqui.",
  "library.noMatch.title": "Nenhum documento corresponde",
  "library.noMatch.help": "Tente outra pesquisa.",
};
