appearance-dark = Ciemny

appearance-error-notRemembered = Wygląd zmieniono na tę sesję, ale nie udało się go zapamiętać na tym urządzeniu.

appearance-error-unreadable = Nie udało się odczytać zapisanego wyglądu. W tej sesji używana jest opcja „{ $system }”.

appearance-error-window = Wygląd okna nie mógł dostosować się do tego wyboru. Można dalej korzystać z myCarlos.

appearance-help = Opcja „{ $system }” dopasowuje się do jasnego lub ciemnego wyglądu urządzenia. Wysoki kontrast używa czarnego tła i jasnego tekstu. Kolory kontrastu ustawione na urządzeniu zawsze mają pierwszeństwo.

appearance-highContrast = Wysoki kontrast

appearance-light = Jasny

appearance-system = Systemowy

appearance-title = Wygląd

auth-kicker = Prywatne dokumenty myCarlos

box-currentPassphrase = obecne hasło główne

box-folderName = nazwę folderu

box-name = nazwę

box-newPassphrase = nowe hasło główne

box-passphrase = hasło główne

box-profileName = nazwę profilu

box-recoveryKey = klucz odzyskiwania

box-typedWords = wpisane słowa

checklist-allMet = Hasło główne spełnia wszystkie zasady.

checklist-done = , spełnione

checklist-hardToGuess = Trudne do odgadnięcia

checklist-heading = Hasło główne musi być:

checklist-length = Długie na co najmniej { $min } znaków

checklist-notAName = Inne niż imię i nazwisko

checklist-notYet = , jeszcze nie

checklist-spaces = Spacje są dozwolone, więc kilka niezwiązanych ze sobą słów to dobre hasło główne. myCarlos sprawdza te zasady na tym komputerze.

comfort-autoLock-body = myCarlos blokuje się sam, gdy nie jest używany przez ten czas, aby nikt inny nie zobaczył dokumentów. Proszę wybrać od 1 do 15 minut.

comfort-continue = Dalej

comfort-intro = Przed konfiguracją proszę wybrać to, co najbardziej odpowiada. Każdy wybór działa od razu.

comfort-later = Można je zmienić w każdej chwili w sekcji „{ $settings }”: „{ $textSize }” w części „{ $preferences }”, a „{ $autoLock }” w części „{ $security }”.

comfort-sample = Tak wygląda tekst w myCarlos. Proszę naciskać − lub +, aż będzie łatwy do przeczytania.

comfort-title = Dostosuj myCarlos do siebie

comfort-usual = Użyj zwykłych ustawień

common-cancel = Anuluj

create-intro = Pliki i szczegóły dokumentów są szyfrowane na tym urządzeniu. Hasło główne otwiera sejf. Następnie można skonfigurować klucz odzyskiwania na wypadek zapomnienia hasła głównego.

create-profile-label = Czyje dokumenty będą tu przechowywane?

create-profile-sharedTaken = „{ $folder }” to miejsce, do którego trafiają udostępnione pliki. Proszę wybrać inną nazwę.

create-profile-tooLong = Ta nazwa jest zbyt długa. Proszę ją skrócić.

create-stays = Sejf pozostaje na tym urządzeniu. Jeśli został utworzony na innym urządzeniu, nadal tam jest i nie pojawi się tutaj.

create-submit = Utwórz sejf

create-title = Skonfiguruj myCarlos na tym komputerze

error-checkBoxes = Proszę sprawdzić { $boxes }, a potem spróbować ponownie.

error-damaged = Nie zapisano kopii zapasowej: dokument „{ $name }” ({ $where }) jest uszkodzony i nie da się go już odczytać, a kopii, która go zawiera, nie dałoby się przywrócić. Nic nie zostało zmienione. Proszę zachować wcześniejsze kopie zapasowe. Przed ponowną próbą proszę poprosić o pomoc w odzyskaniu tego dokumentu z nieuszkodzonej kopii lub kopii zapasowej.

error-damaged-where = dodany { $date }

error-damaged-whereFor = dodany { $date }, w dokumentach osoby { $person }

error-fallback = Nie udało się wykonać operacji na sejfie.

error-retryIn =
    { $count ->
    [one] Proszę spróbować ponownie za { $count } sekundę.
    [few] Proszę spróbować ponownie za { $count } sekundy.
    [many] Proszę spróbować ponownie za { $count } sekund.
    *[other] Proszę spróbować ponownie za { $count } sekundy.
    }

frame-banner-body = Nie należy używać prawdziwych danych pacjentów

frame-banner-title = Wersja deweloperska z danymi fikcyjnymi

frame-state-locked = Zablokowany

frame-state-locking = Blokowanie

frame-state-notLocked = Odblokowany

frame-state-opening = Otwieranie

frame-state-settingUp = Konfiguracja

frame-window-label = Prywatny sejf myCarlos

interface-camera-denied = myCarlos nie może używać aparatu. { $help } Następnie wybierz Spróbuj ponownie.

interface-CameraDialog-cameraReady = Aparat gotowy.

interface-CameraDialog-cameraView = Podgląd aparatu

interface-CameraDialog-myCarlosUsesTheCameraToSavePhotos = myCarlos używa aparatu do zapisywania zdjęć dokumentów dotyczących zdrowia. Zdjęcia pozostają zabezpieczone w myCarlos.

interface-CameraDialog-photoTakenRetakeOrUseThePhoto = Zdjęcie zrobione. Zrób je ponownie lub użyj tego zdjęcia.

interface-CameraDialog-retake = Zrób ponownie

interface-CameraDialog-startingTheCamera = Uruchamianie aparatu…

interface-CameraDialog-takeAPhoto = Zrób zdjęcie

interface-CameraDialog-takePhoto = Zrób zdjęcie

interface-CameraDialog-theCameraIsOnOnlyWhileYou = Aparat działa tylko podczas robienia zdjęcia. Wyłącza się po zrobieniu zdjęcia, zamknięciu tego okna lub zablokowaniu myCarlos.

interface-CameraDialog-thePhotoCouldNotBePreparedChoose = Nie udało się przygotować zdjęcia. Wybierz Zrób ponownie.

interface-CameraDialog-thePhotoYouTook = Zrobione zdjęcie

interface-CameraDialog-tryAgain = Spróbuj ponownie

interface-CameraDialog-usePhoto = Użyj zdjęcia

interface-CameraDialog-useTheCamera = Użyj aparatu

interface-CameraDialog-yourPhoneAsksOnceWhetherMyCarlosMay = Telefon pyta jeden raz, czy myCarlos może używać aparatu. Aparat działa tylko podczas robienia zdjęcia. Wyłącza się po zrobieniu zdjęcia, anulowaniu lub zablokowaniu myCarlos.

interface-count-documents =
    { $count ->
    [one] { $count } dokument
    [few] { $count } dokumenty
    [many] { $count } dokumentów
    *[other] { $count } dokumentu
    }

interface-count-folders =
    { $count ->
    [one] { $count } folder
    [few] { $count } foldery
    [many] { $count } folderów
    *[other] { $count } folderu
    }

interface-count-found = Znaleziono: { $items }

interface-count-foundInLocation = Znaleziono: { $folders } · { $documents }

interface-count-hidden =
    { $count ->
    [one] { $count } ukryty dokument
    [few] { $count } ukryte dokumenty
    [many] { $count } ukrytych dokumentów
    *[other] { $count } ukrytego dokumentu
    }

interface-count-inLocation = { $folders } · { $documents } w tym miejscu

interface-count-new =
    { $count ->
    [one] { $count } nowy
    [few] { $count } nowe
    [many] { $count } nowych
    *[other] { $count } nowego
    }

interface-count-selected =
    { $count ->
    [one] { $count } wybrany
    [few] { $count } wybrane
    [many] { $count } wybranych
    *[other] { $count } wybranego
    }

interface-DocumentReader-documentPassword = Hasło dokumentu

interface-DocumentReader-fitWidth = Dopasuj do szerokości

interface-DocumentReader-larger = Powiększ

interface-DocumentReader-nextPage = Następna strona

interface-DocumentReader-noTextCouldBeReadOnThis = Nie udało się odczytać tekstu na tej stronie. To może być skan.

interface-DocumentReader-open = Otwórz

interface-DocumentReader-previousPage = Poprzednia strona

interface-DocumentReader-smaller = Pomniejsz

interface-DocumentReader-textOnThisPage = Tekst na tej stronie

interface-DocumentReader-thatPasswordDidNotOpenTheDocument = To hasło nie otworzyło dokumentu. Proszę sprawdzić je w portalu pacjenta i spróbować ponownie.

interface-DocumentReader-thisDocumentIsLockedWithItsOwn = Ten dokument jest zabezpieczony własnym hasłem. Proszę wpisać hasło dokumentu z portalu pacjenta. Nie będzie przechowywane po zamknięciu dokumentu.

interface-hidden-fileBack = Plik jest z powrotem dostępny

interface-hidden-fileMissing = Uszkodzony: brak pliku

interface-hidden-record = { $name }, ukryty

interface-hidden-restore = Przywróć { $name }

interface-HiddenDocuments-documentsYouHideAreListedHere = Tutaj znajdują się dokumenty, które zostały ukryte.

interface-HiddenDocuments-hidden = Ukryte

interface-HiddenDocuments-hiddenDocumentsStayInYourEncryptedVault = Ukryte dokumenty pozostają w zaszyfrowanym sejfie: myCarlos nigdy nie usuwa dokumentów. Przywrócenie dokumentu umieszcza go z powrotem tam, gdzie był.

interface-HiddenDocuments-nothingIsHidden = Nie ma ukrytych dokumentów

interface-HiddenDocuments-restore = Przywróć

interface-HiddenDocuments-wasIn = Poprzednie miejsce

interface-hideDamaged-title =
    { $count ->
    [one] Ukryć { $count } uszkodzony dokument?
    [few] Ukryć { $count } uszkodzone dokumenty?
    [many] Ukryć { $count } uszkodzonych dokumentów?
    *[other] Ukryć { $count } uszkodzonego dokumentu?
    }

interface-inLocation = W { $location }

interface-LibraryItems-in = W

interface-LibrarySidebar-sharedWithMe = Udostępnione mi

interface-notice-alreadyFiled = { $name } był już w dokumentach osoby { $person }, więc pozostał w { $source }.

interface-notice-alreadyShared = { $name } był już w sekcji Udostępnione mi.

interface-notice-changesResumed = { $outcome } W sejfie znów można wprowadzać zmiany.

interface-notice-copySaved = Zapisano czytelną kopię na tym komputerze.

interface-notice-damagedHidden =
    { $count ->
    [one] Ukryto { $count } uszkodzony dokument. Znajduje się w sekcji Ukryte.
    [few] Ukryto { $count } uszkodzone dokumenty. Znajdują się w sekcji Ukryte.
    [many] Ukryto { $count } uszkodzonych dokumentów. Znajdują się w sekcji Ukryte.
    *[other] Ukryto { $count } uszkodzonego dokumentu. Znajdują się w sekcji Ukryte.
    }

interface-notice-duplicates =
    { $count ->
    [one] Pominięto { $count } duplikat.
    [few] Pominięto { $count } duplikaty.
    [many] Pominięto { $count } duplikatów.
    *[other] Pominięto { $count } duplikatu.
    }

interface-notice-folderCreated = Utworzono { $name }.

interface-notice-folderCycle = Nie można przenieść folderu do niego samego ani do jego podfolderów.

interface-notice-folderMoved = Przeniesiono folder do { $where }.

interface-notice-folderMovedNamed = Przeniesiono { $name }.

interface-notice-hidden = Ukryto { $name }. Dokument pozostaje w sejfie w sekcji Ukryte.

