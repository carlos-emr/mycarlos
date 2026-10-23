import interfaceMessages from "./interface-es.json";
import type { Message } from "../types";
import type { MessageKey } from "./en";

/** Spanish, formal register ("usted"). */
export const es: Record<MessageKey, Message> = {
  ...interfaceMessages,
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
  "create.profile.sharedTaken":
    "«{folder}» es donde van los archivos compartidos. Elija otro nombre.",
  "create.submit": "Crear bóveda",

  "unlock.title": "Desbloquee su bóveda",
  "unlock.autoLock": {
    one: "La bóveda se bloquea tras {count} minuto de inactividad y siempre que myCarlos se oculta, por ejemplo al minimizarlo o enviarlo a segundo plano.",
    many: "La bóveda se bloquea tras {count} de minutos de inactividad y siempre que myCarlos se oculta, por ejemplo al minimizarlo o enviarlo a segundo plano.",
    other:
      "La bóveda se bloquea tras {count} minutos de inactividad y siempre que myCarlos se oculta, por ejemplo al minimizarlo o enviarlo a segundo plano.",
  },
  "unlock.waiting.one":
    "Hay un archivo compartido en espera. Desbloquee la bóveda y pasará a «{folder}». Si myCarlos se cierra antes, no se conservará: compártalo de nuevo.",
  "unlock.waiting": {
    one: "Hay {count} archivo compartido en espera. Desbloquee la bóveda y pasará a «{folder}». Si myCarlos se cierra antes, no se conservará: compártalo de nuevo.",
    many: "Hay {count} archivos compartidos en espera. Desbloquee la bóveda y pasarán a «{folder}». Si myCarlos se cierra antes, no se conservarán: compártalos de nuevo.",
    other:
      "Hay {count} archivos compartidos en espera. Desbloquee la bóveda y pasarán a «{folder}». Si myCarlos se cierra antes, no se conservarán: compártalos de nuevo.",
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

  // Shared
  "common.cancel": "Cancelar",

  // Library sidebar
  "sidebar.label": "Biblioteca de documentos",
  "sidebar.myRecords": "Mis documentos",
  "sidebar.settings": "Configuración",
  "sidebar.preferences": "Preferencias",
  "sidebar.storage": "Bóveda local cifrada",
  "sidebar.documents": {
    one: "{count} documento",
    many: "{count} de documentos",
    other: "{count} documentos",
  },
  "sidebar.folderCount": {
    one: "{count} carpeta",
    many: "{count} de carpetas",
    other: "{count} carpetas",
  },

  // Text size (Settings > Preferences)
  "textSize.title": "Tamaño del texto",
  "textSize.announce": "Tamaño del texto {percent}",
  "textSize.help":
    "Agranda o reduce todo el contenido de myCarlos, del {min}% al {max}%. myCarlos recuerda el tamaño en este equipo. También puede mantener pulsada la tecla {modifier} y pulsar más, menos o 0.",
  "textSize.key.command": "Comando",
  "textSize.smaller": "Texto más pequeño",
  "textSize.larger": "Texto más grande",
  "textSize.box": "Tamaño del texto en porcentaje",
  "textSize.reset": "Volver al tamaño normal",
  "textSize.notNumber": "Escriba un número del {min} al {max}.",
  "textSize.smallest": "El tamaño más pequeño es {min}%.",
  "textSize.largest": "El tamaño más grande es {max}%.",
  "textSize.between": "{typed}% está entre dos tamaños, así que se usa {size}.",

  // Rename a document or folder
  "rename.title.document": "Cambiar el nombre del documento",
  "rename.title.folder": "Cambiar el nombre de la carpeta",
  "rename.label.folder": "Nombre de la carpeta",
  "rename.label.document": "Nombre del archivo",
  "rename.help.folder":
    "La carpeta y su contenido permanecen en el mismo lugar.",
  "rename.help.document":
    "Esto cambia el nombre en myCarlos y el nombre sugerido al exportar.",
  "rename.help.documentExtension":
    "Esto cambia el nombre en myCarlos y el nombre sugerido al exportar. La extensión {extension} no cambia.",
  "rename.stemMissing": "Escriba un nombre antes de {extension}.",
  "rename.gainsExtension":
    "El nombre de este documento no tiene la extensión .pdf, así que no puede terminar en .pdf.",
  "rename.tooLong": "Este nombre es demasiado largo. Acórtelo para guardarlo.",
  "rename.unsafe":
    "Los nombres de documento no pueden contener {characters} ni caracteres de control invisibles, ni terminar en punto.",
  "rename.reserved":
    "“{word}” no se puede usar como nombre de documento, porque Windows lo reserva para su propio uso. Elija otro nombre.",
  "rename.saving": "Guardando…",
  "rename.save": "Guardar el nombre",

  // Settings > Security
  "security.title": "Seguridad",
  "security.subtitle": "Su bóveda cifrada y la configuración de acceso",
  "security.devBuild.title": "Versión de desarrollo.",
  "security.devBuild.body": "Use solo archivos ficticios.",
  "security.encryption.title": "Cifrado",
  "security.encryption.state": "Activado — siempre",
  "security.encryption.body":
    "Los archivos, los nombres, las carpetas y los detalles de los documentos se cifran en este dispositivo.",
  "security.autoLock.title": "Bloqueo automático",
  "security.autoLock.minutes": {
    one: "{count} minuto",
    many: "{count} de minutos",
    other: "{count} minutos",
  },
  "security.autoLock.body":
    "La bóveda se bloquea tras el periodo elegido sin actividad del teclado, el puntero o la pantalla táctil. Elija entre 1 y 15 minutos.",
  "security.autoLock.label": "Tiempo para el bloqueo automático",
  "security.autoLock.shorter": "Tiempo más corto",
  "security.autoLock.longer": "Tiempo más largo",
  "security.lockNow": "Bloquear ahora",
  "security.recoveryKey.title": "Clave de recuperación",
  "security.recoveryKey.setUpOn": "Configurada el {date}",
  "security.recoveryKey.notSetUp": "No configurada",
  "security.recoveryKey.body":
    "Abre su bóveda si olvida su frase de contraseña. Solo usted la tiene: nadie en su clínica ni en myCarlos puede abrir su bóveda por usted. Al reemplazarla, la anterior deja de funcionar.",
  "security.recoveryKey.current":
    "Su clave actual tiene la etiqueta {label}. El kit o la nota con esta etiqueta es el que funciona; uno con otra etiqueta no abre esta bóveda. Los kits y las notas hechos antes de que se mostraran las etiquetas no tienen ninguna: uno sin etiqueta puede seguir siendo esta clave, configurada el {date}.",
  "security.recoveryKey.replace": "Reemplazar la clave de recuperación",
  "security.recoveryKey.setUp": "Configurar una clave de recuperación",
  "security.backup.title": "Copia de seguridad cifrada",
  "security.backup.body":
    "Un solo archivo con toda su bóveda, todavía cifrada. Guárdelo en un lugar distinto de este dispositivo, como una unidad USB. Se abre con la frase de contraseña o la clave de recuperación que tenga al guardarlo, y se sigue abriendo con ellas aunque después las cambie aquí. Para restaurar una copia, bloquee la bóveda y elija Restaurar desde una copia de seguridad.",
  "security.oldBackups.title": "Sus copias de seguridad anteriores",
  "security.oldBackups.intro":
    "Es posible que el kit de una clave de recuperación anterior se haya perdido o que alguien lo haya visto, y todavía abre las copias de seguridad guardadas antes de reemplazar esa clave.",
  "security.oldBackups.saveWhenWritable":
    "Cuando la bóveda vuelva a aceptar cambios, guarde una nueva copia de seguridad: elija Guardar copia de seguridad cifrada.",
  "security.oldBackups.saveNow":
    "Guarde ahora una nueva copia de seguridad: elija Guardar copia de seguridad cifrada.",
  "security.oldBackups.keepCopy":
    "Guárdela, o una copia de ella, en un lugar distinto de este dispositivo, como una memoria USB o un almacenamiento en la nube.",
  "security.oldBackups.thenDelete":
    "Luego elimine las copias de seguridad anteriores. Cuando la nueva esté guardada, aquí se explica cómo.",
  "security.oldBackups.none": "No tengo copias de seguridad anteriores",
  "security.oldBackups.named": "Su nueva copia de seguridad es “{name}”.",
  "security.oldBackups.namedWithSize":
    "Su nueva copia de seguridad es “{name}” ({size}).",
  "security.oldBackups.justSaved":
    "Su nueva copia de seguridad es la que acaba de guardar, el {date} hacia las {time}: su aplicación de archivos muestra cuándo se guardó cada archivo y su tamaño.",
  "security.oldBackups.justSavedWithSize":
    "Su nueva copia de seguridad es la que acaba de guardar, el {date} hacia las {time} ({size}): su aplicación de archivos muestra cuándo se guardó cada archivo y su tamaño.",
  "security.oldBackups.deleteOlder":
    "Elimine las copias de seguridad anteriores: los archivos cuyo nombre empieza por “myCarlos backup” y las que haya cambiado de nombre, salvo la nueva y sus copias. Están donde las guardó: una carpeta, una memoria USB o, en un teléfono, la aplicación Archivos o un almacenamiento en la nube.",
  "security.oldBackups.inPlace":
    "Si la guardó en lugar de una copia de seguridad anterior, ese archivo es ahora su nueva copia de seguridad: consérvelo.",
  "security.oldBackups.done": "He terminado con las copias anteriores",
  "security.backup.save": "Guardar copia de seguridad cifrada…",
  "security.passphrase.title": "Cambiar la frase de contraseña",
  "security.passphrase.rules":
    "Use al menos {min} caracteres y evite nombres comunes o frases previsibles. Su clave de recuperación, si tiene una, sigue funcionando; sin ella, olvidar la nueva frase de contraseña significa dejar la bóveda aparte y empezar de nuevo.",
  "security.passphrase.copies":
    "Cambiar la frase de contraseña impide el acceso a quien solo conoce la anterior. Si esa persona también podría tener una copia de su bóveda, como una copia de seguridad de este dispositivo o un archivo de copia de seguridad guardado, una nueva frase de contraseña no basta: la anterior sigue abriendo esa copia, y con esa copia podría abrir una más reciente que consiga después. Para dejarla fuera hace falta una bóveda nueva, y cuidado de no perder documentos por el camino. Pida ayuda antes de dejar su bóveda aparte.",
  "security.passphrase.current": "Frase de contraseña actual",
  "security.passphrase.currentTooLong":
    "La frase de contraseña actual es más larga que cualquier frase de contraseña de bóveda. Revise lo que escribió.",
  "security.passphrase.mismatch":
    "Las nuevas frases de contraseña no coinciden.",
  "security.passphrase.newTooLong":
    "La nueva frase de contraseña es demasiado larga. Acórtela.",
  "security.passphrase.newTooShort":
    "La nueva frase de contraseña es demasiado corta. Use al menos {min} caracteres.",
  "security.passphrase.submit": "Cambiar la frase de contraseña",
  "security.speed.title": "Prueba de velocidad, para quienes hacen pruebas",
  "security.speed.body":
    "Mide cuánto tarda este dispositivo en comprobar una frase de contraseña. Usa una frase de contraseña inventada, no la suya, y no cambia nada. Tarda unos segundos, más en un teléfono antiguo. Cierre antes las demás aplicaciones y permanezca en esta pantalla hasta que termine. Envíe el resultado con la marca y el modelo del dispositivo.",
  "security.speed.run": "Hacer la prueba de velocidad",
  "security.speed.measuring": "Midiendo…",
  "security.copies.title": "Copias legibles y capturas de pantalla",
  "security.copies.body":
    "Las exportaciones y las capturas de pantalla quedan fuera de la protección de la bóveda. Ocultar un documento en myCarlos no borra esas copias ni el historial médico original de la clínica.",
  "security.profiles.title": "Perfiles de paciente",
  "security.profiles.body":
    "Mantenga separados los documentos de cada persona dentro de esta bóveda.",
  "security.profiles.label": "Nombre del nuevo perfil",
  "security.profiles.add": "Añadir perfil",
  "security.erase.title": "Borrar toda la bóveda",
  "security.erase.body":
    "Elimina de forma permanente todos los documentos, perfiles y carpetas cifrados. No se puede deshacer.",
  "security.erase.show": "Mostrar los controles de borrado",
  "security.erase.submit": "Borrar toda la bóveda",

  // Recovery key setup, and the printed kit
  "recoveryKey.printUnavailable":
    "Aquí no se puede imprimir. Guarde el kit o anote la clave.",
  "recoveryKey.chooseReason":
    "Elija por qué reemplaza su clave de recuperación.",
  "recoveryKey.kitSaved":
    "Kit de recuperación guardado. La clave empezará a funcionar cuando termine la comprobación.",
  "recoveryKey.typedCount": {
    one: "Escribió {count} letra o dígito. Su clave de recuperación tiene {total} letras y dígitos: 7 grupos de 4. Revise lo que anotó.",
    many: "Escribió {count} de letras y dígitos. Su clave de recuperación tiene {total} letras y dígitos: 7 grupos de 4. Revise lo que anotó.",
    other:
      "Escribió {count} letras y dígitos. Su clave de recuperación tiene {total} letras y dígitos: 7 grupos de 4. Revise lo que anotó.",
  },
  "recoveryKey.notChanged":
    "Su clave de recuperación no se cambió. Su clave actual sigue funcionando. Para cambiarla, pulse de nuevo Comprobar y guardar.",
  "recoveryKey.threeMisses":
    "No coincidió tres veces. Vuelva a mirar su clave de recuperación y luego compruébela.",
  "recoveryKey.leave.required": "Bloquear la bóveda y terminar más tarde",
  "recoveryKey.leave.offered": "Configurar más tarde",
  "recoveryKey.title.replace": "Reemplace su clave de recuperación",
  "recoveryKey.title.setUp": "Configure una clave de recuperación",
  "recoveryKey.title.key": "Su clave de recuperación",
  "recoveryKey.title.check": "Compruebe su clave de recuperación",
  "recoveryKey.discard.title": "¿Descartar esta clave de recuperación?",
  "recoveryKey.discard.body":
    "Esta clave de recuperación todavía no está configurada, así que nunca abrirá la bóveda. myCarlos bloquea ahora la bóveda. Después de desbloquearla, podrá configurar una clave nueva.",
  "recoveryKey.discard.confirm": "Descartar la clave y bloquear",
  "recoveryKey.about.offered":
    "Su bóveda está abierta. Todavía no tiene clave de recuperación. Sin ella, si olvida su frase de contraseña, la única forma de volver a entrar es dejar la bóveda aparte y empezar de nuevo.",
  "recoveryKey.about.what":
    "Una clave de recuperación abre su bóveda si olvida su frase de contraseña. Solo usted la tendrá: nadie en su clínica ni en myCarlos puede abrir su bóveda por usted.",
  "recoveryKey.about.replacing":
    "Su clave de recuperación actual dejará de funcionar cuando haya comprobado la nueva.",
  "recoveryKey.about.type":
    "Escriba su frase de contraseña para crear su clave de recuperación. Se mostrará a continuación: elija Continuar solo cuando nadie más pueda ver su pantalla.",
  "recoveryKey.about.typeAgain":
    "Escriba de nuevo su frase de contraseña para crear su clave de recuperación. Se mostrará a continuación: elija Continuar solo cuando nadie más pueda ver su pantalla.",
  "recoveryKey.about.typeNew":
    "Escriba su frase de contraseña para crear su nueva clave de recuperación. Se mostrará a continuación: elija Continuar solo cuando nadie más pueda ver su pantalla.",
  "recoveryKey.about.typeAgainNew":
    "Escriba de nuevo su frase de contraseña para crear su nueva clave de recuperación. Se mostrará a continuación: elija Continuar solo cuando nadie más pueda ver su pantalla.",
  "recoveryKey.reason.legend": "¿Por qué la reemplaza?",
  "recoveryKey.reason.hint": "Si no está seguro, elija la primera.",
  "recoveryKey.reason.exposed":
    "Es posible que su kit o su nota se haya perdido o que otra persona lo haya visto",
  "recoveryKey.reason.routine":
    "Solo quiero una clave nueva: su kit está a salvo",
  "recoveryKey.continue": "Continuar",
  "recoveryKey.keyboardHint":
    "La tecla Esc sale de esta configuración. En la primera configuración, antes pide confirmación, porque salir bloquea la bóveda y una clave sin terminar no funcionará.",
  "recoveryKey.instructions":
    "Anótela, o guarde o imprima el kit, y consérvela en un lugar privado, lejos de este dispositivo. Es la única vez que myCarlos la muestra. Después, la escribirá completa para comprobarla. Permanezca en myCarlos hasta terminar la comprobación: salir o bloquear cancela esta clave.",
  "recoveryKey.hiddenWhileSaving": "Oculta mientras se guarda el kit.",
  "recoveryKey.group": "Grupo {number}: {characters}",
  "recoveryKey.label":
    "Etiqueta de la clave: {label}. Anótela junto a la clave. No es secreta: en Seguridad, myCarlos muestra la etiqueta de la clave que funciona, para que sepa qué kit es el vigente.",
  "recoveryKey.saveKit": "Guardar el kit de recuperación…",
  "recoveryKey.printKit": "Imprimir el kit de recuperación",
  "recoveryKey.next": "Siguiente: comprobar su clave de recuperación",
  "recoveryKey.check.label": "Su clave de recuperación",
  "recoveryKey.check.hint":
    "Escriba su clave de recuperación completa, tal como la anotó o la guardó: 7 grupos de 4 letras y dígitos. Los guiones, los espacios y otros signos de puntuación no importan.",
  "recoveryKey.back": "Atrás: leer su clave de recuperación",
  "recoveryKey.checkAndSave": "Comprobar y guardar",
  "kit.title": "Kit de recuperación de myCarlos",
  "kit.printed": "Impreso el {date}",
  "kit.labelPrinted": "Etiqueta de la clave: {label} · Impreso el {date}",
  "kit.labelNote":
    "La etiqueta no es secreta. En Seguridad, myCarlos muestra la etiqueta de la clave de recuperación que funciona ahora: un kit con otra etiqueta ya no abre la bóveda.",
  "kit.use":
    "Si olvida su frase de contraseña de myCarlos, esta clave abre su bóveda en este dispositivo y le permite elegir una nueva frase de contraseña. Funciona una vez que haya terminado la comprobación en myCarlos.",
  "kit.keep":
    "Guárdela en un lugar privado y lejos del dispositivo. Cualquier persona con esta clave y una copia de su bóveda puede abrirla. Si configura una nueva clave de recuperación, esta ya no abrirá la bóveda en este dispositivo.",

  // First setup: comfort settings, before the passphrase
  "comfort.title": "Ajuste myCarlos a su medida",
  "comfort.intro":
    "Elija lo que le resulte cómodo antes de configurar. Cada opción se aplica al instante.",
  "comfort.sample":
    "Así se ve el texto en myCarlos. Pulse − o + hasta que se lea con facilidad.",
  "textSize.followsDevice":
    "Aquí, el tamaño del texto depende de su dispositivo: de su propio ajuste de tamaño del texto o del zoom del navegador.",
  "comfort.autoLock.body":
    "myCarlos se bloquea solo cuando no se usa durante este tiempo, para que nadie más vea sus documentos. Elija entre 1 y 15 minutos.",
  "comfort.later":
    "Puede cambiarlos cuando quiera en {settings}: {textSize} en {preferences} y {autoLock} en {security}.",
  "comfort.continue": "Continuar",
  "comfort.usual": "Usar los ajustes habituales",

  // Notices after vault actions (the app's status line)
  "notice.iosKeepOpen":
    "Mantenga myCarlos abierto: cambiar de aplicación pausa esta transferencia.",
  "notice.dropRefused":
    "Para importar archivos PDF, desbloquee su bóveda y use {button}. Arrastrar y soltar mueve los documentos que ya están en myCarlos.",
  "notice.lockedIdle": {
    one: "Bloqueada tras {count} minuto sin uso.",
    many: "Bloqueada tras {count} de minutos sin uso.",
    other: "Bloqueada tras {count} minutos sin uso.",
  },
  "notice.lockedHidden":
    "Bloqueada porque myCarlos se minimizó o pasó a segundo plano.",
  "notice.locked": "Bóveda bloqueada.",
  "notice.autoLockSet": {
    one: "Bloqueo automático ajustado a {count} minuto.",
    many: "Bloqueo automático ajustado a {count} de minutos.",
    other: "Bloqueo automático ajustado a {count} minutos.",
  },
  "notice.backupCutOff":
    "La copia de seguridad se detuvo porque la bóveda se bloqueó. No se guardó ninguna copia. Conserve sus copias anteriores. {note}",
  "notice.transferUnfinished": "La transferencia no terminó.",
  "notice.restored":
    "Copia de seguridad restaurada. Desbloquee la bóveda con la frase de contraseña con la que se creó o use su clave de recuperación.",
  "notice.createdThenLocked":
    "Su bóveda se creó y luego se bloqueó antes de poder crear su clave de recuperación. Desbloquéela para configurar una.",
  "notice.created":
    "Bóveda cifrada creada. Configure una clave de recuperación para que olvidar su frase de contraseña no le impida acceder a sus documentos para siempre.",
  "notice.unlockedRecovery":
    "Bóveda desbloqueada en modo de recuperación de solo lectura. Consulte el aviso en la biblioteca para saber qué hacer.",
  "notice.unlocked": "Bóveda desbloqueada.",
  "notice.recovered":
    "Bóveda abierta con su clave de recuperación. A partir de ahora, use su nueva frase de contraseña.",
  "notice.recoveredReadOnly":
    "Bóveda abierta en solo lectura con su clave de recuperación; su frase de contraseña no cambió. Consulte el aviso en la biblioteca para saber qué hacer.",
  "notice.eraseCancelled": "No cambió nada: la bóveda no se dejó aparte.",

  // What to check after a refusal, and other errors the app words itself
  "box.name": "el nombre",
  "box.passphrase": "la frase de contraseña",
  "box.currentPassphrase": "la frase de contraseña actual",
  "box.newPassphrase": "la nueva frase de contraseña",
  "box.recoveryKey": "la clave de recuperación",
  "box.typedWords": "las palabras escritas",
  "box.profileName": "el nombre del perfil",
  "box.folderName": "el nombre de la carpeta",
  "error.checkBoxes": "Revise {boxes} y vuelva a intentarlo.",
  "error.retryIn": {
    one: "Vuelva a intentarlo en {count} segundo.",
    many: "Vuelva a intentarlo en {count} de segundos.",
    other: "Vuelva a intentarlo en {count} segundos.",
  },
  "error.fallback": "No se pudo completar la operación en la bóveda.",
  "error.damaged":
    "No se guardó ninguna copia de seguridad: el documento «{name}» ({where}) está dañado y ya no se puede leer, y una copia que lo contenga no se podría restaurar. No se cambió nada. Conserve sus copias de seguridad anteriores. Pida ayuda para recuperar este documento desde una copia o copia de seguridad en buen estado antes de volver a intentarlo.",
  "error.damaged.where": "añadido el {date}",
  "error.damaged.whereFor": "añadido el {date}, en los documentos de {person}",

  // The warning before the automatic lock (#68)
  "lockWarning.title": {
    one: "myCarlos se bloqueará en {count} segundo para mantener privados sus documentos.",
    many: "myCarlos se bloqueará en {count} de segundos para mantener privados sus documentos.",
    other:
      "myCarlos se bloqueará en {count} segundos para mantener privados sus documentos.",
  },
  "lockWarning.help":
    "Para mantenerlo abierto, pulse {keepOpen} o cualquier tecla.",
  "lockWarning.left": {
    one: "Queda {count} segundo.",
    many: "Quedan {count} de segundos.",
    other: "Quedan {count} segundos.",
  },
  "lockWarning.keepOpen": "Mantener abierto",

  // Settings > Preferences, and Appearance (#47)
  "preferences.subtitle": "Cómo se ve myCarlos en este equipo",
  "language.title": "Idioma",
  "language.help":
    "Se recuerda en este dispositivo. Sus documentos conservan su idioma original.",
  "language.system": "Predeterminado del sistema",
  "language.error.unreadable":
    "No se pudo leer el idioma guardado. Se usa el idioma de su dispositivo durante esta sesión.",
  "language.error.notRemembered":
    "El idioma cambió para esta sesión, pero no se pudo recordar en este dispositivo.",

  "appearance.title": "Apariencia",
  "appearance.help":
    "{system} sigue la apariencia clara u oscura de su dispositivo. El alto contraste usa un fondo negro y texto claro. Los colores de contraste de su dispositivo siempre tienen prioridad.",
  "appearance.system": "Sistema",
  "appearance.light": "Claro",
  "appearance.dark": "Oscuro",
  "appearance.highContrast": "Alto contraste",
  "appearance.error.unreadable":
    "No se pudo leer la apariencia guardada. Se usa {system} durante esta sesión.",
  "appearance.error.notRemembered":
    "La apariencia cambió para esta sesión, pero no se pudo recordar en este dispositivo.",
  "appearance.error.window":
    "La apariencia de la ventana no pudo seguir esta elección. Puede seguir usando myCarlos.",

  // A document shown as a photo
  "photo.eyebrow": "Foto",
  "photo.alt": "Foto: {name}",
  "photo.area":
    "Foto. Amplíe para ver los detalles; arrastre o desplácese para moverse.",
  "photo.fitted": "Ajustada a la ventana.",
  "photo.zoomed": "Ampliada al {percent}%.",
  "photo.zoomOut": "Alejar",
  "photo.zoomIn": "Acercar",
  "photo.close": "Cerrar",

  // The library's folders and documents, as a list or a grid
  "library.items": {
    one: "{count} elemento visible de la biblioteca",
    many: "{count} de elementos visibles de la biblioteca",
    other: "{count} elementos visibles de la biblioteca",
  },
  "library.column.name": "Nombre",
  "library.column.source": "Origen",
  "library.column.added": "Añadido el",
  "library.folder.label": "Carpeta {name}",
  "library.folder.open": "Abrir {name}",
  "library.folder.items": {
    one: "{count} elemento",
    many: "{count} de elementos",
    other: "{count} elementos",
  },
  "library.folder.rename": "Cambiar el nombre de la carpeta {name}",
  "library.rename": "Cambiar nombre",
  "library.document.label": "Documento {name}",
  "library.document.details": "Detalles de {name}",
  "library.details": "Detalles",
  "library.select": "Seleccionar {name}",
  "library.empty.title": "Esta ubicación está vacía",
  "library.empty.help": "Añada una carpeta o importe un documento aquí.",
  "library.noMatch.title": "Ningún documento coincide",
  "library.noMatch.help": "Pruebe otra búsqueda.",
};
