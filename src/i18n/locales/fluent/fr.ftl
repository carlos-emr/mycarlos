appearance-dark = Sombre

appearance-error-notRemembered = L’apparence a changé pour cette session, mais n’a pas pu être mémorisée sur cet appareil.

appearance-error-unreadable = L’apparence enregistrée n’a pas pu être lue. L’option { $system } est utilisée pendant cette session.

appearance-error-window = L’apparence de la fenêtre n’a pas pu suivre ce choix. Vous pouvez continuer à utiliser myCarlos.

appearance-help = { $system } suit l’apparence claire ou sombre de votre appareil. Le contraste élevé utilise un fond noir et du texte clair. Les couleurs de contraste de votre appareil restent prioritaires.

appearance-highContrast = Contraste élevé

appearance-light = Clair

appearance-system = Système

appearance-title = Apparence

auth-kicker = Dossiers privés myCarlos

box-currentPassphrase = la phrase secrète actuelle

box-folderName = le nom du dossier

box-name = le nom

box-newPassphrase = la nouvelle phrase secrète

box-passphrase = la phrase secrète

box-profileName = le nom du profil

box-recoveryKey = la clé de récupération

box-typedWords = les mots saisis

checklist-allMet = Votre phrase secrète respecte toutes les règles.

checklist-done = , c’est fait

checklist-hardToGuess = Difficile à deviner

checklist-heading = Votre phrase secrète doit être :

checklist-length = Longue d’au moins { $min } caractères

checklist-notAName = Différente de votre nom

checklist-notYet = , pas encore

checklist-spaces = Les espaces sont autorisés, donc quelques mots sans lien entre eux font une bonne phrase secrète. myCarlos vérifie ces règles sur cet ordinateur.

comfort-autoLock-body = myCarlos se verrouille de lui-même après ce délai sans utilisation, pour que personne d’autre ne voie vos documents. Choisissez entre 1 et 15 minutes.

comfort-continue = Continuer

comfort-intro = Choisissez ce qui vous convient avant la configuration. Chaque choix s’applique tout de suite.

comfort-later = Vous pouvez les modifier à tout moment dans { $settings } : { $textSize } sous { $preferences }, et { $autoLock } sous { $security }.

comfort-sample = Voici à quoi ressemble le texte dans myCarlos. Appuyez sur − ou + jusqu’à ce qu’il soit facile à lire.

comfort-title = Adaptez myCarlos à vos besoins

comfort-usual = Utiliser les réglages habituels

common-cancel = Annuler

create-intro = Vos fichiers et les détails de vos dossiers sont chiffrés sur cet appareil. Votre phrase secrète ouvre le coffre-fort. Vous pourrez ensuite configurer une clé de récupération au cas où vous l’oublieriez.

create-profile-label = De qui allez-vous conserver les dossiers ici ?

create-profile-sharedTaken = « { $folder } » est l’endroit où vont les fichiers partagés. Choisissez un autre nom.

create-profile-tooLong = Ce nom est trop long. Raccourcissez-le.

create-stays = Votre coffre-fort reste sur cet appareil. Si vous en avez créé un sur un autre appareil, il s’y trouve toujours et n’apparaîtra pas ici.

create-submit = Créer le coffre-fort

create-title = Configurer myCarlos sur cet ordinateur

error-checkBoxes = Vérifiez { $boxes }, puis réessayez.

error-damaged = Aucune sauvegarde n’a été enregistrée : le document « { $name } » ({ $where }) est endommagé et ne peut plus être lu, et une sauvegarde qui le contient ne pourrait pas être restaurée. Rien n’a été modifié. Conservez vos anciennes sauvegardes. Demandez de l’aide pour récupérer ce document à partir d’une copie ou d’une sauvegarde en bon état avant de réessayer.

error-damaged-where = ajouté le { $date }

error-damaged-whereFor = ajouté le { $date }, dans les documents de { $person }

error-fallback = L’opération sur le coffre-fort n’a pas pu aboutir.

error-retryIn =
    { $count ->
    [one] Réessayez dans { $count } seconde.
    [many] Réessayez dans { $count } de secondes.
    *[other] Réessayez dans { $count } secondes.
    }

frame-banner-body = N’utilisez pas de véritables renseignements sur des patients

frame-banner-title = Version de développement avec données fictives

frame-state-locked = Verrouillé

frame-state-locking = Verrouillage en cours

frame-state-notLocked = Déverrouillé

frame-state-opening = Ouverture en cours

frame-state-settingUp = Configuration

frame-window-label = Coffre-fort privé myCarlos

interface-camera-denied = myCarlos ne peut pas utiliser l’appareil photo. { $help } Choisissez ensuite Réessayer.

interface-CameraDialog-cameraReady = Appareil photo prêt.

interface-CameraDialog-cameraView = Vue de l’appareil photo

interface-CameraDialog-myCarlosUsesTheCameraToSavePhotos = myCarlos utilise l’appareil photo pour enregistrer des photos de vos documents de santé. Les photos restent verrouillées dans myCarlos.

interface-CameraDialog-photoTakenRetakeOrUseThePhoto = Photo prise. Reprenez-la ou utilisez-la.

interface-CameraDialog-retake = Reprendre

interface-CameraDialog-startingTheCamera = Démarrage de l’appareil photo…

interface-CameraDialog-takeAPhoto = Prendre une photo

interface-CameraDialog-takePhoto = Prendre la photo

interface-CameraDialog-theCameraIsOnOnlyWhileYou = L’appareil photo ne fonctionne que pendant la prise de photo. Il s’éteint lorsque vous prenez la photo, fermez cette fenêtre ou que myCarlos se verrouille.

interface-CameraDialog-thePhotoCouldNotBePreparedChoose = La photo n’a pas pu être préparée. Choisissez Reprendre.

interface-CameraDialog-thePhotoYouTook = La photo que vous avez prise

interface-CameraDialog-tryAgain = Réessayer

interface-CameraDialog-usePhoto = Utiliser la photo

interface-CameraDialog-useTheCamera = Utiliser l’appareil photo

interface-CameraDialog-yourPhoneAsksOnceWhetherMyCarlosMay = Votre téléphone vous demande une fois si myCarlos peut utiliser l’appareil photo. Celui-ci ne fonctionne que pendant la prise de photo. Il s’éteint lorsque vous prenez la photo, annulez ou que myCarlos se verrouille.

interface-count-documents =
    { $count ->
    [one] { $count } document
    *[other] { $count } documents
    [many] { $count } documents
    }

interface-count-folders =
    { $count ->
    [one] { $count } dossier
    *[other] { $count } dossiers
    [many] { $count } dossiers
    }

interface-count-found = Résultats : { $items }

interface-count-foundInLocation = { $folders } · { $documents } trouvés

interface-count-hidden =
    { $count ->
    [one] { $count } document masqué
    *[other] { $count } documents masqués
    [many] { $count } documents masqués
    }

interface-count-inLocation = { $folders } · { $documents } à cet emplacement

interface-count-new =
    { $count ->
    [one] { $count } nouveau
    *[other] { $count } nouveaux
    [many] { $count } nouveaux
    }

interface-count-selected =
    { $count ->
    [one] { $count } sélectionné
    *[other] { $count } sélectionnés
    [many] { $count } sélectionnés
    }

interface-DocumentReader-documentPassword = Mot de passe du document

interface-DocumentReader-fitWidth = Ajuster à la largeur

interface-DocumentReader-larger = Agrandir

interface-DocumentReader-nextPage = Page suivante

interface-DocumentReader-noTextCouldBeReadOnThis = Aucun texte n’a pu être lu sur cette page. Il s’agit peut-être d’une numérisation.

interface-DocumentReader-open = Ouvrir

interface-DocumentReader-previousPage = Page précédente

interface-DocumentReader-smaller = Réduire

interface-DocumentReader-textOnThisPage = Texte de cette page

interface-DocumentReader-thatPasswordDidNotOpenTheDocument = Ce mot de passe n’a pas ouvert le document. Vérifiez-le dans votre portail patient, puis réessayez.

interface-DocumentReader-thisDocumentIsLockedWithItsOwn = Ce document est verrouillé par son propre mot de passe. Saisissez le mot de passe du document indiqué dans votre portail patient. Il n’est pas conservé après la fermeture du document.

interface-hidden-fileBack = Son fichier est de nouveau disponible

interface-hidden-fileMissing = Endommagé : fichier manquant

interface-hidden-record = { $name }, masqué

interface-hidden-restore = Restaurer { $name }

interface-HiddenDocuments-documentsYouHideAreListedHere = Les documents que vous masquez sont répertoriés ici.

interface-HiddenDocuments-hidden = Masqués

interface-HiddenDocuments-hiddenDocumentsStayInYourEncryptedVault = Les documents masqués restent dans votre coffre-fort chiffré : myCarlos ne supprime jamais de document. Restaurez-en un pour le remettre à sa place d’origine.

interface-HiddenDocuments-nothingIsHidden = Aucun document masqué

interface-HiddenDocuments-restore = Restaurer

interface-HiddenDocuments-wasIn = Se trouvait dans

interface-hideDamaged-title =
    { $count ->
    [one] Masquer { $count } document endommagé?
    *[other] Masquer { $count } documents endommagés?
    [many] Masquer { $count } documents endommagés?
    }

interface-inLocation = Dans { $location }

interface-LibraryItems-in = Dans

interface-LibrarySidebar-sharedWithMe = Partagés avec moi

interface-notice-alreadyFiled = { $name } figurait déjà dans les documents de { $person }; il est donc resté dans { $source }.

interface-notice-alreadyShared = { $name } figurait déjà dans Partagés avec moi.

interface-notice-changesResumed = { $outcome } Le coffre-fort accepte de nouveau les modifications.

interface-notice-copySaved = Une copie lisible a été enregistrée sur cet ordinateur.

interface-notice-damagedHidden =
    { $count ->
    [one] { $count } document endommagé masqué. Il figure dans Masqués.
    *[other] { $count } documents endommagés masqués. Ils figurent dans Masqués.
    [many] { $count } documents endommagés masqués. Ils figurent dans Masqués.
    }

interface-notice-duplicates =
    { $count ->
    [one] { $count } doublon ignoré.
    *[other] { $count } doublons ignorés.
    [many] { $count } doublons ignorés.
    }

interface-notice-folderCreated = Le dossier { $name } a été créé.

interface-notice-folderCycle = Un dossier ne peut pas être déplacé dans lui-même ni dans l’un de ses sous-dossiers.

interface-notice-folderMoved = Dossier déplacé vers { $where }.

interface-notice-folderMovedNamed = { $name } a été déplacé.

interface-notice-hidden = { $name } a été masqué. Il reste dans le coffre-fort, dans Masqués.

interface-notice-imported =
    { $count ->
    [one] { $count } document chiffré et ajouté.
    *[other] { $count } documents chiffrés et ajoutés.
    [many] { $count } documents chiffrés et ajoutés.
    }