interface-notice-imported =
    { $count ->
    [one] Zaszyfrowano i dodano { $count } dokument.
    [few] Zaszyfrowano i dodano { $count } dokumenty.
    [many] Zaszyfrowano i dodano { $count } dokumentów.
    *[other] Zaszyfrowano i dodano { $count } dokumentu.
    }

interface-notice-moved =
    { $count ->
    [one] Przeniesiono { $count } dokument.
    [few] Przeniesiono { $count } dokumenty.
    [many] Przeniesiono { $count } dokumentów.
    *[other] Przeniesiono { $count } dokumentu.
    }

interface-notice-movedMany =
    { $count ->
    [one] Przeniesiono { $count } dokument do { $where }.
    [few] Przeniesiono { $count } dokumenty do { $where }.
    [many] Przeniesiono { $count } dokumentów do { $where }.
    *[other] Przeniesiono { $count } dokumentu do { $where }.
    }

interface-notice-movedNamed = Przeniesiono { $name } do { $where }.

interface-notice-notPdf = { $name } nie jest dokumentem PDF, więc myCarlos go nie dodał. Na razie do myCarlos można udostępniać tylko dokumenty PDF.

interface-notice-pdfUnlocked = Dodano odblokowaną kopię. Zabezpieczony oryginał nosi teraz nazwę { $name }.

interface-notice-personAdded = Dodano { $name }.

interface-notice-photoSaved = Zapisano { $name } w myCarlos.

interface-notice-renamedDocument = Zmieniono nazwę dokumentu na { $name }.

interface-notice-renamedFolder = Zmieniono nazwę folderu na { $name }.

interface-notice-restored = Przywrócono { $name } do poprzedniego miejsca.

interface-notice-sharedAdded =
    { $count ->
    [one] Dodano udostępniony plik do sekcji Udostępnione mi.
    [few] Dodano { $count } udostępnione pliki do sekcji Udostępnione mi.
    [many] Dodano { $count } udostępnionych plików do sekcji Udostępnione mi.
    *[other] Dodano { $count } udostępnionego pliku do sekcji Udostępnione mi.
    }

interface-notice-whereFolder = { $person }, folder { $folder }

interface-oldBackups-eachBackupYouSavedBeforeNowStill = Każda wcześniej zapisana kopia zapasowa nadal otwiera się starym kluczem lub hasłem głównym użytym przy jej zapisaniu. Proszę bezpiecznie przechowywać zestaw starego klucza. Po jego zniszczeniu te kopie zapasowe można otworzyć tylko hasłem głównym. Kopie zapasowe zapisane od teraz otwierają się nowym kluczem.

interface-oldBackups-yourOldKitCouldStillOpenBackups = Stary zestaw nadal może otwierać wcześniej zapisane kopie zapasowe. Proszę zapisać nową kopię zapasową w sekcji Bezpieczeństwo, a następnie usunąć starsze: sekcja Bezpieczeństwo pokazuje kolejne kroki.

interface-oldBackups-yourOldKitCouldStillOpenBackupsAlternative = Stary zestaw nadal może otwierać wcześniej zapisane kopie zapasowe, ale na razie proszę je zachować: w tym sejfie nie można zapisać nowej kopii zapasowej, dopóki nie zostaną wykonane zalecenia z komunikatu „Wprowadzanie zmian jest wstrzymane” w bibliotece. Następnie proszę zapisać nową kopię zapasową w sekcji Bezpieczeństwo i usunąć starsze.

interface-person-records = Dokumenty osoby { $name }

interface-photo-checkYourComputersCameraPrivacySettingsAnd = Proszę sprawdzić ustawienia prywatności aparatu na komputerze i zezwolić myCarlos na jego używanie.

interface-photo-inSystemSettingsOpenPrivacySecurityThen = W Ustawieniach systemowych proszę otworzyć Prywatność i ochrona, następnie Aparat i włączyć myCarlos.

interface-photo-inWindowsSettingsOpenPrivacySecurityThen = W Ustawieniach systemu Windows proszę otworzyć Prywatność i zabezpieczenia, następnie Aparat i włączyć dostęp do aparatu dla aplikacji klasycznych.

interface-photo-name = Zdjęcie, { $date }, { $time }.jpg

interface-photo-noCameraWasFoundConnectACamera = Nie znaleziono aparatu. Proszę podłączyć aparat, a następnie wybrać Spróbuj ponownie.

interface-photo-openYourPhonesSettingsThenAppsThen = Proszę otworzyć Ustawienia telefonu, następnie Aplikacje, myCarlos, Uprawnienia i zezwolić na używanie aparatu.

interface-photo-openYourPhonesSettingsThenMyCarlosAnd = Proszę otworzyć Ustawienia telefonu, następnie myCarlos i włączyć Aparat.

interface-photo-theCameraCouldNotBeStartedChoose = Nie udało się uruchomić aparatu. Wybierz Spróbuj ponownie.

interface-photo-theCameraIsInUseByAnother = Inna aplikacja używa aparatu. Proszę ją zamknąć, a następnie wybrać Spróbuj ponownie.

interface-photo-theCameraStoppedCheckThatItIs = Aparat przestał działać. Proszę sprawdzić, czy jest podłączony, a następnie wybrać Spróbuj ponownie.

interface-photo-theCameraStoppedChooseTryAgain = Aparat przestał działać. Wybierz Spróbuj ponownie.

interface-photo-thisPhonesCameraCouldNotBeFound = Nie znaleziono aparatu tego telefonu. Wybierz Spróbuj ponownie.

interface-reader-opening = Otwieranie strony { $page }…

interface-reader-page = Strona { $page }

interface-reader-textFollows = Strona { $page } z { $total }. Poniżej znajduje się tekst strony.

interface-reader-where = Strona { $page } z { $total }

interface-reader-zoom = { $percent }%

interface-receive-dropped =
    { $count ->
    [one] Nie odebrano jednego udostępnionego elementu: myCarlos przyjmuje tylko pliki PDF.
    [few] Nie odebrano { $count } udostępnionych elementów: myCarlos przyjmuje tylko pliki PDF.
    [many] Nie odebrano { $count } udostępnionych elementów: myCarlos przyjmuje tylko pliki PDF.
    *[other] Nie odebrano { $count } udostępnionego elementu: myCarlos przyjmuje tylko pliki PDF.
    }

interface-receive-refused =
    { $count ->
    [one] Nie odebrano udostępnienia: jednocześnie może oczekiwać najwyżej 100 udostępnionych plików. Proszę odblokować sejf, aby oczekujące pliki trafiły do sekcji Udostępnione mi, a następnie udostępnić ponownie.
    [few] Nie odebrano { $count } udostępnień: jednocześnie może oczekiwać najwyżej 100 udostępnionych plików. Proszę odblokować sejf, aby oczekujące pliki trafiły do sekcji Udostępnione mi, a następnie udostępnić ponownie.
    [many] Nie odebrano { $count } udostępnień: jednocześnie może oczekiwać najwyżej 100 udostępnionych plików. Proszę odblokować sejf, aby oczekujące pliki trafiły do sekcji Udostępnione mi, a następnie udostępnić ponownie.
    *[other] Nie odebrano { $count } udostępnienia: jednocześnie może oczekiwać najwyżej 100 udostępnionych plików. Proszę odblokować sejf, aby oczekujące pliki trafiły do sekcji Udostępnione mi, a następnie udostępnić ponownie.
    }

interface-RecordDetails-closeDocumentDetails = Zamknij szczegóły dokumentu

interface-RecordDetails-encryptedDocument = Zaszyfrowany dokument

interface-RecordDetails-encryptedDocumentDetails = Szczegóły zaszyfrowanego dokumentu

interface-RecordDetails-file = Plik

interface-RecordDetails-folder = Folder

interface-RecordDetails-hide = Ukryj

interface-RecordDetails-itsEncryptedFileIsMissingFromThis = Na tym urządzeniu brakuje jego zaszyfrowanego pliku, więc nie można zapisać kopii. Przywrócenie folderu danych myCarlos z kopii zapasowej może go odzyskać.

interface-RecordDetails-itsEncryptedFileIsMissingOrCould = Brakuje jego zaszyfrowanego pliku lub nie udało się go odczytać, więc nie można zapisać kopii. Komunikat w bibliotece wyjaśnia, co sprawdzić.

interface-RecordDetails-kind = Rodzaj

interface-RecordDetails-lockedWithAPasswordMyCarlosCannotOpen = Zabezpieczony hasłem. myCarlos nie potrafi jeszcze otworzyć go na tym urządzeniu.

interface-RecordDetails-lockedWithAPasswordUnlockAddsA = Zabezpieczony hasłem. Odblokowanie dodaje kopię otwieraną bez hasła i zachowuje ten dokument.

interface-RecordDetails-move = Przenieś

interface-RecordDetails-moveTo = Przenieś do

interface-RecordDetails-read = Czytaj

interface-RecordDetails-saveACopyToThisComputer = Zapisz kopię na tym komputerze

interface-RecordDetails-theFileStaysEncryptedInTheVault = Plik pozostaje zaszyfrowany w sejfie. Proszę zapisywać kopię tylko wtedy, gdy potrzebny jest czytelny plik poza myCarlos.

interface-RecordDetails-thisDocumentIsDamaged = Ten dokument jest uszkodzony.

interface-RecordDetails-thisDocumentIsUnavailable = Ten dokument jest niedostępny.

interface-RecordDetails-unlock = Odblokuj…

interface-RecordDetails-viewPhoto = Zobacz zdjęcie

interface-recordPresentation-imaging = Badanie obrazowe

interface-recordPresentation-prescription = Recepta

interface-recordPresentation-testResult = Wynik badania

interface-recovery-earlierStopped = Wcześniejszy klucz odzyskiwania nie otwiera już tego sejfu. { $backups }

interface-recovery-replaced = Zastąpiono klucz odzyskiwania. Stary klucz nie otwiera już tego sejfu. { $backups }

interface-recovery-savedBeforeLock = Pokazany klucz odzyskiwania został zapisany tuż przed zablokowaniem sejfu lub zamknięciem myCarlos, więc jest teraz Twoim kluczem odzyskiwania: proszę zachować to, co zostało zapisane lub zanotowane.

interface-search-all = Szukaj wszędzie w { $location }

interface-SecuritySettings-evaluationBuild = Wersja testowa


interface-SecuritySettings-myCarlosNeverDeletesADocumentHidingOne = myCarlos nigdy nie usuwa dokumentów. Ukrycie usuwa dokument z widoku: pozostaje on w zaszyfrowanym sejfie, w sekcji Ukryte, i można go przywrócić. Czytelne kopie zapisane poza myCarlos można zachować lub usunąć samodzielnie.

interface-SecuritySettings-releaseBuild = Wersja wydaniowa

interface-SecuritySettings-startingAgainOrRestoringABackupOver = Rozpoczęcie od nowa lub przywrócenie kopii zapasowej w miejsce tego sejfu odstawia go na bok: pozostaje na tym urządzeniu, zaszyfrowany. myCarlos nigdy nie usuwa sejfów.

interface-SecuritySettings-whatMyCarlosKeeps = Co przechowuje myCarlos

interface-sidebar-sharedNew = { $shared }, { $new }

interface-size-bytes =
    { $count ->
    [one] { $count } bajt
    [few] { $count } bajty
    [many] { $count } bajtów
    *[other] { $count } bajtu
    }

interface-speed-median = Mediana { $median } ms, najdłuższy czas { $max } ms.

interface-speed-parameters = Argon2id, { $memory } MiB, { $iterations } przebiegów, { $lanes } ścieżek.

interface-speed-platform = { $platform } { $architecture }, myCarlos { $version }.

interface-speed-runs =
    { $count ->
    [one] { $count } pomiar: { $samples } ms.
    [few] { $count } pomiary: { $samples } ms.
    [many] { $count } pomiarów: { $samples } ms.
    *[other] { $count } pomiaru: { $samples } ms.
    }

