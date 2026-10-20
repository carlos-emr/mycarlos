import type { Message } from "../types";
import type { MessageKey } from "./en";

/** Polish. Plain, polite wording: "Proszę ..." for instructions in running text,
 * short imperatives for buttons and headings, as is usual in Polish interfaces.
 * Plural forms: one, few, many, other (fractions). */
export const pl: Record<MessageKey, Message> = {
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
    "Bez niego jedynym sposobem powrotu jest usunięcie myCarlos i rozpoczęcie od nowa.",
  "restore.summary": "Przywróć z kopii zapasowej",

  "reset.plainly":
    "Usunięcie kasuje z myCarlos na tym komputerze wszystkie dokumenty, foldery i profile pacjentów i nie można tego cofnąć. Aby potwierdzić, proszę wpisać dokładnie poniższe słowa.",
  "reset.type": "Wpisz {phrase}",
  "reset.submit": "Usuń sejf",

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
    "Sejf na tym urządzeniu zawiera te same dokumenty. Przywrócenie zastępuje go tą kopią zapasową.",
  "restore.consequence.differs":
    "Sejf na tym urządzeniu może nie być taki sam jak ta kopia zapasowa: mógł się od tego czasu zmienić albo jego część nie mogła zostać odczytana. Przywrócenie zastępuje sejf kopią zapasową: wszystko, co jest w sejfie, a czego nie ma w kopii, zostaje utracone, a hasło główne i klucz odzyskiwania stają się tymi, z którymi wykonano kopię.",
  "restore.consequence.otherVault":
    "To urządzenie ma inny sejf. Przywrócenie trwale go usuwa i umieszcza w jego miejscu kopię zapasową.",
  "restore.consequence.unreadable":
    "Sejfu na tym urządzeniu nie udało się odczytać, więc myCarlos nie może stwierdzić, czy jest to ten, z którego wykonano tę kopię zapasową. Przywrócenie trwale go usuwa i umieszcza w jego miejscu kopię zapasową.",
  "restore.agree.erase":
    "Usuń sejf z tego urządzenia i przywróć kopię zapasową",
  "restore.agree.replace":
    "Zastąp sejf na tym urządzeniu tą kopią zapasową i utrać zmiany wprowadzone od tego czasu",
  "restore.submit": "Przywróć kopię zapasową",
  "restore.restoring":
    "Przywracanie kopii zapasowej. W przypadku dużego sejfu może to chwilę potrwać…",
  "restore.cancelled": "Przywracanie anulowane. Nic się nie zmieniło.",
};