interface-notice-moved =
    { $count ->
    [one] { $count } document déplacé.
    *[other] { $count } documents déplacés.
    [many] { $count } documents déplacés.
    }

interface-notice-movedMany =
    { $count ->
    [one] { $count } document déplacé vers { $where }.
    *[other] { $count } documents déplacés vers { $where }.
    [many] { $count } documents déplacés vers { $where }.
    }

interface-notice-movedNamed = { $name } a été déplacé vers { $where }.

interface-notice-notPdf = { $name } n’est pas un document PDF; myCarlos ne l’a donc pas ajouté. Pour le moment, seuls les documents PDF peuvent être partagés avec myCarlos.

interface-notice-pdfUnlocked = Une copie déverrouillée a été ajoutée. L’original verrouillé s’appelle maintenant { $name }.

interface-notice-personAdded = Le profil { $name } a été ajouté.

interface-notice-photoSaved = La photo { $name } a été enregistrée dans myCarlos.

interface-notice-renamedDocument = Document renommé : { $name }.

interface-notice-renamedFolder = Dossier renommé : { $name }.

interface-notice-restored = { $name } a été remis à sa place d’origine.

interface-notice-sharedAdded =
    { $count ->
    [one] Un fichier partagé a été ajouté à Partagés avec moi.
    *[other] { $count } fichiers partagés ont été ajoutés à Partagés avec moi.
    [many] { $count } fichiers partagés ont été ajoutés à Partagés avec moi.
    }

interface-notice-whereFolder = { $person }, dossier { $folder }

interface-oldBackups-eachBackupYouSavedBeforeNowStill = Chaque sauvegarde enregistrée auparavant s’ouvre toujours avec votre ancienne clé ou la phrase secrète utilisée lors de son enregistrement. Conservez la trousse de l’ancienne clé en lieu sûr. Si vous la détruisez, ces sauvegardes ne pourront être ouvertes qu’avec leur phrase secrète. Les sauvegardes enregistrées à partir de maintenant s’ouvrent avec votre nouvelle clé.

interface-oldBackups-yourOldKitCouldStillOpenBackups = Votre ancienne trousse pourrait encore ouvrir des sauvegardes enregistrées auparavant. Dans Sécurité, enregistrez une nouvelle sauvegarde, puis supprimez les anciennes : la section Sécurité indique les étapes.

interface-oldBackups-yourOldKitCouldStillOpenBackupsAlternative = Votre ancienne trousse pourrait encore ouvrir des sauvegardes enregistrées auparavant, mais conservez-les pour le moment : ce coffre-fort ne peut pas enregistrer de nouvelle sauvegarde tant que vous n’avez pas suivi les instructions de l’avis « Les modifications sont suspendues » dans la bibliothèque. Enregistrez ensuite une nouvelle sauvegarde dans Sécurité et supprimez les anciennes.

interface-person-records = Documents de { $name }

interface-photo-checkYourComputersCameraPrivacySettingsAnd = Vérifiez les paramètres de confidentialité de la caméra de votre ordinateur et autorisez myCarlos à l’utiliser.

interface-photo-inSystemSettingsOpenPrivacySecurityThen = Dans Réglages système, ouvrez Confidentialité et sécurité, puis Caméra, et activez myCarlos.

interface-photo-inWindowsSettingsOpenPrivacySecurityThen = Dans les Paramètres Windows, ouvrez Confidentialité et sécurité, puis Caméra, et autorisez les applications de bureau à accéder à la caméra.

interface-photo-name = Photo, { $date }, { $time }.jpg

interface-photo-noCameraWasFoundConnectACamera = Aucune caméra détectée. Connectez une caméra, puis choisissez Réessayer.

interface-photo-openYourPhonesSettingsThenAppsThen = Ouvrez les Paramètres de votre téléphone, puis Applications, myCarlos et Autorisations, et autorisez l’appareil photo.

interface-photo-openYourPhonesSettingsThenMyCarlosAnd = Ouvrez les Réglages de votre téléphone, puis myCarlos, et activez l’appareil photo.

interface-photo-theCameraCouldNotBeStartedChoose = La caméra n’a pas pu démarrer. Choisissez Réessayer.

interface-photo-theCameraIsInUseByAnother = Une autre application utilise la caméra. Fermez-la, puis choisissez Réessayer.

interface-photo-theCameraStoppedCheckThatItIs = La caméra s’est arrêtée. Vérifiez qu’elle est connectée, puis choisissez Réessayer.

interface-photo-theCameraStoppedChooseTryAgain = La caméra s’est arrêtée. Choisissez Réessayer.

interface-photo-thisPhonesCameraCouldNotBeFound = L’appareil photo de ce téléphone est introuvable. Choisissez Réessayer.

interface-reader-opening = Ouverture de la page { $page }…

interface-reader-page = Page { $page }

interface-reader-textFollows = Page { $page } sur { $total }. Le texte de la page suit.

interface-reader-where = Page { $page } sur { $total }

interface-reader-zoom = { $percent }%

interface-receive-dropped =
    { $count ->
    [one] Un élément partagé n’a pas été reçu : myCarlos n’accepte que les fichiers PDF.
    *[other] { $count } éléments partagés n’ont pas été reçus : myCarlos n’accepte que les fichiers PDF.
    [many] { $count } éléments partagés n’ont pas été reçus : myCarlos n’accepte que les fichiers PDF.
    }

interface-receive-refused =
    { $count ->
    [one] Un partage n’a pas été reçu : pas plus de 100 fichiers partagés peuvent être en attente à la fois. Déverrouillez le coffre-fort pour que les fichiers en attente arrivent dans Partagés avec moi, puis partagez-les de nouveau.
    *[other] { $count } partages n’ont pas été reçus : pas plus de 100 fichiers partagés peuvent être en attente à la fois. Déverrouillez le coffre-fort pour que les fichiers en attente arrivent dans Partagés avec moi, puis partagez-les de nouveau.
    [many] { $count } partages n’ont pas été reçus : pas plus de 100 fichiers partagés peuvent être en attente à la fois. Déverrouillez le coffre-fort pour que les fichiers en attente arrivent dans Partagés avec moi, puis partagez-les de nouveau.
    }

interface-RecordDetails-closeDocumentDetails = Fermer les détails du document

interface-RecordDetails-encryptedDocument = Document chiffré

interface-RecordDetails-encryptedDocumentDetails = Détails du document chiffré

interface-RecordDetails-file = Fichier

interface-RecordDetails-folder = Dossier

interface-RecordDetails-hide = Masquer

interface-RecordDetails-itsEncryptedFileIsMissingFromThis = Son fichier chiffré est absent de cet appareil; aucune copie ne peut donc être enregistrée. Restaurer le dossier de données myCarlos à partir d’une sauvegarde pourrait le récupérer.

interface-RecordDetails-itsEncryptedFileIsMissingOrCould = Son fichier chiffré est manquant ou n’a pas pu être lu; aucune copie ne peut donc être enregistrée. Consultez l’avis dans la bibliothèque pour savoir quoi vérifier.

interface-RecordDetails-kind = Type

interface-RecordDetails-lockedWithAPasswordMyCarlosCannotOpen = Verrouillé par un mot de passe. myCarlos ne peut pas encore l’ouvrir sur cet appareil.

interface-RecordDetails-lockedWithAPasswordUnlockAddsA = Verrouillé par un mot de passe. Le déverrouillage ajoute une copie qui s’ouvre sans ce mot de passe et conserve celle-ci.

interface-RecordDetails-move = Déplacer

interface-RecordDetails-moveTo = Déplacer vers

interface-RecordDetails-read = Lire

interface-RecordDetails-saveACopyToThisComputer = Enregistrer une copie sur cet ordinateur

interface-RecordDetails-theFileStaysEncryptedInTheVault = Le fichier reste chiffré dans le coffre-fort. Enregistrez une copie seulement si vous avez besoin d’un fichier lisible en dehors de myCarlos.

interface-RecordDetails-thisDocumentIsDamaged = Ce document est endommagé.

interface-RecordDetails-thisDocumentIsUnavailable = Ce document est indisponible.

interface-RecordDetails-unlock = Déverrouiller…

interface-RecordDetails-viewPhoto = Voir la photo

interface-recordPresentation-imaging = Imagerie

interface-recordPresentation-prescription = Ordonnance

interface-recordPresentation-testResult = Résultat d’analyse

interface-recovery-earlierStopped = Votre ancienne clé de récupération n’ouvre plus ce coffre-fort. { $backups }

interface-recovery-replaced = Clé de récupération remplacée. L’ancienne clé n’ouvre plus ce coffre-fort. { $backups }

interface-recovery-savedBeforeLock = La clé de récupération qui vous a été montrée a été enregistrée juste avant le verrouillage du coffre-fort ou la fermeture de myCarlos. C’est donc maintenant votre clé de récupération : conservez ce que vous avez enregistré ou noté à son sujet.

interface-search-all = Rechercher partout dans { $location }

interface-SecuritySettings-evaluationBuild = Version d’évaluation


interface-SecuritySettings-myCarlosNeverDeletesADocumentHidingOne = myCarlos ne supprime jamais de document. Masquer un document le retire de l’affichage : il reste dans le coffre-fort chiffré, dans Masqués, et peut être restauré. Vous pouvez conserver ou supprimer les copies lisibles que vous enregistrez en dehors de myCarlos.

interface-SecuritySettings-releaseBuild = Version de distribution

interface-SecuritySettings-startingAgainOrRestoringABackupOver = Recommencer ou restaurer une sauvegarde à la place de ce coffre-fort met celui-ci de côté : il reste sur cet appareil, chiffré. myCarlos ne supprime jamais de coffre-fort.

interface-SecuritySettings-whatMyCarlosKeeps = Ce que myCarlos conserve

interface-sidebar-sharedNew = { $shared }, { $new }

interface-size-bytes =
    { $count ->
    [one] { $count } octet
    *[other] { $count } octets
    [many] { $count } octets
    }

interface-speed-median = Médiane : { $median } ms, durée maximale : { $max } ms.

interface-speed-parameters = Argon2id, { $memory } MiB, { $iterations } passes, { $lanes } voies.

interface-speed-platform = { $platform } { $architecture }, myCarlos { $version }.

interface-speed-runs =
    { $count ->
    [one] { $count } essai : { $samples } ms.
    *[other] { $count } essais : { $samples } ms.
    [many] { $count } essais : { $samples } ms.
    }

interface-speed-simulator = { $build }, simulateur.

interface-tab-withNew = { $section } ({ $new })

interface-unfinishedRecoveryKey-recoveryKeySetupEndedWhenTheVault = La configuration de la clé de récupération s’est arrêtée lorsque le coffre-fort s’est verrouillé ou que myCarlos s’est fermé. Le coffre-fort n’a donc toujours pas de clé de récupération. Si vous avez enregistré ou noté la clé affichée, détruisez-la : elle n’ouvre pas le coffre-fort.

