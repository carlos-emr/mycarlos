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
    "Sans clé, la seule façon de revenir est d’effacer myCarlos et de recommencer.",
  "restore.summary": "Restaurer à partir d’une sauvegarde",

  "reset.plainly":
    "L’effacement supprime de myCarlos sur cet ordinateur tous vos documents, dossiers et profils de patients, et il est irréversible. Pour confirmer, saisissez exactement les mots ci-dessous.",
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
};
