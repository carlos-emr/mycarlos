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
};