interface-unfinishedRecoveryKey-yourRecoveryKeyWasNotReplacedSetup = Votre clé de récupération n’a pas été remplacée : la configuration s’est arrêtée lorsque le coffre-fort s’est verrouillé ou que myCarlos s’est fermé, et votre ancienne clé fonctionne toujours. Si vous avez enregistré ou noté la nouvelle clé affichée, détruisez-la : elle n’ouvre pas le coffre-fort.

interface-UnlockPdfDialog-thisDocumentIsLockedWithAPassword = Ce document est verrouillé par un mot de passe. Saisissez le mot de passe du document indiqué dans votre portail patient. myCarlos ajoute une copie qui s’ouvre sans ce mot de passe et conserve l’original verrouillé. Il ne conserve jamais le mot de passe.

interface-UnlockPdfDialog-unlocking = Déverrouillage…

interface-VaultApp-chooseFilesToImport = Choisir les fichiers à importer

interface-VaultApp-finishingTheTransfer = Fin du transfert

interface-VaultApp-lockNowAndCancelTheTransfer = Verrouiller maintenant et annuler le transfert

interface-VaultApp-myCarlosCouldNotLockTheVaultIts = myCarlos n’a pas pu verrouiller le coffre-fort. Son contenu est masqué, mais le coffre-fort est toujours ouvert.

interface-VaultApp-openingMyCarlos = Ouverture de myCarlos…

interface-VaultApp-tryLockingAgain = Réessayer le verrouillage

interface-VaultApp-vaultContentIsHiddenMyCarlosWillLock = Le contenu du coffre-fort est masqué. myCarlos se verrouillera dès la fin du transfert.

interface-VaultApp-vaultContentIsHiddenWhileMyCarlosFinishes = Le contenu du coffre-fort est masqué pendant que myCarlos termine le verrouillage…

interface-VaultLibrary-anotherVaultOperationIsStillRunningTry = Une autre opération est toujours en cours dans le coffre-fort. Réessayez lorsqu’elle sera terminée.

interface-VaultLibrary-changesArePaused = Les modifications sont suspendues.

interface-VaultLibrary-chooseAFolder = Choisir un dossier

interface-VaultLibrary-chooseRecordView = Choisir l’affichage des documents

interface-VaultLibrary-clear = Désélectionner

interface-VaultLibrary-create = Créer

interface-VaultLibrary-damagedFileMissing = Endommagé : fichier manquant

interface-VaultLibrary-destination = Destination

interface-VaultLibrary-documentMoved = Document déplacé.

interface-VaultLibrary-documentsToHide = Documents à masquer

interface-VaultLibrary-encryptedBackupSavedKeepItSomewhereOther = Sauvegarde chiffrée enregistrée. Conservez-la ailleurs que sur cet appareil.

interface-VaultLibrary-encryptedBackupSavedThisIsYourNew = Sauvegarde chiffrée enregistrée. C’est votre nouvelle sauvegarde : conservez-la, ou une copie, ailleurs que sur cet appareil. La section Sécurité indique maintenant quelles anciennes sauvegardes supprimer.

interface-VaultLibrary-everyFileIsBackOnThisDevice = Tous les fichiers sont de nouveau sur cet appareil. Aucun document n’a été masqué.

interface-VaultLibrary-filesAndRecordDetailsAreEncryptedAnd = Les fichiers et les détails des documents sont chiffrés et enregistrés sur cet appareil

interface-VaultLibrary-filesYouOpenWithMyCarlosArriveHere = Les fichiers que vous ouvrez avec myCarlos arrivent ici, chiffrés.

interface-VaultLibrary-filesYouShareToMyCarlosFromAnother = Les fichiers que vous partagez avec myCarlos depuis une autre application arrivent ici, chiffrés.

interface-VaultLibrary-fileUnavailable = Fichier indisponible

interface-VaultLibrary-firstCheckThatTheFilesAreNot = Vérifiez d’abord que les fichiers ne sont pas simplement inaccessibles : si le dossier de données myCarlos se trouve sur un lecteur déconnecté ou qu’un autre programme l’utilise, corrigez le problème, puis verrouillez et déverrouillez de nouveau. Si vous avez une sauvegarde du dossier de données, restaurez-la d’abord : tout fichier qui réapparaît est conservé.

interface-VaultLibrary-foldersStayWithTheirPersonMoveIndividual = Les dossiers restent associés à la même personne. Pour transférer des documents à une autre personne, déplacez-les individuellement.

interface-VaultLibrary-grid = Grille

interface-VaultLibrary-gridView = Affichage en grille

interface-VaultLibrary-hideDamagedDocuments = Masquer les documents endommagés

interface-VaultLibrary-holdAndDragADocumentOrFolder = Maintenez un document ou un dossier et faites-le glisser pour le déplacer, ou ouvrez-le et choisissez Déplacer vers.

interface-VaultLibrary-ifYouForgetYourPassphraseWithoutOne = Si vous oubliez votre phrase secrète sans clé de récupération, la seule façon de retrouver un accès est de mettre le coffre-fort de côté et de recommencer.

interface-VaultLibrary-insideFolder = Dans le dossier

interface-VaultLibrary-list = Liste

interface-VaultLibrary-listView = Affichage en liste

interface-VaultLibrary-moveAFolderWithTheKeyboard = Déplacer un dossier avec le clavier

interface-VaultLibrary-moveFolder = Déplacer le dossier

interface-VaultLibrary-moveSelectedTo = Déplacer la sélection vers

interface-VaultLibrary-moveThemIntoYourFoldersWheneverYou = Déplacez-les dans vos dossiers quand vous le souhaitez.

interface-VaultLibrary-moveTheSelectedDocuments = Déplacer les documents sélectionnés.

interface-VaultLibrary-myCarlosCouldNotSaveAChangeTo = myCarlos n’a pas pu enregistrer une modification sur cet ordinateur. Libérez de l’espace de stockage ou vérifiez le disque, puis verrouillez et déverrouillez de nouveau; le coffre-fort se répare lorsqu’il peut écrire.

interface-VaultLibrary-myCarlosEncryptedRecordLibrary = Bibliothèque de documents chiffrés myCarlos

interface-VaultLibrary-nameAZ = Nom de A à Z

interface-VaultLibrary-new = Nouveau

interface-VaultLibrary-newestFirst = Les plus récents d’abord

interface-VaultLibrary-newFolder = Nouveau dossier

interface-VaultLibrary-noFilesSelectedNothingChanged = Aucun fichier sélectionné. Rien n’a changé.

interface-VaultLibrary-noLocationChosenNothingChanged = Aucun emplacement choisi. Rien n’a changé.

interface-VaultLibrary-noRecoveryKeyYet = Aucune clé de récupération pour le moment.

interface-VaultLibrary-passphraseChanged = Phrase secrète modifiée.

interface-VaultLibrary-privateVault = Coffre-fort privé

interface-VaultLibrary-records = Documents

interface-VaultLibrary-recoveryKeySavedKeepYourKitSomewhere = Clé de récupération enregistrée. Conservez votre trousse en lieu sûr.

interface-VaultLibrary-recoveryKeySetupWasNotFinishedThe = La configuration de la clé de récupération n’a pas été terminée. La clé qui vous a été montrée n’ouvre pas le coffre-fort; votre ancienne clé fonctionne toujours. Détruisez toute trousse enregistrée ou imprimée à l’instant.

interface-VaultLibrary-recoveryKeySetupWasNotFinishedTheAlternative = La configuration de la clé de récupération n’a pas été terminée. La clé qui vous a été montrée n’ouvre pas le coffre-fort. Détruisez toute trousse enregistrée ou imprimée à l’instant.

interface-VaultLibrary-saveACopy = Enregistrer une copie

interface-VaultLibrary-saveAReadableCopy = Enregistrer une copie lisible?

interface-VaultLibrary-saveCancelledNothingChanged = Enregistrement annulé. Rien n’a changé.

interface-VaultLibrary-savingCreatesAReadableFileOutsideThe = L’enregistrement crée un fichier lisible en dehors du coffre-fort chiffré. myCarlos ne peut pas effacer cette copie par la suite, et masquer ce document ne la supprimera pas.

interface-VaultLibrary-searchSharedWithMe = Rechercher dans Partagés avec moi

interface-VaultLibrary-searchThisFolderAndItsSubfolders = Rechercher dans ce dossier et ses sous-dossiers

interface-VaultLibrary-section = Section

interface-VaultLibrary-someEncryptedFilesAreMissingFromThis = Certains fichiers chiffrés sont absents de cet appareil. Les documents indiqués comme endommagés ne peuvent être ni ouverts ni copiés; enregistrez dès maintenant des copies des autres documents. Pour pouvoir de nouveau modifier le coffre-fort, restaurez le dossier de données myCarlos à partir d’une sauvegarde ou masquez les documents endommagés.

interface-VaultLibrary-someOfTheVaultsFilesCouldNot = Certains fichiers du coffre-fort n’ont pas pu être lus et pourraient être plus récents ou intacts. Aucune modification n’est donc possible pour le moment, y compris celle de votre phrase secrète ou de votre clé de récupération. Vous pouvez toujours ouvrir vos documents et en enregistrer des copies, sauf ceux indiqués comme « Fichier indisponible ». Vérifiez que le lecteur contenant le dossier de données myCarlos est connecté, qu’aucun autre programme n’utilise ce dossier et qu’un outil de synchronisation infonuagique conserve ses fichiers sur cet appareil, puis verrouillez et déverrouillez de nouveau.

interface-VaultLibrary-sortBy = Trier par

interface-VaultLibrary-thatFolderIsNoLongerAvailable = Ce dossier n’est plus disponible.

interface-VaultLibrary-theirEncryptedFilesAreMissingFromThis = Leurs fichiers chiffrés sont absents de cet appareil. Les masquer permet au coffre-fort d’accepter de nouveau les modifications. Ils restent répertoriés dans Masqués, avec leurs noms et leurs détails, et tout document dont le fichier réapparaît peut être restauré.

interface-VaultLibrary-theVaultIsReadonlySoTheName = Le coffre-fort est en lecture seule; le nom n’a donc pas été modifié.

interface-VaultLibrary-theyAreInNoOnesRecordsUntil = Ils ne figurent dans les documents de personne tant que vous ne les déplacez pas vers la personne concernée.

interface-VaultLibrary-thisPhotoIsAlreadyInTheVault = Cette photo est déjà dans le coffre-fort; elle n’a donc pas été enregistrée de nouveau.

interface-VaultLibrary-topLevel = Niveau supérieur

interface-VaultLibrary-unlockedLockNow = Déverrouillé · Verrouiller maintenant

interface-VaultLibrary-working = Opération en cours…

kit-keep = Conservez-la dans un endroit privé, loin de l’appareil. Toute personne qui a cette clé et une copie de votre coffre-fort peut l’ouvrir. Si vous configurez une nouvelle clé de récupération, celle-ci n’ouvre plus le coffre-fort sur cet appareil.