interface-speed-simulator = { $build }, symulator.

interface-tab-withNew = { $section } ({ $new })

interface-unfinishedRecoveryKey-recoveryKeySetupEndedWhenTheVault = Konfiguracja klucza odzyskiwania zakończyła się po zablokowaniu sejfu lub zamknięciu myCarlos, więc sejf nadal nie ma klucza odzyskiwania. Jeśli pokazany klucz został zapisany lub zanotowany, proszę go zniszczyć: ten klucz nie otwiera sejfu.

interface-unfinishedRecoveryKey-yourRecoveryKeyWasNotReplacedSetup = Klucz odzyskiwania nie został zastąpiony: konfiguracja zakończyła się po zablokowaniu sejfu lub zamknięciu myCarlos, a wcześniejszy klucz nadal działa. Jeśli pokazany nowy klucz został zapisany lub zanotowany, proszę go zniszczyć: ten klucz nie otwiera sejfu.

interface-UnlockPdfDialog-thisDocumentIsLockedWithAPassword = Ten dokument jest zabezpieczony hasłem. Proszę wpisać hasło dokumentu z portalu pacjenta. myCarlos dodaje kopię otwieraną bez hasła i zachowuje zabezpieczony oryginał. Nigdy nie przechowuje hasła.

interface-UnlockPdfDialog-unlocking = Odblokowywanie…

interface-VaultApp-chooseFilesToImport = Wybierz pliki do importu

interface-VaultApp-finishingTheTransfer = Kończenie przesyłania

interface-VaultApp-lockNowAndCancelTheTransfer = Zablokuj teraz i anuluj przesyłanie

interface-VaultApp-myCarlosCouldNotLockTheVaultIts = myCarlos nie mógł zablokować sejfu. Jego zawartość jest ukryta, ale sejf nadal jest otwarty.

interface-VaultApp-openingMyCarlos = Otwieranie myCarlos…

interface-VaultApp-tryLockingAgain = Spróbuj zablokować ponownie

interface-VaultApp-vaultContentIsHiddenMyCarlosWillLock = Zawartość sejfu jest ukryta. myCarlos zablokuje się po zakończeniu przesyłania.

interface-VaultApp-vaultContentIsHiddenWhileMyCarlosFinishes = Zawartość sejfu jest ukryta, gdy myCarlos kończy blokowanie…

interface-VaultLibrary-anotherVaultOperationIsStillRunningTry = Inna operacja na sejfie nadal trwa. Proszę spróbować ponownie po jej zakończeniu.

interface-VaultLibrary-changesArePaused = Wprowadzanie zmian jest wstrzymane.

interface-VaultLibrary-chooseAFolder = Wybierz folder

interface-VaultLibrary-chooseRecordView = Wybierz widok dokumentów

interface-VaultLibrary-clear = Wyczyść

interface-VaultLibrary-create = Utwórz

interface-VaultLibrary-damagedFileMissing = Uszkodzony: brak pliku

interface-VaultLibrary-destination = Miejsce docelowe

interface-VaultLibrary-documentMoved = Przeniesiono dokument.

interface-VaultLibrary-documentsToHide = Dokumenty do ukrycia

interface-VaultLibrary-encryptedBackupSavedKeepItSomewhereOther = Zapisano zaszyfrowaną kopię zapasową. Proszę przechowywać ją poza tym urządzeniem.

interface-VaultLibrary-encryptedBackupSavedThisIsYourNew = Zapisano zaszyfrowaną kopię zapasową. To nowa kopia zapasowa: proszę przechowywać ją lub jej kopię poza tym urządzeniem. W sekcji Bezpieczeństwo można teraz sprawdzić, które starsze kopie usunąć.

interface-VaultLibrary-everyFileIsBackOnThisDevice = Wszystkie pliki są z powrotem na tym urządzeniu. Nic nie zostało ukryte.

interface-VaultLibrary-filesAndRecordDetailsAreEncryptedAnd = Pliki i szczegóły dokumentów są zaszyfrowane i zapisane na tym urządzeniu

interface-VaultLibrary-filesYouOpenWithMyCarlosArriveHere = Pliki otwierane w myCarlos trafiają tutaj, zaszyfrowane.

interface-VaultLibrary-filesYouShareToMyCarlosFromAnother = Pliki udostępniane do myCarlos z innej aplikacji trafiają tutaj, zaszyfrowane.

interface-VaultLibrary-fileUnavailable = Plik niedostępny

interface-VaultLibrary-firstCheckThatTheFilesAreNot = Najpierw proszę sprawdzić, czy pliki nie są tylko chwilowo niedostępne: jeśli dysk z folderem danych myCarlos jest odłączony lub inny program go używa, proszę to naprawić, a następnie zablokować i odblokować sejf. Jeśli istnieje kopia zapasowa folderu danych, proszę ją najpierw przywrócić: każdy odzyskany plik zostanie zachowany.

interface-VaultLibrary-foldersStayWithTheirPersonMoveIndividual = Foldery pozostają przy swojej osobie. Pojedyncze dokumenty można przenieść do innej osoby.

interface-VaultLibrary-grid = Siatka

interface-VaultLibrary-gridView = Widok siatki

interface-VaultLibrary-hideDamagedDocuments = Ukryj uszkodzone dokumenty

interface-VaultLibrary-holdAndDragADocumentOrFolder = Aby przenieść dokument lub folder, proszę go przytrzymać i przeciągnąć albo otworzyć i wybrać Przenieś do.

interface-VaultLibrary-ifYouForgetYourPassphraseWithoutOne = Bez niego, w razie zapomnienia hasła głównego, jedynym sposobem odzyskania dostępu jest odstawienie sejfu na bok i rozpoczęcie od nowa.

interface-VaultLibrary-insideFolder = Wewnątrz folderu

interface-VaultLibrary-list = Lista

interface-VaultLibrary-listView = Widok listy

interface-VaultLibrary-moveAFolderWithTheKeyboard = Przenieś folder za pomocą klawiatury

interface-VaultLibrary-moveFolder = Przenieś folder

interface-VaultLibrary-moveSelectedTo = Przenieś wybrane do

interface-VaultLibrary-moveThemIntoYourFoldersWheneverYou = Można je przenieść do swoich folderów w dowolnym momencie.

interface-VaultLibrary-moveTheSelectedDocuments = Przenieś wybrane dokumenty.

interface-VaultLibrary-myCarlosCouldNotSaveAChangeTo = myCarlos nie mógł zapisać zmiany na tym komputerze. Proszę zwolnić miejsce lub sprawdzić dysk, a następnie zablokować i odblokować sejf; naprawi się on sam, gdy będzie mógł zapisywać.

interface-VaultLibrary-myCarlosEncryptedRecordLibrary = Biblioteka zaszyfrowanych dokumentów myCarlos

interface-VaultLibrary-nameAZ = Nazwa A–Z

interface-VaultLibrary-new = Nowe

interface-VaultLibrary-newestFirst = Od najnowszych

interface-VaultLibrary-newFolder = Nowy folder

interface-VaultLibrary-noFilesSelectedNothingChanged = Nie wybrano plików. Nic się nie zmieniło.

interface-VaultLibrary-noLocationChosenNothingChanged = Nie wybrano miejsca. Nic się nie zmieniło.

interface-VaultLibrary-noRecoveryKeyYet = Nie ma jeszcze klucza odzyskiwania.

interface-VaultLibrary-passphraseChanged = Zmieniono hasło główne.

interface-VaultLibrary-privateVault = Prywatny sejf

interface-VaultLibrary-records = Dokumenty

interface-VaultLibrary-recoveryKeySavedKeepYourKitSomewhere = Zapisano klucz odzyskiwania. Proszę przechowywać zestaw w bezpiecznym miejscu.

interface-VaultLibrary-recoveryKeySetupWasNotFinishedThe = Nie ukończono konfiguracji klucza odzyskiwania. Pokazany klucz nie otwiera sejfu; wcześniejszy klucz nadal działa. Proszę zniszczyć każdy zestaw zapisany lub wydrukowany przed chwilą.

interface-VaultLibrary-recoveryKeySetupWasNotFinishedTheAlternative = Nie ukończono konfiguracji klucza odzyskiwania. Pokazany klucz nie otwiera sejfu. Proszę zniszczyć każdy zestaw zapisany lub wydrukowany przed chwilą.

interface-VaultLibrary-saveACopy = Zapisz kopię

interface-VaultLibrary-saveAReadableCopy = Zapisać czytelną kopię?

interface-VaultLibrary-saveCancelledNothingChanged = Anulowano zapisywanie. Nic się nie zmieniło.

interface-VaultLibrary-savingCreatesAReadableFileOutsideThe = Zapisanie tworzy czytelny plik poza zaszyfrowanym sejfem. myCarlos nie może później usunąć tej kopii, a ukrycie tego dokumentu jej nie usunie.

interface-VaultLibrary-searchSharedWithMe = Szukaj w sekcji Udostępnione mi

interface-VaultLibrary-searchThisFolderAndItsSubfolders = Szukaj w tym folderze i jego podfolderach

interface-VaultLibrary-section = Sekcja

interface-VaultLibrary-someEncryptedFilesAreMissingFromThis = Na tym urządzeniu brakuje niektórych zaszyfrowanych plików. Dokumentów oznaczonych jako uszkodzone nie można otworzyć ani skopiować; proszę teraz zapisać kopie pozostałych. Aby znów wprowadzać zmiany, proszę przywrócić folder danych myCarlos z kopii zapasowej lub ukryć uszkodzone dokumenty.

interface-VaultLibrary-someOfTheVaultsFilesCouldNot = Nie udało się odczytać niektórych plików sejfu, a mogą być nowsze lub nieuszkodzone, więc na razie nie można nic zmieniać, w tym hasła głównego i klucza odzyskiwania. Nadal można otwierać dokumenty i zapisywać ich kopie, z wyjątkiem tych oznaczonych jako „Plik niedostępny”. Proszę sprawdzić, czy dysk z folderem danych myCarlos jest podłączony, czy żaden inny program nie blokuje folderu i czy narzędzie synchronizacji z chmurą przechowuje pliki na tym urządzeniu, a następnie zablokować i odblokować sejf.

interface-VaultLibrary-sortBy = Sortuj według

interface-VaultLibrary-thatFolderIsNoLongerAvailable = Ten folder nie jest już dostępny.

interface-VaultLibrary-theirEncryptedFilesAreMissingFromThis = Na tym urządzeniu brakuje ich zaszyfrowanych plików. Ukrycie tych dokumentów pozwoli znów wprowadzać zmiany w sejfie. Pozostaną w sekcji Ukryte wraz z nazwami i szczegółami, a jeśli plik powróci, jego dokument będzie można przywrócić.

interface-VaultLibrary-theVaultIsReadonlySoTheName = Sejf jest tylko do odczytu, więc nazwa nie została zmieniona.

interface-VaultLibrary-theyAreInNoOnesRecordsUntil = Nie należą do dokumentów żadnej osoby, dopóki każdy z nich nie zostanie przeniesiony do właściwej osoby.

interface-VaultLibrary-thisPhotoIsAlreadyInTheVault = To zdjęcie jest już w sejfie, więc nie zostało zapisane ponownie.

interface-VaultLibrary-topLevel = Poziom główny

interface-VaultLibrary-unlockedLockNow = Odblokowany · Zablokuj teraz

interface-VaultLibrary-working = Przetwarzanie…

kit-keep = Proszę przechowywać go w prywatnym miejscu, z dala od urządzenia. Każdy, kto ma ten klucz i kopię sejfu, może go otworzyć. Po skonfigurowaniu nowego klucza odzyskiwania ten klucz nie otwiera już sejfu na tym urządzeniu.

