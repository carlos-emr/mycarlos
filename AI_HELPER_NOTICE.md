# AI helper: the in-app privacy notice (#72)

- **Status:** draft text for review, by Ben and by a native speaker of each language, for the
  planned AI helper. It is **not in the app yet**. The change that first shows it (#72 part B, the
  anonymized text export) adds its messages to the seven `.ftl` files and to
  `src/i18n/locales/fluent/message-keys.json`.
- **Date:** 2026-10-29
- **Data restriction:** synthetic (made-up) files only, until the pilot privacy review (#25)
  approves real health information.

## Where it is shown

- Before the patient first uses the AI helper, as a dialog the patient closes with a button. It
  opens again until the patient has seen it once in that vault, and again whenever its text
  changes (the app keeps the version of the notice last seen).
- At any time from Security, under "About the AI helper".
- **Part B** (the export only) shows: `title`, `introShare`, `testBuild`, `shareHeading`,
  `shareBody`, `previewBody`, `limitsBody`, `fileBody`, `serviceBody` and `adviceBody`.
- **Part D** (the AI on this device) replaces `introShare` with `intro` and adds `modelHeading`,
  `modelBody` and `resultsBody`. It also uses `aiHelper-resultLabel` on every answer.
- `testBuild` is shown while the app is for synthetic data only, as `security-devBuild-body` is
  today.

## What each sentence promises, and the control behind it

Each sentence is a promise to the patient. If a control below changes, the text changes with it,
in all seven languages.

| Message | Promise | Control ([THREAT_MODEL](THREAT_MODEL.md)) |
| --- | --- | --- |
| `introShare`, `intro` | myCarlos itself sends nothing over the internet. | No network use (AI-08; [SECURITY_OPERATIONS](SECURITY_OPERATIONS.md#ai-helper-72-nothing-leaves-the-device)). |
| `shareBody` | The kinds of details looked for and removed; other dates moved by whole days, gaps kept. | The anonymizer (AI-01). |
| `previewBody` | Removed parts and moved dates marked; the patient can remove more; the preview shows all the text the file will hold; nothing is saved before the patient chooses to save. | The native preview session, removals only (AI-01, AI-02). |
| `limitsBody` | Removal can miss a name or a number, and indirect clues remain. | Stated limit (AI-01). |
| `fileBody` | A plain text file where the patient chooses; not encrypted; myCarlos cannot erase it; a synced folder copies it; recorded in the audit history. | The export (AI-03). |
| `serviceBody` | The other service's rules apply; a signed-in service knows who the patient is; its dates are the moved ones. | Stated limits (AI-03, AI-09). |
| `adviceBody` | AI answers can be wrong; they are not a diagnosis or advice. | Clinical-safety limits (AI-05; #25). |
| `modelBody` | The model is added only by the patient's choice, kept outside the vault, checked before every use; it cannot use the internet or open other files. | The model file and its sandboxed helper (AI-04). |
| `resultsBody` | Answers are saved encrypted with the document, tool, model and date, and labelled. | Saved answers (AI-05, AI-06). |
| `aiHelper-resultLabel` | The label on every AI answer. | AI-05. The quoted label in `resultsBody` must be the same words in each language; part D adds a test that compares them. |

## The messages

Reading level: short sentences and everyday words, as in the rest of the app (#67, #69). The
register follows each catalogue: *vous* (French), *usted* (Spanish), impersonal forms and
*Proszę* (Polish), *você* (Brazilian Portuguese), and 您 (Chinese). Terms follow the existing
catalogues:

- the vault: coffre-fort, bóveda, sejf, cofre, 保险库, 保險庫;
- the audit history: `interface-history-title`;
- synthetic files: `security-devBuild-body`;
- "cannot erase it later": the readable-copy warning,
  `interface-VaultLibrary-savingCreatesAReadableFileOutsideThe`;
- a cloud drive: `security-oldBackups-keepCopy`;
- clinics: przychodnia in Polish, as everywhere in its catalogue.

### en

```ftl
aiHelper-notice-title = About the AI helper
aiHelper-notice-introShare = myCarlos can prepare a document’s text for an AI service you choose. myCarlos itself sends nothing over the internet.
aiHelper-notice-intro = The AI helper explains a document in plain words, here on this device, and can prepare a document’s text for an AI service you choose. myCarlos itself sends nothing over the internet.
aiHelper-notice-testBuild = This test version is for synthetic (made-up) files only. Do not use it with real health information.
aiHelper-notice-shareHeading = Saving text for another AI service
aiHelper-notice-shareBody = myCarlos can save a document’s text with identifying details removed, so that you can give it to an AI service you choose. It looks for names, health card and medical record numbers, dates of birth, addresses, postal codes, phone and fax numbers, email and web addresses, the names of clinics, hospitals, labs and doctors, and other identifying numbers such as lab order numbers, and removes them. It moves the other dates by the same number of days, so the time between them stays the same.
aiHelper-notice-previewBody = You see the text first, with the removed parts and the moved dates marked, and you can remove more. The preview shows all of the text the file will hold, even text that is hidden in the document. Nothing is saved until you choose to save it.
aiHelper-notice-limitsBody = Removing details is never perfect. myCarlos can miss a name or a number, and a rare illness, a job or a small town can still point to you or to someone else. Read all of the text before you save it.
aiHelper-notice-fileBody = The text is saved as a plain text file, in a place you choose. It is not encrypted, and myCarlos cannot erase it later. If that place is a folder that syncs to a cloud drive, the file is copied there too. The save is recorded in the audit history.
aiHelper-notice-serviceBody = Once you give the text to another service, what happens to it is up to that service. If you are signed in to it, it knows who you are, whatever was removed. Dates in its answers are the moved dates, not the real ones.
aiHelper-notice-adviceBody = Answers written by an AI can be wrong. Do not take them as a diagnosis or as advice about treatment or medicines, and do not change a medicine or a treatment because of what an AI says. Ask your doctor.
aiHelper-notice-modelHeading = The AI on this device
aiHelper-notice-modelBody = The AI uses a model file that is added only if you choose to add it. The file is kept outside the vault, because it holds nothing about you. myCarlos checks it before every use and will not use a file that has been changed. The AI cannot use the internet or open your other files.
aiHelper-notice-resultsBody = The AI’s answers are saved in the vault, encrypted, with the document, the tool, the model and the date. Each answer is marked “Written by AI and may be wrong. Check with your doctor.”
aiHelper-resultLabel = Written by AI and may be wrong. Check with your doctor.
```

### fr

```ftl
aiHelper-notice-title = À propos de l’assistant IA
aiHelper-notice-introShare = myCarlos peut préparer le texte d’un document pour le service d’IA de votre choix. myCarlos lui-même n’envoie rien par Internet.
aiHelper-notice-intro = L’assistant IA explique un document en termes simples, ici sur cet appareil, et peut préparer le texte d’un document pour le service d’IA de votre choix. myCarlos lui-même n’envoie rien par Internet.
aiHelper-notice-testBuild = Cette version d’essai est réservée aux fichiers fictifs. Ne l’utilisez pas avec de vraies informations de santé.
aiHelper-notice-shareHeading = Enregistrer le texte pour un autre service d’IA
aiHelper-notice-shareBody = myCarlos peut enregistrer le texte d’un document après en avoir retiré les renseignements qui permettent d’identifier une personne, pour que vous puissiez le donner au service d’IA de votre choix. Il recherche les noms, les numéros de carte santé et de dossier médical, les dates de naissance, les adresses, les codes postaux, les numéros de téléphone et de télécopieur, les adresses courriel et Web, les noms des cliniques, des hôpitaux, des laboratoires et des médecins, ainsi que d’autres numéros d’identification comme les numéros de demande d’analyse, et les retire. Il décale les autres dates d’un même nombre de jours, pour que l’écart entre elles reste le même.
aiHelper-notice-previewBody = Vous voyez d’abord le texte, avec les parties retirées et les dates décalées signalées, et vous pouvez en retirer davantage. L’aperçu montre tout le texte que contiendra le fichier, même le texte caché dans le document. Rien n’est enregistré tant que vous ne choisissez pas de l’enregistrer.
aiHelper-notice-limitsBody = Retirer ces renseignements n’est jamais parfait. myCarlos peut laisser passer un nom ou un numéro, et une maladie rare, un métier ou une petite ville peuvent encore permettre de vous reconnaître, ou de reconnaître une autre personne. Lisez tout le texte avant de l’enregistrer.
aiHelper-notice-fileBody = Le texte est enregistré dans un fichier texte simple, à l’endroit de votre choix. Il n’est pas chiffré, et myCarlos ne peut pas l’effacer par la suite. Si cet endroit est un dossier synchronisé avec un espace de stockage en nuage, le fichier y est aussi copié. L’enregistrement est noté dans l’historique des événements.
aiHelper-notice-serviceBody = Une fois que vous avez donné le texte à un autre service, ce qu’il en advient dépend de ce service. Si vous y êtes connecté avec votre compte, il sait qui vous êtes, même si des renseignements ont été retirés. Les dates de ses réponses sont les dates décalées, pas les vraies.
aiHelper-notice-adviceBody = Les réponses écrites par une IA peuvent être fausses. Ne les prenez pas pour un diagnostic ni pour un conseil sur un traitement ou des médicaments, et ne changez pas un médicament ou un traitement à cause de ce que dit une IA. Demandez à votre médecin.
aiHelper-notice-modelHeading = L’IA sur cet appareil
aiHelper-notice-modelBody = L’IA utilise un fichier de modèle qui n’est ajouté que si vous choisissez de l’ajouter. Ce fichier est conservé en dehors du coffre-fort, car il ne contient rien à votre sujet. myCarlos le vérifie avant chaque utilisation et n’utilise pas un fichier qui a été modifié. L’IA ne peut ni utiliser Internet ni ouvrir vos autres fichiers.
aiHelper-notice-resultsBody = Les réponses de l’IA sont enregistrées dans le coffre-fort, chiffrées, avec le document, l’outil, le modèle et la date. Chaque réponse porte la mention « Écrit par une IA et peut contenir des erreurs. Vérifiez auprès de votre médecin. »
aiHelper-resultLabel = Écrit par une IA et peut contenir des erreurs. Vérifiez auprès de votre médecin.
```

### es

```ftl
aiHelper-notice-title = Acerca del asistente de IA
aiHelper-notice-introShare = myCarlos puede preparar el texto de un documento para el servicio de IA que usted elija. myCarlos no envía nada por internet.
aiHelper-notice-intro = El asistente de IA explica un documento con palabras sencillas, aquí en este dispositivo, y puede preparar el texto de un documento para el servicio de IA que usted elija. myCarlos no envía nada por internet.
aiHelper-notice-testBuild = Esta versión de prueba es solo para archivos ficticios. No la use con información de salud real.
aiHelper-notice-shareHeading = Guardar el texto para otro servicio de IA
aiHelper-notice-shareBody = myCarlos puede guardar el texto de un documento quitando los datos que permiten identificar a una persona, para que usted pueda dárselo al servicio de IA que elija. Busca los nombres, los números de tarjeta de salud y de historia clínica, las fechas de nacimiento, las direcciones, los códigos postales, los números de teléfono y de fax, las direcciones de correo electrónico y web, los nombres de clínicas, hospitales, laboratorios y médicos, y otros números de identificación, como los números de solicitud de análisis, y los quita. Cambia las demás fechas el mismo número de días, para que el tiempo entre ellas no cambie.
aiHelper-notice-previewBody = Primero verá el texto, con las partes quitadas y las fechas cambiadas marcadas, y podrá quitar más. La vista previa muestra todo el texto que tendrá el archivo, incluso el texto oculto en el documento. No se guarda nada hasta que usted decida guardarlo.
aiHelper-notice-limitsBody = Quitar estos datos nunca es perfecto. myCarlos puede pasar por alto un nombre o un número, y una enfermedad poco común, un trabajo o un pueblo pequeño aún pueden señalarle a usted o a otra persona. Lea todo el texto antes de guardarlo.
aiHelper-notice-fileBody = El texto se guarda como un archivo de texto sin formato, en el lugar que usted elija. No está cifrado, y myCarlos no puede borrarlo después. Si ese lugar es una carpeta que se sincroniza con un almacenamiento en la nube, el archivo también se copia allí. Queda anotado en el historial de auditoría.
aiHelper-notice-serviceBody = Una vez que se lo dé a otro servicio, lo que pase con el texto depende de ese servicio. Si usa ese servicio con su cuenta, el servicio sabe quién es usted, aunque se hayan quitado datos. Las fechas de sus respuestas son las fechas cambiadas, no las reales.
aiHelper-notice-adviceBody = Las respuestas escritas por una IA pueden estar equivocadas. No las tome como un diagnóstico ni como un consejo sobre tratamientos o medicamentos, y no cambie un medicamento ni un tratamiento por lo que diga una IA. Pregunte a su médico.
aiHelper-notice-modelHeading = La IA en este dispositivo
aiHelper-notice-modelBody = La IA usa un archivo de modelo que solo se añade si usted decide añadirlo. El archivo se guarda fuera de la bóveda, porque no contiene nada sobre usted. myCarlos lo comprueba antes de cada uso y no usará un archivo que haya sido modificado. La IA no puede usar internet ni abrir sus otros archivos.
aiHelper-notice-resultsBody = Las respuestas de la IA se guardan en la bóveda, cifradas, con el documento, la herramienta, el modelo y la fecha. Cada respuesta lleva la nota «Escrito por IA; puede contener errores. Consulte con su médico.»
aiHelper-resultLabel = Escrito por IA; puede contener errores. Consulte con su médico.
```

### pl

```ftl
aiHelper-notice-title = O asystencie AI
aiHelper-notice-introShare = myCarlos może przygotować tekst dokumentu dla wybranej usługi AI. Sam myCarlos niczego nie wysyła przez internet.
aiHelper-notice-intro = Asystent AI wyjaśnia dokument prostymi słowami, tutaj, na tym urządzeniu, i może przygotować tekst dokumentu dla wybranej usługi AI. Sam myCarlos niczego nie wysyła przez internet.
aiHelper-notice-testBuild = Ta wersja testowa jest przeznaczona wyłącznie do fikcyjnych plików. Proszę nie używać jej z prawdziwymi informacjami o zdrowiu.
aiHelper-notice-shareHeading = Zapisywanie tekstu dla innej usługi AI
aiHelper-notice-shareBody = myCarlos może zapisać tekst dokumentu po usunięciu danych, które pozwalają kogoś rozpoznać, aby można go było przekazać wybranej usłudze AI. Wyszukuje i usuwa imiona i nazwiska, numery kart zdrowia i dokumentacji medycznej, daty urodzenia, adresy, kody pocztowe, numery telefonów i faksów, adresy e-mail i stron internetowych, nazwy przychodni, szpitali i laboratoriów, nazwiska lekarzy oraz inne numery identyfikacyjne, na przykład numery zleceń badań. Pozostałe daty przesuwa o tę samą liczbę dni, więc odstępy między nimi się nie zmieniają.
aiHelper-notice-previewBody = Najpierw wyświetla się tekst z zaznaczonymi usuniętymi fragmentami i przesuniętymi datami i można usunąć więcej. Podgląd pokazuje cały tekst, który znajdzie się w pliku, także tekst ukryty w dokumencie. Nic nie zostanie zapisane, dopóki nie wybierze się zapisu.
aiHelper-notice-limitsBody = Usuwanie danych nigdy nie jest doskonałe. myCarlos może pominąć imię, nazwisko lub numer, a rzadka choroba, zawód lub mała miejscowość mogą nadal pozwolić rozpoznać konkretną osobę. Proszę przeczytać cały tekst przed zapisaniem.
aiHelper-notice-fileBody = Tekst jest zapisywany jako zwykły plik tekstowy w wybranym miejscu. Nie jest zaszyfrowany i myCarlos nie może go później usunąć. Jeśli to miejsce jest folderem synchronizowanym z dyskiem w chmurze, plik zostanie skopiowany także tam. Zapis jest odnotowywany w historii zdarzeń.
aiHelper-notice-serviceBody = Po przekazaniu tekstu innej usłudze to ta usługa decyduje, co się z nim stanie. Jeśli korzysta się z tej usługi po zalogowaniu, usługa wie, kim jest użytkownik, nawet po usunięciu danych. Daty w jej odpowiedziach są datami przesuniętymi, a nie prawdziwymi.
aiHelper-notice-adviceBody = Odpowiedzi napisane przez AI mogą być błędne. Proszę nie traktować ich jako diagnozy ani porady dotyczącej leczenia lub leków i nie zmieniać leku ani leczenia z powodu tego, co mówi AI. Proszę zapytać lekarza.
aiHelper-notice-modelHeading = AI na tym urządzeniu
aiHelper-notice-modelBody = AI korzysta z pliku modelu, który zostaje dodany tylko na wyraźne życzenie. Plik jest przechowywany poza sejfem, ponieważ nie zawiera żadnych danych o użytkowniku. myCarlos sprawdza go przed każdym użyciem i nie użyje pliku, który został zmieniony. AI nie może korzystać z internetu ani otwierać innych plików.
aiHelper-notice-resultsBody = Odpowiedzi AI są zapisywane w sejfie, zaszyfrowane, razem z dokumentem, narzędziem, modelem i datą. Każda odpowiedź ma oznaczenie „Napisane przez AI, może zawierać błędy. Proszę skonsultować się z lekarzem.”
aiHelper-resultLabel = Napisane przez AI, może zawierać błędy. Proszę skonsultować się z lekarzem.
```

### pt-BR

```ftl
aiHelper-notice-title = Sobre o assistente de IA
aiHelper-notice-introShare = O myCarlos pode preparar o texto de um documento para o serviço de IA que você escolher. O próprio myCarlos não envia nada pela internet.
aiHelper-notice-intro = O assistente de IA explica um documento em palavras simples, aqui neste dispositivo, e pode preparar o texto de um documento para o serviço de IA que você escolher. O próprio myCarlos não envia nada pela internet.
aiHelper-notice-testBuild = Esta versão de teste é só para arquivos fictícios. Não a use com informações de saúde reais.
aiHelper-notice-shareHeading = Salvar o texto para outro serviço de IA
aiHelper-notice-shareBody = O myCarlos pode salvar o texto de um documento sem os dados que identificam pessoas, para que você possa entregá-lo ao serviço de IA que escolher. Ele procura nomes, números do cartão de saúde e de prontuário, datas de nascimento, endereços, códigos postais, números de telefone e de fax, endereços de e-mail e de sites, nomes de clínicas, hospitais, laboratórios e médicos, e outros números de identificação, como números de pedidos de exames, e os remove. Ele move as outras datas pelo mesmo número de dias, para que o tempo entre elas continue igual.
aiHelper-notice-previewBody = Primeiro você vê o texto, com as partes removidas e as datas movidas marcadas, e pode remover mais. A prévia mostra todo o texto que o arquivo vai conter, inclusive texto escondido no documento. Nada é salvo até você decidir salvar.
aiHelper-notice-limitsBody = Remover esses dados nunca é perfeito. O myCarlos pode deixar passar um nome ou um número, e uma doença rara, uma profissão ou uma cidade pequena ainda podem apontar para você ou para outra pessoa. Leia todo o texto antes de salvá-lo.
aiHelper-notice-fileBody = O texto é salvo como um arquivo de texto simples, no lugar que você escolher. Ele não é criptografado, e o myCarlos não consegue apagá-lo depois. Se esse lugar for uma pasta sincronizada com um armazenamento na nuvem, o arquivo também é copiado para lá. O salvamento fica registrado no histórico de auditoria.
aiHelper-notice-serviceBody = Depois que você entrega o texto a outro serviço, o que acontece com ele depende desse serviço. Se você usa esse serviço com a sua conta, ele sabe quem você é, mesmo com os dados removidos. As datas nas respostas dele são as datas movidas, não as reais.
aiHelper-notice-adviceBody = Respostas escritas por uma IA podem estar erradas. Não as considere um diagnóstico nem um conselho sobre tratamentos ou remédios, e não mude um remédio ou um tratamento por causa do que uma IA diz. Pergunte ao seu médico.
aiHelper-notice-modelHeading = A IA neste dispositivo
aiHelper-notice-modelBody = A IA usa um arquivo de modelo que só é adicionado se você escolher adicioná-lo. O arquivo fica fora do cofre, porque não contém nada sobre você. O myCarlos o verifica antes de cada uso e não usa um arquivo que tenha sido alterado. A IA não pode usar a internet nem abrir seus outros arquivos.
aiHelper-notice-resultsBody = As respostas da IA são salvas no cofre, criptografadas, com o documento, a ferramenta, o modelo e a data. Cada resposta traz o aviso “Escrito por IA e pode estar errado. Confira com seu médico.”
aiHelper-resultLabel = Escrito por IA e pode estar errado. Confira com seu médico.
```

### zh-CN

```ftl
aiHelper-notice-title = 关于 AI 助手
aiHelper-notice-introShare = myCarlos 可以为您选择的 AI 服务准备文档的文本。myCarlos 本身不会通过互联网发送任何内容。
aiHelper-notice-intro = AI 助手会在这台设备上用浅显的语言解释文档，也可以为您选择的 AI 服务准备文档的文本。myCarlos 本身不会通过互联网发送任何内容。
aiHelper-notice-testBuild = 此测试版本仅供合成文件使用。请勿用于真实的健康信息。
aiHelper-notice-shareHeading = 为其他 AI 服务保存文本
aiHelper-notice-shareBody = myCarlos 可以去除身份信息后保存文档的文本，供您提交给您选择的 AI 服务。它会查找并去除姓名、健康卡号和病历号、出生日期、地址、邮政编码、电话和传真号码、电子邮件地址和网址、诊所、医院和化验室的名称、医生姓名，以及化验单号等其他识别号码。其他日期会统一平移相同的天数，因此日期之间的间隔保持不变。
aiHelper-notice-previewBody = 您会先看到文本，被去除的部分和被平移的日期都会标出，您还可以去除更多内容。预览会显示文件将包含的全部文本，包括文档中隐藏的文本。在您选择保存之前，不会保存任何内容。
aiHelper-notice-limitsBody = 去除身份信息永远无法做到完美。myCarlos 可能漏掉姓名或号码；罕见疾病、职业或小城镇也仍可能让人认出您或其他人。保存前请阅读全部文本。
aiHelper-notice-fileBody = 文本会保存为纯文本文件，保存位置由您选择。该文件未加密，myCarlos 之后无法清除它。如果该位置是会同步到云端硬盘的文件夹，文件也会被复制到那里。此次保存会记入操作记录。
aiHelper-notice-serviceBody = 您将文本交给其他服务后，如何处理它由该服务决定。如果您登录了该服务，即使去除了身份信息，它也知道您是谁。它的回答中的日期是平移后的日期，不是真实日期。
aiHelper-notice-adviceBody = AI 撰写的回答可能有误。请勿将其视为诊断或治疗、用药方面的建议，也不要因为 AI 的说法而更改用药或治疗。请咨询您的医生。
aiHelper-notice-modelHeading = 这台设备上的 AI
aiHelper-notice-modelBody = AI 使用的模型文件只有在您选择添加时才会添加。该文件保存在保险库之外，因为其中不含任何关于您的信息。myCarlos 每次使用前都会检查它，不会使用被改动过的文件。AI 无法使用互联网，也无法打开您的其他文件。
aiHelper-notice-resultsBody = AI 的回答会加密保存在保险库中，并附有文档、工具、模型和日期。每条回答都标有「由 AI 撰写，可能有误。请向您的医生核实。」
aiHelper-resultLabel = 由 AI 撰写，可能有误。请向您的医生核实。
```

### zh-TW

```ftl
aiHelper-notice-title = 關於 AI 助理
aiHelper-notice-introShare = myCarlos 可以為您選擇的 AI 服務準備文件的文字。myCarlos 本身不會透過網際網路傳送任何內容。
aiHelper-notice-intro = AI 助理會在這台裝置上用淺白的文字說明文件內容，也可以為您選擇的 AI 服務準備文件的文字。myCarlos 本身不會透過網際網路傳送任何內容。
aiHelper-notice-testBuild = 此測試版本僅供合成檔案使用。請勿用於真實的健康資訊。
aiHelper-notice-shareHeading = 為其他 AI 服務儲存文字
aiHelper-notice-shareBody = myCarlos 可以在移除身分資訊後儲存文件的文字，讓您提供給您選擇的 AI 服務。它會尋找並移除姓名、健康卡號與病歷號碼、出生日期、地址、郵遞區號、電話與傳真號碼、電子郵件地址與網址、診所、醫院與檢驗所的名稱、醫師姓名，以及檢驗單號等其他識別號碼。其他日期會統一移動相同的天數，因此日期之間的間隔不變。
aiHelper-notice-previewBody = 您會先看到文字，已移除的部分和已移動的日期都會標示出來，您也可以再移除更多內容。預覽會顯示檔案將包含的全部文字，包括文件中隱藏的文字。在您選擇儲存之前，不會儲存任何內容。
aiHelper-notice-limitsBody = 移除身分資訊永遠無法做到完美。myCarlos 可能漏掉姓名或號碼；罕見疾病、職業或小鎮也仍可能讓人認出您或其他人。儲存前請閱讀全部文字。
aiHelper-notice-fileBody = 文字會儲存為純文字檔，儲存位置由您選擇。此檔案未加密，myCarlos 之後無法清除它。如果該位置是會同步到雲端硬碟的資料夾，檔案也會被複製到那裡。此次儲存會記錄在操作紀錄中。
aiHelper-notice-serviceBody = 您將文字交給其他服務後，如何處理由該服務決定。如果您登入了該服務，即使移除了身分資訊，它也知道您是誰。它的回答中的日期是移動後的日期，不是真實日期。
aiHelper-notice-adviceBody = AI 撰寫的回答可能有誤。請勿將其視為診斷或治療、用藥方面的建議，也不要因為 AI 的說法而更改用藥或治療。請詢問您的醫師。
aiHelper-notice-modelHeading = 這台裝置上的 AI
aiHelper-notice-modelBody = AI 使用的模型檔案只有在您選擇加入時才會加入。此檔案存放在保險庫之外，因為其中不含任何關於您的資訊。myCarlos 每次使用前都會檢查它，不會使用遭到修改的檔案。AI 無法使用網際網路，也無法開啟您的其他檔案。
aiHelper-notice-resultsBody = AI 的回答會加密儲存在保險庫中，並附上文件、工具、模型和日期。每則回答都標有「由 AI 撰寫，可能有誤。請向您的醫師確認。」
aiHelper-resultLabel = 由 AI 撰寫，可能有誤。請向您的醫師確認。
```

## Back-translations

Literal English renderings of each translation, to check that it says what the English says.
Where a language puts something slightly differently, the notes below the table say how.

| Message | fr | es | pl | pt-BR | zh-CN | zh-TW |
| --- | --- | --- | --- | --- | --- | --- |
| `title` | About the AI assistant | About the AI assistant | About the AI assistant | About the AI assistant | About the AI assistant | About the AI assistant |
| `introShare` | myCarlos can prepare a document's text for the AI service of your choice. myCarlos itself sends nothing over the Internet. | myCarlos can prepare a document's text for the AI service you choose. myCarlos sends nothing over the internet. | myCarlos can prepare a document's text for a chosen AI service. myCarlos itself sends nothing over the internet. | myCarlos can prepare a document's text for the AI service you choose. myCarlos itself sends nothing over the internet. | myCarlos can prepare a document's text for the AI service you choose. myCarlos itself does not send any content over the internet. | myCarlos can prepare a document's text for the AI service you choose. myCarlos itself does not send any content over the internet. |
| `intro` | The AI assistant explains a document in simple terms, here on this device, and can prepare a document's text for the AI service of your choice. myCarlos itself sends nothing over the Internet. | The AI assistant explains a document with simple words, here on this device, and can prepare a document's text for the AI service you choose. myCarlos sends nothing over the internet. | The AI assistant explains a document in simple words, here, on this device, and can prepare a document's text for a chosen AI service. myCarlos itself sends nothing over the internet. | The AI assistant explains a document in simple words, here on this device, and can prepare a document's text for the AI service you choose. myCarlos itself sends nothing over the internet. | The AI assistant explains documents in plain language on this device, and can also prepare a document's text for the AI service you choose. myCarlos itself does not send any content over the internet. | The AI assistant explains a document's content in plain words on this device, and can also prepare a document's text for the AI service you choose. myCarlos itself does not send any content over the internet. |
| `testBuild` | This trial version is reserved for fictitious files. Do not use it with real health information. | This test version is only for fictitious files. Do not use it with real health information. | This test version is intended only for fictitious files. Please do not use it with real health information. | This test version is only for fictitious files. Do not use it with real health information. | This test version is only for use with synthetic files. Please do not use it for real health information. | This test version is only for use with synthetic files. Please do not use it for real health information. |
| `shareHeading` | Save the text for another AI service | Save the text for another AI service | Saving text for another AI service | Save the text for another AI service | Save text for other AI services | Save text for other AI services |
| `shareBody` | myCarlos can save a document's text after removing the information that makes it possible to identify a person, so that you can give it to the AI service of your choice. It looks for names, health card and medical record numbers, dates of birth, addresses, postal codes, telephone and fax numbers, email (courriel) and web addresses, the names of clinics, hospitals, laboratories and doctors, and other identification numbers such as test request numbers, and removes them. It shifts the other dates by the same number of days, so that the gap between them stays the same. | myCarlos can save a document's text removing the data that make it possible to identify a person, so that you can give it to the AI service you choose. It looks for names, health card and clinical record numbers, dates of birth, addresses, postal codes, telephone and fax numbers, email and web addresses, the names of clinics, hospitals, laboratories and doctors, and other identification numbers, such as test request numbers, and removes them. It changes the other dates by the same number of days, so that the time between them does not change. | myCarlos can save a document's text after removing data that allow someone to be recognised, so that it can be passed to a chosen AI service. It searches for and removes first names and surnames, health card and medical record numbers, dates of birth, addresses, postal codes, telephone and fax numbers, e-mail and website addresses, the names of clinics, hospitals and laboratories, doctors' surnames, and other identification numbers, for example test order numbers. It shifts the other dates by the same number of days, so the gaps between them do not change. | myCarlos can save a document's text without the data that identify people, so that you can hand it to the AI service you choose. It looks for names, health card and chart numbers, dates of birth, addresses, postal codes, telephone and fax numbers, email and website addresses, names of clinics, hospitals, laboratories and doctors, and other identification numbers, such as test order numbers, and removes them. It moves the other dates by the same number of days, so that the time between them stays the same. | myCarlos can save a document's text after removing identity information, for you to submit to the AI service you choose. It looks for and removes names, health card and medical record numbers, dates of birth, addresses, postal codes, telephone and fax numbers, email addresses and web addresses, the names of clinics, hospitals and laboratories, doctors' names, and other identifying numbers such as lab slip numbers. Other dates are all shifted by the same number of days, so the intervals between dates stay unchanged. | myCarlos can save a document's text after removing identity information, letting you provide it to the AI service you choose. It searches for and removes names, health card and medical record numbers, dates of birth, addresses, postal codes, telephone and fax numbers, email addresses and web addresses, the names of clinics, hospitals and laboratories, doctors' names, and other identifying numbers such as lab slip numbers. Other dates are all moved by the same number of days, so the intervals between dates do not change. |
| `previewBody` | You first see the text, with the removed parts and the shifted dates marked, and you can remove more of it. The preview shows all the text the file will contain, even text hidden in the document. Nothing is saved as long as you do not choose to save it. | First you will see the text, with the removed parts and the changed dates marked, and you will be able to remove more. The preview shows all the text the file will have, even text hidden in the document. Nothing is saved until you decide to save it. | First the text is shown with the removed fragments and shifted dates marked, and more can be removed. The preview shows all the text that will be in the file, including text hidden in the document. Nothing will be saved until saving is chosen. | First you see the text, with the removed parts and the moved dates marked, and you can remove more. The preview shows all the text the file will contain, including hidden text in the document. Nothing is saved until you decide to save. | You will first see the text, with the removed parts and the shifted dates marked, and you can remove more content. The preview shows all the text the file will contain, including text hidden in the document. Until you choose to save, nothing is saved. | You will first see the text, with the removed parts and the moved dates marked, and you can also remove more content. The preview shows all the text the file will contain, including text hidden in the document. Until you choose to save, nothing is saved. |
| `limitsBody` | Removing this information is never perfect. myCarlos can let a name or a number slip through, and a rare illness, an occupation or a small town can still make it possible to recognise you, or to recognise another person. Read all the text before saving it. | Removing these data is never perfect. myCarlos can overlook a name or a number, and an uncommon illness, a job or a small town can still point to you or to another person. Read all the text before saving it. | Removing data is never perfect. myCarlos can miss a first name, a surname or a number, and a rare illness, an occupation or a small town can still make it possible to recognise a specific person. Please read all the text before saving. | Removing these data is never perfect. myCarlos can let a name or a number through, and a rare illness, a profession or a small city can still point to you or to another person. Read all the text before saving it. | Removing identity information can never be done perfectly. myCarlos may miss names or numbers; a rare illness, an occupation or a small town may also still let people recognise you or others. Please read all the text before saving. | Removing identity information can never be done perfectly. myCarlos may miss names or numbers; a rare illness, an occupation or a small town may also still let people recognise you or others. Please read all the text before saving. |
| `fileBody` | The text is saved in a plain text file, in the place of your choice. It is not encrypted, and myCarlos cannot erase it afterwards. If that place is a folder synchronised with cloud storage, the file is copied there too. The save is noted in the event history. | The text is saved as a plain text file, in the place you choose. It is not encrypted, and myCarlos cannot delete it afterwards. If that place is a folder that syncs with cloud storage, the file is copied there too. It is noted in the audit history. | The text is saved as an ordinary text file in the chosen place. It is not encrypted and myCarlos cannot delete it later. If that place is a folder synchronised with a cloud drive, the file will be copied there too. The save is recorded in the event history. | The text is saved as a plain text file, in the place you choose. It is not encrypted, and myCarlos cannot delete it later. If that place is a folder synced with cloud storage, the file is copied there too. The save is recorded in the audit history. | The text is saved as a plain text file, in a location you choose. The file is not encrypted, and myCarlos cannot erase it later. If that location is a folder that syncs to a cloud drive, the file is copied there too. This save is entered in the activity record. | The text is saved as a plain text file, in a location you choose. This file is not encrypted, and myCarlos cannot erase it later. If that location is a folder that syncs to a cloud drive, the file is copied there too. This save is recorded in the activity record. |
| `serviceBody` | Once you have given the text to another service, what becomes of it depends on that service. If you are signed in to it with your account, it knows who you are, even if information was removed. The dates in its answers are the shifted dates, not the real ones. | Once you give it to another service, what happens to the text depends on that service. If you use that service with your account, the service knows who you are, even if data were removed. The dates in its answers are the changed dates, not the real ones. | After the text is passed to another service, that service decides what happens to it. If the service is used while signed in, the service knows who the user is, even after data are removed. The dates in its answers are shifted dates, not real ones. | After you hand the text to another service, what happens to it depends on that service. If you use that service with your account, it knows who you are, even with the data removed. The dates in its answers are the moved dates, not the real ones. | After you give the text to another service, how it is handled is decided by that service. If you are signed in to that service, it knows who you are even though identity information was removed. The dates in its answers are the shifted dates, not the real dates. | After you give the text to another service, how it is handled is decided by that service. If you are signed in to that service, it knows who you are even though identity information was removed. The dates in its answers are the moved dates, not the real dates. |
| `adviceBody` | Answers written by an AI can be wrong. Do not take them for a diagnosis or for advice about a treatment or medicines, and do not change a medicine or a treatment because of what an AI says. Ask your doctor. | Answers written by an AI can be mistaken. Do not take them as a diagnosis or as advice about treatments or medicines, and do not change a medicine or a treatment because of what an AI says. Ask your doctor. | Answers written by AI can be wrong. Please do not treat them as a diagnosis or as advice about treatment or medicines, and do not change a medicine or treatment because of what the AI says. Please ask a doctor. | Answers written by an AI can be wrong. Do not consider them a diagnosis or advice about treatments or medicines, and do not change a medicine or a treatment because of what an AI says. Ask your doctor. | Answers written by AI may be wrong. Please do not treat them as a diagnosis or as advice on treatment or medication, and do not change your medication or treatment because of what an AI says. Please consult your doctor. | Answers written by AI may be wrong. Please do not treat them as a diagnosis or as advice on treatment or medication, and do not change your medication or treatment because of what an AI says. Please ask your doctor. |
| `modelHeading` | The AI on this device | The AI on this device | AI on this device | The AI on this device | The AI on this device | The AI on this device |
| `modelBody` | The AI uses a model file that is added only if you choose to add it. This file is kept outside the safe, because it contains nothing about you. myCarlos checks it before each use and does not use a file that has been modified. The AI can neither use the Internet nor open your other files. | The AI uses a model file that is only added if you decide to add it. The file is kept outside the vault, because it contains nothing about you. myCarlos checks it before each use and will not use a file that has been modified. The AI cannot use the internet or open your other files. | The AI uses a model file that is added only on an explicit wish. The file is stored outside the safe, because it contains no data about the user. myCarlos checks it before each use and will not use a file that has been changed. The AI cannot use the internet or open other files. | The AI uses a model file that is only added if you choose to add it. The file stays outside the safe, because it contains nothing about you. myCarlos checks it before each use and does not use a file that has been altered. The AI cannot use the internet or open your other files. | The model file the AI uses is added only when you choose to add it. The file is kept outside the vault, because it contains no information about you. myCarlos checks it before every use and will not use a file that has been altered. The AI cannot use the internet and cannot open your other files. | The model file the AI uses is added only when you choose to add it. This file is stored outside the vault, because it contains no information about you. myCarlos checks it before every use and will not use a file that has been modified. The AI cannot use the internet and cannot open your other files. |
| `resultsBody` | The AI's answers are saved in the safe, encrypted, with the document, the tool, the model and the date. Each answer carries the note "Written by an AI and may contain errors. Check with your doctor." | The AI's answers are saved in the vault, encrypted, with the document, the tool, the model and the date. Each answer carries the note "Written by AI; may contain errors. Consult your doctor." | The AI's answers are saved in the safe, encrypted, together with the document, the tool, the model and the date. Each answer is marked "Written by AI, may contain errors. Please consult a doctor." | The AI's answers are saved in the safe, encrypted, with the document, the tool, the model and the date. Each answer carries the notice "Written by AI and may be wrong. Check with your doctor." | The AI's answers are saved encrypted in the vault, with the document, tool, model and date attached. Every answer is marked "Written by AI, may be wrong. Please verify with your doctor." | The AI's answers are saved encrypted in the vault, with the document, tool, model and date attached. Every answer is marked "Written by AI, may be wrong. Please confirm with your doctor." |
| `resultLabel` | Written by an AI and may contain errors. Check with your doctor. | Written by AI; may contain errors. Consult your doctor. | Written by AI, may contain errors. Please consult a doctor. | Written by AI and may be wrong. Check with your doctor. | Written by AI, may be wrong. Please verify with your doctor. | Written by AI, may be wrong. Please confirm with your doctor. |

Notes:

- **"Vault":** French, Polish and Portuguese use their catalogues' words (coffre-fort, sejf, cofre),
  which back-translate as "safe".
- **"Audit history":** each language uses its catalogue's name for that screen
  (`interface-history-title`): the event history in French and Polish, and the activity record
  (操作记录 / 操作紀錄) in Chinese.
- **"Erase":** French and Chinese say "erase" (effacer, 清除), as their readable-copy warnings do.
  Spanish, Polish and Portuguese say "delete" (borrar, usunąć, apagar), as theirs do.
- **Polish** addresses nobody directly, like the rest of its catalogue. So "you or someone else"
  becomes "a specific person", "your doctor" becomes "a doctor", and "if you are signed in"
  becomes "if the service is used while signed in". Clinics are *przychodnie*, the catalogue's
  word.
- **French** uses *courriel*, the Canadian word for email, and *télécopieur* for fax. Its quotation
  marks take no-break spaces, as elsewhere in its catalogue.
- **Spanish** uses *tarjeta de salud*, the usual word in Canada, rather than Spain's *tarjeta
  sanitaria*.
- **Chinese** uses 「」 quotation marks, as both Chinese catalogues already do. It uses 名称 / 名稱
  for organisations and 姓名 for doctors. zh-CN says 去除 ("remove") and 提交 ("submit"); zh-TW
  says 移除 and 提供 ("provide").