kit-labelNote = L’étiquette n’est pas secrète. Dans Sécurité, myCarlos affiche l’étiquette de la clé de récupération qui fonctionne maintenant : une trousse avec une autre étiquette n’ouvre plus le coffre-fort.

kit-labelPrinted = Étiquette de la clé : { $label } · Imprimée le { $date }

kit-printed = Imprimée le { $date }

kit-title = Trousse de récupération myCarlos

kit-use = Si vous oubliez votre phrase secrète myCarlos, cette clé ouvre votre coffre-fort sur cet appareil et vous permet de choisir une nouvelle phrase secrète. Elle fonctionne une fois la vérification terminée dans myCarlos.

language-error-notRemembered = La langue a changé pour cette session, mais ce choix n’a pas pu être mémorisé sur cet appareil.

language-error-unreadable = La langue enregistrée n’a pas pu être lue. La langue de votre appareil est utilisée pour cette session.

language-help = Ce choix est mémorisé sur cet appareil. Vos documents restent dans leur langue d’origine.

language-system = Par défaut du système

language-title = Langue

library-column-added = Date d’ajout

library-column-name = Nom

library-column-source = Source

library-details = Détails

library-document-details = Détails de { $name }

library-document-label = Document { $name }

library-empty-help = Ajoutez un dossier ou importez un document ici.

library-empty-title = Cet emplacement est vide

library-folder-items =
    { $count ->
    [one] { $count } élément
    [many] { $count } d’éléments
    *[other] { $count } éléments
    }

library-folder-label = Dossier { $name }

library-folder-open = Ouvrir { $name }

library-folder-rename = Renommer le dossier { $name }

library-items =
    { $count ->
    [one] { $count } élément visible dans la bibliothèque
    [many] { $count } d’éléments visibles dans la bibliothèque
    *[other] { $count } éléments visibles dans la bibliothèque
    }

library-noMatch-help = Essayez une autre recherche.

library-noMatch-title = Aucun document correspondant

library-rename = Renommer

library-search-cleared = Recherche effacée. Dossiers à cet emplacement : { $folders }. Documents : { $documents }.

library-search-results = Résultats de la recherche. Dossiers : { $folders }. Documents : { $documents }.

library-select = Sélectionner { $name }

lockWarning-help = Pour le garder ouvert, appuyez sur { $keepOpen } ou sur n’importe quelle touche.

lockWarning-keepOpen = Garder ouvert

lockWarning-left =
    { $count ->
    [one] Il reste { $count } seconde.
    [many] Il reste { $count } de secondes.
    *[other] Il reste { $count } secondes.
    }

lockWarning-title =
    { $count ->
    [one] myCarlos se verrouillera dans { $count } seconde pour protéger vos documents.
    [many] myCarlos se verrouillera dans { $count } de secondes pour protéger vos documents.
    *[other] myCarlos se verrouillera dans { $count } secondes pour protéger vos documents.
    }

native-backup-noteEmptied = Le fichier à l’emplacement choisi peut être vide ou incomplet; si vous avez choisi de remplacer une ancienne sauvegarde, celle-ci a été vidée. Supprimez ce fichier, pas vos autres sauvegardes.

native-backup-noteUntouched = Un fichier vide (0 octet) peut rester à l’emplacement choisi; vous pouvez le supprimer. Conservez toute sauvegarde qui n’est pas vide.

native-cancel = Annuler

native-error-01 = myCarlos n’a pas pu lire certains de ses fichiers à l’instant; aucune sauvegarde n’a donc été enregistrée. Vos documents n’ont pas été modifiés. Conservez vos anciennes sauvegardes. Réessayez. Si le problème se reproduit, fermez myCarlos et ouvrez-le de nouveau; sur un ordinateur, vérifiez aussi que le lecteur est connecté et suspendez tout outil de synchronisation ou antivirus.

native-error-02 = L’espace est insuffisant à l’emplacement choisi. Aucune sauvegarde n’a été enregistrée. Conservez vos anciennes sauvegardes.

native-error-03 = La sauvegarde n’a pas pu être enregistrée à cet emplacement. Aucune sauvegarde n’a été enregistrée. Conservez vos anciennes sauvegardes.

native-error-04 = La sauvegarde s’est arrêtée parce que le coffre-fort s’est verrouillé. Aucune sauvegarde n’a été enregistrée. Conservez vos anciennes sauvegardes.

native-error-05 = Plusieurs tentatives incorrectes se sont succédé. Pour ralentir toute personne qui essaierait de deviner votre secret, myCarlos attend un peu avant la prochaine tentative : ce que vous avez saisi n’a pas été vérifié.

native-error-06 = La destination sélectionnée peut contenir une copie lisible partielle. Supprimez cette copie avant de réessayer.

native-error-07 = Cette clé de récupération n’ouvre pas cette sauvegarde. Une sauvegarde s’ouvre avec la clé de récupération que le coffre-fort avait lors de son enregistrement, s’il en avait une, et non avec une clé configurée ou remplacée depuis, ou avec la phrase secrète utilisée lors de sa création.

native-error-08 = Cette phrase secrète n’ouvre pas cette sauvegarde. Une sauvegarde s’ouvre avec la phrase secrète utilisée lors de sa création, et non avec une phrase modifiée depuis, ou avec la clé de récupération que le coffre-fort avait lors de son enregistrement, s’il en avait une.

native-error-09 = La photo n’est pas arrivée dans le coffre-fort; elle n’a donc pas été enregistrée. Choisissez Utiliser la photo pour réessayer.

native-error-10 = Aucun document n’a été masqué. Le coffre-fort ne peut pas être modifié pour le moment; l’avis au-dessus des documents explique pourquoi.

native-error-11 = Une vérification de phrase secrète ou un test de vitesse est en cours. Attendez qu’il se termine, puis réessayez.

native-error-12 = Un coffre-fort existe déjà sur cet appareil.

native-error-13 = Aucun coffre-fort n’existe sur cet appareil.

native-error-14 = Déverrouillez le coffre-fort pour continuer.

native-error-15 = Ce coffre-fort est ouvert dans une autre fenêtre myCarlos. Verrouillez ou fermez cette fenêtre, puis réessayez.

native-error-16 = Cette phrase secrète n’a pas ouvert myCarlos. Vérifiez la touche Verr. maj., puis réessayez.

native-error-17 = Le coffre-fort est endommagé ou incomplet. Aucune donnée n’a été modifiée.

native-error-18 = Cet élément n’est plus disponible.

native-error-19 = Une valeur saisie n’a pas été acceptée. Vérifiez-la, puis réessayez.

native-error-20 = Choisissez une phrase secrète moins prévisible, qui ne soit pas fondée sur des mots de passe courants, des noms ou myCarlos.

native-error-21 = Ne choisissez pas plus de 100 fichiers par importation.

native-error-22 = L’un des fichiers n’est pas un document PDF; aucun fichier n’a donc été ajouté. myCarlos ne conserve que les documents PDF.

native-error-23 = Ce document est verrouillé par un mot de passe. Saisissez le mot de passe du document indiqué dans votre portail patient.

native-error-24 = Ce document n’est pas verrouillé par un mot de passe; il s’ouvre donc tel quel.

native-error-25 = Une copie déverrouillée de ce document se trouve déjà ici; aucun document n’a donc été ajouté.

native-error-26 = Ce mot de passe n’a pas ouvert le document. Vérifiez le mot de passe du document dans votre portail patient, puis réessayez.

native-error-27 = myCarlos n’a pas pu ouvrir ce document verrouillé. Il est peut-être endommagé ou verrouillé d’une manière que myCarlos ne peut pas traiter. Le document n’a pas été modifié.

native-error-28 = myCarlos ne peut pas encore ouvrir les documents protégés par mot de passe sur cet appareil. Le document n’a pas été modifié.

native-error-29 = myCarlos ne peut pas ouvrir les documents verrouillés en toute sécurité sur ce système; ce document n’a donc pas été ouvert. Le document n’a pas été modifié.

native-error-30 = Ce document verrouillé dépasse 100 MB; myCarlos ne peut donc pas l’ouvrir. Le document n’a pas été modifié.

native-error-31 = myCarlos n’a pas pu afficher ce document. Il est peut-être endommagé ou utilise des fonctions que myCarlos ne peut pas encore afficher. Enregistrez une copie pour le lire dans une autre application.

native-error-32 = myCarlos ne peut pas encore afficher les documents sur cet appareil. Enregistrez une copie pour le lire dans une autre application.

native-error-33 = myCarlos ne peut pas afficher les documents en toute sécurité sur ce système. Enregistrez une copie pour le lire dans une autre application.

native-error-34 = L’espace de stockage est insuffisant pour terminer cette opération.

native-error-35 = myCarlos n’a pas pu lire ou écrire ses fichiers sur cet ordinateur. Vérifiez que le lecteur contenant myCarlos est connecté et dispose d’espace libre, puis réessayez. Si vous étiez en train de modifier quelque chose, vérifiez d’abord dans vos documents si la modification a été faite.

native-error-36 = L’opération s’est arrêtée parce que le coffre-fort a été verrouillé.

native-error-37 = myCarlos ne peut pas conserver un coffre-fort en toute sécurité sur le stockage de cet appareil, car celui-ci ne confirme pas que les fichiers sont écrits durablement, par exemple dans un dossier personnel sur le réseau. Utilisez myCarlos sur un appareil doté d’un stockage local.

native-error-38 = La liste des documents endommagés a changé. Aucun élément n’a été retiré. Vérifiez la liste, puis réessayez.

native-error-39 = myCarlos n’a pas pu lire certains de ses fichiers à l’instant. Vos documents n’ont été ni modifiés ni supprimés; ne mettez donc pas le coffre-fort de côté. Vérifiez ce que vous avez saisi, puis réessayez. Si le problème se reproduit, fermez myCarlos et ouvrez-le de nouveau; sur un ordinateur, vérifiez aussi que le lecteur est connecté et suspendez tout outil de synchronisation ou antivirus.

native-error-40 = Le coffre-fort est en mode de récupération en lecture seule. Exportez les documents importants et libérez de l’espace de stockage avant de réessayer.

native-error-41 = Cela ne correspond pas à la clé de récupération. Vérifiez chaque groupe de caractères, puis réessayez.

native-error-42 = Le fichier de sauvegarde ou le coffre-fort de cet appareil a changé depuis que vous avez choisi de restaurer. Rien n’a été modifié sur cet appareil. Choisissez de nouveau le fichier de sauvegarde.

native-error-43 = Ce fichier n’est pas une sauvegarde myCarlos complète, ou il a été modifié après son enregistrement. Rien n’a été modifié sur cet appareil.

native-error-44 = Cette clé de récupération n’ouvre pas ce coffre-fort. Si vous avez remplacé votre clé de récupération, utilisez la plus récente.