kit-labelNote = Etykieta nie jest tajna. W sekcji Bezpieczeństwo myCarlos pokazuje etykietę klucza odzyskiwania, który teraz działa: zestaw z inną etykietą już nie otwiera sejfu.

kit-labelPrinted = Etykieta klucza: { $label } · Wydrukowano { $date }

kit-printed = Wydrukowano { $date }

kit-title = Zestaw odzyskiwania myCarlos

kit-use = W razie zapomnienia hasła głównego myCarlos ten klucz otwiera sejf na tym urządzeniu i pozwala wybrać nowe hasło główne. Działa po zakończeniu sprawdzania w myCarlos.

language-error-notRemembered = Język został zmieniony na tę sesję, ale nie udało się go zapamiętać na tym urządzeniu.

language-error-unreadable = Nie udało się odczytać zapisanego języka. W tej sesji używany jest język urządzenia.

language-help = Wybór jest zapamiętywany na tym urządzeniu. Dokumenty pozostają w oryginalnym języku.

language-system = Język systemu

language-title = Język

library-column-added = Data dodania

library-column-name = Nazwa

library-column-source = Źródło

library-details = Szczegóły

library-document-details = Szczegóły dokumentu { $name }

library-document-label = Dokument { $name }

library-empty-help = Proszę dodać tutaj folder lub zaimportować dokument.

library-empty-title = To miejsce jest puste

library-folder-items =
    { $count ->
    [one] { $count } element
    [few] { $count } elementy
    [many] { $count } elementów
    *[other] { $count } elementu
    }

library-folder-label = Folder { $name }

library-folder-open = Otwórz { $name }

library-folder-rename = Zmień nazwę folderu { $name }

library-items =
    { $count ->
    [one] { $count } widoczny element biblioteki
    [few] { $count } widoczne elementy biblioteki
    [many] { $count } widocznych elementów biblioteki
    *[other] { $count } widocznego elementu biblioteki
    }

library-noMatch-help = Proszę spróbować innego wyszukiwania.

library-noMatch-title = Brak pasujących dokumentów

library-rename = Zmień nazwę

library-search-cleared = Wyszukiwanie wyczyszczone. Foldery w tej lokalizacji: { $folders }. Dokumenty: { $documents }.

library-search-results = Wyniki wyszukiwania. Foldery: { $folders }. Dokumenty: { $documents }.

library-select = Zaznacz { $name }

lockWarning-help = Aby pozostawić go otwartym, proszę nacisnąć „{ $keepOpen }” lub dowolny klawisz.

lockWarning-keepOpen = Pozostaw otwarty

lockWarning-left =
    { $count ->
    [one] Została { $count } sekunda.
    [few] Zostały { $count } sekundy.
    [many] Zostało { $count } sekund.
    *[other] Zostało { $count } sekundy.
    }

lockWarning-title =
    { $count ->
    [one] myCarlos zablokuje się za { $count } sekundę, aby chronić prywatność dokumentów.
    [few] myCarlos zablokuje się za { $count } sekundy, aby chronić prywatność dokumentów.
    [many] myCarlos zablokuje się za { $count } sekund, aby chronić prywatność dokumentów.
    *[other] myCarlos zablokuje się za { $count } sekundy, aby chronić prywatność dokumentów.
    }

native-backup-noteEmptied = Plik w wybranym miejscu zapisu może być pusty lub niekompletny; jeśli zapis miał zastąpić starszą kopię zapasową, została ona opróżniona. Proszę usunąć ten plik, a zachować pozostałe kopie zapasowe.

native-backup-noteUntouched = W wybranym miejscu zapisu może pozostać pusty plik (0 bajtów): można go usunąć. Proszę zachować każdą niepustą kopię zapasową.

native-cancel = Anuluj

native-error-01 = myCarlos nie mógł teraz odczytać niektórych swoich plików, więc nie zapisano kopii zapasowej. Dokumenty nie zostały zmienione. Proszę zachować starsze kopie zapasowe i spróbować ponownie. Jeśli problem się powtórzy, proszę zamknąć i ponownie otworzyć myCarlos; na komputerze proszę także sprawdzić, czy dysk jest podłączony, oraz wstrzymać narzędzia synchronizacji lub program antywirusowy.

native-error-02 = W wybranym miejscu zapisu brakuje wolnego miejsca. Nie zapisano kopii zapasowej. Proszę zachować starsze kopie zapasowe.

native-error-03 = Nie udało się zapisać kopii zapasowej w tym miejscu. Nie zapisano kopii zapasowej. Proszę zachować starsze kopie zapasowe.

native-error-04 = Tworzenie kopii zapasowej zostało przerwane, ponieważ sejf został zablokowany. Nie zapisano kopii zapasowej. Proszę zachować starsze kopie zapasowe.

native-error-05 = Podjęto kilka błędnych prób z rzędu. Aby spowolnić zgadywanie, myCarlos czeka chwilę przed kolejną próbą: wpisana wartość nie została sprawdzona.

native-error-06 = W wybranym miejscu docelowym może znajdować się częściowa czytelna kopia. Proszę ją usunąć przed ponowną próbą.

native-error-07 = Ten klucz odzyskiwania nie otwiera tej kopii zapasowej. Kopię zapasową otwiera klucz odzyskiwania, który sejf miał w chwili jej zapisania, jeśli go miał (a nie klucz ustawiony lub zastąpiony później), albo hasło główne użyte przy jej utworzeniu.

native-error-08 = To hasło główne nie otwiera tej kopii zapasowej. Kopię zapasową otwiera hasło główne użyte przy jej utworzeniu (a nie zmienione później) albo klucz odzyskiwania, który sejf miał w chwili jej zapisania, jeśli go miał.

native-error-09 = Zdjęcie nie dotarło do sejfu, więc nie zostało zapisane. Wybierz Użyj zdjęcia, aby spróbować ponownie.

native-error-10 = Nic nie zostało ukryte. Obecnie nie można wprowadzać zmian w sejfie; komunikat nad dokumentami wyjaśnia dlaczego.

native-error-11 = Trwa sprawdzanie hasła głównego lub test szybkości. Proszę zaczekać do zakończenia i spróbować ponownie.

native-error-12 = Na tym urządzeniu już istnieje sejf.

native-error-13 = Na tym urządzeniu nie ma sejfu.

native-error-14 = Odblokuj sejf, aby kontynuować.

native-error-15 = Ten sejf jest otwarty w innym oknie myCarlos. Proszę zablokować lub zamknąć tamto okno i spróbować ponownie.

native-error-16 = To hasło główne nie otworzyło myCarlos. Proszę sprawdzić Caps Lock i spróbować ponownie.

native-error-17 = Sejf jest uszkodzony lub niekompletny. Żadne dane nie zostały zmienione.

native-error-18 = Ten element nie jest już dostępny.

native-error-19 = Nie przyjęto jednej z wpisanych wartości. Proszę ją sprawdzić i spróbować ponownie.

native-error-20 = Proszę wybrać trudniejsze do odgadnięcia hasło główne, które nie opiera się na popularnych hasłach, imionach, nazwiskach ani nazwie myCarlos.

native-error-21 = Proszę wybrać najwyżej 100 plików do jednego importu.

native-error-22 = Jeden z plików nie jest dokumentem PDF, więc nic nie dodano. myCarlos przechowuje tylko dokumenty PDF.

native-error-23 = Ten dokument jest zabezpieczony hasłem. Proszę wpisać hasło dokumentu z portalu pacjenta.

native-error-24 = Ten dokument nie jest zabezpieczony hasłem, więc można go otworzyć bez zmian.

native-error-25 = Odblokowana kopia tego dokumentu już tu jest, więc nic nie dodano.

native-error-26 = To hasło nie otworzyło dokumentu. Proszę sprawdzić hasło dokumentu w portalu pacjenta i spróbować ponownie.

native-error-27 = myCarlos nie mógł otworzyć tego zabezpieczonego dokumentu. Może być uszkodzony lub zabezpieczony w sposób, którego myCarlos nie obsługuje. Dokument nie został zmieniony.

native-error-28 = myCarlos nie potrafi jeszcze otwierać dokumentów zabezpieczonych hasłem na tym urządzeniu. Dokument nie został zmieniony.

native-error-29 = myCarlos nie może bezpiecznie otwierać zabezpieczonych dokumentów w tym systemie, więc ten dokument nie został otwarty. Dokument nie został zmieniony.

native-error-30 = Ten zabezpieczony dokument jest większy niż 100 MB, więc myCarlos nie może go otworzyć. Dokument nie został zmieniony.

native-error-31 = myCarlos nie mógł wyświetlić tego dokumentu. Może być uszkodzony lub używać funkcji, których myCarlos jeszcze nie wyświetla. Proszę zapisać kopię, aby przeczytać go w innej aplikacji.

native-error-32 = myCarlos nie potrafi jeszcze wyświetlać dokumentów na tym urządzeniu. Proszę zapisać kopię, aby przeczytać dokument w innej aplikacji.

native-error-33 = myCarlos nie może bezpiecznie wyświetlać dokumentów w tym systemie. Proszę zapisać kopię, aby przeczytać dokument w innej aplikacji.

native-error-34 = Brakuje miejsca, aby ukończyć tę operację.

native-error-35 = myCarlos nie mógł odczytać lub zapisać swoich plików na tym komputerze. Proszę sprawdzić, czy dysk z myCarlos jest podłączony i ma wolne miejsce, a następnie spróbować ponownie. Jeśli wprowadzano zmianę, proszę najpierw sprawdzić w dokumentach, czy została zapisana.

native-error-36 = Operacja została przerwana, ponieważ sejf został zablokowany.

native-error-37 = myCarlos nie może bezpiecznie przechowywać sejfu w pamięci tego urządzenia, ponieważ nie potwierdza ona trwałego zapisu plików (na przykład sieciowy folder domowy). Proszę używać myCarlos na urządzeniu z lokalną pamięcią masową.

native-error-38 = Lista uszkodzonych dokumentów uległa zmianie. Nic nie zostało usunięte. Proszę sprawdzić listę i spróbować ponownie.

native-error-39 = myCarlos nie mógł teraz odczytać niektórych swoich plików. Dokumenty nie zostały zmienione ani usunięte, więc proszę nie odstawiać sejfu na bok. Proszę sprawdzić wpisane wartości i spróbować ponownie. Jeśli problem się powtórzy, proszę zamknąć i ponownie otworzyć myCarlos; na komputerze proszę także sprawdzić, czy dysk jest podłączony, oraz wstrzymać narzędzia synchronizacji lub program antywirusowy.

native-error-40 = Sejf działa w trybie odzyskiwania tylko do odczytu. Proszę wyeksportować ważne dokumenty i zwolnić miejsce przed ponowną próbą.

native-error-41 = To nie pasuje do klucza odzyskiwania. Proszę sprawdzić każdą grupę znaków i spróbować ponownie.

native-error-42 = Plik kopii zapasowej lub sejf na tym urządzeniu zmienił się po wybraniu przywracania. Nic na tym urządzeniu nie zostało zmienione. Proszę ponownie wybrać plik kopii zapasowej.

native-error-43 = Ten plik nie jest kompletną kopią zapasową myCarlos lub został zmieniony po zapisaniu. Nic na tym urządzeniu nie zostało zmienione.

native-error-44 = Ten klucz odzyskiwania nie otwiera tego sejfu. Jeśli klucz odzyskiwania został zastąpiony, proszę użyć najnowszego.

native-error-45 = myCarlos nie mógł otworzyć tego pliku. Jeśli znajduje się w chmurze lub folderze udostępnionym, proszę skopiować go do folderu na tym urządzeniu i tam go wybrać. Nic na tym urządzeniu nie zostało zmienione.

