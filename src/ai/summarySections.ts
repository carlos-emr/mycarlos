/**
 * The summary under two headings (K3, a try-out on Ben's tuning board): what
 * the letter says, then what the patient needs to do.
 *
 * The model is not asked for the headings. The summary prompt being tried
 * (E5, E6) already writes what the document found first and what the patient
 * must do after it, so the reader splits the sentences at the first one that
 * tells the patient to do something. That is found by wording alone, per
 * language: an obligation anywhere in the sentence ("you need to", "il faut",
 * "należy", "请"), an instruction verb at its start ("Take", "Appelez",
 * "Tome"), or "if …, call …". Everything from that sentence on is under the
 * second heading. A summary with no such sentence has the first heading only.
 *
 * Wording is a guess: a fact that reads like an instruction moves the split
 * earlier. The try-out is to see whether the headings help, before any model
 * change is made for them.
 */

/** Letters and digits on both sides make a whole word or phrase. */
const word = (alternatives: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}-])`, "iu");
const start = (alternatives: string) =>
  new RegExp(`^\\s*(?:${alternatives})(?![\\p{L}\\p{N}-])`, "iu");

interface Cues {
  /** An obligation, anywhere in the sentence. */
  anywhere: RegExp;
  /** An instruction verb, at the start of the sentence. */
  atStart: RegExp;
  /** "If … , do …": a condition, then an instruction verb after a comma. */
  conditional?: RegExp;
}

const CUES: Record<string, Cues> = {
  en: {
    anywhere: word(
      "you (?:should|must|need to|will need to|'ll need to|have to|are asked to|are to|may need to)|please",
    ),
    atStart: start(
      "do not|don't|take|stop|start|book|call|phone|go|see|make|come|bring|avoid|keep|continue|repeat|have|get|return|follow up|contact|attend|ask|use|check|eat|drink|fast|apply|arrange|schedule|tell|let|seek|visit|wear|rest|limit|reduce|increase|monitor|record|collect|complete|fill in|remember",
    ),
    conditional:
      /^\s*(?:if|when|unless)\b[^.]*,\s*(?:please\s+)?(?:call|go|see|seek|contact|stop|take|return|come|phone)\b/iu,
  },
  fr: {
    anywhere: word(
      "vous devez|vous devrez|vous devriez|il faut|il faudra|veuillez|merci de|n['’]oubliez pas|ne prenez pas|n['’]arrêtez pas",
    ),
    atStart: start(
      "prenez|arrêtez|appelez|consultez|contactez|prévoyez|revenez|évitez|continuez|présentez-vous|apportez|faites|gardez|surveillez|notez|allez|rendez-vous|reprenez|commencez",
    ),
    conditional:
      /^\s*(?:si|en cas de)\b[^.]*,\s*(?:appelez|consultez|contactez|allez|rendez-vous|arrêtez|prenez|revenez)\b/iu,
  },
  es: {
    anywhere: word(
      "debe|deberá|debería|tiene que|tendrá que|necesita|por favor|no olvide|no tome|deje de",
    ),
    atStart: start(
      "tome|llame|acuda|evite|continúe|pida|traiga|haga|vuelva|consulte|vigile|programe|siga|use|beba|coma|regrese|póngase en contacto",
    ),
    conditional:
      /^\s*(?:si|cuando)\b[^.]*,\s*(?:llame|acuda|consulte|vaya|deje|tome|vuelva)\b/iu,
  },
  pl: {
    anywhere: word(
      "należy|musi|musisz|powinien|powinna|powinno|powinni|proszę|trzeba|konieczne jest|pamiętaj|nie przyjmuj",
    ),
    atStart: start(
      "weź|zadzwoń|unikaj|zgłoś się|umów się|przyjmuj|kontynuuj|odstaw|skontaktuj się|wróć|stosuj|zażywaj|przyjdź",
    ),
    conditional:
      /^\s*(?:jeśli|jeżeli|gdy|w razie)\b[^.]*,\s*(?:zadzwoń|zgłoś się|skontaktuj się|odstaw|wróć|należy)\b/iu,
  },
  pt: {
    anywhere: word(
      "deve|deverá|deveria|precisa|tem que|terá que|por favor|não esqueça|não tome|pare de",
    ),
    atStart: start(
      "tome|ligue|procure|evite|continue|marque|traga|faça|volte|agende|mantenha|use|beba|coma|retorne|entre em contato",
    ),
    conditional:
      /^\s*(?:se|caso|quando)\b[^.]*,\s*(?:ligue|procure|volte|pare|tome|vá)\b/iu,
  },
  "zh-CN": {
    anywhere: /请|需要|必须|务必|应该|应当|应在|须在|记得|不要|按时/u,
    atStart: /^\s*(?:服用|停用|预约|联系|复查|避免|继续)/u,
  },
  "zh-TW": {
    anywhere: /請|需要|必須|務必|應該|應當|應在|須在|記得|不要|按時/u,
    atStart: /^\s*(?:服用|停用|預約|聯繫|聯絡|複查|避免|繼續)/u,
  },
};

/** The cues for a summary's language: "pt-BR" as Portuguese, any other
 * English-like or unknown tag as English. */
function cuesFor(lang: string): Cues {
  if (CUES[lang]) return CUES[lang];
  const base = lang.split("-")[0].toLowerCase();
  if (base === "zh") return CUES[/tw|hant|hk/i.test(lang) ? "zh-TW" : "zh-CN"];
  return CUES[base] ?? CUES.en;
}

/** Whether a summary sentence, in `lang`, tells the patient to do something. */
export function isInstruction(text: string, lang: string): boolean {
  const cues = cuesFor(lang);
  return (
    cues.anywhere.test(text) ||
    cues.atStart.test(text) ||
    (cues.conditional?.test(text) ?? false)
  );
}

/** One section of the summary: its sentences, with their place in it. */
export interface SummarySection<T> {
  heading: "ai.summary.saysHeading" | "ai.summary.todoHeading";
  sentences: { sentence: T; index: number }[];
}

/** The summary's sentences in order, under the two headings: those before
 * the first instruction, then that one and every one after it. A section
 * with no sentences is left out. */
export function summarySections<T extends { text: string }>(
  sentences: T[],
  lang: string,
): SummarySection<T>[] {
  const placed = sentences.map((sentence, index) => ({ sentence, index }));
  const first = sentences.findIndex(({ text }) => isInstruction(text, lang));
  const split = first < 0 ? sentences.length : first;
  const sections: SummarySection<T>[] = [
    { heading: "ai.summary.saysHeading", sentences: placed.slice(0, split) },
    { heading: "ai.summary.todoHeading", sentences: placed.slice(split) },
  ];
  return sections.filter((section) => section.sentences.length > 0);
}