native-error-45 = myCarlos n’a pas pu ouvrir ce fichier. S’il se trouve dans un dossier infonuagique ou partagé, copiez-le dans un dossier sur cet appareil et choisissez-le à cet endroit. Rien n’a été modifié sur cet appareil.

native-error-46 = Un document du coffre-fort est endommagé et ne peut plus être lu; aucune sauvegarde n’a donc été enregistrée. Rien n’a été modifié.

native-error-47 = Cette photo ne peut pas être enregistrée ou affichée par myCarlos : il doit s’agir d’une image JPEG complète d’au plus 25 MB et de 8 192 pixels par côté. Rien n’a été modifié.

native-error-48 = La sauvegarde a été vérifiée, mais la restauration n’est pas terminée. Fermez myCarlos et ouvrez-le de nouveau pour terminer. Ouvrez ensuite le coffre-fort avec la phrase secrète ou la clé de récupération de la sauvegarde.

native-error-speedTest = Le test de vitesse s’est arrêté avant la fin. Rien n’a été modifié. Réessayez.

native-filter-backups = Sauvegardes myCarlos

native-filter-pdf = Documents PDF

native-kit-text =
    Trousse de récupération myCarlos

    Clé de récupération : { $key }
    Étiquette de la clé : { $label } (non secrète : elle sert à distinguer les trousses)
    Enregistrée le : { $date } (UTC)

    À quoi sert cette clé
    Si vous oubliez votre phrase secrète myCarlos, cette clé ouvre le coffre-fort sur cet appareil et vous permet de choisir une nouvelle phrase secrète. Elle fonctionne une fois que vous avez terminé la vérification dans myCarlos qui suit l’enregistrement de cette trousse.

    Gardez-la en lieu sûr
    - Conservez cette trousse dans un endroit privé, loin de l’appareil, par exemple imprimée avec vos documents importants. Toute personne qui possède cette clé et une copie de votre coffre-fort peut l’ouvrir.
    - Si vous configurez une nouvelle clé de récupération, la clé de cette trousse n’ouvre plus le coffre-fort de cet appareil.
    - Ni votre clinique ni les créateurs de myCarlos ne peuvent ouvrir votre coffre-fort pour vous.


native-recovery-keep = Conserver la clé actuelle

native-recovery-replace = Remplacer la clé

native-recovery-title = Remplacer votre clé de récupération?

native-recovery-warning = Votre clé de récupération actuelle cessera de fonctionner dès que la nouvelle sera enregistrée : une trousse enregistrée ou imprimée pour l’ancienne clé n’ouvrira plus ce coffre-fort. Les sauvegardes enregistrées auparavant s’ouvrent toujours avec la phrase secrète ou la clé de récupération utilisée lors de leur enregistrement, y compris la clé actuelle; myCarlos vous indiquera ensuite quoi en faire. Avant de continuer, assurez-vous d’avoir noté ou enregistré la nouvelle clé. Si vous n’avez pas demandé à remplacer votre clé de récupération, choisissez Conserver la clé actuelle.

native-reset-phrase = RÉINITIALISER LE COFFRE-FORT MYCARLOS

native-restore-changed = Le coffre-fort de cet appareil n’est peut-être pas identique à cette sauvegarde ({ $documents }) : il peut avoir changé depuis, ou une partie n’a pas pu être lue. La restauration le met de côté et le remplace par la sauvegarde : tout ce qui ne figure pas dans la sauvegarde ne se trouve plus dans le coffre-fort que vous utilisez, et la phrase secrète ainsi que la clé de récupération deviennent celles de la sauvegarde. { $kept }

native-restore-other = Le coffre-fort de cet appareil n’est pas celui dont provient cette sauvegarde. La restauration met le coffre-fort de cet appareil de côté et le remplace par la sauvegarde ({ $documents }). { $kept }

native-restore-replace = Remplacer par la sauvegarde

native-restore-same = La restauration met le coffre-fort de cet appareil de côté et le remplace par la sauvegarde, qui contient les mêmes documents ({ $documents }). { $kept }

native-restore-title = Remplacer le coffre-fort de cet appareil?

native-restore-unreadable = Le coffre-fort de cet appareil n’a pas pu être lu. myCarlos ne peut donc pas savoir s’il s’agit de celui dont provient cette sauvegarde. La restauration met le coffre-fort de cet appareil de côté et le remplace par la sauvegarde ({ $documents }). { $kept }

native-setAside-confirm = Le mettre de côté

native-setAside-desktop = Pour supprimer un coffre-fort mis de côté et libérer son espace, fermez myCarlos et supprimez son dossier dans { $folder }.

native-setAside-kept = Le coffre-fort mis de côté reste sur cet appareil, chiffré, avec tout son contenu. Sa phrase secrète ou sa clé de récupération l’ouvre toujours, mais myCarlos ne peut pas encore l’ouvrir de nouveau pour vous.

native-setAside-mobile = Sur ce téléphone, les coffres-forts mis de côté restent dans le stockage privé de myCarlos, qui ne peut pas les supprimer. La seule façon de le faire est d’effacer les données de myCarlos dans les réglages du téléphone ou de désinstaller l’application, ce qui supprime tous les coffres-forts du téléphone.

native-setAside-title = Mettre ce coffre-fort myCarlos de côté et recommencer?

native-setAside-warning = Cela met tout le coffre-fort de côté et recommence avec un coffre-fort vide. { $kept } myCarlos ne le supprime jamais. Si vous recommencez parce qu’une autre personne pourrait connaître votre phrase secrète, elle peut toujours ouvrir le coffre-fort mis de côté; supprimez donc celui-ci. { $removal }

native-vault-keep = Conserver ce coffre-fort

notice-autoLockSet =
    { $count ->
    [one] Verrouillage automatique réglé à { $count } minute.
    [many] Verrouillage automatique réglé à { $count } de minutes.
    *[other] Verrouillage automatique réglé à { $count } minutes.
    }

notice-backupCutOff = La sauvegarde s’est arrêtée parce que le coffre-fort s’est verrouillé. Aucune sauvegarde n’a été enregistrée. Conservez vos sauvegardes plus anciennes. { $note }

notice-created = Coffre-fort chiffré créé. Configurez une clé de récupération pour qu’un oubli de votre phrase secrète ne vous prive pas définitivement de vos documents.

notice-createdThenLocked = Votre coffre-fort a été créé, puis verrouillé avant que sa clé de récupération puisse être créée. Déverrouillez-le pour en configurer une.

notice-dropRefused = Pour importer des PDF, déverrouillez votre coffre-fort et utilisez { $button }. Le glisser-déposer déplace les documents déjà dans myCarlos.

notice-eraseCancelled = Rien n’a changé : le coffre-fort n’a pas été mis de côté.

notice-iosKeepOpen = Gardez myCarlos ouvert : changer d’application met ce transfert en pause.

notice-locked = Coffre-fort verrouillé.

notice-lockedHidden = Verrouillé parce que myCarlos a été réduit ou envoyé en arrière-plan.

notice-lockedIdle =
    { $count ->
    [one] Verrouillé après { $count } minute sans utilisation.
    [many] Verrouillé après { $count } de minutes sans utilisation.
    *[other] Verrouillé après { $count } minutes sans utilisation.
    }

notice-recovered = Coffre-fort ouvert avec votre clé de récupération. Utilisez désormais votre nouvelle phrase secrète.

notice-recoveredReadOnly = Coffre-fort ouvert en lecture seule avec votre clé de récupération, et votre phrase secrète n’a pas changé. Consultez l’avis dans la bibliothèque pour savoir quoi faire.

notice-restored = Sauvegarde restaurée. Déverrouillez le coffre-fort avec la phrase secrète utilisée lors de sa création, ou utilisez sa clé de récupération.

notice-transferUnfinished = Le transfert n’a pas abouti.

notice-unlocked = Coffre-fort déverrouillé.

notice-unlockedRecovery = Coffre-fort déverrouillé en mode de récupération, en lecture seule. Consultez l’avis dans la bibliothèque pour savoir quoi faire.

passphrase-confirm-label = Confirmer la phrase secrète

passphrase-confirmNew-label = Confirmer la nouvelle phrase secrète

passphrase-label = Phrase secrète

passphrase-longerThanAny = Ce texte est plus long que n’importe quelle phrase secrète du coffre-fort. Vérifiez ce que vous avez saisi.

passphrase-mismatch = Les phrases secrètes ne correspondent pas.

passphrase-new-label = Nouvelle phrase secrète

passphrase-rules = Utilisez au moins { $min } caractères. Les espaces sont permis; les mots de passe courants, les noms et les suites prévisibles sont refusés sur cet appareil.

passphrase-show = Afficher la phrase secrète

passphrase-show-inConfirm = dans Confirmer la phrase secrète

passphrase-tooLong = Cette phrase secrète est trop longue. Raccourcissez-la.

passphrase-tooShort = Cette phrase secrète est trop courte. Utilisez au moins { $min } caractères.

photo-alt = Photo : { $name }

photo-area = Photo. Agrandissez pour voir les détails ; faites glisser ou défilez pour vous déplacer.

photo-close = Fermer

photo-eyebrow = Photo

photo-fitted = Ajustée à la fenêtre.

photo-zoomed = Agrandie à { $percent } %.

photo-zoomIn = Agrandir

photo-zoomOut = Réduire

preferences-subtitle = L’apparence de myCarlos sur cet ordinateur

record-kind-document = Document

record-source-manual = Importation manuelle — non vérifiée

recover-intro = Utilisez votre clé de récupération pour ouvrir le coffre-fort et choisir une nouvelle phrase secrète.

recover-key-format = 28 lettres et chiffres, en 7 groupes de 4, comme sur votre trousse ou tels que vous les avez notés. Les tirets, les espaces et les autres signes de ponctuation n’ont pas d’importance.

recover-key-label = Clé de récupération

recover-key-show = Afficher la clé de récupération

recover-submit = Ouvrir avec la clé de récupération

recoveryKey-about-offered = Votre coffre-fort est ouvert. Il n’a pas encore de clé de récupération. Sans clé, si vous oubliez votre phrase secrète, la seule façon de revenir est de mettre le coffre-fort de côté et de recommencer.

recoveryKey-about-replacing = Votre clé de récupération actuelle cessera de fonctionner une fois la nouvelle vérifiée.

recoveryKey-about-type = Saisissez votre phrase secrète pour créer votre clé de récupération. Elle s’affiche ensuite : choisissez Continuer seulement quand personne d’autre ne peut voir votre écran.

recoveryKey-about-typeAgain = Saisissez de nouveau votre phrase secrète pour créer votre clé de récupération. Elle s’affiche ensuite : choisissez Continuer seulement quand personne d’autre ne peut voir votre écran.

recoveryKey-about-typeAgainNew = Saisissez de nouveau votre phrase secrète pour créer votre nouvelle clé de récupération. Elle s’affiche ensuite : choisissez Continuer seulement quand personne d’autre ne peut voir votre écran.