native-error-46 = Dokument w sejfie jest uszkodzony i nie można go już odczytać, więc nie zapisano kopii zapasowej. Nic nie zostało zmienione.

native-error-47 = To nie jest zdjęcie, które myCarlos może zapisać lub wyświetlić: musi być kompletnym obrazem JPEG o rozmiarze najwyżej 25 MB i wymiarach najwyżej 8 192 pikseli na każdym boku. Nic nie zostało zmienione.

native-error-48 = Kopia zapasowa została sprawdzona, ale przywracanie nie zostało ukończone. Proszę zamknąć i ponownie otworzyć myCarlos, aby je dokończyć. Następnie proszę otworzyć sejf hasłem głównym lub kluczem odzyskiwania z kopii zapasowej.

native-error-speedTest = Test szybkości został przerwany przed zakończeniem. Nic nie zostało zmienione. Proszę spróbować ponownie.

native-filter-backups = Kopie zapasowe myCarlos

native-filter-pdf = Dokumenty PDF

native-kit-text =
    Zestaw odzyskiwania myCarlos

    Klucz odzyskiwania: { $key }
    Etykieta klucza: { $label } (nie jest tajna: odróżnia zestawy)
    Zapisano: { $date } (UTC)

    Do czego służy
    Jeśli zapomnisz hasła głównego myCarlos, ten klucz otworzy sejf na tym urządzeniu i pozwoli wybrać nowe hasło główne. Działa po ukończeniu sprawdzenia w myCarlos, które następuje po zapisaniu tego zestawu.

    Przechowuj bezpiecznie
    - Proszę przechowywać ten zestaw w prywatnym miejscu z dala od urządzenia, na przykład wydrukowany razem z ważnymi dokumentami. Każdy, kto ma ten klucz i kopię sejfu, może go otworzyć.
    - Po ustawieniu nowego klucza odzyskiwania ten klucz nie otwiera już sejfu na tym urządzeniu.
    - Ani Twoja przychodnia, ani twórcy myCarlos nie mogą otworzyć sejfu za Ciebie.


native-recovery-keep = Zachowaj obecny klucz

native-recovery-replace = Zastąp klucz

native-recovery-title = Zastąpić klucz odzyskiwania?

native-recovery-warning = Obecny klucz odzyskiwania przestanie działać po zapisaniu nowego: zapisany lub wydrukowany zestaw obecnego klucza nie będzie już otwierał tego sejfu. Wcześniejsze kopie zapasowe nadal otwierają się hasłem głównym lub kluczem odzyskiwania użytym przy ich zapisaniu, w tym obecnym kluczem; po zakończeniu myCarlos wyjaśni, co z nimi zrobić. Przed kontynuowaniem proszę upewnić się, że nowy klucz został zanotowany lub zapisany. Jeśli zastąpienie klucza odzyskiwania nie było zamierzone, wybierz Zachowaj obecny klucz.

native-reset-phrase = ZRESETUJ SEJF MYCARLOS

native-restore-changed = Sejf na tym urządzeniu może różnić się od tej kopii zapasowej ({ $documents }): mógł się od tamtej pory zmienić lub nie udało się odczytać jego części. Przywrócenie odstawia go na bok i umieszcza kopię zapasową w jego miejscu: wszystko, czego nie ma w kopii zapasowej, znika z używanego sejfu, a hasło główne i klucz odzyskiwania zostają zastąpione tymi z kopii zapasowej. { $kept }

native-restore-other = Sejf na tym urządzeniu nie jest sejfem, z którego utworzono tę kopię zapasową. Przywrócenie odstawia sejf na tym urządzeniu na bok i umieszcza kopię zapasową ({ $documents }) w jego miejscu. { $kept }

native-restore-replace = Zastąp kopią zapasową

native-restore-same = Przywrócenie odstawia sejf na tym urządzeniu na bok i umieszcza kopię zapasową w jego miejscu, zawierającą te same dokumenty ({ $documents }). { $kept }

native-restore-title = Zastąpić sejf na tym urządzeniu?

native-restore-unreadable = Nie udało się odczytać sejfu na tym urządzeniu, więc myCarlos nie może stwierdzić, czy to sejf, z którego utworzono tę kopię zapasową. Przywrócenie odstawia sejf na tym urządzeniu na bok i umieszcza kopię zapasową ({ $documents }) w jego miejscu. { $kept }

native-setAside-confirm = Odstaw na bok

native-setAside-desktop = Aby usunąć odstawiony sejf i zwolnić miejsce, proszę zamknąć myCarlos i usunąć jego folder w { $folder }.

native-setAside-kept = Odstawiony sejf pozostaje na tym urządzeniu, zaszyfrowany, wraz z całą zawartością, a jego hasło główne lub klucz odzyskiwania nadal go otwiera, ale myCarlos nie potrafi go jeszcze ponownie otworzyć.

native-setAside-mobile = Na tym telefonie odstawione sejfy pozostają w prywatnej pamięci myCarlos i myCarlos nie może ich usunąć: jedynym sposobem jest wyczyszczenie danych myCarlos w ustawieniach telefonu lub odinstalowanie aplikacji, co usuwa wszystkie sejfy na telefonie.

native-setAside-title = Odstawić ten sejf myCarlos na bok i zacząć od nowa?

native-setAside-warning = Cały sejf zostanie odstawiony na bok i rozpocznie się praca z pustym sejfem. { $kept } myCarlos nigdy go nie usuwa. Jeśli powodem rozpoczęcia od nowa jest podejrzenie, że ktoś zna Twoje hasło główne, ta osoba nadal może go otworzyć, więc proszę go usunąć. { $removal }

native-vault-keep = Zachowaj ten sejf

notice-autoLockSet =
    { $count ->
    [one] Automatyczna blokada ustawiona na { $count } minutę.
    [few] Automatyczna blokada ustawiona na { $count } minuty.
    [many] Automatyczna blokada ustawiona na { $count } minut.
    *[other] Automatyczna blokada ustawiona na { $count } minuty.
    }

notice-backupCutOff = Tworzenie kopii zapasowej zostało przerwane, ponieważ sejf się zablokował. Nie zapisano kopii. Proszę zachować starsze kopie zapasowe. { $note }

notice-created = Utworzono zaszyfrowany sejf. Proszę skonfigurować klucz odzyskiwania, aby zapomniane hasło główne nie uniemożliwiło na zawsze dostępu do dokumentów.

notice-createdThenLocked = Sejf został utworzony, a potem zablokowany, zanim można było utworzyć klucz odzyskiwania. Proszę odblokować sejf, aby skonfigurować klucz.

notice-dropRefused = Aby zaimportować pliki PDF, proszę odblokować sejf i użyć przycisku „{ $button }”. Przeciąganie i upuszczanie przenosi dokumenty, które już są w myCarlos.

notice-eraseCancelled = Nic się nie zmieniło: sejf nie został odłożony na bok.

notice-iosKeepOpen = Proszę nie zamykać myCarlos: przełączenie aplikacji wstrzymuje to przesyłanie.

notice-locked = Sejf zablokowany.

notice-lockedHidden = Zablokowano, ponieważ myCarlos został zminimalizowany lub przeniesiony do tła.

notice-lockedIdle =
    { $count ->
    [one] Zablokowano po { $count } minucie bez używania.
    [few] Zablokowano po { $count } minutach bez używania.
    [many] Zablokowano po { $count } minutach bez używania.
    *[other] Zablokowano po { $count } minuty bez używania.
    }

notice-recovered = Sejf otwarto kluczem odzyskiwania. Od teraz proszę używać nowego hasła głównego.

notice-recoveredReadOnly = Sejf otwarto kluczem odzyskiwania w trybie tylko do odczytu; hasło główne się nie zmieniło. Co zrobić, opisuje komunikat w bibliotece.

notice-restored = Przywrócono kopię zapasową. Proszę odblokować sejf hasłem głównym, z którym został utworzony, lub użyć jego klucza odzyskiwania.

notice-transferUnfinished = Przesyłanie nie zostało ukończone.

notice-unlocked = Sejf odblokowany.

notice-unlockedRecovery = Sejf odblokowano w trybie odzyskiwania tylko do odczytu. Co zrobić, opisuje komunikat w bibliotece.

passphrase-confirm-label = Powtórz hasło główne

passphrase-confirmNew-label = Powtórz nowe hasło główne

passphrase-label = Hasło główne

passphrase-longerThanAny = Ten tekst jest dłuższy niż jakiekolwiek hasło główne do sejfu. Proszę sprawdzić, co zostało wpisane.

passphrase-mismatch = Hasła główne nie są takie same.

passphrase-new-label = Nowe hasło główne

passphrase-rules = Proszę użyć co najmniej { $min } znaków. Spacje są dozwolone; popularne hasła, imiona i nazwiska oraz łatwe do odgadnięcia wzorce są odrzucane na tym urządzeniu.

passphrase-show = Pokaż hasło główne

passphrase-show-inConfirm = w polu Powtórz hasło główne

passphrase-tooLong = To hasło główne jest zbyt długie. Proszę je skrócić.

passphrase-tooShort = To hasło główne jest zbyt krótkie. Proszę użyć co najmniej { $min } znaków.

photo-alt = Zdjęcie: { $name }

photo-area = Zdjęcie. Proszę powiększyć, aby zobaczyć szczegóły; przeciągnąć lub przewinąć, aby się przesunąć.

photo-close = Zamknij

photo-eyebrow = Zdjęcie

photo-fitted = Dopasowano do okna.

photo-zoomed = Powiększono do { $percent }%.

photo-zoomIn = Powiększ

photo-zoomOut = Pomniejsz

preferences-subtitle = Wygląd myCarlos na tym komputerze

record-kind-document = Dokument

record-source-manual = Import ręczny — niezweryfikowany

recover-intro = Użyj klucza odzyskiwania, aby otworzyć sejf i wybrać nowe hasło główne.

recover-key-format = 28 liter i cyfr, w 7 grupach po 4, tak jak na zestawie lub tak, jak zostały zapisane. Myślniki, spacje i inne znaki interpunkcyjne nie mają znaczenia.

recover-key-label = Klucz odzyskiwania

recover-key-show = Pokaż klucz odzyskiwania

recover-submit = Otwórz kluczem odzyskiwania

recoveryKey-about-offered = Sejf jest otwarty. Nie ma jeszcze klucza odzyskiwania. Bez niego, w razie zapomnienia hasła głównego, jedynym sposobem powrotu jest odłożenie sejfu na bok i rozpoczęcie od nowa.

recoveryKey-about-replacing = Obecny klucz odzyskiwania przestanie działać po sprawdzeniu nowego.

recoveryKey-about-type = Proszę wpisać hasło główne, aby utworzyć klucz odzyskiwania. Zaraz zostanie wyświetlony: proszę wybrać Dalej dopiero wtedy, gdy nikt inny nie widzi ekranu.

recoveryKey-about-typeAgain = Proszę ponownie wpisać hasło główne, aby utworzyć klucz odzyskiwania. Zaraz zostanie wyświetlony: proszę wybrać Dalej dopiero wtedy, gdy nikt inny nie widzi ekranu.

recoveryKey-about-typeAgainNew = Proszę ponownie wpisać hasło główne, aby utworzyć nowy klucz odzyskiwania. Zaraz zostanie wyświetlony: proszę wybrać Dalej dopiero wtedy, gdy nikt inny nie widzi ekranu.

recoveryKey-about-typeNew = Proszę wpisać hasło główne, aby utworzyć nowy klucz odzyskiwania. Zaraz zostanie wyświetlony: proszę wybrać Dalej dopiero wtedy, gdy nikt inny nie widzi ekranu.

recoveryKey-about-what = Klucz odzyskiwania otwiera sejf w razie zapomnienia hasła głównego. Będzie go mieć tylko właściciel sejfu: nikt w przychodni ani w myCarlos nie otworzy sejfu w jego imieniu.

