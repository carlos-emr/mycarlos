import interfaceMessages from "./interface-pl.json";
import type { Message } from "../types";
import type { MessageKey } from "./en";

/** Polish. Plain, polite wording: "Proszę ..." for instructions in running text,
 * short imperatives for buttons and headings, as is usual in Polish interfaces.
 * Plural forms: one, few, many, other (fractions). */
export const pl: Record<MessageKey, Message> = {
  ...interfaceMessages,
  "frame.banner.title": "Wersja deweloperska z danymi fikcyjnymi",
  "frame.banner.body": "Nie należy używać prawdziwych danych pacjentów",
  "frame.window.label": "Prywatny sejf myCarlos",
  "frame.state.locked": "Zablokowany",
  "frame.state.locking": "Blokowanie",
  "frame.state.notLocked": "Odblokowany",
  "frame.state.settingUp": "Konfiguracja",
  "frame.state.opening": "Otwieranie",
  "auth.kicker": "Prywatne dokumenty myCarlos",

  "passphrase.label": "Hasło główne",
  "passphrase.confirm.label": "Powtórz hasło główne",
  "passphrase.new.label": "Nowe hasło główne",
  "passphrase.confirmNew.label": "Powtórz nowe hasło główne",
  "passphrase.rules":
    "Proszę użyć co najmniej {min} znaków. Spacje są dozwolone; popularne hasła, imiona i nazwiska oraz łatwe do odgadnięcia wzorce są odrzucane na tym urządzeniu.",
  "passphrase.mismatch": "Hasła główne nie są takie same.",
  "passphrase.tooLong": "To hasło główne jest zbyt długie. Proszę je skrócić.",
  "passphrase.tooShort":
    "To hasło główne jest zbyt krótkie. Proszę użyć co najmniej {min} znaków.",
  "passphrase.longerThanAny":
    "Ten tekst jest dłuższy niż jakiekolwiek hasło główne do sejfu. Proszę sprawdzić, co zostało wpisane.",

  "passphrase.show": "Pokaż hasło główne",
  "passphrase.show.inConfirm": "w polu Powtórz hasło główne",

  "checklist.heading": "Hasło główne musi być:",
  "checklist.length": "Długie na co najmniej {min} znaków",
  "checklist.hardToGuess": "Trudne do odgadnięcia",
  "checklist.notAName": "Inne niż imię i nazwisko",
  "checklist.done": ", spełnione",
  "checklist.notYet": ", jeszcze nie",
  "checklist.spaces":
    "Spacje są dozwolone, więc kilka niezwiązanych ze sobą słów to dobre hasło główne. myCarlos sprawdza te zasady na tym komputerze.",
  "checklist.allMet": "Hasło główne spełnia wszystkie zasady.",

  "create.title": "Skonfiguruj myCarlos na tym komputerze",
  "create.intro":
    "Pliki i szczegóły dokumentów są szyfrowane na tym urządzeniu. Hasło główne otwiera sejf. Następnie można skonfigurować klucz odzyskiwania na wypadek zapomnienia hasła głównego.",
  "create.stays":
    "Sejf pozostaje na tym urządzeniu. Jeśli został utworzony na innym urządzeniu, nadal tam jest i nie pojawi się tutaj.",
  "create.profile.label": "Czyje dokumenty będą tu przechowywane?",
  "create.profile.tooLong": "Ta nazwa jest zbyt długa. Proszę ją skrócić.",
  "create.profile.sharedTaken":
    "„{folder}” to miejsce, do którego trafiają udostępnione pliki. Proszę wybrać inną nazwę.",
  "create.submit": "Utwórz sejf",

  "unlock.title": "Odblokuj sejf",
  "unlock.autoLock": {
    one: "Sejf blokuje się po {count} minucie bezczynności oraz za każdym razem, gdy myCarlos zostaje ukryty, na przykład zminimalizowany lub przeniesiony do tła.",
    few: "Sejf blokuje się po {count} minutach bezczynności oraz za każdym razem, gdy myCarlos zostaje ukryty, na przykład zminimalizowany lub przeniesiony do tła.",
    many: "Sejf blokuje się po {count} minutach bezczynności oraz za każdym razem, gdy myCarlos zostaje ukryty, na przykład zminimalizowany lub przeniesiony do tła.",
    other:
      "Sejf blokuje się po {count} minuty bezczynności oraz za każdym razem, gdy myCarlos zostaje ukryty, na przykład zminimalizowany lub przeniesiony do tła.",
  },
  "unlock.waiting.one":
    "Jeden udostępniony plik czeka. Po odblokowaniu sejfu trafi do „{folder}”. Jeśli myCarlos zostanie wcześniej zamknięty, plik nie zostanie zachowany: proszę udostępnić go ponownie.",
  "unlock.waiting": {
    one: "{count} udostępniony plik czeka. Po odblokowaniu sejfu trafi do „{folder}”. Jeśli myCarlos zostanie wcześniej zamknięty, plik nie zostanie zachowany: proszę udostępnić go ponownie.",
    few: "{count} udostępnione pliki czekają. Po odblokowaniu sejfu trafią do „{folder}”. Jeśli myCarlos zostanie wcześniej zamknięty, pliki nie zostaną zachowane: proszę udostępnić je ponownie.",
    many: "{count} udostępnionych plików czeka. Po odblokowaniu sejfu trafią do „{folder}”. Jeśli myCarlos zostanie wcześniej zamknięty, pliki nie zostaną zachowane: proszę udostępnić je ponownie.",
    other:
      "{count} udostępnionego pliku czeka. Po odblokowaniu sejfu trafią do „{folder}”. Jeśli myCarlos zostanie wcześniej zamknięty, pliki nie zostaną zachowane: proszę udostępnić je ponownie.",
  },
  "unlock.submit": "Odblokuj",
  "unlock.forgot.summary": "Nie pamiętasz hasła głównego?",
  "unlock.noKey.heading": "Nie masz klucza odzyskiwania?",
  "unlock.noKey.body":
    "Bez niego jedynym sposobem powrotu jest odłożenie tego sejfu i rozpoczęcie od nowa. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany, ale nikt nie może go otworzyć bez jego hasła głównego.",
  "restore.summary": "Przywróć z kopii zapasowej",

  "reset.plainly":
    "Odłożenie sejfu usuwa z myCarlos na tym komputerze wszystkie dokumenty, foldery i profile pacjentów. Pozostają one na tym komputerze, zaszyfrowane, ale nikt nie może ich otworzyć bez hasła głównego. Aby potwierdzić, proszę wpisać dokładnie poniższe słowa.",
  "reset.type": "Wpisz {phrase}",
  "reset.submit": "Odłóż sejf",

  "recover.intro":
    "Użyj klucza odzyskiwania, aby otworzyć sejf i wybrać nowe hasło główne.",
  "recover.key.label": "Klucz odzyskiwania",
  "recover.key.format":
    "28 liter i cyfr, w 7 grupach po 4, tak jak na zestawie lub tak, jak zostały zapisane. Myślniki, spacje i inne znaki interpunkcyjne nie mają znaczenia.",
  "recover.key.show": "Pokaż klucz odzyskiwania",
  "recover.submit": "Otwórz kluczem odzyskiwania",

  "secret.count.password": {
    one: "Hasło główne: {count} znak",
    few: "Hasło główne: {count} znaki",
    many: "Hasło główne: {count} znaków",
    other: "Hasło główne: {count} znaku",
  },
  "secret.count.recoveryKey": {
    one: "Klucz odzyskiwania: {count} znak",
    few: "Klucz odzyskiwania: {count} znaki",
    many: "Klucz odzyskiwania: {count} znaków",
    other: "Klucz odzyskiwania: {count} znaku",
  },
  "secret.count.shown": "{description}, widoczne",

  "restore.intro":
    "Zaszyfrowaną kopię zapasową otwiera hasło główne, którego użyto przy jej tworzeniu, albo klucz odzyskiwania, jaki sejf miał w chwili zapisania kopii, jeśli go miał.",
  "restore.choose": "Wybierz plik kopii zapasowej…",
  "restore.chooseOther": "Wybierz inną kopię zapasową…",
  "restore.chosen": "Wybrano kopię zapasową.",
  "restore.openWith": "Otwórz za pomocą",
  "restore.method.passphrase": "Jej hasła głównego",
  "restore.method.recoveryKey": "Jej klucza odzyskiwania",
  "restore.passphrase.label": "Hasło główne kopii zapasowej",
  "restore.passphrase.show": "Pokaż hasło główne",
  "restore.tooLong":
    "To jest zbyt długie. Proszę sprawdzić, co zostało wpisane.",
  "restore.check": "Sprawdź kopię zapasową",
  "restore.checking": "Sprawdzanie kopii zapasowej…",
  "restore.checked": {
    one: "Kopia zapasowa zawiera {count} dokument. {consequence}",
    few: "Kopia zapasowa zawiera {count} dokumenty. {consequence}",
    many: "Kopia zapasowa zawiera {count} dokumentów. {consequence}",
    other: "Kopia zapasowa zawiera {count} dokumentu. {consequence}",
  },
  "restore.consequence.nothing":
    "Przywrócenie umieszcza ten sejf na tym urządzeniu.",
  "restore.consequence.same":
    "Sejf na tym urządzeniu zawiera te same dokumenty. Przywrócenie odkłada go i umieszcza w jego miejscu tę kopię zapasową. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany, ale myCarlos nie może go jeszcze ponownie otworzyć.",
  "restore.consequence.differs":
    "Sejf na tym urządzeniu może nie być taki sam jak ta kopia zapasowa: mógł się od tego czasu zmienić albo jego część nie mogła zostać odczytana. Przywrócenie odkłada sejf i umieszcza w jego miejscu kopię zapasową: tego, czego nie ma w kopii, nie będzie już w używanym sejfie, a hasło główne i klucz odzyskiwania stają się tymi, z którymi wykonano kopię. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany, ale myCarlos nie może go jeszcze ponownie otworzyć.",
  "restore.consequence.otherVault":
    "To urządzenie ma inny sejf. Przywrócenie odkłada go i umieszcza w jego miejscu kopię zapasową. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany, ale myCarlos nie może go jeszcze ponownie otworzyć.",
  "restore.consequence.unreadable":
    "Sejfu na tym urządzeniu nie udało się odczytać, więc myCarlos nie może stwierdzić, czy jest to ten, z którego wykonano tę kopię zapasową. Przywrócenie odkłada go i umieszcza w jego miejscu kopię zapasową. Odłożony sejf pozostaje na tym urządzeniu, zaszyfrowany, ale myCarlos nie może go jeszcze ponownie otworzyć.",
  "restore.agree.erase":
    "Odłóż sejf z tego urządzenia i przywróć kopię zapasową",
  "restore.agree.replace":
    "Odłóż sejf z tego urządzenia, razem ze zmianami wprowadzonymi od tego czasu, i przywróć tę kopię zapasową",
  "restore.submit": "Przywróć kopię zapasową",
  "restore.restoring":
    "Przywracanie kopii zapasowej. W przypadku dużego sejfu może to chwilę potrwać…",
  "restore.cancelled": "Przywracanie anulowane. Nic się nie zmieniło.",

  // Shared
  "common.cancel": "Anuluj",

  // Library sidebar
  "sidebar.label": "Biblioteka dokumentów",
  "sidebar.myRecords": "Moje dokumenty",
  "sidebar.settings": "Ustawienia",
  "sidebar.preferences": "Preferencje",
  "sidebar.storage": "Lokalny zaszyfrowany sejf",
  "sidebar.documents": {
    one: "{count} dokument",
    few: "{count} dokumenty",
    many: "{count} dokumentów",
    other: "{count} dokumentu",
  },
  "sidebar.folderCount": {
    one: "{count} folder",
    few: "{count} foldery",
    many: "{count} folderów",
    other: "{count} folderu",
  },

  // Text size (Settings > Preferences)
  "textSize.title": "Rozmiar tekstu",
  "textSize.announce": "Rozmiar tekstu {percent}",
  "textSize.help":
    "Powiększa lub pomniejsza wszystko w myCarlos, od {min}% do {max}%. myCarlos zapamiętuje rozmiar na tym komputerze. Można też przytrzymać klawisz {modifier} i nacisnąć plus, minus lub 0.",
  "textSize.key.command": "Command",
  "textSize.smaller": "Mniejszy tekst",
  "textSize.larger": "Większy tekst",
  "textSize.box": "Rozmiar tekstu w procentach",
  "textSize.reset": "Przywróć normalny rozmiar",
  "textSize.notNumber": "Proszę wpisać liczbę od {min} do {max}.",
  "textSize.smallest": "Najmniejszy rozmiar to {min}%.",
  "textSize.largest": "Największy rozmiar to {max}%.",
  "textSize.between":
    "{typed}% wypada między rozmiarami, więc ustawiono {size}.",

  // Rename a document or folder
  "rename.title.document": "Zmień nazwę dokumentu",
  "rename.title.folder": "Zmień nazwę folderu",
  "rename.label.folder": "Nazwa folderu",
  "rename.label.document": "Nazwa pliku",
  "rename.help.folder":
    "Folder i jego zawartość pozostają w tym samym miejscu.",
  "rename.help.document":
    "Zmienia to nazwę w myCarlos oraz nazwę proponowaną przy eksporcie.",
  "rename.help.documentExtension":
    "Zmienia to nazwę w myCarlos oraz nazwę proponowaną przy eksporcie. Rozszerzenie {extension} pozostaje bez zmian.",
  "rename.stemMissing": "Proszę wpisać nazwę przed {extension}.",
  "rename.gainsExtension":
    "Nazwa tego dokumentu nie ma rozszerzenia .pdf, więc nie może kończyć się na .pdf.",
  "rename.tooLong": "Ta nazwa jest zbyt długa. Proszę ją skrócić, aby zapisać.",
  "rename.unsafe":
    "Nazwy dokumentów nie mogą zawierać znaków {characters} ani niewidocznych znaków sterujących ani kończyć się kropką.",
  "rename.reserved":
    "„{word}” nie może być nazwą dokumentu, ponieważ Windows zastrzega tę nazwę na własny użytek. Proszę wybrać inną nazwę.",
  "rename.saving": "Zapisywanie…",
  "rename.save": "Zapisz nazwę",

  // Settings > Security
  "security.title": "Bezpieczeństwo",
  "security.subtitle": "Zaszyfrowany sejf i ustawienia dostępu",
  "security.devBuild.title": "Wersja rozwojowa.",
  "security.devBuild.body": "Proszę używać wyłącznie fikcyjnych plików.",
  "security.encryption.title": "Szyfrowanie",
  "security.encryption.state": "Włączone — zawsze",
  "security.encryption.body":
    "Pliki, nazwy, foldery i szczegóły dokumentów są szyfrowane na tym urządzeniu.",
  "security.autoLock.title": "Automatyczna blokada",
  "security.autoLock.minutes": {
    one: "{count} minuta",
    few: "{count} minuty",
    many: "{count} minut",
    other: "{count} minuty",
  },
  "security.autoLock.body":
    "Sejf blokuje się po wybranym czasie bez aktywności klawiatury, wskaźnika lub ekranu dotykowego. Proszę wybrać od 1 do 15 minut.",
  "security.autoLock.label": "Czas do automatycznej blokady",
  "security.autoLock.shorter": "Krótszy czas",
  "security.autoLock.longer": "Dłuższy czas",
  "security.lockNow": "Zablokuj teraz",
  "security.recoveryKey.title": "Klucz odzyskiwania",
  "security.recoveryKey.setUpOn": "Skonfigurowano {date}",
  "security.recoveryKey.notSetUp": "Nieskonfigurowany",
  "security.recoveryKey.body":
    "Otwiera sejf w razie zapomnienia hasła głównego. Ma go tylko jego właściciel: nikt w przychodni ani w myCarlos nie otworzy sejfu w jego imieniu. Zastąpienie go sprawia, że stary przestaje działać.",
  "security.recoveryKey.current":
    "Obecny klucz ma etykietę {label}. Działa zestaw lub notatka z tą etykietą; zestaw z inną etykietą nie otworzy tego sejfu. Zestawy i notatki sprzed wprowadzenia etykiet ich nie mają: taki bez etykiety może nadal być tym kluczem, skonfigurowanym {date}.",
  "security.recoveryKey.replace": "Zastąp klucz odzyskiwania",
  "security.recoveryKey.setUp": "Skonfiguruj klucz odzyskiwania",
  "security.backup.title": "Zaszyfrowana kopia zapasowa",
  "security.backup.body":
    "Jeden plik z całym sejfem, nadal zaszyfrowanym. Proszę przechowywać go poza tym urządzeniem, na przykład na dysku USB. Otwiera go hasło główne lub klucz odzyskiwania obowiązujące w chwili zapisania i nadal go otwierają, nawet po ich zmianie tutaj. Aby przywrócić kopię, należy zablokować sejf i wybrać Przywróć z kopii zapasowej.",
  "security.oldBackups.title": "Starsze kopie zapasowe",
  "security.oldBackups.intro":
    "Zestaw do wcześniejszego klucza odzyskiwania mógł zostać zgubiony lub zobaczony przez kogoś, a nadal otwiera kopie zapasowe zapisane przed zastąpieniem tego klucza.",
  "security.oldBackups.saveWhenWritable":
    "Gdy sejf znów będzie przyjmował zmiany, proszę zapisać nową kopię zapasową: wybrać Zapisz zaszyfrowaną kopię zapasową.",
  "security.oldBackups.saveNow":
    "Proszę teraz zapisać nową kopię zapasową: wybrać Zapisz zaszyfrowaną kopię zapasową.",
  "security.oldBackups.keepCopy":
    "Proszę przechowywać ją, lub jej kopię, poza tym urządzeniem, na przykład na pendrivie lub dysku w chmurze.",
  "security.oldBackups.thenDelete":
    "Następnie należy usunąć starsze kopie zapasowe. Po zapisaniu nowej pojawi się tu opis, jak to zrobić.",
  "security.oldBackups.none": "Nie mam starszych kopii zapasowych",
  "security.oldBackups.named": "Nowa kopia zapasowa to „{name}”.",
  "security.oldBackups.namedWithSize":
    "Nowa kopia zapasowa to „{name}” ({size}).",
  "security.oldBackups.justSaved":
    "Nowa kopia zapasowa to ta właśnie zapisana, {date} około {time}: aplikacja do plików pokazuje, kiedy zapisano każdy plik, oraz jego rozmiar.",
  "security.oldBackups.justSavedWithSize":
    "Nowa kopia zapasowa to ta właśnie zapisana, {date} około {time} ({size}): aplikacja do plików pokazuje, kiedy zapisano każdy plik, oraz jego rozmiar.",
  "security.oldBackups.deleteOlder":
    "Proszę usunąć starsze kopie zapasowe: pliki, których nazwy zaczynają się od „myCarlos backup”, oraz te, których nazwy zostały zmienione, z wyjątkiem nowej kopii i jej kopii. Znajdują się tam, gdzie zostały zapisane: w folderze, na pendrivie, a na telefonie w aplikacji Pliki lub na dysku w chmurze.",
  "security.oldBackups.inPlace":
    "Jeśli została zapisana w miejsce starszej kopii zapasowej, ten plik jest teraz nową kopią zapasową: proszę go zachować.",
  "security.oldBackups.done": "Starsze kopie zapasowe są załatwione",
  "security.backup.save": "Zapisz zaszyfrowaną kopię zapasową…",
  "security.passphrase.title": "Zmiana hasła głównego",
  "security.passphrase.rules":
    "Proszę użyć co najmniej {min} znaków i unikać popularnych imion oraz przewidywalnych fraz. Klucz odzyskiwania, jeśli jest, nadal działa; bez niego zapomnienie nowego hasła głównego oznacza odłożenie sejfu na bok i rozpoczęcie od nowa.",
  "security.passphrase.copies":
    "Zmiana hasła głównego zatrzymuje kogoś, kto zna tylko stare. Jeśli ta osoba może mieć też kopię sejfu, na przykład kopię zapasową tego urządzenia lub zapisany plik kopii zapasowej, nowe hasło główne nie wystarczy: stare nadal otwiera tę kopię, a dzięki niej osoba ta mogłaby otworzyć nowszą, zdobytą później. Odcięcie jej dostępu wymaga nowego sejfu i ostrożności, by po drodze nie stracić dokumentów. Przed odłożeniem sejfu na bok proszę poprosić o pomoc.",
  "security.passphrase.current": "Obecne hasło główne",
  "security.passphrase.currentTooLong":
    "Obecne hasło główne jest dłuższe niż jakiekolwiek hasło główne do sejfu. Proszę sprawdzić, co zostało wpisane.",
  "security.passphrase.mismatch": "Nowe hasła główne nie są takie same.",
  "security.passphrase.newTooLong":
    "Nowe hasło główne jest zbyt długie. Proszę je skrócić.",
  "security.passphrase.newTooShort":
    "Nowe hasło główne jest zbyt krótkie. Proszę użyć co najmniej {min} znaków.",
  "security.passphrase.submit": "Zmień hasło główne",
  "security.speed.title": "Test szybkości, dla testerów",
  "security.speed.body":
    "Mierzy, ile czasu to urządzenie potrzebuje na sprawdzenie hasła głównego. Używa wymyślonego hasła, a nie hasła użytkownika, i niczego nie zmienia. Trwa kilka sekund, dłużej na starszym telefonie. Proszę najpierw zamknąć inne aplikacje i pozostać na tym ekranie do końca testu. Wynik należy wysłać razem z marką i modelem urządzenia.",
  "security.speed.run": "Uruchom test szybkości",
  "security.speed.measuring": "Pomiar…",
  "security.copies.title": "Czytelne kopie i zrzuty ekranu",
  "security.copies.body":
    "Wyeksportowane pliki i zrzuty ekranu nie są objęte ochroną sejfu. Ukrycie dokumentu w myCarlos nie usuwa tych kopii ani źródłowej dokumentacji medycznej w przychodni.",
  "security.profiles.title": "Profile pacjentów",
  "security.profiles.body":
    "Dokumenty każdej osoby są przechowywane w tym sejfie oddzielnie.",
  "security.profiles.label": "Nazwa nowego profilu",
  "security.profiles.add": "Dodaj profil",
  "security.erase.title": "Usuń cały sejf",
  "security.erase.body":
    "Trwale usuwa wszystkie zaszyfrowane dokumenty, profile i foldery. Tej operacji nie można cofnąć.",
  "security.erase.show": "Pokaż opcje usuwania",
  "security.erase.submit": "Usuń cały sejf",

  // Recovery key setup, and the printed kit
  "recoveryKey.printUnavailable":
    "Drukowanie nie jest tu dostępne. Proszę zapisać zestaw lub zanotować klucz.",
  "recoveryKey.chooseReason":
    "Proszę wybrać, dlaczego klucz odzyskiwania jest zastępowany.",
  "recoveryKey.kitSaved":
    "Zestaw odzyskiwania zapisany. Klucz zacznie działać po zakończeniu sprawdzania.",
  "recoveryKey.typedCount": {
    one: "Wpisano {count} literę lub cyfrę. Klucz odzyskiwania ma {total} liter i cyfr: 7 grup po 4. Proszę sprawdzić, co zostało zapisane.",
    few: "Wpisano {count} litery lub cyfry. Klucz odzyskiwania ma {total} liter i cyfr: 7 grup po 4. Proszę sprawdzić, co zostało zapisane.",
    many: "Wpisano {count} liter lub cyfr. Klucz odzyskiwania ma {total} liter i cyfr: 7 grup po 4. Proszę sprawdzić, co zostało zapisane.",
    other:
      "Wpisano {count} litery lub cyfry. Klucz odzyskiwania ma {total} liter i cyfr: 7 grup po 4. Proszę sprawdzić, co zostało zapisane.",
  },
  "recoveryKey.notChanged":
    "Klucz odzyskiwania nie został zmieniony. Obecny klucz nadal działa. Aby go zmienić, proszę ponownie nacisnąć Sprawdź i zapisz.",
  "recoveryKey.threeMisses":
    "Trzy razy z rzędu klucz się nie zgadzał. Proszę ponownie spojrzeć na klucz odzyskiwania, a potem go sprawdzić.",
  "recoveryKey.leave.required": "Zablokuj sejf i dokończ później",
  "recoveryKey.leave.offered": "Skonfiguruj później",
  "recoveryKey.title.replace": "Zastąp klucz odzyskiwania",
  "recoveryKey.title.setUp": "Skonfiguruj klucz odzyskiwania",
  "recoveryKey.title.key": "Klucz odzyskiwania",
  "recoveryKey.title.check": "Sprawdź klucz odzyskiwania",
  "recoveryKey.discard.title": "Odrzucić ten klucz odzyskiwania?",
  "recoveryKey.discard.body":
    "Ten klucz odzyskiwania nie jest jeszcze skonfigurowany, więc nigdy nie otworzy sejfu. myCarlos teraz blokuje sejf. Po odblokowaniu można będzie skonfigurować nowy klucz.",
  "recoveryKey.discard.confirm": "Odrzuć klucz i zablokuj",
  "recoveryKey.about.offered":
    "Sejf jest otwarty. Nie ma jeszcze klucza odzyskiwania. Bez niego, w razie zapomnienia hasła głównego, jedynym sposobem powrotu jest odłożenie sejfu na bok i rozpoczęcie od nowa.",
  "recoveryKey.about.what":
    "Klucz odzyskiwania otwiera sejf w razie zapomnienia hasła głównego. Będzie go mieć tylko właściciel sejfu: nikt w przychodni ani w myCarlos nie otworzy sejfu w jego imieniu.",
  "recoveryKey.about.replacing":
    "Obecny klucz odzyskiwania przestanie działać po sprawdzeniu nowego.",
  "recoveryKey.about.type":
    "Proszę wpisać hasło główne, aby utworzyć klucz odzyskiwania. Zaraz zostanie wyświetlony: proszę wybrać Dalej dopiero wtedy, gdy nikt inny nie widzi ekranu.",
  "recoveryKey.about.typeAgain":
    "Proszę ponownie wpisać hasło główne, aby utworzyć klucz odzyskiwania. Zaraz zostanie wyświetlony: proszę wybrać Dalej dopiero wtedy, gdy nikt inny nie widzi ekranu.",
  "recoveryKey.about.typeNew":
    "Proszę wpisać hasło główne, aby utworzyć nowy klucz odzyskiwania. Zaraz zostanie wyświetlony: proszę wybrać Dalej dopiero wtedy, gdy nikt inny nie widzi ekranu.",
  "recoveryKey.about.typeAgainNew":
    "Proszę ponownie wpisać hasło główne, aby utworzyć nowy klucz odzyskiwania. Zaraz zostanie wyświetlony: proszę wybrać Dalej dopiero wtedy, gdy nikt inny nie widzi ekranu.",
  "recoveryKey.reason.legend": "Dlaczego klucz jest zastępowany?",
  "recoveryKey.reason.hint":
    "W razie wątpliwości proszę wybrać pierwszą odpowiedź.",
  "recoveryKey.reason.exposed":
    "Zestaw lub notatka z kluczem mogły zostać zgubione albo zobaczone przez kogoś innego",
  "recoveryKey.reason.routine":
    "Chcę po prostu nowy klucz: zestaw jest bezpieczny",
  "recoveryKey.continue": "Dalej",
  "recoveryKey.keyboardHint":
    "Klawisz Esc zamyka tę konfigurację. Podczas pierwszej konfiguracji najpierw pojawia się pytanie, ponieważ wyjście blokuje sejf, a niedokończony klucz nie będzie działać.",
  "recoveryKey.instructions":
    "Proszę zapisać klucz albo zapisać lub wydrukować zestaw i przechowywać go w prywatnym miejscu, z dala od tego urządzenia. myCarlos pokazuje go tylko ten jeden raz. Następnie trzeba wpisać go w całości, aby go sprawdzić. Proszę pozostać w myCarlos do zakończenia sprawdzania: wyjście lub zablokowanie anuluje ten klucz.",
  "recoveryKey.hiddenWhileSaving": "Ukryty podczas zapisywania zestawu.",
  "recoveryKey.group": "Grupa {number}: {characters}",
  "recoveryKey.label":
    "Etykieta klucza: {label}. Proszę zapisać ją obok klucza. Nie jest tajna: w sekcji Bezpieczeństwo myCarlos pokazuje etykietę działającego klucza, dzięki czemu wiadomo, który zestaw jest aktualny.",
  "recoveryKey.saveKit": "Zapisz zestaw odzyskiwania…",
  "recoveryKey.printKit": "Drukuj zestaw odzyskiwania",
  "recoveryKey.next": "Dalej: sprawdź klucz odzyskiwania",
  "recoveryKey.check.label": "Klucz odzyskiwania",
  "recoveryKey.check.hint":
    "Proszę wpisać cały klucz odzyskiwania, tak jak został zapisany: 7 grup po 4 litery i cyfry. Myślniki, spacje i inne znaki interpunkcyjne nie mają znaczenia.",
  "recoveryKey.back": "Wstecz: odczytaj klucz odzyskiwania",
  "recoveryKey.checkAndSave": "Sprawdź i zapisz",
  "kit.title": "Zestaw odzyskiwania myCarlos",
  "kit.printed": "Wydrukowano {date}",
  "kit.labelPrinted": "Etykieta klucza: {label} · Wydrukowano {date}",
  "kit.labelNote":
    "Etykieta nie jest tajna. W sekcji Bezpieczeństwo myCarlos pokazuje etykietę klucza odzyskiwania, który teraz działa: zestaw z inną etykietą już nie otwiera sejfu.",
  "kit.use":
    "W razie zapomnienia hasła głównego myCarlos ten klucz otwiera sejf na tym urządzeniu i pozwala wybrać nowe hasło główne. Działa po zakończeniu sprawdzania w myCarlos.",
  "kit.keep":
    "Proszę przechowywać go w prywatnym miejscu, z dala od urządzenia. Każdy, kto ma ten klucz i kopię sejfu, może go otworzyć. Po skonfigurowaniu nowego klucza odzyskiwania ten klucz nie otwiera już sejfu na tym urządzeniu.",

  // First setup: comfort settings, before the passphrase
  "comfort.title": "Dostosuj myCarlos do siebie",
  "comfort.intro":
    "Przed konfiguracją proszę wybrać to, co najbardziej odpowiada. Każdy wybór działa od razu.",
  "comfort.sample":
    "Tak wygląda tekst w myCarlos. Proszę naciskać − lub +, aż będzie łatwy do przeczytania.",
  "textSize.followsDevice":
    "Tutaj rozmiar tekstu zależy od urządzenia: od jego ustawienia rozmiaru tekstu lub od powiększenia w przeglądarce.",
  "comfort.autoLock.body":
    "myCarlos blokuje się sam, gdy nie jest używany przez ten czas, aby nikt inny nie zobaczył dokumentów. Proszę wybrać od 1 do 15 minut.",
  "comfort.later":
    "Można je zmienić w każdej chwili w sekcji „{settings}”: „{textSize}” w części „{preferences}”, a „{autoLock}” w części „{security}”.",
  "comfort.continue": "Dalej",
  "comfort.usual": "Użyj zwykłych ustawień",

  // Notices after vault actions (the app's status line)
  "notice.iosKeepOpen":
    "Proszę nie zamykać myCarlos: przełączenie aplikacji wstrzymuje to przesyłanie.",
  "notice.dropRefused":
    "Aby zaimportować pliki PDF, proszę odblokować sejf i użyć przycisku „{button}”. Przeciąganie i upuszczanie przenosi dokumenty, które już są w myCarlos.",
  "notice.lockedIdle": {
    one: "Zablokowano po {count} minucie bez używania.",
    few: "Zablokowano po {count} minutach bez używania.",
    many: "Zablokowano po {count} minutach bez używania.",
    other: "Zablokowano po {count} minuty bez używania.",
  },
  "notice.lockedHidden":
    "Zablokowano, ponieważ myCarlos został zminimalizowany lub przeniesiony do tła.",
  "notice.locked": "Sejf zablokowany.",
  "notice.autoLockSet": {
    one: "Automatyczna blokada ustawiona na {count} minutę.",
    few: "Automatyczna blokada ustawiona na {count} minuty.",
    many: "Automatyczna blokada ustawiona na {count} minut.",
    other: "Automatyczna blokada ustawiona na {count} minuty.",
  },
  "notice.backupCutOff":
    "Tworzenie kopii zapasowej zostało przerwane, ponieważ sejf się zablokował. Nie zapisano kopii. Proszę zachować starsze kopie zapasowe. {note}",
  "notice.transferUnfinished": "Przesyłanie nie zostało ukończone.",
  "notice.restored":
    "Przywrócono kopię zapasową. Proszę odblokować sejf hasłem głównym, z którym został utworzony, lub użyć jego klucza odzyskiwania.",
  "notice.createdThenLocked":
    "Sejf został utworzony, a potem zablokowany, zanim można było utworzyć klucz odzyskiwania. Proszę odblokować sejf, aby skonfigurować klucz.",
  "notice.created":
    "Utworzono zaszyfrowany sejf. Proszę skonfigurować klucz odzyskiwania, aby zapomniane hasło główne nie uniemożliwiło na zawsze dostępu do dokumentów.",
  "notice.unlockedRecovery":
    "Sejf odblokowano w trybie odzyskiwania tylko do odczytu. Co zrobić, opisuje komunikat w bibliotece.",
  "notice.unlocked": "Sejf odblokowany.",
  "notice.recovered":
    "Sejf otwarto kluczem odzyskiwania. Od teraz proszę używać nowego hasła głównego.",
  "notice.recoveredReadOnly":
    "Sejf otwarto kluczem odzyskiwania w trybie tylko do odczytu; hasło główne się nie zmieniło. Co zrobić, opisuje komunikat w bibliotece.",
  "notice.eraseCancelled":
    "Nic się nie zmieniło: sejf nie został odłożony na bok.",

  // What to check after a refusal, and other errors the app words itself
  "box.name": "nazwę",
  "box.passphrase": "hasło główne",
  "box.currentPassphrase": "obecne hasło główne",
  "box.newPassphrase": "nowe hasło główne",
  "box.recoveryKey": "klucz odzyskiwania",
  "box.typedWords": "wpisane słowa",
  "box.profileName": "nazwę profilu",
  "box.folderName": "nazwę folderu",
  "error.checkBoxes": "Proszę sprawdzić {boxes}, a potem spróbować ponownie.",
  "error.retryIn": {
    one: "Proszę spróbować ponownie za {count} sekundę.",
    few: "Proszę spróbować ponownie za {count} sekundy.",
    many: "Proszę spróbować ponownie za {count} sekund.",
    other: "Proszę spróbować ponownie za {count} sekundy.",
  },
  "error.fallback": "Nie udało się wykonać operacji na sejfie.",
  "error.damaged":
    "Nie zapisano kopii zapasowej: dokument „{name}” ({where}) jest uszkodzony i nie da się go już odczytać, a kopii, która go zawiera, nie dałoby się przywrócić. Nic nie zostało zmienione. Proszę zachować wcześniejsze kopie zapasowe. Przed ponowną próbą proszę poprosić o pomoc w odzyskaniu tego dokumentu z nieuszkodzonej kopii lub kopii zapasowej.",
  "error.damaged.where": "dodany {date}",
  "error.damaged.whereFor": "dodany {date}, w dokumentach osoby {person}",

  // The warning before the automatic lock (#68)
  "lockWarning.title": {
    one: "myCarlos zablokuje się za {count} sekundę, aby chronić prywatność dokumentów.",
    few: "myCarlos zablokuje się za {count} sekundy, aby chronić prywatność dokumentów.",
    many: "myCarlos zablokuje się za {count} sekund, aby chronić prywatność dokumentów.",
    other:
      "myCarlos zablokuje się za {count} sekundy, aby chronić prywatność dokumentów.",
  },
  "lockWarning.help":
    "Aby pozostawić go otwartym, proszę nacisnąć „{keepOpen}” lub dowolny klawisz.",
  "lockWarning.left": {
    one: "Została {count} sekunda.",
    few: "Zostały {count} sekundy.",
    many: "Zostało {count} sekund.",
    other: "Zostało {count} sekundy.",
  },
  "lockWarning.keepOpen": "Pozostaw otwarty",

  // Settings > Preferences, and Appearance (#47)
  "preferences.subtitle": "Wygląd myCarlos na tym komputerze",
  "language.title": "Język",
  "language.help":
    "Wybór jest zapamiętywany na tym urządzeniu. Dokumenty pozostają w oryginalnym języku.",
  "language.system": "Język systemu",
  "language.error.unreadable":
    "Nie udało się odczytać zapisanego języka. W tej sesji używany jest język urządzenia.",
  "language.error.notRemembered":
    "Język został zmieniony na tę sesję, ale nie udało się go zapamiętać na tym urządzeniu.",

  "appearance.title": "Wygląd",
  "appearance.help":
    "Opcja „{system}” dopasowuje się do jasnego lub ciemnego wyglądu urządzenia. Wysoki kontrast używa czarnego tła i jasnego tekstu. Kolory kontrastu ustawione na urządzeniu zawsze mają pierwszeństwo.",
  "appearance.system": "Systemowy",
  "appearance.light": "Jasny",
  "appearance.dark": "Ciemny",
  "appearance.highContrast": "Wysoki kontrast",
  "appearance.error.unreadable":
    "Nie udało się odczytać zapisanego wyglądu. W tej sesji używana jest opcja „{system}”.",
  "appearance.error.notRemembered":
    "Wygląd zmieniono na tę sesję, ale nie udało się go zapamiętać na tym urządzeniu.",
  "appearance.error.window":
    "Wygląd okna nie mógł dostosować się do tego wyboru. Można dalej korzystać z myCarlos.",

  // A document shown as a photo
  "photo.eyebrow": "Zdjęcie",
  "photo.alt": "Zdjęcie: {name}",
  "photo.area":
    "Zdjęcie. Proszę powiększyć, aby zobaczyć szczegóły; przeciągnąć lub przewinąć, aby się przesunąć.",
  "photo.fitted": "Dopasowano do okna.",
  "photo.zoomed": "Powiększono do {percent}%.",
  "photo.zoomOut": "Pomniejsz",
  "photo.zoomIn": "Powiększ",
  "photo.close": "Zamknij",

  // The library's folders and documents, as a list or a grid
  "library.items": {
    one: "{count} widoczny element biblioteki",
    few: "{count} widoczne elementy biblioteki",
    many: "{count} widocznych elementów biblioteki",
    other: "{count} widocznego elementu biblioteki",
  },
  "library.column.name": "Nazwa",
  "library.column.source": "Źródło",
  "library.column.added": "Data dodania",
  "library.folder.label": "Folder {name}",
  "library.folder.open": "Otwórz {name}",
  "library.folder.items": {
    one: "{count} element",
    few: "{count} elementy",
    many: "{count} elementów",
    other: "{count} elementu",
  },
  "library.folder.rename": "Zmień nazwę folderu {name}",
  "library.rename": "Zmień nazwę",
  "library.document.label": "Dokument {name}",
  "library.document.details": "Szczegóły dokumentu {name}",
  "library.details": "Szczegóły",
  "library.select": "Zaznacz {name}",
  "library.empty.title": "To miejsce jest puste",
  "library.empty.help": "Proszę dodać tutaj folder lub zaimportować dokument.",
  "library.noMatch.title": "Brak pasujących dokumentów",
  "library.noMatch.help": "Proszę spróbować innego wyszukiwania.",
};