recoveryKey-about-typeNew = Saisissez votre phrase secrète pour créer votre nouvelle clé de récupération. Elle s’affiche ensuite : choisissez Continuer seulement quand personne d’autre ne peut voir votre écran.

recoveryKey-about-what = Une clé de récupération ouvre votre coffre-fort si vous oubliez votre phrase secrète. Vous serez la seule personne à l’avoir : personne à votre clinique ni chez myCarlos ne peut ouvrir votre coffre-fort à votre place.

recoveryKey-back = Retour : relire votre clé de récupération

recoveryKey-check-hint = Saisissez votre clé de récupération en entier, telle que vous l’avez notée ou enregistrée : 7 groupes de 4 lettres et chiffres. Les tirets, les espaces et les autres signes de ponctuation n’ont pas d’importance.

recoveryKey-check-label = Votre clé de récupération

recoveryKey-checkAndSave = Vérifier et enregistrer

recoveryKey-chooseReason = Indiquez pourquoi vous remplacez votre clé de récupération.

recoveryKey-continue = Continuer

recoveryKey-discard-body = Cette clé de récupération n’est pas encore configurée : elle n’ouvrira donc jamais le coffre-fort. myCarlos verrouille maintenant le coffre-fort. Après l’avoir déverrouillé, vous pourrez configurer une nouvelle clé.

recoveryKey-discard-confirm = Abandonner la clé et verrouiller

recoveryKey-discard-title = Abandonner cette clé de récupération?

recoveryKey-group = Groupe { $number } : { $characters }

recoveryKey-hiddenWhileSaving = Masquée pendant l’enregistrement de la trousse.

recoveryKey-instructions = Notez-la, ou enregistrez ou imprimez la trousse, et conservez-la dans un endroit privé, loin de cet appareil. C’est la seule fois que myCarlos l’affiche. Ensuite, vous la saisirez en entier pour la vérifier. Restez dans myCarlos jusqu’à la fin de la vérification : quitter ou verrouiller annule cette clé.

recoveryKey-keyboardHint = La touche Échap quitte cette configuration. Lors de la première configuration, une confirmation est demandée, car quitter verrouille le coffre-fort et une clé inachevée ne fonctionnera pas.

recoveryKey-kitSaved = Trousse de récupération enregistrée. La clé fonctionnera une fois la vérification terminée.

recoveryKey-label = Étiquette de la clé : { $label }. Notez-la à côté de la clé. Elle n’est pas secrète : dans Sécurité, myCarlos affiche l’étiquette de la clé qui fonctionne, pour que vous sachiez quelle trousse est la bonne.

recoveryKey-leave-offered = Configurer plus tard

recoveryKey-leave-required = Verrouiller le coffre-fort et terminer plus tard

recoveryKey-next = Suivant : vérifier votre clé de récupération

recoveryKey-notChanged = Votre clé de récupération n’a pas été changée. Votre clé actuelle fonctionne toujours. Pour la changer, appuyez de nouveau sur Vérifier et enregistrer.

recoveryKey-printKit = Imprimer la trousse de récupération

recoveryKey-printUnavailable = L’impression n’est pas offerte ici. Enregistrez la trousse ou notez la clé.

recoveryKey-reason-exposed = Sa trousse ou sa note a peut-être été perdue ou vue par quelqu’un d’autre

recoveryKey-reason-hint = En cas de doute, choisissez la première réponse.

recoveryKey-reason-legend = Pourquoi la remplacez-vous?

recoveryKey-reason-routine = Je veux seulement une nouvelle clé : sa trousse est en lieu sûr

recoveryKey-saveKit = Enregistrer la trousse de récupération…

recoveryKey-threeMisses = La clé ne correspondait pas, trois fois de suite. Relisez votre clé de récupération, puis vérifiez-la.

recoveryKey-title-check = Vérifier votre clé de récupération

recoveryKey-title-key = Votre clé de récupération

recoveryKey-title-replace = Remplacer votre clé de récupération

recoveryKey-title-setUp = Configurer une clé de récupération

recoveryKey-typedCount =
    { $count ->
    [one] Vous avez saisi { $count } lettre ou chiffre. Votre clé de récupération compte { $total } lettres et chiffres : 7 groupes de 4. Vérifiez ce que vous avez noté.
    [many] Vous avez saisi { $count } de lettres et chiffres. Votre clé de récupération compte { $total } lettres et chiffres : 7 groupes de 4. Vérifiez ce que vous avez noté.
    *[other] Vous avez saisi { $count } lettres et chiffres. Votre clé de récupération compte { $total } lettres et chiffres : 7 groupes de 4. Vérifiez ce que vous avez noté.
    }

rename-gainsExtension = Le nom de ce document n’a pas l’extension .pdf; il ne peut donc pas se terminer par .pdf.

rename-help-document = Cela change le nom dans myCarlos et le nom proposé à l’exportation.

rename-help-documentExtension = Cela change le nom dans myCarlos et le nom proposé à l’exportation. L’extension { $extension } reste la même.

rename-help-folder = Le dossier et son contenu restent au même endroit.

rename-label-document = Nom du fichier

rename-label-folder = Nom du dossier

rename-reserved = « { $word } » ne peut pas servir de nom de document, car Windows le réserve à son propre usage. Choisissez un autre nom.

rename-save = Enregistrer le nom

rename-saving = Enregistrement…

rename-stemMissing = Saisissez un nom avant { $extension }.

rename-title-document = Renommer le document

rename-title-folder = Renommer le dossier

rename-tooLong = Ce nom est trop long. Raccourcissez-le pour l’enregistrer.

rename-unsafe = Le nom d’un document ne peut pas contenir { $characters } ni de caractères de contrôle invisibles, ni se terminer par un point.

reset-plainly = Mettre le coffre-fort de côté retire de myCarlos sur cet ordinateur tous vos documents, dossiers et profils de patients. Ils restent sur cet ordinateur, chiffrés. Ce coffre-fort peut toujours être ouvert avec sa phrase secrète d’origine ou sa clé de récupération correspondante. Créer un nouveau coffre-fort ne change pas ces identifiants. Pour confirmer, saisissez exactement les mots ci-dessous.

reset-submit = Mettre le coffre-fort de côté

reset-type = Saisissez { $phrase }

restore-agree-erase = Mettre de côté le coffre-fort de cet appareil et restaurer la sauvegarde

restore-agree-replace = Mettre de côté le coffre-fort de cet appareil, avec ce qui a changé depuis, et restaurer cette sauvegarde

restore-cancelled = Restauration annulée. Rien n’a changé.

restore-check = Vérifier la sauvegarde

restore-checked =
    { $count ->
    [one] La sauvegarde contient { $count } document. { $consequence }
    [many] La sauvegarde contient { $count } de documents. { $consequence }
    *[other] La sauvegarde contient { $count } documents. { $consequence }
    }

restore-checking = Vérification de la sauvegarde…

restore-choose = Choisir le fichier de sauvegarde…

restore-chooseOther = Choisir une autre sauvegarde…

restore-chosen = Sauvegarde choisie.

restore-consequence-differs = Le coffre-fort de cet appareil pourrait ne pas être identique à cette sauvegarde : il a peut-être changé depuis, ou une partie n’a pas pu être lue. La restauration met le coffre-fort de côté et met la sauvegarde à sa place : ce qui n’est pas dans la sauvegarde n’est plus dans le coffre-fort que vous utilisez, et la phrase secrète et la clé de récupération deviennent celles qui étaient en vigueur lors de la sauvegarde. Le coffre-fort mis de côté reste sur cet appareil, chiffré, mais myCarlos ne peut pas encore le rouvrir pour vous.

restore-consequence-nothing = La restauration place ce coffre-fort sur cet appareil.

restore-consequence-otherVault = Cet appareil contient un autre coffre-fort. La restauration le met de côté et met la sauvegarde à sa place. Le coffre-fort mis de côté reste sur cet appareil, chiffré, mais myCarlos ne peut pas encore le rouvrir pour vous.

restore-consequence-same = Le coffre-fort de cet appareil contient les mêmes documents. La restauration le met de côté et met cette sauvegarde à sa place. Le coffre-fort mis de côté reste sur cet appareil, chiffré, mais myCarlos ne peut pas encore le rouvrir pour vous.

restore-consequence-unreadable = Le coffre-fort de cet appareil n’a pas pu être lu ; myCarlos ne peut donc pas savoir s’il s’agit de celui dont cette sauvegarde provient. La restauration le met de côté et met la sauvegarde à sa place. Le coffre-fort mis de côté reste sur cet appareil, chiffré, mais myCarlos ne peut pas encore le rouvrir pour vous.

restore-intro = Une sauvegarde chiffrée s’ouvre avec la phrase secrète utilisée lors de sa création, ou avec la clé de récupération que possédait le coffre-fort au moment de la sauvegarde, le cas échéant.

restore-method-passphrase = Sa phrase secrète

restore-method-recoveryKey = Sa clé de récupération

restore-openWith = L’ouvrir avec

restore-passphrase-label = Phrase secrète de la sauvegarde

restore-passphrase-show = Afficher la phrase secrète

restore-restoring = Restauration de la sauvegarde en cours. Cela peut prendre du temps pour un gros coffre-fort…

restore-submit = Restaurer la sauvegarde

restore-summary = Restaurer à partir d’une sauvegarde

restore-tooLong = Ce texte est trop long. Vérifiez ce que vous avez saisi.

secret-count-password =
    { $count ->
    [one] Phrase secrète de { $count } caractère
    [many] Phrase secrète de { $count } de caractères
    *[other] Phrase secrète de { $count } caractères
    }

secret-count-recoveryKey =
    { $count ->
    [one] Clé de récupération de { $count } caractère
    [many] Clé de récupération de { $count } de caractères
    *[other] Clé de récupération de { $count } caractères
    }

secret-count-shown = { $description }, affichée

security-autoLock-body = Le coffre-fort se verrouille après la période choisie sans activité du clavier, du pointeur ou de l’écran tactile. Choisissez une durée de 1 à 15 minutes.

security-autoLock-label = Délai de verrouillage automatique

security-autoLock-longer = Délai plus long

security-autoLock-minutes =
    { $count ->
    [one] { $count } minute
    [many] { $count } de minutes
    *[other] { $count } minutes
    }

security-autoLock-shorter = Délai plus court

security-autoLock-title = Verrouillage automatique

security-backup-body = Un seul fichier qui contient tout votre coffre-fort, toujours chiffré. Conservez-le ailleurs que sur cet appareil, par exemple sur une clé USB. Il s’ouvre avec la phrase secrète ou la clé de récupération que vous avez au moment de l’enregistrer, et continue de s’ouvrir avec elles même après que vous les avez changées ici. Pour en restaurer un, verrouillez le coffre-fort et choisissez Restaurer à partir d’une sauvegarde.

security-backup-save = Enregistrer une sauvegarde chiffrée…

security-backup-title = Sauvegarde chiffrée

