import type { Message } from "../types";
import type { MessageKey } from "./en";

/** Spanish, formal register ("usted"). */
export const es: Record<MessageKey, Message> = {
  "frame.banner.title": "Versión de desarrollo con datos ficticios",
  "frame.banner.body": "No use información real de pacientes",
  "frame.window.label": "Bóveda privada de myCarlos",
  "frame.state.locked": "Bloqueada",
  "frame.state.locking": "Bloqueando",
  "frame.state.notLocked": "Desbloqueada",
  "frame.state.settingUp": "Configurando",
  "frame.state.opening": "Abriendo",
  "auth.kicker": "Registros privados de myCarlos",

  "passphrase.label": "Frase de contraseña",
  "passphrase.confirm.label": "Confirmar la frase de contraseña",
  "passphrase.new.label": "Nueva frase de contraseña",
  "passphrase.confirmNew.label": "Confirmar la nueva frase de contraseña",
  "passphrase.rules":
    "Use al menos {min} caracteres. Se permiten espacios; las contraseñas comunes, los nombres y los patrones predecibles se rechazan en este dispositivo.",
  "passphrase.mismatch": "Las frases de contraseña no coinciden.",
  "passphrase.tooLong":
    "Esta frase de contraseña es demasiado larga. Acórtela.",
  "passphrase.tooShort":
    "Esta frase de contraseña es demasiado corta. Use al menos {min} caracteres.",
  "passphrase.longerThanAny":
    "Este texto es más largo que cualquier frase de contraseña de la bóveda. Revise lo que escribió.",

  "passphrase.show": "Mostrar la frase de contraseña",
  "passphrase.show.inConfirm": "en Confirmar la frase de contraseña",

  "checklist.heading": "Su frase de contraseña debe ser:",
  "checklist.length": "De al menos {min} caracteres",
  "checklist.hardToGuess": "Difícil de adivinar",
  "checklist.notAName": "Distinta de su nombre",
  "checklist.done": ", cumplido",
  "checklist.notYet": ", todavía no",
  "checklist.spaces":
    "Se permiten espacios, así que unas cuantas palabras sin relación entre sí forman una buena frase de contraseña. myCarlos comprueba estas reglas en este equipo.",
  "checklist.allMet": "Su frase de contraseña cumple todas las reglas.",

  "create.title": "Configure myCarlos en este equipo",
  "create.intro":
    "Sus archivos y los detalles de sus registros se cifran en este dispositivo. Su frase de contraseña abre la bóveda. Después podrá configurar una clave de recuperación por si la olvida.",
  "create.stays":
    "Su bóveda permanece en este dispositivo. Si creó una en otro dispositivo, sigue allí y no aparecerá aquí.",
  "create.profile.label": "¿De quién son los registros que guardará aquí?",
  "create.profile.tooLong": "Este nombre es demasiado largo. Acórtelo.",
  "create.submit": "Crear bóveda",

  "unlock.title": "Desbloquee su bóveda",
  "unlock.autoLock": {
    one: "La bóveda se bloquea tras {count} minuto de inactividad y siempre que myCarlos se oculta, por ejemplo al minimizarlo o enviarlo a segundo plano.",
    many: "La bóveda se bloquea tras {count} de minutos de inactividad y siempre que myCarlos se oculta, por ejemplo al minimizarlo o enviarlo a segundo plano.",
    other:
      "La bóveda se bloquea tras {count} minutos de inactividad y siempre que myCarlos se oculta, por ejemplo al minimizarlo o enviarlo a segundo plano.",
  },
  "unlock.submit": "Desbloquear",
  "unlock.forgot.summary": "¿Olvidó su frase de contraseña?",
  "unlock.noKey.heading": "¿No tiene una clave de recuperación?",
  "unlock.noKey.body":
    "Sin ella, la única forma de volver a entrar es apartar esta bóveda y empezar de nuevo. La bóveda apartada se queda en este dispositivo, cifrada, pero nadie puede abrirla sin su frase de contraseña.",
  "restore.summary": "Restaurar desde una copia de seguridad",

  "reset.plainly":
    "Al apartar la bóveda se quitan de myCarlos en este equipo todos sus documentos, carpetas y perfiles de pacientes. Se quedan en este equipo, cifrados, pero nadie puede abrirlos sin la frase de contraseña. Para confirmarlo, escriba exactamente las palabras de abajo.",
  "reset.type": "Escriba {phrase}",
  "reset.submit": "Apartar la bóveda",

  "recover.intro":
    "Use su clave de recuperación para abrir la bóveda y elegir una nueva frase de contraseña.",
  "recover.key.label": "Clave de recuperación",
  "recover.key.format":
    "28 letras y dígitos, en 7 grupos de 4, como aparecen en su kit o como los anotó. Los guiones, los espacios y otros signos de puntuación no importan.",
  "recover.key.show": "Mostrar la clave de recuperación",
  "recover.submit": "Abrir con la clave de recuperación",

  "secret.count.password": {
    one: "Frase de contraseña de {count} carácter",
    many: "Frase de contraseña de {count} de caracteres",
    other: "Frase de contraseña de {count} caracteres",
  },
  "secret.count.recoveryKey": {
    one: "Clave de recuperación de {count} carácter",
    many: "Clave de recuperación de {count} de caracteres",
    other: "Clave de recuperación de {count} caracteres",
  },
  "secret.count.shown": "{description}, visible",

  "restore.intro":
    "Una copia de seguridad cifrada se abre con la frase de contraseña con la que se creó, o con la clave de recuperación que tenía la bóveda cuando se guardó la copia, si tenía una.",
  "restore.choose": "Elegir archivo de copia de seguridad…",
  "restore.chooseOther": "Elegir otra copia de seguridad…",
  "restore.chosen": "Copia de seguridad elegida.",
  "restore.openWith": "Abrirla con",
  "restore.method.passphrase": "Su frase de contraseña",
  "restore.method.recoveryKey": "Su clave de recuperación",
  "restore.passphrase.label": "Frase de contraseña de la copia de seguridad",
  "restore.passphrase.show": "Mostrar la frase de contraseña",
  "restore.tooLong": "Este texto es demasiado largo. Revise lo que escribió.",
  "restore.check": "Comprobar copia de seguridad",
  "restore.checking": "Comprobando la copia de seguridad…",
  "restore.checked": {
    one: "La copia de seguridad contiene {count} documento. {consequence}",
    many: "La copia de seguridad contiene {count} de documentos. {consequence}",
    other: "La copia de seguridad contiene {count} documentos. {consequence}",
  },
  "restore.consequence.nothing":
    "Al restaurar, esta bóveda se coloca en este dispositivo.",
  "restore.consequence.same":
    "La bóveda de este dispositivo contiene los mismos documentos. Al restaurar, se aparta y se coloca esta copia de seguridad en su lugar. La bóveda apartada se queda en este dispositivo, cifrada, pero myCarlos aún no puede volver a abrirla por usted.",
  "restore.consequence.differs":
    "Es posible que la bóveda de este dispositivo no sea igual a esta copia de seguridad: puede haber cambiado desde entonces, o una parte no se pudo leer. Al restaurar, la bóveda se aparta y se coloca la copia de seguridad en su lugar: lo que no esté en la copia ya no estará en la bóveda que usa, y la frase de contraseña y la clave de recuperación pasan a ser las de la copia de seguridad. La bóveda apartada se queda en este dispositivo, cifrada, pero myCarlos aún no puede volver a abrirla por usted.",
  "restore.consequence.otherVault":
    "Este dispositivo tiene una bóveda distinta. Al restaurar, se aparta y se coloca la copia de seguridad en su lugar. La bóveda apartada se queda en este dispositivo, cifrada, pero myCarlos aún no puede volver a abrirla por usted.",
  "restore.consequence.unreadable":
    "No se pudo leer la bóveda de este dispositivo, por lo que myCarlos no puede saber si es aquella de la que procede esta copia de seguridad. Al restaurar, se aparta y se coloca la copia de seguridad en su lugar. La bóveda apartada se queda en este dispositivo, cifrada, pero myCarlos aún no puede volver a abrirla por usted.",
  "restore.agree.erase":
    "Apartar la bóveda de este dispositivo y restaurar la copia de seguridad",
  "restore.agree.replace":
    "Apartar la bóveda de este dispositivo, con lo que haya cambiado desde entonces, y restaurar esta copia de seguridad",
  "restore.submit": "Restaurar copia de seguridad",
  "restore.restoring":
    "Restaurando la copia de seguridad. Puede tardar un rato si la bóveda es grande…",
  "restore.cancelled": "Restauración cancelada. No se cambió nada.",
};