recoveryKey-back = Wstecz: odczytaj klucz odzyskiwania

recoveryKey-check-hint = Proszę wpisać cały klucz odzyskiwania, tak jak został zapisany: 7 grup po 4 litery i cyfry. Myślniki, spacje i inne znaki interpunkcyjne nie mają znaczenia.

recoveryKey-check-label = Klucz odzyskiwania

recoveryKey-checkAndSave = Sprawdź i zapisz

recoveryKey-chooseReason = Proszę wybrać, dlaczego klucz odzyskiwania jest zastępowany.

recoveryKey-continue = Dalej

recoveryKey-discard-body = Ten klucz odzyskiwania nie jest jeszcze skonfigurowany, więc nigdy nie otworzy sejfu. myCarlos teraz blokuje sejf. Po odblokowaniu można będzie skonfigurować nowy klucz.

recoveryKey-discard-confirm = Odrzuć klucz i zablokuj

recoveryKey-discard-title = Odrzucić ten klucz odzyskiwania?

recoveryKey-group = Grupa { $number }: { $characters }

recoveryKey-hiddenWhileSaving = Ukryty podczas zapisywania zestawu.

recoveryKey-instructions = Proszę zapisać klucz albo zapisać lub wydrukować zestaw i przechowywać go w prywatnym miejscu, z dala od tego urządzenia. myCarlos pokazuje go tylko ten jeden raz. Następnie trzeba wpisać go w całości, aby go sprawdzić. Proszę pozostać w myCarlos do zakończenia sprawdzania: wyjście lub zablokowanie anuluje ten klucz.

recoveryKey-keyboardHint = Klawisz Esc zamyka tę konfigurację. Podczas pierwszej konfiguracji najpierw pojawia się pytanie, ponieważ wyjście blokuje sejf, a niedokończony klucz nie będzie działać.

recoveryKey-kitSaved = Zestaw odzyskiwania zapisany. Klucz zacznie działać po zakończeniu sprawdzania.

recoveryKey-label = Etykieta klucza: { $label }. Proszę zapisać ją obok klucza. Nie jest tajna: w sekcji Bezpieczeństwo myCarlos pokazuje etykietę działającego klucza, dzięki czemu wiadomo, który zestaw jest aktualny.

recoveryKey-leave-offered = Skonfiguruj później

recoveryKey-leave-required = Zablokuj sejf i dokończ później

recoveryKey-next = Dalej: sprawdź klucz odzyskiwania

recoveryKey-notChanged = Klucz odzyskiwania nie został zmieniony. Obecny klucz nadal działa. Aby go zmienić, proszę ponownie nacisnąć Sprawdź i zapisz.

recoveryKey-printKit = Drukuj zestaw odzyskiwania

recoveryKey-printUnavailable = Drukowanie nie jest tu dostępne. Proszę zapisać zestaw lub zanotować klucz.

recoveryKey-reason-exposed = Zestaw lub notatka z kluczem mogły zostać zgubione albo zobaczone przez kogoś innego

recoveryKey-reason-hint = W razie wątpliwości proszę wybrać pierwszą odpowiedź.

recoveryKey-reason-legend = Dlaczego klucz jest zastępowany?

recoveryKey-reason-routine = Chcę po prostu nowy klucz: zestaw jest bezpieczny

recoveryKey-saveKit = Zapisz zestaw odzyskiwania…

recoveryKey-threeMisses = Trzy razy z rzędu klucz się nie zgadzał. Proszę ponownie spojrzeć na klucz odzyskiwania, a potem go sprawdzić.

recoveryKey-title-check = Sprawdź klucz odzyskiwania

recoveryKey-title-key = Klucz odzyskiwania

recoveryKey-title-replace = Zastąp klucz odzyskiwania

recoveryKey-title-setUp = Skonfiguruj klucz odzyskiwania

recoveryKey-typedCount =
    { $count ->
    [one] Wpisano { $count } literę lub cyfrę. Klucz odzyskiwania ma { $total } liter i cyfr: 7 grup po 4. Proszę sprawdzić, co zostało zapisane.
    [few] Wpisano { $count } litery lub cyfry. Klucz odzyskiwania ma { $total } liter i cyfr: 7 grup po 4. Proszę sprawdzić, co zostało zapisane.
    [many] Wpisano { $count } liter lub cyfr. Klucz odzyskiwania ma { $total } liter i cyfr: 7 grup po 4. Proszę sprawdzić, co zostało zapisane.
    *[other] Wpisano { $count } litery lub cyfry. Klucz odzyskiwania ma { $total } liter i cyfr: 7 grup po 4. Proszę sprawdzić, co zostało zapisane.
    }

rename-gainsExtension = Nazwa tego dokumentu nie ma rozszerzenia .pdf, więc nie może kończyć się na .pdf.

rename-help-document = Zmienia to nazwę w myCarlos oraz nazwę proponowaną przy eksporcie.

rename-help-documentExtension = Zmienia to nazwę w myCarlos oraz nazwę proponowaną przy eksporcie. Rozszerzenie { $extension } pozostaje bez zmian.

rename-help-folder = Folder i jego zawartość pozostają w tym samym miejscu.

rename-label-document = Nazwa pliku

rename-label-folder = Nazwa folderu

rename-reserved = „{ $word }” nie może być nazwą dokumentu, ponieważ Windows zastrzega tę nazwę na własny użytek. Proszę wybrać inną nazwę.

rename-save = Zapisz nazwę

rename-saving = Zapisywanie…

rename-stemMissing = Proszę wpisać nazwę przed { $extension }.

rename-title-document = Zmień nazwę dokumentu

rename-title-folder = Zmień nazwę folderu

rename-tooLong = Ta nazwa jest zbyt długa. Proszę ją skrócić, aby zapisać.

rename-unsafe = Nazwy dokumentów nie mogą zawierać znaków { $characters } ani niewidocznych znaków sterujących ani kończyć się kropką.

reset-plainly = Odłożenie sejfu usuwa z myCarlos na tym komputerze wszystkie dokumenty, foldery i profile pacjentów. Pozostają one na tym komputerze, zaszyfrowane. Ten sejf nadal można otworzyć jego pierwotnym hasłem głównym lub pasującym kluczem odzyskiwania. Utworzenie nowego sejfu nie zmienia tych danych dostępu. Aby potwierdzić, proszę wpisać dokładnie poniższe słowa.

reset-submit = Odłóż sejf

reset-type = Wpisz { $phrase }

restore-agree-erase = Odłóż sejf z tego urządzenia i przywróć kopię zapasową

restore-agree-replace = Odłóż sejf z tego urządzenia, razem ze zmianami wprowadzonymi od tego czasu, i przywróć tę kopię zapasową

restore-cancelled = Przywracanie anulowane. Nic się nie zmieniło.

restore-check = Sprawdź kopię zapasową

restore-checked =
    { $count ->
    [one] Kopia zapasowa zawiera { $count } dokument. { $consequence }
    [few] Kopia zapasowa zawiera { $count } dokumenty. { $consequence }
    [many] Kopia zapasowa zawiera { $count } dokumentów. { $consequence }
    *[other] Kopia zapasowa zawiera { $count } dokumentu. { $consequence }
    }

restore-checking = Sprawdzanie kopii zapasowej…

restore-choose = Wybierz plik kopii zapasowej…

restore-chooseOther = Wybierz inną kopię zapasową…

restore-chosen = Wybrano kopię zapasową.

restore-consequence-differs = Sejf na tym urządzeniu może nie być taki sam jak ta kopia zapasowa: mógł się od tego czasu zmienić albo jego część nie mogła zostać odczytana. Przywrócenie odkłada sejf i umieszcza w jego miejscu kopię zapasową: tego, czego nie ma w kopii, nie będzie już w używanym sejfie, a hasło główne i klucz odzyskiwania stają się tymi, z którymi wykonano kopię. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany, ale myCarlos nie może go jeszcze ponownie otworzyć.

restore-consequence-nothing = Przywrócenie umieszcza ten sejf na tym urządzeniu.

restore-consequence-otherVault = To urządzenie ma inny sejf. Przywrócenie odkłada go i umieszcza w jego miejscu kopię zapasową. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany, ale myCarlos nie może go jeszcze ponownie otworzyć.

restore-consequence-same = Sejf na tym urządzeniu zawiera te same dokumenty. Przywrócenie odkłada go i umieszcza w jego miejscu tę kopię zapasową. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany, ale myCarlos nie może go jeszcze ponownie otworzyć.

restore-consequence-unreadable = Sejfu na tym urządzeniu nie udało się odczytać, więc myCarlos nie może stwierdzić, czy jest to ten, z którego wykonano tę kopię zapasową. Przywrócenie odkłada go i umieszcza w jego miejscu kopię zapasową. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany, ale myCarlos nie może go jeszcze ponownie otworzyć.

restore-intro = Zaszyfrowaną kopię zapasową otwiera hasło główne, którego użyto przy jej tworzeniu, albo klucz odzyskiwania, jaki sejf miał w chwili zapisania kopii, jeśli go miał.

restore-method-passphrase = Jej hasła głównego

restore-method-recoveryKey = Jej klucza odzyskiwania

restore-openWith = Otwórz za pomocą

restore-passphrase-label = Hasło główne kopii zapasowej

restore-passphrase-show = Pokaż hasło główne

restore-restoring = Przywracanie kopii zapasowej. W przypadku dużego sejfu może to chwilę potrwać…

restore-submit = Przywróć kopię zapasową

restore-summary = Przywróć z kopii zapasowej

restore-tooLong = To jest zbyt długie. Proszę sprawdzić, co zostało wpisane.

secret-count-password =
    { $count ->
    [one] Hasło główne: { $count } znak
    [few] Hasło główne: { $count } znaki
    [many] Hasło główne: { $count } znaków
    *[other] Hasło główne: { $count } znaku
    }

secret-count-recoveryKey =
    { $count ->
    [one] Klucz odzyskiwania: { $count } znak
    [few] Klucz odzyskiwania: { $count } znaki
    [many] Klucz odzyskiwania: { $count } znaków
    *[other] Klucz odzyskiwania: { $count } znaku
    }

secret-count-shown = { $description }, widoczne

security-autoLock-body = Sejf blokuje się po wybranym czasie bez aktywności klawiatury, wskaźnika lub ekranu dotykowego. Proszę wybrać od 1 do 15 minut.

security-autoLock-label = Czas do automatycznej blokady

security-autoLock-longer = Dłuższy czas

security-autoLock-minutes =
    { $count ->
    [one] { $count } minuta
    [few] { $count } minuty
    [many] { $count } minut
    *[other] { $count } minuty
    }

security-autoLock-shorter = Krótszy czas

security-autoLock-title = Automatyczna blokada

security-backup-body = Jeden plik z całym sejfem, nadal zaszyfrowanym. Proszę przechowywać go poza tym urządzeniem, na przykład na dysku USB. Otwiera go hasło główne lub klucz odzyskiwania obowiązujące w chwili zapisania i nadal go otwierają, nawet po ich zmianie tutaj. Aby przywrócić kopię, należy zablokować sejf i wybrać Przywróć z kopii zapasowej.

security-backup-save = Zapisz zaszyfrowaną kopię zapasową…

security-backup-title = Zaszyfrowana kopia zapasowa

security-copies-body = Wyeksportowane pliki i zrzuty ekranu nie są objęte ochroną sejfu. Ukrycie dokumentu w myCarlos nie usuwa tych kopii ani źródłowej dokumentacji medycznej w przychodni.

security-copies-title = Czytelne kopie i zrzuty ekranu

security-devBuild-body = Proszę używać wyłącznie fikcyjnych plików.

security-devBuild-title = Wersja rozwojowa.

