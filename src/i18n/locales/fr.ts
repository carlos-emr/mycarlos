import type { Message } from "../types";
import type { MessageKey } from "./en";

/** Canadian French, formal register ("vous"). */
export const fr: Record<MessageKey, Message> = {
  "frame.banner.title": "Version de développement avec données fictives",
  "frame.banner.body":
    "N’utilisez pas de véritables renseignements sur des patients",
  "frame.window.label": "Coffre-fort privé myCarlos",
  "frame.state.locked": "Verrouillé",
  "frame.state.locking": "Verrouillage en cours",
  "frame.state.notLocked": "Déverrouillé",
  "frame.state.settingUp": "Configuration",
  "frame.state.opening": "Ouverture en cours",
  "auth.kicker": "Dossiers privés myCarlos",

  "passphrase.label": "Phrase secrète",
  "passphrase.confirm.label": "Confirmer la phrase secrète",
  "passphrase.new.label": "Nouvelle phrase secrète",
  "passphrase.confirmNew.label": "Confirmer la nouvelle phrase secrète",
  "passphrase.rules":
    "Utilisez au moins {min} caractères. Les espaces sont permis; les mots de passe courants, les noms et les suites prévisibles sont refusés sur cet appareil.",
  "passphrase.mismatch": "Les phrases secrètes ne correspondent pas.",
  "passphrase.tooLong":
    "Cette phrase secrète est trop longue. Raccourcissez-la.",
  "passphrase.tooShort":
    "Cette phrase secrète est trop courte. Utilisez au moins {min} caractères.",
  "passphrase.longerThanAny":
    "Ce texte est plus long que n’importe quelle phrase secrète du coffre-fort. Vérifiez ce que vous avez saisi.",

  "create.title": "Créer votre coffre-fort chiffré",
  "create.intro":
    "Vos fichiers et les détails de vos dossiers sont chiffrés sur cet appareil. Votre phrase secrète ouvre le coffre-fort. Vous pourrez ensuite configurer une clé de récupération au cas où vous l’oublieriez.",
  "create.stays":
    "Votre coffre-fort reste sur cet appareil. Si vous en avez créé un sur un autre appareil, il s’y trouve toujours et n’apparaîtra pas ici.",
  "create.profile.label": "Premier profil de patient",
  "create.profile.tooLong": "Ce nom est trop long. Raccourcissez-le.",
  "create.submit": "Créer le coffre-fort",

  "unlock.title": "Déverrouiller votre coffre-fort",
  "unlock.autoLock": {
    one: "Le coffre-fort se verrouille après {count} minute d’inactivité et chaque fois que myCarlos est masqué, par exemple réduit ou envoyé en arrière-plan.",
    many: "Le coffre-fort se verrouille après {count} de minutes d’inactivité et chaque fois que myCarlos est masqué, par exemple réduit ou envoyé en arrière-plan.",
    other:
      "Le coffre-fort se verrouille après {count} minutes d’inactivité et chaque fois que myCarlos est masqué, par exemple réduit ou envoyé en arrière-plan.",
  },
  "unlock.submit": "Déverrouiller",
  "unlock.forgot.summary": "Vous avez oublié votre phrase secrète?",
  "unlock.noKey.heading": "Pas de clé de récupération?",
  "unlock.noKey.body":
    "Sans clé, la seule façon de revenir est d’effacer ce coffre-fort, ce qui supprime définitivement tout son contenu, puis de recommencer.",
  "restore.summary": "Restaurer à partir d’une sauvegarde",

  "reset.type": "Saisissez {phrase}",
  "reset.submit": "Effacer le coffre-fort",

  "recover.intro":
    "Utilisez votre clé de récupération pour ouvrir le coffre-fort et choisir une nouvelle phrase secrète.",
  "recover.key.label": "Clé de récupération",
  "recover.key.format":
    "28 lettres et chiffres, en 7 groupes de 4, comme sur votre trousse ou tels que vous les avez notés. Les tirets, les espaces et les autres signes de ponctuation n’ont pas d’importance.",
  "recover.key.show": "Afficher la clé de récupération",
  "recover.submit": "Ouvrir avec la clé de récupération",

  "secret.count.password": {
    one: "Phrase secrète de {count} caractère",
    many: "Phrase secrète de {count} de caractères",
    other: "Phrase secrète de {count} caractères",
  },
  "secret.count.recoveryKey": {
    one: "Clé de récupération de {count} caractère",
    many: "Clé de récupération de {count} de caractères",
    other: "Clé de récupération de {count} caractères",
  },
  "secret.count.shown": "{description}, affichée",

  "restore.intro":
    "Une sauvegarde chiffrée s’ouvre avec la phrase secrète utilisée lors de sa création, ou avec la clé de récupération que possédait le coffre-fort au moment de la sauvegarde, le cas échéant.",
  "restore.choose": "Choisir le fichier de sauvegarde…",
  "restore.chooseOther": "Choisir une autre sauvegarde…",
  "restore.chosen": "Sauvegarde choisie.",
  "restore.openWith": "L’ouvrir avec",
  "restore.method.passphrase": "Sa phrase secrète",
  "restore.method.recoveryKey": "Sa clé de récupération",
  "restore.passphrase.label": "Phrase secrète de la sauvegarde",
  "restore.passphrase.show": "Afficher la phrase secrète",
  "restore.tooLong": "Ce texte est trop long. Vérifiez ce que vous avez saisi.",
  "restore.check": "Vérifier la sauvegarde",
  "restore.checking": "Vérification de la sauvegarde…",
  "restore.checked": {
    one: "La sauvegarde contient {count} document. {consequence}",
    many: "La sauvegarde contient {count} de documents. {consequence}",
    other: "La sauvegarde contient {count} documents. {consequence}",
  },
  "restore.consequence.nothing":
    "La restauration place ce coffre-fort sur cet appareil.",
  "restore.consequence.same":
    "Le coffre-fort de cet appareil contient les mêmes documents. La restauration le remplace par cette sauvegarde.",
  "restore.consequence.differs":
    "Le coffre-fort de cet appareil pourrait ne pas être identique à cette sauvegarde : il a peut-être changé depuis, ou une partie n’a pas pu être lue. La restauration remplace le coffre-fort par la sauvegarde : tout ce qui se trouve dans le coffre-fort mais pas dans la sauvegarde est perdu, et la phrase secrète et la clé de récupération deviennent celles qui étaient en vigueur lors de la sauvegarde.",
  "restore.consequence.otherVault":
    "Cet appareil contient un autre coffre-fort. La restauration l’efface définitivement et met la sauvegarde à sa place.",
  "restore.consequence.unreadable":
    "Le coffre-fort de cet appareil n’a pas pu être lu; myCarlos ne peut donc pas savoir s’il s’agit de celui dont cette sauvegarde provient. La restauration l’efface définitivement et met la sauvegarde à sa place.",
  "restore.agree.erase":
    "Effacer le coffre-fort de cet appareil et restaurer la sauvegarde",
  "restore.agree.replace":
    "Remplacer le coffre-fort de cet appareil par cette sauvegarde et perdre ce qui a changé depuis",
  "restore.submit": "Restaurer la sauvegarde",
  "restore.restoring":
    "Restauration de la sauvegarde en cours. Cela peut prendre du temps pour un gros coffre-fort…",
  "restore.cancelled": "Restauration annulée. Rien n’a changé.",

  // Shared
  "common.cancel": "Annuler",

  // Library sidebar
  "sidebar.label": "Bibliothèque de documents",
  "sidebar.myRecords": "Mes documents",
  "sidebar.folders": "Dossiers",
  "sidebar.noFolders": "Aucun dossier pour l’instant",
  "sidebar.settings": "Paramètres",
  "sidebar.preferences": "Préférences",
  "sidebar.storage": "Coffre-fort local chiffré",
  "sidebar.documents": {
    one: "{count} document",
    many: "{count} de documents",
    other: "{count} documents",
  },
  "sidebar.folderCount": {
    one: "{count} dossier",
    many: "{count} de dossiers",
    other: "{count} dossiers",
  },

  // Shared with me (#61)
  "shared.title": "Partagés avec moi",
  "shared.tab.waiting": {
    one: "Partagés avec moi, {count} en attente",
    many: "Partagés avec moi, {count} en attente",
    other: "Partagés avec moi, {count} en attente",
  },
  "shared.section.waiting": {
    one: "Partagés avec moi ({count} en attente)",
    many: "Partagés avec moi ({count} en attente)",
    other: "Partagés avec moi ({count} en attente)",
  },
  "shared.arrived.one": "Un fichier partagé attend dans Partagés avec moi.",
  "shared.arrived.many": {
    one: "{count} fichier partagé attend dans Partagés avec moi.",
    many: "{count} de fichiers partagés attendent dans Partagés avec moi.",
    other: "{count} fichiers partagés attendent dans Partagés avec moi.",
  },
  "shared.waiting.none": "Rien n’est en attente.",
  "shared.waiting.count": {
    one: "{count} fichier est en attente.",
    many: "{count} de fichiers sont en attente.",
    other: "{count} fichiers sont en attente.",
  },
  "shared.intro.computer":
    "Les fichiers que vous ouvrez avec myCarlos attendent ici.",
  "shared.intro.phone":
    "Les fichiers que vous partagez avec myCarlos depuis une autre application attendent ici.",
  "shared.intro.notAdded":
    "Ils ne font pas partie de vos documents tant que vous ne les ajoutez pas.",
  "shared.empty.computer":
    "Pour ajouter un PDF de cette façon, ouvrez-le avec myCarlos à partir des fichiers de votre ordinateur.",
  "shared.empty.phone":
    "Pour ajouter un PDF de cette façon, choisissez Partager dans l’application qui le contient, puis myCarlos.",
  "shared.list.label": "Fichiers en attente",
  "shared.origin.computer": "Ouvert avec myCarlos",
  "shared.origin.phone": "Partagé depuis une autre application",
  "shared.row.detail": "{origin} · sera marqué « {label} »",
  "shared.row.notPdf":
    "Ce n’est pas un document PDF : myCarlos ne peut pas l’ajouter.",
  "shared.paused.title": "Les modifications sont suspendues.",
  "shared.paused.body":
    "Les fichiers ne peuvent pas être ajoutés ni refusés pour le moment. Mes documents en indique la raison et ce qu’il faut faire.",
  "shared.add": "Ajouter…",
  "shared.add.name": "Ajouter {name}…",
  "shared.decline": "Refuser",
  "shared.decline.name": "Refuser {name}",
  "shared.decline.title": "Refuser {name} ?",
  "shared.decline.body":
    "Il n’est pas ajouté, et myCarlos l’oublie. L’application qui l’a partagé l’a toujours.",
  "shared.addTo.label": "Ajouter {name}",
  "shared.addTo.person": "Dans les documents de",
  "shared.addTo.folder": "Dossier",
  "shared.addTo.noFolder": "Aucun dossier (Mes documents)",
  "shared.addTo.submit": "Ajouter",
  "shared.added": "{name} a été chiffré et ajouté aux documents de {person}.",
  "shared.addedToFolder":
    "{name} a été chiffré et ajouté aux documents de {person}, dossier {folder}.",
  "shared.alreadyThere":
    "{name} était déjà dans les documents de {person} ; il n’a donc pas été ajouté de nouveau.",
  "shared.declined": "{name} refusé. Rien n’a été ajouté.",

  // Text size (Settings > Preferences)
  "textSize.title": "Taille du texte",
  "textSize.announce": "Taille du texte {percent}",
  "textSize.help":
    "Agrandit ou réduit tout le contenu de myCarlos, de {min} % à {max} %. myCarlos retient la taille sur cet ordinateur. Vous pouvez aussi maintenir la touche {modifier} enfoncée et appuyer sur plus, moins ou 0.",
  "textSize.key.command": "Commande",
  "textSize.smaller": "Texte plus petit",
  "textSize.larger": "Texte plus grand",
  "textSize.box": "Taille du texte en pourcentage",
  "textSize.reset": "Revenir à la taille normale",
  "textSize.notNumber": "Saisissez un nombre de {min} à {max}.",
  "textSize.smallest": "La plus petite taille est de {min} %.",
  "textSize.largest": "La plus grande taille est de {max} %.",
  "textSize.between":
    "{typed} % se situe entre deux tailles; la taille choisie est donc {size}.",

  // Rename a document or folder
  "rename.title.document": "Renommer le document",
  "rename.title.folder": "Renommer le dossier",
  "rename.label.folder": "Nom du dossier",
  "rename.label.document": "Nom du fichier",
  "rename.help.folder": "Le dossier et son contenu restent au même endroit.",
  "rename.help.document":
    "Cela change le nom dans myCarlos et le nom proposé à l’exportation.",
  "rename.help.documentExtension":
    "Cela change le nom dans myCarlos et le nom proposé à l’exportation. L’extension {extension} reste la même.",
  "rename.stemMissing": "Saisissez un nom avant {extension}.",
  "rename.gainsExtension":
    "Le nom de ce document n’a pas l’extension .pdf; il ne peut donc pas se terminer par .pdf.",
  "rename.tooLong":
    "Ce nom est trop long. Raccourcissez-le pour l’enregistrer.",
  "rename.unsafe":
    "Le nom d’un document ne peut pas contenir {characters} ni de caractères de contrôle invisibles, ni se terminer par un point.",
  "rename.reserved":
    "« {word} » ne peut pas servir de nom de document, car Windows le réserve à son propre usage. Choisissez un autre nom.",
  "rename.saving": "Enregistrement…",
  "rename.save": "Enregistrer le nom",

  // Settings > Security
  "security.title": "Sécurité",
  "security.subtitle": "Votre coffre-fort chiffré et vos paramètres d’accès",
  "security.devBuild.title": "Version de développement.",
  "security.devBuild.body": "Utilisez uniquement des fichiers fictifs.",
  "security.encryption.title": "Chiffrement",
  "security.encryption.state": "Activé — toujours",
  "security.encryption.body":
    "Les fichiers, les noms, les dossiers et les détails des documents sont chiffrés sur cet appareil.",
  "security.autoLock.title": "Verrouillage automatique",
  "security.autoLock.minutes": {
    one: "{count} minute",
    many: "{count} de minutes",
    other: "{count} minutes",
  },
  "security.autoLock.body":
    "Le coffre-fort se verrouille après la période choisie sans activité du clavier, du pointeur ou de l’écran tactile. Ce paramètre non médical est limité à une durée de 1 à 15 minutes.",
  "security.autoLock.label": "Délai de verrouillage automatique",
  "security.lockNow": "Verrouiller maintenant",
  "security.recoveryKey.title": "Clé de récupération",
  "security.recoveryKey.setUpOn": "Configurée le {date}",
  "security.recoveryKey.notSetUp": "Non configurée",
  "security.recoveryKey.body":
    "Ouvre votre coffre-fort si vous oubliez votre phrase secrète. Vous êtes la seule personne à l’avoir : personne à votre clinique ni chez myCarlos ne peut ouvrir votre coffre-fort à votre place. La remplacer met fin à l’ancienne.",
  "security.recoveryKey.current":
    "Votre clé actuelle porte l’étiquette {label}. La trousse ou la note qui porte cette étiquette est celle qui fonctionne; une autre étiquette n’ouvre pas ce coffre-fort. Les trousses et les notes faites avant l’affichage des étiquettes n’en ont pas : une trousse sans étiquette peut tout de même être cette clé, configurée le {date}.",
  "security.recoveryKey.replace": "Remplacer la clé de récupération",
  "security.recoveryKey.setUp": "Configurer une clé de récupération",
  "security.backup.title": "Sauvegarde chiffrée",
  "security.backup.body":
    "Un seul fichier qui contient tout votre coffre-fort, toujours chiffré. Conservez-le ailleurs que sur cet appareil, par exemple sur une clé USB. Il s’ouvre avec la phrase secrète ou la clé de récupération que vous avez au moment de l’enregistrer, et continue de s’ouvrir avec elles même après que vous les avez changées ici. Pour en restaurer un, verrouillez le coffre-fort et choisissez Restaurer à partir d’une sauvegarde.",
  "security.oldBackups.title": "Vos anciennes sauvegardes",
  "security.oldBackups.intro":
    "La trousse d’une ancienne clé de récupération a peut-être été perdue ou vue, et elle ouvre encore les sauvegardes enregistrées avant le remplacement de cette clé.",
  "security.oldBackups.saveWhenWritable":
    "Dès que le coffre-fort accepte de nouveau les modifications, enregistrez une nouvelle sauvegarde : choisissez Enregistrer une sauvegarde chiffrée.",
  "security.oldBackups.saveNow":
    "Enregistrez une nouvelle sauvegarde maintenant : choisissez Enregistrer une sauvegarde chiffrée.",
  "security.oldBackups.keepCopy":
    "Conservez-la, ou une copie, ailleurs que sur cet appareil, par exemple sur une clé USB ou dans un espace de stockage en nuage.",
  "security.oldBackups.thenDelete":
    "Supprimez ensuite les anciennes sauvegardes. Une fois la nouvelle enregistrée, cette section vous indique comment faire.",
  "security.oldBackups.none": "Je n’ai pas d’anciennes sauvegardes",
  "security.oldBackups.named": "Votre nouvelle sauvegarde est « {name} ».",
  "security.oldBackups.namedWithSize":
    "Votre nouvelle sauvegarde est « {name} » ({size}).",
  "security.oldBackups.justSaved":
    "Votre nouvelle sauvegarde est celle que vous venez d’enregistrer, le {date} vers {time} : votre application de fichiers indique quand chaque fichier a été enregistré, ainsi que sa taille.",
  "security.oldBackups.justSavedWithSize":
    "Votre nouvelle sauvegarde est celle que vous venez d’enregistrer, le {date} vers {time} ({size}) : votre application de fichiers indique quand chaque fichier a été enregistré, ainsi que sa taille.",
  "security.oldBackups.deleteOlder":
    "Supprimez les anciennes sauvegardes : les fichiers dont le nom commence par « myCarlos backup », et celles que vous avez renommées, sauf la nouvelle et ses copies. Elles se trouvent là où vous les avez enregistrées : un dossier, une clé USB ou, sur un téléphone, l’application Fichiers ou un espace de stockage en nuage.",
  "security.oldBackups.inPlace":
    "Si vous l’avez enregistrée à la place d’une ancienne sauvegarde, ce fichier est maintenant votre nouvelle sauvegarde : conservez-le.",
  "security.oldBackups.done": "J’ai terminé avec les anciennes sauvegardes",
  "security.backup.save": "Enregistrer une sauvegarde chiffrée…",
  "security.passphrase.title": "Changer de phrase secrète",
  "security.passphrase.rules":
    "Utilisez au moins {min} caractères et évitez les noms courants et les phrases prévisibles. Votre clé de récupération, si vous en avez une, continue de fonctionner; sans clé, oublier la nouvelle phrase secrète oblige à effacer le coffre-fort.",
  "security.passphrase.copies":
    "Changer de phrase secrète bloque une personne qui ne connaît que l’ancienne. Si elle a peut-être aussi une copie de votre coffre-fort, comme une sauvegarde de cet appareil ou un fichier de sauvegarde enregistré, une nouvelle phrase secrète ne suffit pas : l’ancienne ouvre toujours cette copie, et avec cette copie, elle pourrait ouvrir une copie plus récente obtenue plus tard. Pour la tenir à l’écart, il faut un nouveau coffre-fort, et veiller à ne perdre aucun document en chemin. Demandez de l’aide avant d’effacer quoi que ce soit.",
  "security.passphrase.current": "Phrase secrète actuelle",
  "security.passphrase.currentTooLong":
    "La phrase secrète actuelle est plus longue que n’importe quelle phrase secrète de coffre-fort. Vérifiez ce que vous avez saisi.",
  "security.passphrase.mismatch":
    "Les nouvelles phrases secrètes ne correspondent pas.",
  "security.passphrase.newTooLong":
    "La nouvelle phrase secrète est trop longue. Raccourcissez-la.",
  "security.passphrase.newTooShort":
    "La nouvelle phrase secrète est trop courte. Utilisez au moins {min} caractères.",
  "security.passphrase.submit": "Changer de phrase secrète",
  "security.speed.title": "Test de vitesse, pour les testeurs",
  "security.speed.body":
    "Mesure le temps que prend cet appareil pour vérifier une phrase secrète. Le test utilise une phrase secrète inventée, pas la vôtre, et ne change rien. Il dure quelques secondes, plus longtemps sur un téléphone plus ancien. Fermez d’abord les autres applications et restez sur cet écran jusqu’à la fin. Envoyez le résultat avec la marque et le modèle de l’appareil.",
  "security.speed.run": "Lancer le test de vitesse",
  "security.speed.measuring": "Mesure en cours…",
  "security.copies.title": "Copies lisibles et captures d’écran",
  "security.copies.body":
    "Les exportations et les captures d’écran ne sont plus protégées par le coffre-fort. Supprimer un document de myCarlos ne peut pas effacer ces copies ni le dossier médical d’origine de la clinique.",
  "security.profiles.title": "Profils de patient",
  "security.profiles.body":
    "Gardez séparés les documents de chaque personne dans ce coffre-fort.",
  "security.profiles.label": "Nom du nouveau profil",
  "security.profiles.add": "Ajouter le profil",
  "security.erase.title": "Effacer tout le coffre-fort",
  "security.erase.body":
    "Supprime définitivement tous les documents, profils et dossiers chiffrés. Cette action est irréversible.",
  "security.erase.show": "Afficher les commandes d’effacement",
  "security.erase.submit": "Effacer tout le coffre-fort",

  // Recovery key setup, and the printed kit
  "recoveryKey.printUnavailable":
    "L’impression n’est pas offerte ici. Enregistrez la trousse ou notez la clé.",
  "recoveryKey.chooseReason":
    "Indiquez pourquoi vous remplacez votre clé de récupération.",
  "recoveryKey.kitSaved":
    "Trousse de récupération enregistrée. La clé fonctionnera une fois la vérification terminée.",
  "recoveryKey.typedCount": {
    one: "Vous avez saisi {count} lettre ou chiffre. Votre clé de récupération compte {total} lettres et chiffres : 7 groupes de 4. Vérifiez ce que vous avez noté.",
    many: "Vous avez saisi {count} de lettres et chiffres. Votre clé de récupération compte {total} lettres et chiffres : 7 groupes de 4. Vérifiez ce que vous avez noté.",
    other:
      "Vous avez saisi {count} lettres et chiffres. Votre clé de récupération compte {total} lettres et chiffres : 7 groupes de 4. Vérifiez ce que vous avez noté.",
  },
  "recoveryKey.notChanged":
    "Votre clé de récupération n’a pas été changée. Votre clé actuelle fonctionne toujours. Pour la changer, appuyez de nouveau sur Vérifier et enregistrer.",
  "recoveryKey.threeMisses":
    "La clé ne correspondait pas, trois fois de suite. Relisez votre clé de récupération, puis vérifiez-la.",
  "recoveryKey.leave.required":
    "Verrouiller le coffre-fort et terminer plus tard",
  "recoveryKey.leave.offered": "Configurer plus tard",
  "recoveryKey.title.replace": "Remplacer votre clé de récupération",
  "recoveryKey.title.setUp": "Configurer une clé de récupération",
  "recoveryKey.title.key": "Votre clé de récupération",
  "recoveryKey.title.check": "Vérifier votre clé de récupération",
  "recoveryKey.discard.title": "Abandonner cette clé de récupération?",
  "recoveryKey.discard.body":
    "Cette clé de récupération n’est pas encore configurée : elle n’ouvrira donc jamais le coffre-fort. myCarlos verrouille maintenant le coffre-fort. Après l’avoir déverrouillé, vous pourrez configurer une nouvelle clé.",
  "recoveryKey.discard.confirm": "Abandonner la clé et verrouiller",
  "recoveryKey.about.offered":
    "Votre coffre-fort est ouvert. Il n’a pas encore de clé de récupération. Sans clé, si vous oubliez votre phrase secrète, la seule façon de revenir est d’effacer le coffre-fort.",
  "recoveryKey.about.what":
    "Une clé de récupération ouvre votre coffre-fort si vous oubliez votre phrase secrète. Vous serez la seule personne à l’avoir : personne à votre clinique ni chez myCarlos ne peut ouvrir votre coffre-fort à votre place.",
  "recoveryKey.about.replacing":
    "Votre clé de récupération actuelle cessera de fonctionner une fois la nouvelle vérifiée.",
  "recoveryKey.about.type":
    "Saisissez votre phrase secrète pour créer votre clé de récupération. Elle s’affiche ensuite : choisissez Continuer seulement quand personne d’autre ne peut voir votre écran.",
  "recoveryKey.about.typeAgain":
    "Saisissez de nouveau votre phrase secrète pour créer votre clé de récupération. Elle s’affiche ensuite : choisissez Continuer seulement quand personne d’autre ne peut voir votre écran.",
  "recoveryKey.about.typeNew":
    "Saisissez votre phrase secrète pour créer votre nouvelle clé de récupération. Elle s’affiche ensuite : choisissez Continuer seulement quand personne d’autre ne peut voir votre écran.",
  "recoveryKey.about.typeAgainNew":
    "Saisissez de nouveau votre phrase secrète pour créer votre nouvelle clé de récupération. Elle s’affiche ensuite : choisissez Continuer seulement quand personne d’autre ne peut voir votre écran.",
  "recoveryKey.reason.legend": "Pourquoi la remplacez-vous?",
  "recoveryKey.reason.hint": "En cas de doute, choisissez la première réponse.",
  "recoveryKey.reason.exposed":
    "Sa trousse ou sa note a peut-être été perdue ou vue par quelqu’un d’autre",
  "recoveryKey.reason.routine":
    "Je veux seulement une nouvelle clé : sa trousse est en lieu sûr",
  "recoveryKey.continue": "Continuer",
  "recoveryKey.keyboardHint":
    "La touche Échap quitte cette configuration. Lors de la première configuration, une confirmation est demandée, car quitter verrouille le coffre-fort et une clé inachevée ne fonctionnera pas.",
  "recoveryKey.instructions":
    "Notez-la, ou enregistrez ou imprimez la trousse, et conservez-la dans un endroit privé, loin de cet appareil. C’est la seule fois que myCarlos l’affiche. Ensuite, vous la saisirez en entier pour la vérifier. Restez dans myCarlos jusqu’à la fin de la vérification : quitter ou verrouiller annule cette clé.",
  "recoveryKey.hiddenWhileSaving":
    "Masquée pendant l’enregistrement de la trousse.",
  "recoveryKey.group": "Groupe {number} : {characters}",
  "recoveryKey.label":
    "Étiquette de la clé : {label}. Notez-la à côté de la clé. Elle n’est pas secrète : dans Sécurité, myCarlos affiche l’étiquette de la clé qui fonctionne, pour que vous sachiez quelle trousse est la bonne.",
  "recoveryKey.saveKit": "Enregistrer la trousse de récupération…",
  "recoveryKey.printKit": "Imprimer la trousse de récupération",
  "recoveryKey.next": "Suivant : vérifier votre clé de récupération",
  "recoveryKey.check.label": "Votre clé de récupération",
  "recoveryKey.check.hint":
    "Saisissez votre clé de récupération en entier, telle que vous l’avez notée ou enregistrée : 7 groupes de 4 lettres et chiffres. Les tirets, les espaces et les autres signes de ponctuation n’ont pas d’importance.",
  "recoveryKey.back": "Retour : relire votre clé de récupération",
  "recoveryKey.checkAndSave": "Vérifier et enregistrer",
  "kit.title": "Trousse de récupération myCarlos",
  "kit.printed": "Imprimée le {date}",
  "kit.labelPrinted": "Étiquette de la clé : {label} · Imprimée le {date}",
  "kit.labelNote":
    "L’étiquette n’est pas secrète. Dans Sécurité, myCarlos affiche l’étiquette de la clé de récupération qui fonctionne maintenant : une trousse avec une autre étiquette n’ouvre plus le coffre-fort.",
  "kit.use":
    "Si vous oubliez votre phrase secrète myCarlos, cette clé ouvre votre coffre-fort sur cet appareil et vous permet de choisir une nouvelle phrase secrète. Elle fonctionne une fois la vérification terminée dans myCarlos.",
  "kit.keep":
    "Conservez-la dans un endroit privé, loin de l’appareil. Toute personne qui a cette clé et une copie de votre coffre-fort peut l’ouvrir. Si vous configurez une nouvelle clé de récupération, celle-ci n’ouvre plus le coffre-fort sur cet appareil.",
};
