/**
 * Which of the app's languages a document is written in (#215), so that its
 * placeholders can use that language's words. Plain text in, a locale out:
 * no network, no i18n, nothing remembered. It guesses from common words and
 * from letters only one language uses, and says when it is not confident;
 * then the app's own language is used, and the preview lets the patient
 * choose.
 */

export type DocumentLocale =
  | "en"
  | "fr"
  | "es"
  | "pl"
  | "pt-BR"
  | "zh-CN"
  | "zh-TW";

export interface DocumentLanguage {
  locale: DocumentLocale;
  /** False when the text is too short or too mixed to tell: `locale` is
   * then the app's language (or its Chinese, for Chinese text). */
  confident: boolean;
}

type Latin = "en" | "fr" | "es" | "pl" | "pt-BR";

/** About 40 short, frequent words per language, matched as whole words in
 * lower case. Words two languages share count for both. */
const STOP_WORDS: Record<Latin, ReadonlySet<string>> = {
  en: new Set(
    "the and of to in is was for with on at by from this that be are has have had not or an as it he she his her you your will were been after before no which who than".split(
      " ",
    ),
  ),
  fr: new Set(
    "le la les des du de et est un une pour avec dans sur par au aux ce cette qui que il elle son sa ses vous votre été sont pas ne plus mais ou lors après avant chez très".split(
      " ",
    ),
  ),
  es: new Set(
    "el la los las del de y es un una para con en por al que se su sus usted ha han fue son no pero o como más este esta tras antes después muy sin sobre desde hasta entre".split(
      " ",
    ),
  ),
  pl: new Set(
    "i w z na nie się do jest że to o od po przez dla jak ale lub oraz był była są ma może tak przy pod nad bez czy już tylko także który która które jego jej ich roku".split(
      " ",
    ),
  ),
  "pt-BR": new Set(
    "o a os as do da dos das de e é um uma para com em no na nos nas por ao que se seu sua você foi são não mas ou como mais este esta após antes sem muito".split(
      " ",
    ),
  ),
};

/** Letters only one of the languages uses (in this set of seven). */
const OWN_LETTERS: Record<Latin, RegExp> = {
  en: /(?!)/gu,
  fr: /[èêàùœ]/gu,
  es: /[ñ¿¡]/gu,
  pl: /[łąęśźżń]/gu,
  "pt-BR": /[ãõ]/gu,
};

/** Characters written one way in simplified Chinese and another in
 * traditional; a character both scripts share counts for neither. */
const SIMPLIFIED_ONLY = new Set(
  "医诊检药门过们这时验报疗护级规处现实应关开问题给说话请谢页务员单证书号电网络记录体压减轻头颈脑肾肠胆节质静动运进选择种类数据测试观断术输剂针颗胶缓释维钙铁锌钾钠镁结论议见视听觉读写长东车间闭阅广产业乐历华国图团园围张归当总战扩扫担换损显杂条来极标样欢毕汇没洁济湿满点热爱状独环盖监码确离积称稳简红约纸线组细织终经统继续综职联肤脸苏获营补装计认讨训讲许设访评识诉译详语误课谁调谈负责购费资转软较辅边达还远连适钟钱银锁错键镜闻阳阶际陈险随难韩顶项顺须顾预领频额风飞饭鲜鸡齐齿卫层岁龄儿妇婴肿疮疡痫疟瘫",
);
const TRADITIONAL_ONLY = new Set(
  "醫診檢藥門過們這時驗報療護級規處現實應關開問題給說話請謝頁務員單證書號電網絡記錄體壓減輕頭頸腦腎腸膽節質靜動運進選擇種類數據測試觀斷術輸劑針顆膠緩釋維鈣鐵鋅鉀鈉鎂結論議見視聽覺讀寫長東車間閉閱廣產業樂歷華國圖團園圍張歸當總戰擴掃擔換損顯雜條來極標樣歡畢匯沒潔濟濕滿點熱愛狀獨環蓋監碼確離積稱穩簡紅約紙線組細織終經統繼續綜職聯膚臉蘇獲營補裝計認討訓講許設訪評識訴譯詳語誤課誰調談負責購費資轉軟較輔邊達還遠連適鐘錢銀鎖錯鍵鏡聞陽階際陳險隨難韓頂項順須顧預領頻額風飛飯鮮雞齊齒衛層歲齡兒婦嬰腫瘡瘍癇瘧癱",
);

/** Enough evidence to choose: this many word hits for the top language… */
const MIN_HITS = 20;
/** …and at least this much more than the next one. */
const MARGIN = 1.5;
/** One-form Chinese characters needed to choose a script. */
const MIN_HAN_FORMS = 5;

const HAN = /\p{Script=Han}/u;
const LATIN = /\p{Script=Latin}/u;

export function detectDocumentLanguage(
  text: string,
  appLocale: DocumentLocale,
): DocumentLanguage {
  const unsure = (locale: DocumentLocale = appLocale): DocumentLanguage => ({
    locale,
    confident: false,
  });
  let han = 0;
  let latin = 0;
  let simplified = 0;
  let traditional = 0;
  for (const character of text) {
    if (HAN.test(character)) {
      han++;
      if (SIMPLIFIED_ONLY.has(character)) simplified++;
      else if (TRADITIONAL_ONLY.has(character)) traditional++;
    } else if (LATIN.test(character)) latin++;
  }
  const letters = han + latin;
  if (!letters) return unsure();
  if (han / letters >= 0.3) {
    const appChinese =
      appLocale === "zh-CN" || appLocale === "zh-TW" ? appLocale : "zh-CN";
    if (simplified >= MIN_HAN_FORMS && simplified > traditional)
      return { locale: "zh-CN", confident: true };
    if (traditional >= MIN_HAN_FORMS && traditional > simplified)
      return { locale: "zh-TW", confident: true };
    return unsure(appChinese);
  }
  if (latin / letters < 0.6) return unsure();
  const lower = text.toLowerCase();
  const words = lower.match(/\p{L}+/gu) ?? [];
  const scores = (Object.keys(STOP_WORDS) as Latin[]).map((locale) => {
    let hits = 0;
    for (const word of words) if (STOP_WORDS[locale].has(word)) hits++;
    hits += lower.match(OWN_LETTERS[locale])?.length ?? 0;
    return { locale, hits };
  });
  scores.sort((a, b) => b.hits - a.hits);
  const [top, next] = scores;
  if (top.hits >= MIN_HITS && top.hits >= next.hits * MARGIN)
    return { locale: top.locale, confident: true };
  return unsure();
}