security-encryption-body = Pliki, nazwy, foldery i szczegóły dokumentów są szyfrowane na tym urządzeniu.

security-encryption-state = Włączone — zawsze

security-encryption-title = Szyfrowanie

security-erase-body = Trwale usuwa wszystkie zaszyfrowane dokumenty, profile i foldery. Tej operacji nie można cofnąć.

security-erase-show = Pokaż opcje usuwania

security-erase-submit = Usuń cały sejf

security-erase-title = Usuń cały sejf

security-lockNow = Zablokuj teraz

security-oldBackups-deleteOlder = Proszę usunąć starsze kopie zapasowe: pliki, których nazwy zaczynają się od „myCarlos backup”, oraz te, których nazwy zostały zmienione, z wyjątkiem nowej kopii i jej kopii. Znajdują się tam, gdzie zostały zapisane: w folderze, na pendrivie, a na telefonie w aplikacji Pliki lub na dysku w chmurze.

security-oldBackups-done = Starsze kopie zapasowe są załatwione

security-oldBackups-inPlace = Jeśli została zapisana w miejsce starszej kopii zapasowej, ten plik jest teraz nową kopią zapasową: proszę go zachować.

security-oldBackups-intro = Zestaw do wcześniejszego klucza odzyskiwania mógł zostać zgubiony lub zobaczony przez kogoś, a nadal otwiera kopie zapasowe zapisane przed zastąpieniem tego klucza.

security-oldBackups-justSaved = Nowa kopia zapasowa to ta właśnie zapisana, { $date } około { $time }: aplikacja do plików pokazuje, kiedy zapisano każdy plik, oraz jego rozmiar.

security-oldBackups-justSavedWithSize = Nowa kopia zapasowa to ta właśnie zapisana, { $date } około { $time } ({ $size }): aplikacja do plików pokazuje, kiedy zapisano każdy plik, oraz jego rozmiar.

security-oldBackups-keepCopy = Proszę przechowywać ją, lub jej kopię, poza tym urządzeniem, na przykład na pendrivie lub dysku w chmurze.

security-oldBackups-named = Nowa kopia zapasowa to „{ $name }”.

security-oldBackups-namedWithSize = Nowa kopia zapasowa to „{ $name }” ({ $size }).

security-oldBackups-none = Nie mam starszych kopii zapasowych

security-oldBackups-saveNow = Proszę teraz zapisać nową kopię zapasową: wybrać Zapisz zaszyfrowaną kopię zapasową.

security-oldBackups-saveWhenWritable = Gdy sejf znów będzie przyjmował zmiany, proszę zapisać nową kopię zapasową: wybrać Zapisz zaszyfrowaną kopię zapasową.

security-oldBackups-thenDelete = Następnie należy usunąć starsze kopie zapasowe. Po zapisaniu nowej pojawi się tu opis, jak to zrobić.

security-oldBackups-title = Starsze kopie zapasowe

security-passphrase-copies = Zmiana hasła głównego zatrzymuje kogoś, kto zna tylko stare. Jeśli ta osoba może mieć też kopię sejfu, na przykład kopię zapasową tego urządzenia lub zapisany plik kopii zapasowej, nowe hasło główne nie wystarczy: stare nadal otwiera tę kopię, a dzięki niej osoba ta mogłaby otworzyć nowszą, zdobytą później. Odcięcie jej dostępu wymaga nowego sejfu i ostrożności, by po drodze nie stracić dokumentów. Przed odłożeniem sejfu na bok proszę poprosić o pomoc.

security-passphrase-current = Obecne hasło główne

security-passphrase-currentTooLong = Obecne hasło główne jest dłuższe niż jakiekolwiek hasło główne do sejfu. Proszę sprawdzić, co zostało wpisane.

security-passphrase-mismatch = Nowe hasła główne nie są takie same.

security-passphrase-newTooLong = Nowe hasło główne jest zbyt długie. Proszę je skrócić.

security-passphrase-newTooShort = Nowe hasło główne jest zbyt krótkie. Proszę użyć co najmniej { $min } znaków.

security-passphrase-rules = Proszę użyć co najmniej { $min } znaków i unikać popularnych imion oraz przewidywalnych fraz. Klucz odzyskiwania, jeśli jest, nadal działa; bez niego zapomnienie nowego hasła głównego oznacza odłożenie sejfu na bok i rozpoczęcie od nowa.

security-passphrase-submit = Zmień hasło główne

security-passphrase-title = Zmiana hasła głównego

security-profiles-add = Dodaj profil

security-profiles-body = Dokumenty każdej osoby są przechowywane w tym sejfie oddzielnie.

security-profiles-label = Nazwa nowego profilu

security-profiles-title = Profile pacjentów

security-recoveryKey-body = Otwiera sejf w razie zapomnienia hasła głównego. Ma go tylko jego właściciel: nikt w przychodni ani w myCarlos nie otworzy sejfu w jego imieniu. Zastąpienie go sprawia, że stary przestaje działać.

security-recoveryKey-current = Obecny klucz ma etykietę { $label }. Działa zestaw lub notatka z tą etykietą; zestaw z inną etykietą nie otworzy tego sejfu. Zestawy i notatki sprzed wprowadzenia etykiet ich nie mają: taki bez etykiety może nadal być tym kluczem, skonfigurowanym { $date }.

security-recoveryKey-notSetUp = Nieskonfigurowany

security-recoveryKey-replace = Zastąp klucz odzyskiwania

security-recoveryKey-setUp = Skonfiguruj klucz odzyskiwania

security-recoveryKey-setUpOn = Skonfigurowano { $date }

security-recoveryKey-title = Klucz odzyskiwania

security-speed-body = Mierzy, ile czasu to urządzenie potrzebuje na sprawdzenie hasła głównego. Używa wymyślonego hasła, a nie hasła użytkownika, i niczego nie zmienia. Trwa kilka sekund, dłużej na starszym telefonie. Proszę najpierw zamknąć inne aplikacje i pozostać na tym ekranie do końca testu. Wynik należy wysłać razem z marką i modelem urządzenia.

security-speed-measuring = Pomiar…

security-speed-run = Uruchom test szybkości

security-speed-title = Test szybkości, dla testerów

security-subtitle = Zaszyfrowany sejf i ustawienia dostępu

security-title = Bezpieczeństwo

sidebar-documents =
    { $count ->
    [one] { $count } dokument
    [few] { $count } dokumenty
    [many] { $count } dokumentów
    *[other] { $count } dokumentu
    }

sidebar-folderCount =
    { $count ->
    [one] { $count } folder
    [few] { $count } foldery
    [many] { $count } folderów
    *[other] { $count } folderu
    }

sidebar-label = Biblioteka dokumentów

sidebar-myRecords = Moje dokumenty

sidebar-preferences = Preferencje

sidebar-settings = Ustawienia

sidebar-storage = Lokalny zaszyfrowany sejf

textSize-announce = Rozmiar tekstu { $percent }

textSize-between = { $typed }% wypada między rozmiarami, więc ustawiono { $size }.

textSize-box = Rozmiar tekstu w procentach

textSize-followsDevice = Tutaj rozmiar tekstu zależy od urządzenia: od jego ustawienia rozmiaru tekstu lub od powiększenia w przeglądarce.

textSize-help = Powiększa lub pomniejsza wszystko w myCarlos, od { $min }% do { $max }%. myCarlos zapamiętuje rozmiar na tym komputerze. Można też przytrzymać klawisz { $modifier } i nacisnąć plus, minus lub 0.

textSize-key-command = Command

textSize-larger = Większy tekst

textSize-largest = Największy rozmiar to { $max }%.

textSize-notNumber = Proszę wpisać liczbę od { $min } do { $max }.

textSize-reset = Przywróć normalny rozmiar

textSize-smaller = Mniejszy tekst

textSize-smallest = Najmniejszy rozmiar to { $min }%.

textSize-title = Rozmiar tekstu

unlock-autoLock =
    { $count ->
    [one] Sejf blokuje się po { $count } minucie bezczynności oraz za każdym razem, gdy myCarlos zostaje ukryty, na przykład zminimalizowany lub przeniesiony do tła.
    [few] Sejf blokuje się po { $count } minutach bezczynności oraz za każdym razem, gdy myCarlos zostaje ukryty, na przykład zminimalizowany lub przeniesiony do tła.
    [many] Sejf blokuje się po { $count } minutach bezczynności oraz za każdym razem, gdy myCarlos zostaje ukryty, na przykład zminimalizowany lub przeniesiony do tła.
    *[other] Sejf blokuje się po { $count } minuty bezczynności oraz za każdym razem, gdy myCarlos zostaje ukryty, na przykład zminimalizowany lub przeniesiony do tła.
    }

unlock-forgot-summary = Nie pamiętasz hasła głównego?

unlock-noKey-body = Bez niego jedynym sposobem powrotu jest odłożenie tego sejfu i rozpoczęcie od nowa. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany. Do jego otwarcia potrzebne jest jego pierwotne hasło główne lub pasujący klucz odzyskiwania.

unlock-noKey-heading = Nie masz klucza odzyskiwania?

unlock-submit = Odblokuj

unlock-title = Odblokuj sejf

unlock-waiting =
    { $count ->
    [one] { $count } udostępniony plik czeka. Po odblokowaniu sejfu trafi do „{ $folder }”. Jeśli myCarlos zostanie wcześniej zamknięty, plik nie zostanie zachowany: proszę udostępnić go ponownie.
    [few] { $count } udostępnione pliki czekają. Po odblokowaniu sejfu trafią do „{ $folder }”. Jeśli myCarlos zostanie wcześniej zamknięty, pliki nie zostaną zachowane: proszę udostępnić je ponownie.
    [many] { $count } udostępnionych plików czeka. Po odblokowaniu sejfu trafią do „{ $folder }”. Jeśli myCarlos zostanie wcześniej zamknięty, pliki nie zostaną zachowane: proszę udostępnić je ponownie.
    *[other] { $count } udostępnionego pliku czeka. Po odblokowaniu sejfu trafią do „{ $folder }”. Jeśli myCarlos zostanie wcześniej zamknięty, pliki nie zostaną zachowane: proszę udostępnić je ponownie.
    }

unlock-waiting-one = Jeden udostępniony plik czeka. Po odblokowaniu sejfu trafi do „{ $folder }”. Jeśli myCarlos zostanie wcześniej zamknięty, plik nie zostanie zachowany: proszę udostępnić go ponownie.

language-error-formatting = myCarlos nie może poprawnie wyświetlić tego komunikatu. Wybierz inny język lub uruchom aplikację ponownie, a przed kolejną próbą sprawdź swoje dokumenty.

error-newerFormat-backup = Ta kopia zapasowa została zapisana przez nowszą wersję myCarlos. Proszę zaktualizować myCarlos, aby ją przywrócić. Nic na tym urządzeniu nie zostało zmienione.

error-newerFormat-vault = Ten sejf został zapisany przez nowszą wersję myCarlos. Proszę zaktualizować myCarlos, aby go otworzyć. Nic nie zostało zmienione.

personDetails-birthDate = Data urodzenia

personDetails-birthDateRequired = Wpisz datę urodzenia lub zaznacz, że jej nie znasz.

personDetails-birthDateUnknown = Nie znam daty urodzenia tej osoby

personDetails-cancel = Anuluj

personDetails-edit = Edytuj dane

personDetails-editFor = Edytuj dane osoby { $name }

personDetails-for = Dane osoby { $name }

personDetails-fullName = Imię i nazwisko, jak na dokumentach z przychodni

personDetails-fullNameRequired = Wpisz imię i nazwisko tej osoby.

personDetails-futureDate = Data urodzenia nie może być w przyszłości.

personDetails-help = Przechowywane w tym zaszyfrowanym sejfie, aby sugerować, dla kogo jest udostępniony dokument. Te dane nie potwierdzają źródła dokumentu.

