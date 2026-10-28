import type { Message } from "../types";
import type { MessageKey } from "./en";

/** Canadian French, formal register ("vous"). */
export const fr: Record<MessageKey, Message> = {
  "portal.working": "Opération avec la clinique en cours…",
  "portal.connectConsent":
    "Cette action associe cet appareil à votre clinique et envoie une demande d’approbation. Votre clinique doit approuver l’appareil avant qu’il puisse recevoir des documents.",
  "portal.connecting":
    "Connexion et demande d’approbation à la clinique en cours…",
  "portal.connected":
    "Appareil associé. Son état d’approbation est indiqué sur la page Sécurité, section Documents de la clinique.",
  "portal.linkedApprovalIssue":
    "Appareil associé, mais la demande d’approbation n’a pas pu être confirmée. L’état de l’appareil, sur la page Sécurité, section Documents de la clinique, indique la marche à suivre.",
  "portal.retryApproval": "Réessayer la demande d’approbation enregistrée",
  "portal.errorBusy":
    "Une autre opération avec la clinique est en cours. Attendez qu’elle se termine, puis réessayez.",
  "portal.serviceDateLabel": "Date du service",
  "portal.serviceDate": "Date du service : {date}",
  "portal.dateNotRecorded": "Date non consignée",
  "portal.restartApproval": "Créer une nouvelle demande d’approbation",
  "portal.approvalExpired":
    "Cette demande d’approbation a expiré. Pour en faire une autre pour cet appareil, allez sur la page Sécurité, section Documents de la clinique.",
  "portal.approvalExpiredCard":
    "Cette demande d’approbation a expiré. Pour en faire une autre pour ce même appareil, choisissez Créer une nouvelle demande d’approbation. Vos documents et le lien de cet appareil restent tels quels.",
  "portal.approvalCancelled":
    "Cette demande d’approbation a été annulée. Vérifiez les mises à jour avant de créer une nouvelle demande.",
  "portal.approvalRefused":
    "La clinique a refusé cette demande d’approbation de l’appareil. Contactez votre clinique pour connaître les prochaines étapes.",
  "portal.approvalContact":
    "L’approbation de la clinique doit être vérifiée. Contactez votre clinique pour connaître les prochaines étapes.",
  "portal.approvalMissing":
    "Votre demande d’approbation enregistrée est introuvable sur le portail. Renvoyez la demande enregistrée.",
  "portal.awaitingClinic":
    "Votre clinique a reçu la demande d’approbation. En attente de l’approbation de cet appareil par le personnel de la clinique.",
  "portal.approvalPickedUp":
    "Le système de dossiers de votre clinique a pris en charge cette demande. En attente de l’approbation de cet appareil par le personnel de la clinique.",
  "portal.approvalTimeLeft": {
    one: "Temps restant pour cette demande : environ {count} minute.",
    many: "Temps restant pour cette demande : environ {count} de minutes.",
    other: "Temps restant pour cette demande : environ {count} minutes.",
  },
  "portal.approvalTimeUp":
    "Le délai de cette demande est écoulé. Vérification auprès de votre clinique…",
  "portal.approvalTimeOver": "Le délai de cette demande est écoulé.",
  "portal.approvalTimeOverRestart":
    "Le délai de cette demande est écoulé. Si votre clinique n’a pas approuvé cet appareil, choisissez {button}.",
  "portal.approvalUnanswered":
    "myCarlos n’a pas pu obtenir l’état de cette demande auprès du portail de la clinique.",
  "portal.deviceRemoved":
    "Cet appareil a été retiré de votre compte du portail de la clinique. Pour l’utiliser de nouveau, associez-le de nouveau avec un nouveau code d’association de votre portail patient.",
  "portal.approvalReplyInvalid":
    "La réponse du portail de la clinique au sujet de cette demande n’a pas pu être vérifiée. Elle n’a donc pas été utilisée. Communiquez avec votre clinique.",
  "portal.approvalStillOpen":
    "Cette demande d’approbation est toujours ouverte sur le portail de la clinique. Attendez qu’elle prenne fin avant d’en créer une nouvelle.",
  "portal.approvalUnreachable":
    "myCarlos n’a pas pu joindre le portail de la clinique : l’état de cette demande n’est donc pas encore connu.",
  "portal.approvalWait":
    "Le portail de la clinique a demandé à myCarlos de vérifier moins souvent.",
  "portal.autoChecking":
    "Tant que cette page est ouverte, myCarlos vérifie automatiquement si votre clinique a répondu.",
  "portal.autoCheckStopped":
    "Les vérifications automatiques sont arrêtées. Pour vérifier de nouveau, choisissez {button}.",
  "portal.errorRateLimited":
    "Le portail de la clinique a demandé à myCarlos d’attendre avant de réessayer.",
  "portal.confirmationsPending":
    "Documents enregistrés en attente de confirmation de réception : {count}. Vérifiez à nouveau pour terminer la confirmation. Vos copies enregistrées restent dans le coffre.",
  "portal.partialResult":
    "Certaines vérifications auprès des cliniques nécessitent votre attention. Nouveaux documents enregistrés : {added}. Documents non vérifiés : {refused}.",
  "portal.clinicIssue": "{clinic} : {detail}",
  "portal.unlockCheckConsent":
    "Chaque fois que vous déverrouillez votre coffre-fort, myCarlos communique avec le portail de la clinique de chaque appareil associé pour vérifier les mises à jour de l’approbation et rechercher de nouveaux documents.",
  "portal.unlockChecked":
    "Recherche de nouveaux documents de la clinique effectuée après le déverrouillage.",
  "portal.unlockCheckIncomplete":
    "myCarlos n’a pas pu terminer la recherche de nouveaux documents de la clinique après le déverrouillage.",
  "portal.checkAgain": "Pour vérifier de nouveau, choisissez {button}.",
  "portal.unlockRefused": {
    one: "{count} document de la clinique n’a pas pu être vérifié, il n’a donc pas été ajouté. Communiquez avec votre clinique.",
    many: "{count} de documents de la clinique n’ont pas pu être vérifiés, ils n’ont donc pas été ajoutés. Communiquez avec votre clinique.",
    other:
      "{count} documents de la clinique n’ont pas pu être vérifiés, ils n’ont donc pas été ajoutés. Communiquez avec votre clinique.",
  },
  "portal.unlockCheckNotRun":
    "myCarlos n’a pas recherché de nouveaux documents de la clinique après le déverrouillage, car une autre opération avec la clinique était en cours.",
  // Native clinic linking and explicit document pickup.
  "portal.title": "Documents de la clinique",
  "portal.intro":
    "Associez myCarlos avec l’adresse et le code affichés dans votre portail patient.",
  "portal.address": "Adresse HTTPS du portail",
  "portal.code": "Code d’association",
  "portal.deviceName": "Nom de cet appareil",
  "portal.person": "Dossiers de quelle personne",
  "portal.matchPerson": "Utiliser les renseignements du document",
  "portal.routing":
    "Les documents sont classés sous la personne dont le nom complet et la date de naissance correspondent. Les autres vont dans Partagés avec moi.",
  "portal.link": "Connecter et demander l’approbation",
  "portal.check": "Rechercher de nouveaux documents",
  "portal.result":
    "Nouveaux documents enregistrés : {added}. Documents non vérifiés : {refused}.",
  "portal.incomplete":
    "Cette tentative enregistrée est incomplète. Vérifiez les appareils associés dans le portail ou contactez votre clinique avant d’associer l’appareil à nouveau. Cette application ne peut pas reprendre cette tentative.",
  "portal.approved": "La clinique a approuvé cet appareil.",
  "portal.notRequested":
    "Demandez l’approbation de la clinique pour recevoir des documents sur cet appareil.",
  "portal.awaiting":
    "Demande d’approbation enregistrée. Vérifiez les mises à jour ou renvoyez-la.",
  "portal.deviceCode": "Code de l’appareil",
  "portal.copy": "Copier le code de l’appareil",
  "portal.copied": "Code de l’appareil copié.",
  "portal.copyFailed":
    "Sélectionnez le code entier de l’appareil et copiez-le.",
  "portal.fingerprint": "Empreinte complète de l’appareil",
  "portal.compare":
    "Demandez au personnel de la clinique de comparer cette empreinte entière sur cet écran avant d’approuver cet appareil.",
  "portal.requestApproval": "Demander l’approbation de la clinique",
  "portal.sourceVerified": "De {clinic} · Vérifié",
  "portal.errorAddress":
    "Saisissez l’adresse HTTPS du portail sans nom d’utilisateur, mot de passe, paramètres de requête ni fragment.",
  "portal.errorCode":
    "Saisissez le code d’association complet affiché dans votre portail patient.",
  "portal.errorDeviceName":
    "Choisissez un nom d’appareil de 1 à 64 caractères sans caractères de contrôle.",
  "portal.errorCodeRejected":
    "Le portail a refusé ce code. Créez un nouveau code d’association dans votre portail patient.",
  "portal.errorKeys":
    "La clinique n’a pas encore publié de clé de signature. L’association est incomplète.",
  "portal.errorExists":
    "Cet appareil est déjà enregistré. Consultez les appareils associés dans votre portail patient.",
  "portal.errorIncomplete":
    "La demande au portail n’a pas abouti. Vérifiez votre connexion et l’horloge de l’appareil, puis réessayez.",
  "portal.errorRefused":
    "Un document de la clinique n’a pas pu être vérifié. Il n’a pas été ajouté et aucun accusé de réception n’a été envoyé.",

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

  "passphrase.show": "Afficher la phrase secrète",
  "passphrase.show.inConfirm": "dans Confirmer la phrase secrète",

  "checklist.heading": "Votre phrase secrète doit être :",
  "checklist.length": "Longue d’au moins {min} caractères",
  "checklist.hardToGuess": "Difficile à deviner",
  "checklist.notAName": "Différente de votre nom",
  "checklist.done": ", c’est fait",
  "checklist.notYet": ", pas encore",
  "checklist.spaces":
    "Les espaces sont autorisés, donc quelques mots sans lien entre eux font une bonne phrase secrète. myCarlos vérifie ces règles sur cet ordinateur.",
  "checklist.allMet": "Votre phrase secrète respecte toutes les règles.",

  "create.title": "Configurer myCarlos sur cet ordinateur",
  "create.intro":
    "Vos fichiers et les détails de vos dossiers sont chiffrés sur cet appareil. Votre phrase secrète ouvre le coffre-fort. Vous pourrez ensuite configurer une clé de récupération au cas où vous l’oublieriez.",
  "create.stays":
    "Votre coffre-fort reste sur cet appareil. Si vous en avez créé un sur un autre appareil, il s’y trouve toujours et n’apparaîtra pas ici.",
  "create.profile.label": "De qui allez-vous conserver les dossiers ici ?",
  "create.profile.tooLong": "Ce nom est trop long. Raccourcissez-le.",
  "create.profile.sharedTaken":
    "« {folder} » est l’endroit où vont les fichiers partagés. Choisissez un autre nom.",
  "create.submit": "Créer le coffre-fort",

  "unlock.title": "Déverrouiller votre coffre-fort",
  "unlock.autoLock": {
    one: "Le coffre-fort se verrouille après {count} minute d’inactivité et chaque fois que myCarlos est masqué, par exemple réduit ou envoyé en arrière-plan.",
    many: "Le coffre-fort se verrouille après {count} de minutes d’inactivité et chaque fois que myCarlos est masqué, par exemple réduit ou envoyé en arrière-plan.",
    other:
      "Le coffre-fort se verrouille après {count} minutes d’inactivité et chaque fois que myCarlos est masqué, par exemple réduit ou envoyé en arrière-plan.",
  },
  "unlock.waiting.one":
    "Un fichier partagé est en attente. Déverrouillez le coffre-fort et il ira dans « {folder} ». Si myCarlos se ferme avant, il ne sera pas conservé : partagez-le de nouveau.",
  "unlock.waiting": {
    one: "{count} fichier partagé est en attente. Déverrouillez le coffre-fort et il ira dans « {folder} ». Si myCarlos se ferme avant, il ne sera pas conservé : partagez-le de nouveau.",
    many: "{count} fichiers partagés sont en attente. Déverrouillez le coffre-fort et ils iront dans « {folder} ». Si myCarlos se ferme avant, ils ne seront pas conservés : partagez-les de nouveau.",
    other:
      "{count} fichiers partagés sont en attente. Déverrouillez le coffre-fort et ils iront dans « {folder} ». Si myCarlos se ferme avant, ils ne seront pas conservés : partagez-les de nouveau.",
  },
  "unlock.submit": "Déverrouiller",
  "unlock.forgot.summary": "Vous avez oublié votre phrase secrète ?",
  "unlock.noKey.heading": "Pas de clé de récupération ?",
  "unlock.noKey.body":
    "Sans clé, la seule façon de revenir est de mettre ce coffre-fort de côté et de recommencer. Le coffre-fort mis de côté reste sur cet appareil, chiffré, mais personne ne peut l’ouvrir sans sa phrase secrète.",
  "restore.summary": "Restaurer à partir d’une sauvegarde",

  "reset.plainly":
    "Mettre le coffre-fort de côté retire de myCarlos sur cet ordinateur tous vos documents, dossiers et profils de patients. Ils restent sur cet ordinateur, chiffrés, mais personne ne peut les ouvrir sans la phrase secrète. Pour confirmer, saisissez exactement les mots ci-dessous.",
  "reset.type": "Saisissez {phrase}",
  "reset.submit": "Mettre le coffre-fort de côté",

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
    "Le coffre-fort de cet appareil contient les mêmes documents. La restauration le met de côté et met cette sauvegarde à sa place. Le coffre-fort mis de côté reste sur cet appareil, chiffré, mais myCarlos ne peut pas encore le rouvrir pour vous.",
  "restore.consequence.differs":
    "Le coffre-fort de cet appareil pourrait ne pas être identique à cette sauvegarde : il a peut-être changé depuis, ou une partie n’a pas pu être lue. La restauration met le coffre-fort de côté et met la sauvegarde à sa place : ce qui n’est pas dans la sauvegarde n’est plus dans le coffre-fort que vous utilisez, et la phrase secrète et la clé de récupération deviennent celles qui étaient en vigueur lors de la sauvegarde. Le coffre-fort mis de côté reste sur cet appareil, chiffré, mais myCarlos ne peut pas encore le rouvrir pour vous.",
  "restore.consequence.otherVault":
    "Cet appareil contient un autre coffre-fort. La restauration le met de côté et met la sauvegarde à sa place. Le coffre-fort mis de côté reste sur cet appareil, chiffré, mais myCarlos ne peut pas encore le rouvrir pour vous.",
  "restore.consequence.unreadable":
    "Le coffre-fort de cet appareil n’a pas pu être lu ; myCarlos ne peut donc pas savoir s’il s’agit de celui dont cette sauvegarde provient. La restauration le met de côté et met la sauvegarde à sa place. Le coffre-fort mis de côté reste sur cet appareil, chiffré, mais myCarlos ne peut pas encore le rouvrir pour vous.",
  "restore.agree.erase":
    "Mettre de côté le coffre-fort de cet appareil et restaurer la sauvegarde",
  "restore.agree.replace":
    "Mettre de côté le coffre-fort de cet appareil, avec ce qui a changé depuis, et restaurer cette sauvegarde",
  "restore.submit": "Restaurer la sauvegarde",
  "restore.restoring":
    "Restauration de la sauvegarde en cours. Cela peut prendre du temps pour un gros coffre-fort…",
  "restore.cancelled": "Restauration annulée. Rien n’a changé.",

  // Shared
  "common.cancel": "Annuler",

  // Library sidebar
  "sidebar.label": "Bibliothèque de documents",
  "sidebar.myRecords": "Mes documents",
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
    "Le coffre-fort se verrouille après la période choisie sans activité du clavier, du pointeur ou de l’écran tactile. Choisissez une durée de 1 à 15 minutes.",
  "security.autoLock.label": "Délai de verrouillage automatique",
  "security.autoLock.shorter": "Délai plus court",
  "security.autoLock.longer": "Délai plus long",
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
    "Utilisez au moins {min} caractères et évitez les noms courants et les phrases prévisibles. Votre clé de récupération, si vous en avez une, continue de fonctionner; sans clé, oublier la nouvelle phrase secrète oblige à mettre le coffre-fort de côté et à recommencer.",
  "security.passphrase.copies":
    "Changer de phrase secrète bloque une personne qui ne connaît que l’ancienne. Si elle a peut-être aussi une copie de votre coffre-fort, comme une sauvegarde de cet appareil ou un fichier de sauvegarde enregistré, une nouvelle phrase secrète ne suffit pas : l’ancienne ouvre toujours cette copie, et avec cette copie, elle pourrait ouvrir une copie plus récente obtenue plus tard. Pour la tenir à l’écart, il faut un nouveau coffre-fort, et veiller à ne perdre aucun document en chemin. Demandez de l’aide avant de mettre votre coffre-fort de côté.",
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
    "Les exportations et les captures d’écran ne sont plus protégées par le coffre-fort. Masquer un document dans myCarlos n’efface ni ces copies ni le dossier médical d’origine de la clinique.",
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
    "Votre coffre-fort est ouvert. Il n’a pas encore de clé de récupération. Sans clé, si vous oubliez votre phrase secrète, la seule façon de revenir est de mettre le coffre-fort de côté et de recommencer.",
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

  // First setup: comfort settings, before the passphrase
  "comfort.title": "Adaptez myCarlos à vos besoins",
  "comfort.intro":
    "Choisissez ce qui vous convient avant la configuration. Chaque choix s’applique tout de suite.",
  "comfort.sample":
    "Voici à quoi ressemble le texte dans myCarlos. Appuyez sur − ou + jusqu’à ce qu’il soit facile à lire.",
  "textSize.followsDevice":
    "Ici, la taille du texte suit votre appareil : son propre réglage de taille du texte, ou le zoom du navigateur.",
  "comfort.autoLock.body":
    "myCarlos se verrouille de lui-même après ce délai sans utilisation, pour que personne d’autre ne voie vos documents. Choisissez entre 1 et 15 minutes.",
  "comfort.later":
    "Vous pouvez les modifier à tout moment dans {settings} : {textSize} sous {preferences}, et {autoLock} sous {security}.",
  "comfort.continue": "Continuer",
  "comfort.usual": "Utiliser les réglages habituels",

  // Notices after vault actions (the app's status line)
  "notice.iosKeepOpen":
    "Gardez myCarlos ouvert : changer d’application met ce transfert en pause.",
  "notice.dropRefused":
    "Pour importer des PDF, déverrouillez votre coffre-fort et utilisez {button}. Le glisser-déposer déplace les documents déjà dans myCarlos.",
  "notice.lockedIdle": {
    one: "Verrouillé après {count} minute sans utilisation.",
    many: "Verrouillé après {count} de minutes sans utilisation.",
    other: "Verrouillé après {count} minutes sans utilisation.",
  },
  "notice.lockedHidden":
    "Verrouillé parce que myCarlos a été réduit ou envoyé en arrière-plan.",
  "notice.locked": "Coffre-fort verrouillé.",
  "notice.autoLockSet": {
    one: "Verrouillage automatique réglé à {count} minute.",
    many: "Verrouillage automatique réglé à {count} de minutes.",
    other: "Verrouillage automatique réglé à {count} minutes.",
  },
  "notice.backupCutOff":
    "La sauvegarde s’est arrêtée parce que le coffre-fort s’est verrouillé. Aucune sauvegarde n’a été enregistrée. Conservez vos sauvegardes plus anciennes. {note}",
  "notice.transferUnfinished": "Le transfert n’a pas abouti.",
  "notice.restored":
    "Sauvegarde restaurée. Déverrouillez le coffre-fort avec la phrase secrète utilisée lors de sa création, ou utilisez sa clé de récupération.",
  "notice.createdThenLocked":
    "Votre coffre-fort a été créé, puis verrouillé avant que sa clé de récupération puisse être créée. Déverrouillez-le pour en configurer une.",
  "notice.created":
    "Coffre-fort chiffré créé. Configurez une clé de récupération pour qu’un oubli de votre phrase secrète ne vous prive pas définitivement de vos documents.",
  "notice.unlockedRecovery":
    "Coffre-fort déverrouillé en mode de récupération, en lecture seule. Consultez l’avis dans la bibliothèque pour savoir quoi faire.",
  "notice.unlocked": "Coffre-fort déverrouillé.",
  "notice.recovered":
    "Coffre-fort ouvert avec votre clé de récupération. Utilisez désormais votre nouvelle phrase secrète.",
  "notice.recoveredReadOnly":
    "Coffre-fort ouvert en lecture seule avec votre clé de récupération, et votre phrase secrète n’a pas changé. Consultez l’avis dans la bibliothèque pour savoir quoi faire.",
  "notice.eraseCancelled":
    "Rien n’a changé : le coffre-fort n’a pas été mis de côté.",

  // What to check after a refusal, and other errors the app words itself
  "box.name": "le nom",
  "box.passphrase": "la phrase secrète",
  "box.currentPassphrase": "la phrase secrète actuelle",
  "box.newPassphrase": "la nouvelle phrase secrète",
  "box.recoveryKey": "la clé de récupération",
  "box.typedWords": "les mots saisis",
  "box.profileName": "le nom du profil",
  "box.folderName": "le nom du dossier",
  "error.checkBoxes": "Vérifiez {boxes}, puis réessayez.",
  "error.retryIn": {
    one: "Réessayez dans {count} seconde.",
    many: "Réessayez dans {count} de secondes.",
    other: "Réessayez dans {count} secondes.",
  },
  "error.fallback": "L’opération sur le coffre-fort n’a pas pu aboutir.",
  "error.damaged":
    "Aucune sauvegarde n’a été enregistrée : le document « {name} » ({where}) est endommagé et ne peut plus être lu, et une sauvegarde qui le contient ne pourrait pas être restaurée. Rien n’a été modifié. Conservez vos anciennes sauvegardes. Demandez de l’aide pour récupérer ce document à partir d’une copie ou d’une sauvegarde en bon état avant de réessayer.",
  "error.damaged.where": "ajouté le {date}",
  "error.damaged.whereFor": "ajouté le {date}, dans les documents de {person}",

  // The warning before the automatic lock (#68)
  "lockWarning.title": {
    one: "myCarlos se verrouillera dans {count} seconde pour protéger vos documents.",
    many: "myCarlos se verrouillera dans {count} de secondes pour protéger vos documents.",
    other:
      "myCarlos se verrouillera dans {count} secondes pour protéger vos documents.",
  },
  "lockWarning.help":
    "Pour le garder ouvert, appuyez sur {keepOpen} ou sur n’importe quelle touche.",
  "lockWarning.left": {
    one: "Il reste {count} seconde.",
    many: "Il reste {count} de secondes.",
    other: "Il reste {count} secondes.",
  },
  "lockWarning.keepOpen": "Garder ouvert",

  // Settings > Preferences, and Appearance (#47)
  "preferences.subtitle": "L’apparence de myCarlos sur cet ordinateur",
  "language.title": "Langue",
  "language.help":
    "Ce choix est mémorisé sur cet appareil. Vos documents restent dans leur langue d’origine.",
  "language.system": "Par défaut du système",
  "language.error.unreadable":
    "La langue enregistrée n’a pas pu être lue. La langue de votre appareil est utilisée pour cette session.",
  "language.error.notRemembered":
    "La langue a changé pour cette session, mais ce choix n’a pas pu être mémorisé sur cet appareil.",

  "appearance.title": "Apparence",
  "appearance.help":
    "{system} suit l’apparence claire ou sombre de votre appareil. Le contraste élevé utilise un fond noir et du texte clair. Les couleurs de contraste de votre appareil restent prioritaires.",
  "appearance.system": "Système",
  "appearance.light": "Clair",
  "appearance.dark": "Sombre",
  "appearance.highContrast": "Contraste élevé",
  "appearance.error.unreadable":
    "L’apparence enregistrée n’a pas pu être lue. L’option {system} est utilisée pendant cette session.",
  "appearance.error.notRemembered":
    "L’apparence a changé pour cette session, mais n’a pas pu être mémorisée sur cet appareil.",
  "appearance.error.window":
    "L’apparence de la fenêtre n’a pas pu suivre ce choix. Vous pouvez continuer à utiliser myCarlos.",

  // A document shown as a photo
  "photo.eyebrow": "Photo",
  "photo.alt": "Photo : {name}",
  "photo.area":
    "Photo. Agrandissez pour voir les détails ; faites glisser ou défilez pour vous déplacer.",
  "photo.fitted": "Ajustée à la fenêtre.",
  "photo.zoomed": "Agrandie à {percent} %.",
  "photo.zoomOut": "Réduire",
  "photo.zoomIn": "Agrandir",
  "photo.close": "Fermer",

  // The library's folders and documents, as a list or a grid
  "library.items": {
    one: "{count} élément visible dans la bibliothèque",
    many: "{count} d’éléments visibles dans la bibliothèque",
    other: "{count} éléments visibles dans la bibliothèque",
  },
  "library.column.name": "Nom",
  "library.column.source": "Source",
  "library.column.added": "Date d’ajout",
  "library.folder.label": "Dossier {name}",
  "library.folder.open": "Ouvrir {name}",
  "library.folder.items": {
    one: "{count} élément",
    many: "{count} d’éléments",
    other: "{count} éléments",
  },
  "library.folder.rename": "Renommer le dossier {name}",
  "library.rename": "Renommer",
  "library.document.label": "Document {name}",
  "library.document.details": "Détails de {name}",
  "library.details": "Détails",
  "library.select": "Sélectionner {name}",
  "library.empty.title": "Cet emplacement est vide",
  "library.empty.help": "Ajoutez un dossier ou importez un document ici.",
  "library.search.results":
    "Résultats de la recherche. Dossiers : {folders}. Documents : {documents}.",
  "library.search.cleared":
    "Recherche effacée. Dossiers à cet emplacement : {folders}. Documents : {documents}.",
  "library.noMatch.title": "Aucun document correspondant",
  "library.noMatch.help": "Essayez une autre recherche.",
  // Optional identity details and explicit shared-document suggestions (#97).
  "personDetails.fullName":
    "Nom complet, comme sur les documents de la clinique (facultatif)",
  "personDetails.birthDate": "Date de naissance (facultative)",
  "personDetails.help":
    "Conservés dans ce coffre chiffré pour suggérer à qui un document partagé est destiné. Ces renseignements ne vérifient pas la source d'un document.",
  "personDetails.nameTooLong":
    "Ce nom complet est trop long. Raccourcissez-le.",
  "personDetails.invalidDate":
    "Saisissez une date de naissance valide : année, mois et jour.",
  "personDetails.futureDate":
    "La date de naissance ne peut pas être dans le futur.",
  "personDetails.list": "Renseignements des personnes",
  "personDetails.for": "Renseignements pour {name}",
  "personDetails.save": "Enregistrer les renseignements",
  "personDetails.cancel": "Annuler",
  "personDetails.noName": "Aucun nom complet",
  "personDetails.noDate": "Aucune date de naissance",
  "personDetails.editFor": "Modifier les renseignements pour {name}",
  "personDetails.edit": "Modifier les renseignements",
  "personDetails.saved": "Renseignements pour {name} enregistrés.",
  "personSuggestion.byDate": "la date de naissance sur le document correspond",
  "personSuggestion.byBoth":
    "la date de naissance et le nom sur le document correspondent",
  "personSuggestion.byName": "le nom sur le document correspond",
  "personSuggestion.for": "Personne suggérée pour {document}",
  "personSuggestion.offer":
    "Ce document semble être destiné à {name} ({why}). Le déplacer dans ses dossiers ?",
  "personSuggestion.moveLabel":
    "Déplacer {document} dans les dossiers de {name}",
  "personSuggestion.move": "Déplacer",
  "personSuggestion.dismissLabel": "Pas cette personne : {document}",
  "personSuggestion.dismiss": "Pas cette personne",
};