security-copies-body = Les exportations et les captures d’écran ne sont plus protégées par le coffre-fort. Masquer un document dans myCarlos n’efface ni ces copies ni le dossier médical d’origine de la clinique.

security-copies-title = Copies lisibles et captures d’écran

security-devBuild-body = Utilisez uniquement des fichiers fictifs.

security-devBuild-title = Version de développement.

security-encryption-body = Les fichiers, les noms, les dossiers et les détails des documents sont chiffrés sur cet appareil.

security-encryption-state = Activé — toujours

security-encryption-title = Chiffrement

security-erase-body = Supprime définitivement tous les documents, profils et dossiers chiffrés. Cette action est irréversible.

security-erase-show = Afficher les commandes d’effacement

security-erase-submit = Effacer tout le coffre-fort

security-erase-title = Effacer tout le coffre-fort

security-lockNow = Verrouiller maintenant

security-oldBackups-deleteOlder = Supprimez les anciennes sauvegardes : les fichiers dont le nom commence par « myCarlos backup », et celles que vous avez renommées, sauf la nouvelle et ses copies. Elles se trouvent là où vous les avez enregistrées : un dossier, une clé USB ou, sur un téléphone, l’application Fichiers ou un espace de stockage en nuage.

security-oldBackups-done = J’ai terminé avec les anciennes sauvegardes

security-oldBackups-inPlace = Si vous l’avez enregistrée à la place d’une ancienne sauvegarde, ce fichier est maintenant votre nouvelle sauvegarde : conservez-le.

security-oldBackups-intro = La trousse d’une ancienne clé de récupération a peut-être été perdue ou vue, et elle ouvre encore les sauvegardes enregistrées avant le remplacement de cette clé.

security-oldBackups-justSaved = Votre nouvelle sauvegarde est celle que vous venez d’enregistrer, le { $date } vers { $time } : votre application de fichiers indique quand chaque fichier a été enregistré, ainsi que sa taille.

security-oldBackups-justSavedWithSize = Votre nouvelle sauvegarde est celle que vous venez d’enregistrer, le { $date } vers { $time } ({ $size }) : votre application de fichiers indique quand chaque fichier a été enregistré, ainsi que sa taille.

security-oldBackups-keepCopy = Conservez-la, ou une copie, ailleurs que sur cet appareil, par exemple sur une clé USB ou dans un espace de stockage en nuage.

security-oldBackups-named = Votre nouvelle sauvegarde est « { $name } ».

security-oldBackups-namedWithSize = Votre nouvelle sauvegarde est « { $name } » ({ $size }).

security-oldBackups-none = Je n’ai pas d’anciennes sauvegardes

security-oldBackups-saveNow = Enregistrez une nouvelle sauvegarde maintenant : choisissez Enregistrer une sauvegarde chiffrée.

security-oldBackups-saveWhenWritable = Dès que le coffre-fort accepte de nouveau les modifications, enregistrez une nouvelle sauvegarde : choisissez Enregistrer une sauvegarde chiffrée.

security-oldBackups-thenDelete = Supprimez ensuite les anciennes sauvegardes. Une fois la nouvelle enregistrée, cette section vous indique comment faire.

security-oldBackups-title = Vos anciennes sauvegardes

security-passphrase-copies = Changer de phrase secrète bloque une personne qui ne connaît que l’ancienne. Si elle a peut-être aussi une copie de votre coffre-fort, comme une sauvegarde de cet appareil ou un fichier de sauvegarde enregistré, une nouvelle phrase secrète ne suffit pas : l’ancienne ouvre toujours cette copie, et avec cette copie, elle pourrait ouvrir une copie plus récente obtenue plus tard. Pour la tenir à l’écart, il faut un nouveau coffre-fort, et veiller à ne perdre aucun document en chemin. Demandez de l’aide avant de mettre votre coffre-fort de côté.

security-passphrase-current = Phrase secrète actuelle

security-passphrase-currentTooLong = La phrase secrète actuelle est plus longue que n’importe quelle phrase secrète de coffre-fort. Vérifiez ce que vous avez saisi.

security-passphrase-mismatch = Les nouvelles phrases secrètes ne correspondent pas.

security-passphrase-newTooLong = La nouvelle phrase secrète est trop longue. Raccourcissez-la.

security-passphrase-newTooShort = La nouvelle phrase secrète est trop courte. Utilisez au moins { $min } caractères.

security-passphrase-rules = Utilisez au moins { $min } caractères et évitez les noms courants et les phrases prévisibles. Votre clé de récupération, si vous en avez une, continue de fonctionner; sans clé, oublier la nouvelle phrase secrète oblige à mettre le coffre-fort de côté et à recommencer.

security-passphrase-submit = Changer de phrase secrète

security-passphrase-title = Changer de phrase secrète

security-profiles-add = Ajouter le profil

security-profiles-body = Gardez séparés les documents de chaque personne dans ce coffre-fort.

security-profiles-label = Nom du nouveau profil

security-profiles-title = Profils de patient

security-recoveryKey-body = Ouvre votre coffre-fort si vous oubliez votre phrase secrète. Vous êtes la seule personne à l’avoir : personne à votre clinique ni chez myCarlos ne peut ouvrir votre coffre-fort à votre place. La remplacer met fin à l’ancienne.

security-recoveryKey-current = Votre clé actuelle porte l’étiquette { $label }. La trousse ou la note qui porte cette étiquette est celle qui fonctionne; une autre étiquette n’ouvre pas ce coffre-fort. Les trousses et les notes faites avant l’affichage des étiquettes n’en ont pas : une trousse sans étiquette peut tout de même être cette clé, configurée le { $date }.

security-recoveryKey-notSetUp = Non configurée

security-recoveryKey-replace = Remplacer la clé de récupération

security-recoveryKey-setUp = Configurer une clé de récupération

security-recoveryKey-setUpOn = Configurée le { $date }

security-recoveryKey-title = Clé de récupération

security-speed-body = Mesure le temps que prend cet appareil pour vérifier une phrase secrète. Le test utilise une phrase secrète inventée, pas la vôtre, et ne change rien. Il dure quelques secondes, plus longtemps sur un téléphone plus ancien. Fermez d’abord les autres applications et restez sur cet écran jusqu’à la fin. Envoyez le résultat avec la marque et le modèle de l’appareil.

security-speed-measuring = Mesure en cours…

security-speed-run = Lancer le test de vitesse

security-speed-title = Test de vitesse, pour les testeurs

security-subtitle = Votre coffre-fort chiffré et vos paramètres d’accès

security-title = Sécurité

sidebar-documents =
    { $count ->
    [one] { $count } document
    [many] { $count } de documents
    *[other] { $count } documents
    }

sidebar-folderCount =
    { $count ->
    [one] { $count } dossier
    [many] { $count } de dossiers
    *[other] { $count } dossiers
    }

sidebar-label = Bibliothèque de documents

sidebar-myRecords = Mes documents

sidebar-preferences = Préférences

sidebar-settings = Paramètres

sidebar-storage = Coffre-fort local chiffré

textSize-announce = Taille du texte { $percent }

textSize-between = { $typed } % se situe entre deux tailles; la taille choisie est donc { $size }.

textSize-box = Taille du texte en pourcentage

textSize-followsDevice = Ici, la taille du texte suit votre appareil : son propre réglage de taille du texte, ou le zoom du navigateur.

textSize-help = Agrandit ou réduit tout le contenu de myCarlos, de { $min } % à { $max } %. myCarlos retient la taille sur cet ordinateur. Vous pouvez aussi maintenir la touche { $modifier } enfoncée et appuyer sur plus, moins ou 0.

textSize-key-command = Commande

textSize-larger = Texte plus grand

textSize-largest = La plus grande taille est de { $max } %.

textSize-notNumber = Saisissez un nombre de { $min } à { $max }.

textSize-reset = Revenir à la taille normale

textSize-smaller = Texte plus petit

textSize-smallest = La plus petite taille est de { $min } %.

textSize-title = Taille du texte

unlock-autoLock =
    { $count ->
    [one] Le coffre-fort se verrouille après { $count } minute d’inactivité et chaque fois que myCarlos est masqué, par exemple réduit ou envoyé en arrière-plan.
    [many] Le coffre-fort se verrouille après { $count } de minutes d’inactivité et chaque fois que myCarlos est masqué, par exemple réduit ou envoyé en arrière-plan.
    *[other] Le coffre-fort se verrouille après { $count } minutes d’inactivité et chaque fois que myCarlos est masqué, par exemple réduit ou envoyé en arrière-plan.
    }

unlock-forgot-summary = Vous avez oublié votre phrase secrète ?

unlock-noKey-body = Sans clé, la seule façon de revenir est de mettre ce coffre-fort de côté et de recommencer. Le coffre-fort mis de côté reste sur cet appareil, chiffré. Sa phrase secrète d’origine ou sa clé de récupération correspondante est nécessaire pour l’ouvrir.

unlock-noKey-heading = Pas de clé de récupération ?

unlock-submit = Déverrouiller

unlock-title = Déverrouiller votre coffre-fort

unlock-waiting =
    { $count ->
    [one] { $count } fichier partagé est en attente. Déverrouillez le coffre-fort et il ira dans « { $folder } ». Si myCarlos se ferme avant, il ne sera pas conservé : partagez-le de nouveau.
    [many] { $count } fichiers partagés sont en attente. Déverrouillez le coffre-fort et ils iront dans « { $folder } ». Si myCarlos se ferme avant, ils ne seront pas conservés : partagez-les de nouveau.
    *[other] { $count } fichiers partagés sont en attente. Déverrouillez le coffre-fort et ils iront dans « { $folder } ». Si myCarlos se ferme avant, ils ne seront pas conservés : partagez-les de nouveau.
    }

unlock-waiting-one = Un fichier partagé est en attente. Déverrouillez le coffre-fort et il ira dans « { $folder } ». Si myCarlos se ferme avant, il ne sera pas conservé : partagez-le de nouveau.

language-error-formatting = myCarlos n’a pas pu afficher ce message correctement. Choisissez une autre langue ou redémarrez l’application, puis vérifiez vos dossiers avant de réessayer.

error-newerFormat-backup = Cette sauvegarde a été enregistrée par une version plus récente de myCarlos. Mettez myCarlos à jour pour la restaurer. Rien n’a été modifié sur cet appareil.

error-newerFormat-vault = Ce coffre-fort a été enregistré par une version plus récente de myCarlos. Mettez myCarlos à jour pour l’ouvrir. Rien n’a été modifié.

personDetails-birthDate = Date de naissance

personDetails-birthDateRequired = Saisissez la date de naissance ou indiquez que vous ne la connaissez pas.

personDetails-birthDateUnknown = Je ne connais pas la date de naissance de cette personne

personDetails-cancel = Annuler

personDetails-edit = Modifier les renseignements

personDetails-editFor = Modifier les renseignements pour { $name }

personDetails-for = Renseignements pour { $name }