personDetails-invalidDate = Wpisz prawidłową datę urodzenia: rok, miesiąc i dzień.

personDetails-list = Dane osób

personDetails-nameTooLong = Imię i nazwisko są zbyt długie. Skróć je.

personDetails-noDate = Brak daty urodzenia

personDetails-noName = Brak imienia i nazwiska

personDetails-save = Zapisz dane

personDetails-saved = Zapisano dane osoby { $name }.

personSuggestion-byBoth = data urodzenia i imię i nazwisko w dokumencie są zgodne

personSuggestion-byDate = data urodzenia w dokumencie jest zgodna

personSuggestion-byName = imię i nazwisko w dokumencie są zgodne

personSuggestion-dismiss = To nie ta osoba

personSuggestion-dismissLabel = To nie ta osoba: { $document }

personSuggestion-for = Sugerowana osoba dla dokumentu { $document }

personSuggestion-move = Przenieś

personSuggestion-moveLabel = Przenieś { $document } do dokumentacji osoby { $name }

personSuggestion-offer = Wygląda na to, że ten dokument jest dla osoby { $name } ({ $why }). Przenieść go do jej dokumentacji?

portal-address = Adres HTTPS portalu

portal-approvalCancelled = Ta prośba o zatwierdzenie została anulowana. Sprawdź aktualizacje przed rozpoczęciem nowej prośby.

portal-approvalContact = Zatwierdzenie przez przychodnię wymaga sprawdzenia. Skontaktuj się z przychodnią, aby ustalić dalsze kroki.

portal-approvalExpired = Ta prośba o zatwierdzenie wygasła. Sprawdź aktualizacje przed rozpoczęciem nowej prośby.

portal-approvalMissing = Nie znaleziono zapisanej prośby o zatwierdzenie w portalu. Wyślij ponownie zapisaną prośbę.

portal-approvalRefused = Przychodnia odrzuciła prośbę o zatwierdzenie tego urządzenia. Skontaktuj się z przychodnią, aby ustalić dalsze kroki.

portal-approved = Przychodnia zatwierdziła to urządzenie.

portal-awaiting = Zapisano prośbę o zatwierdzenie. Sprawdź aktualizacje lub wyślij ją ponownie.

portal-check = Sprawdź nowe dokumenty

portal-clinicIssue = { $clinic }: { $detail }

portal-code = Kod połączenia

portal-compare = Poproś personel przychodni o porównanie całego odcisku na tym ekranie przed zatwierdzeniem urządzenia.

portal-confirmationsPending = Zapisane dokumenty oczekujące na potwierdzenie odbioru: { $count }. Sprawdź ponownie, aby dokończyć potwierdzenie. Zapisane kopie pozostają w sejfie.

portal-copied = Skopiowano kod urządzenia.

portal-copy = Kopiuj kod urządzenia

portal-copyFailed = Zaznacz cały kod urządzenia i skopiuj go.

portal-dateNotRecorded = Data nie została zapisana

portal-deviceCode = Kod urządzenia

portal-deviceName = Nazwa tego urządzenia

portal-errorAddress = Wpisz adres HTTPS portalu bez nazwy użytkownika, hasła, parametrów zapytania ani fragmentu.

portal-errorCancelled = Łączenie zostało przerwane, ponieważ sejf został zablokowany. Sprawdź połączone urządzenia w portalu przed kolejną próbą.

portal-errorCode = Wpisz pełny kod połączenia wyświetlany w portalu pacjenta.

portal-errorCodeRejected = Portal nie zaakceptował kodu. Utwórz nowy kod połączenia w portalu pacjenta.

portal-errorDamaged = Zapisany dokument z tej przychodni jest uszkodzony lub go brakuje, dlatego nie wysłano potwierdzenia jego odbioru. Pozostałe dokumenty zostały sprawdzone. Przywróć go z kopii zapasowej albo poproś przychodnię o ponowne wysłanie.

portal-errorDeviceName = Wybierz nazwę urządzenia o długości od 1 do 64 znaków, bez znaków sterujących.

portal-errorDisabled = Łączenie z portalem nie jest włączone w tej wersji.

portal-errorExists = To urządzenie jest już zarejestrowane. Sprawdź połączone urządzenia w portalu pacjenta.

portal-errorIncomplete = Nie udało się wykonać żądania do portalu. Sprawdź połączenie i zegar urządzenia, a następnie spróbuj ponownie.

portal-errorKeys = Przychodnia nie opublikowała jeszcze klucza podpisu. Połączenie jest nieukończone.

portal-errorRefused = Nie udało się zweryfikować dokumentu z przychodni. Nie dodano go ani nie wysłano potwierdzenia odbioru.

portal-errorUnavailable = Łączenie z portalem nie jest jeszcze dostępne na tym urządzeniu.

portal-fingerprint = Pełny odcisk urządzenia

portal-incomplete = Połączenie nie zostało ukończone. Sprawdź połączone urządzenia w portalu przed kolejną próbą.

portal-intro = Połącz myCarlos, używając adresu i kodu z portalu pacjenta.

portal-link = Połącz z przychodnią

portal-matchPerson = Dopasuj dane z dokumentu

portal-notRequested = Poproś przychodnię o zatwierdzenie, aby odbierać dokumenty na tym urządzeniu.

portal-partialResult = Niektóre sprawdzenia w przychodniach wymagają uwagi. Zapisano nowych dokumentów: { $added }. Nie udało się zweryfikować dokumentów: { $refused }.

portal-person = Czyja dokumentacja

portal-requestApproval = Poproś przychodnię o zatwierdzenie

portal-restartApproval = Rozpocznij nową prośbę o zatwierdzenie

portal-result = Zapisano nowych dokumentów: { $added }. Nie udało się zweryfikować dokumentów: { $refused }.

portal-routing = Dokumenty trafiają do osoby o zgodnym pełnym imieniu i nazwisku oraz dacie urodzenia. Pozostałe trafiają do Udostępnionych mi.

portal-serviceDate = Data świadczenia: { $date }

portal-serviceDateLabel = Data świadczenia

portal-sourceVerified = Z { $clinic } · Zweryfikowano

portal-title = Dokumenty z przychodni

rename-help-profile = Zmienia to tylko wyświetlaną nazwę folderu. Foldery i dokumenty osoby pozostają na swoim miejscu.

rename-label-profile = Nazwa folderu

rename-profile-action = Zmień nazwę „{ $name }”

rename-profile-controls = Nazwy nie mogą zawierać znaków sterujących.

rename-profile-saved = Nazwa folderu została zmieniona na { $name }.

rename-title-profile = Zmień nazwę folderu osoby

hidden-backToSecurity = Powrót do zabezpieczeń

interface-history-appVersion = Wersja myCarlos

interface-history-damaged = Część tej historii jest uszkodzona. Zdarzenia po { $date } nie mogą zostać zweryfikowane i nie są wyświetlane.

interface-history-damagedAll = Część tej historii jest uszkodzona. Jej zdarzeń nie można zweryfikować, więc nie wyświetlono żadnego z nich.

interface-history-damagedBefore = Część tej historii jest uszkodzona. Zdarzenia sprzed { $date } nie mogą zostać zweryfikowane i nie są wyświetlane.

interface-history-damagedBetween = Część tej historii jest uszkodzona. Zdarzenia między { $from } a { $to } nie mogą zostać zweryfikowane i nie są wyświetlane.

interface-history-empty = Brak zdarzeń w historii.

interface-history-error-unverified = Nie udało się odczytać ani zweryfikować historii. Nie wyświetlono żadnych zdarzeń.

interface-history-event-backupRestored = Przywrócono kopię zapasową

interface-history-event-backupSaved = Zapisano zaszyfrowaną kopię zapasową

interface-history-event-copySaved = Zapisano czytelną kopię

interface-history-event-created = Utworzono sejf

interface-history-event-folderCreated = Utworzono folder

interface-history-event-folderMoved = Przeniesiono folder

interface-history-event-folderRenamed = Zmieniono nazwę folderu

interface-history-event-hidden = Ukryto dokument

interface-history-event-historyStarted = Rozpoczęto zapisywanie historii

interface-history-event-imported = Dodano dokument

interface-history-event-moved = Przeniesiono dokument

interface-history-event-passphraseChanged = Zmieniono hasło

interface-history-event-profileCreated = Dodano profil pacjenta

interface-history-event-recoveryKeySet = Ustawiono klucz odzyskiwania

interface-history-event-renamed = Zmieniono nazwę dokumentu

interface-history-event-restored = Przywrócono dokument

interface-history-event-setAside = Odłożono sejf

interface-history-event-unlocked = Otworzono sejf

interface-history-events =
    { $count ->
    [one] { $count } zdarzenie
    [few] { $count } zdarzenia
    [many] { $count } zdarzeń
    *[other] { $count } zdarzenia
    }

interface-history-from = Z

interface-history-gap = Zdarzenia w tym miejscu nie mogą zostać zweryfikowane i nie są wyświetlane.

interface-history-how = Sposób

interface-history-how-camera = Dodano za pomocą aparatu

interface-history-how-damaged = Ukryto, ponieważ brakowało pliku

interface-history-how-importedShared = Dodano do Udostępnione mi

interface-history-how-movedFromShared = Przeniesiono z Udostępnione mi

interface-history-how-passphrase = Hasło

interface-history-how-patient = Ukryto ręcznie

interface-history-how-picked = Zaimportowano z wybranego pliku

interface-history-how-recoveryKey = Klucz odzyskiwania

interface-history-how-replaced = Przywrócono, zastępując istniejący sejf

interface-history-intro = Lista zdarzeń zapisana w zaszyfrowanym sejfie. Można ją tylko odczytywać.

interface-history-laterSessionNotRecorded = Co najmniej jedna późniejsza sesja nie została zapisana.

interface-history-loading = Sprawdzanie i odczytywanie całej historii…

interface-history-moreFolders =
    { $count ->
    [one] jeszcze { $count } folder
    [few] jeszcze { $count } foldery
    [many] jeszcze { $count } folderów
    *[other] jeszcze { $count } foldera
    }

interface-history-name = Nazwa

interface-history-personRootFolder = Poziom główny dokumentów osoby

interface-history-place = Miejsce

interface-history-previousName = Poprzednia nazwa

interface-history-previousSession = Poprzednia sesja

interface-history-rootFolder = Poziom główny (nie zapisano lokalizacji)

interface-history-scopeNote = Niektóre wpisy nie wskazują osoby ani nie rozróżniają folderów o tej samej nazwie. Etykiety folderów to zapisane nazwy, a nie pełne ścieżki. Zapisane lokalizacje mogą być skrócone.

interface-history-sessionLockedAutomatically = Zablokowano automatycznie: { $date }

interface-history-sessionLockedByApp = Zablokowano przez aplikację: { $date }

interface-history-sessionLockedByPerson = Zablokowano ręcznie: { $date }

interface-history-sessionNotRecorded = Poprzednia sesja nie została zapisana.

interface-history-title = Historia zdarzeń

interface-history-to = Do

interface-SecuritySettings-myCarlosAlsoKeepsAHistoryWhenThe = myCarlos przechowuje też historię: kiedy otwarto sejf; kiedy ustawiono lub zmieniono hasło główne albo klucz odzyskiwania oraz kiedy zapisano lub przywrócono kopię zapasową; kiedy dodano każdy profil pacjenta i utworzono każdy folder, zmieniono jego nazwę lub go przeniesiono; a także kiedy dodano każdy dokument, zmieniono jego nazwę, przeniesiono go, ukryto, przywrócono lub zapisano poza myCarlos i gdzie. Historia jest zaszyfrowana wraz z całą resztą. Możesz ją tutaj przeglądać; myCarlos nigdy jej nie zmienia ani nie usuwa.