personDetails-fullName = Nom complet, comme sur les documents de la clinique

personDetails-fullNameRequired = Saisissez le nom complet de la personne.

personDetails-futureDate = La date de naissance ne peut pas être dans le futur.

personDetails-help = Conservés dans ce coffre chiffré pour suggérer à qui un document partagé est destiné. Ces renseignements ne vérifient pas la source d'un document.

personDetails-invalidDate = Saisissez une date de naissance valide : année, mois et jour.

personDetails-list = Renseignements des personnes

personDetails-nameTooLong = Ce nom complet est trop long. Raccourcissez-le.

personDetails-noDate = Aucune date de naissance

personDetails-noName = Aucun nom complet

personDetails-save = Enregistrer les renseignements

personDetails-saved = Renseignements pour { $name } enregistrés.

personSuggestion-byBoth = la date de naissance et le nom sur le document correspondent

personSuggestion-byDate = la date de naissance sur le document correspond

personSuggestion-byName = le nom sur le document correspond

personSuggestion-dismiss = Pas cette personne

personSuggestion-dismissLabel = Pas cette personne : { $document }

personSuggestion-for = Personne suggérée pour { $document }

personSuggestion-move = Déplacer

personSuggestion-moveLabel = Déplacer { $document } dans les dossiers de { $name }

personSuggestion-offer = Ce document semble être destiné à { $name } ({ $why }). Le déplacer dans ses dossiers ?

portal-address = Adresse HTTPS du portail

portal-approvalCancelled = Cette demande d’approbation a été annulée. Vérifiez les mises à jour avant de créer une nouvelle demande.

portal-approvalContact = L’approbation de la clinique doit être vérifiée. Contactez votre clinique pour connaître les prochaines étapes.

portal-approvalExpired = Cette demande d’approbation a expiré. Vérifiez les mises à jour avant de créer une nouvelle demande.

portal-approvalMissing = Votre demande d’approbation enregistrée est introuvable sur le portail. Renvoyez la demande enregistrée.

portal-approvalRefused = La clinique a refusé cette demande d’approbation de l’appareil. Contactez votre clinique pour connaître les prochaines étapes.

portal-approved = La clinique a approuvé cet appareil.

portal-awaiting = Demande d’approbation enregistrée. Vérifiez les mises à jour ou renvoyez-la.

portal-check = Rechercher de nouveaux documents

portal-clinicIssue = { $clinic } : { $detail }

portal-code = Code d’association

portal-compare = Demandez au personnel de la clinique de comparer cette empreinte entière sur cet écran avant d’approuver cet appareil.

portal-confirmationsPending = Documents enregistrés en attente de confirmation de réception : { $count }. Vérifiez à nouveau pour terminer la confirmation. Vos copies enregistrées restent dans le coffre.

portal-copied = Code de l’appareil copié.

portal-copy = Copier le code de l’appareil

portal-copyFailed = Sélectionnez le code entier de l’appareil et copiez-le.

portal-dateNotRecorded = Date non consignée

portal-deviceCode = Code de l’appareil

portal-deviceName = Nom de cet appareil

portal-errorAddress = Saisissez l’adresse HTTPS du portail sans nom d’utilisateur, mot de passe, paramètres de requête ni fragment.

portal-errorCancelled = L’association s’est arrêtée parce que le coffre-fort s’est verrouillé. Consultez les appareils associés dans le portail avant de réessayer.

portal-errorCode = Saisissez le code d’association complet affiché dans votre portail patient.

portal-errorCodeRejected = Le portail a refusé ce code. Créez un nouveau code d’association dans votre portail patient.

portal-errorDamaged = Un document enregistré de cette clinique est endommagé ou manquant. Son accusé de réception n’a donc pas été envoyé. La recherche de vos autres documents s’est poursuivie. Restaurez-le à partir d’une sauvegarde ou demandez à la clinique de vous le renvoyer.

portal-errorDeviceName = Choisissez un nom d’appareil de 1 à 64 caractères sans caractères de contrôle.

portal-errorDisabled = L’association au portail n’est pas activée dans cette version.

portal-errorExists = Cet appareil est déjà enregistré. Consultez les appareils associés dans votre portail patient.

portal-errorIncomplete = La demande au portail n’a pas abouti. Vérifiez votre connexion et l’horloge de l’appareil, puis réessayez.

portal-errorKeys = La clinique n’a pas encore publié de clé de signature. L’association est incomplète.

portal-errorRefused = Un document de la clinique n’a pas pu être vérifié. Il n’a pas été ajouté et aucun accusé de réception n’a été envoyé.

portal-errorUnavailable = L’association au portail n’est pas encore disponible sur cet appareil.

portal-fingerprint = Empreinte complète de l’appareil

portal-incomplete = Association incomplète. Consultez les appareils associés dans le portail avant de réessayer.

portal-intro = Associez myCarlos avec l’adresse et le code affichés dans votre portail patient.

portal-link = Associer à la clinique

portal-matchPerson = Utiliser les renseignements du document

portal-notRequested = Demandez l’approbation de la clinique pour recevoir des documents sur cet appareil.

portal-partialResult = Certaines vérifications auprès des cliniques nécessitent votre attention. Nouveaux documents enregistrés : { $added }. Documents non vérifiés : { $refused }.

portal-person = Dossiers de quelle personne

portal-requestApproval = Demander l’approbation de la clinique

portal-restartApproval = Créer une nouvelle demande d’approbation

portal-result = Nouveaux documents enregistrés : { $added }. Documents non vérifiés : { $refused }.

portal-routing = Les documents sont classés sous la personne dont le nom complet et la date de naissance correspondent. Les autres vont dans Partagés avec moi.

portal-serviceDate = Date du service : { $date }

portal-serviceDateLabel = Date du service

portal-sourceVerified = De { $clinic } · Vérifié

portal-title = Documents de la clinique

rename-help-profile = Cela change uniquement le nom affiché du dossier. Les dossiers et les documents de la personne restent à leur place.

rename-label-profile = Nom du dossier

rename-profile-action = Renommer « { $name } »

rename-profile-controls = Les noms ne peuvent pas contenir de caractères de contrôle.

rename-profile-saved = Le dossier s’appelle maintenant { $name }.

rename-title-profile = Renommer le dossier de la personne

hidden-backToSecurity = Retour à la sécurité

interface-history-appVersion = Version de myCarlos

interface-history-damaged = Une partie de cet historique est endommagée. Les événements après le { $date } ne peuvent pas être vérifiés et ne s’affichent pas.

interface-history-damagedAll = Une partie de cet historique est endommagée. Ses événements ne peuvent pas être vérifiés, donc aucun ne s’affiche.

interface-history-damagedBefore = Une partie de cet historique est endommagée. Les événements avant le { $date } ne peuvent pas être vérifiés et ne s’affichent pas.

interface-history-damagedBetween = Une partie de cet historique est endommagée. Les événements entre le { $from } et le { $to } ne peuvent pas être vérifiés et ne s’affichent pas.

interface-history-empty = Aucun événement dans l’historique.

interface-history-error-unverified = L’historique n’a pas pu être lu et vérifié. Aucun événement ne s’affiche.

interface-history-event-backupRestored = Sauvegarde restaurée

interface-history-event-backupSaved = Sauvegarde chiffrée enregistrée

interface-history-event-copySaved = Copie lisible enregistrée

interface-history-event-created = Coffre créé

interface-history-event-folderCreated = Dossier créé

interface-history-event-folderMoved = Dossier déplacé

interface-history-event-folderRenamed = Dossier renommé

interface-history-event-hidden = Document masqué

interface-history-event-historyStarted = Historique commencé

interface-history-event-imported = Document ajouté

interface-history-event-moved = Document déplacé

interface-history-event-passphraseChanged = Phrase secrète modifiée

interface-history-event-profileCreated = Profil patient ajouté

interface-history-event-recoveryKeySet = Clé de récupération configurée

interface-history-event-renamed = Document renommé

interface-history-event-restored = Document restauré

interface-history-event-setAside = Coffre mis de côté

interface-history-event-unlocked = Coffre ouvert

interface-history-events =
    { $count ->
    [one] { $count } événement
    [many] { $count } événements
    *[other] { $count } événements
    }

interface-history-from = Depuis

interface-history-gap = Les événements à cet endroit ne peuvent pas être vérifiés et ne s’affichent pas.

interface-history-how = Méthode

interface-history-how-camera = Ajouté avec l’appareil photo

interface-history-how-damaged = Masqué car le fichier était absent

interface-history-how-importedShared = Ajouté à Partagé avec moi

interface-history-how-movedFromShared = Déplacé depuis Partagé avec moi

interface-history-how-passphrase = Phrase secrète

interface-history-how-patient = Masqué par vous

interface-history-how-picked = Importé depuis un fichier choisi

interface-history-how-recoveryKey = Clé de récupération

interface-history-how-replaced = Restauré en remplaçant un coffre existant

interface-history-intro = Liste en lecture seule des événements enregistrés dans votre coffre chiffré.

interface-history-laterSessionNotRecorded = Au moins une session ultérieure n’a pas été enregistrée.

interface-history-loading = Vérification et lecture de tout l’historique…

interface-history-moreFolders =
    { $count ->
    [one] { $count } dossier supplémentaire
    [many] { $count } dossiers supplémentaires
    *[other] { $count } dossiers supplémentaires
    }

interface-history-name = Nom

interface-history-personRootFolder = Premier niveau d’une personne

interface-history-place = Emplacement

interface-history-previousName = Nom précédent

interface-history-previousSession = Session précédente

interface-history-rootFolder = Premier niveau (emplacement non enregistré)

interface-history-scopeNote = Certaines entrées n’identifient pas la personne ou ne distinguent pas les dossiers portant le même nom. Les libellés des dossiers sont les noms enregistrés, pas des chemins complets. Les emplacements de sauvegarde peuvent être abrégés.

interface-history-sessionLockedAutomatically = Verrouillé automatiquement le { $date }

interface-history-sessionLockedByApp = Verrouillé par l’application le { $date }

interface-history-sessionLockedByPerson = Verrouillé par vous le { $date }

interface-history-sessionNotRecorded = La session précédente n’a pas été enregistrée.

interface-history-title = Historique des événements

interface-history-to = Vers

interface-SecuritySettings-myCarlosAlsoKeepsAHistoryWhenThe = myCarlos conserve aussi un historique : les ouvertures du coffre-fort; la définition ou la modification de sa phrase secrète ou de sa clé de récupération, ainsi que l’enregistrement ou la restauration d’une sauvegarde; l’ajout de chaque profil patient et la création, le changement de nom ou le déplacement de chaque dossier; l’ajout, le changement de nom, le déplacement, le masquage ou la restauration de chaque document, ainsi que son enregistrement en dehors de myCarlos et l’emplacement choisi. Cet historique est chiffré avec le reste. Vous pouvez le consulter ici ; myCarlos ne le modifie et ne le supprime jamais.
