import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Deterministic first layer of crisis handling. It is deliberately simple,
 * transparent and testable, and it works when the AI provider is unavailable.
 * It is NOT a reliable detector: it will miss indirect phrasing and will
 * sometimes flag benign text. It only decides whether to surface crisis
 * resources and how cautiously to respond; it never contacts anyone.
 */

export type RiskLevel = 'none' | 'concern' | 'urgent';
export type RiskCategory = 'self_harm' | 'harm_from_others';

export interface RiskAssessment {
  level: RiskLevel;
  categories: RiskCategory[];
}

export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/([a-z])\1{2,}/g, '$1') // "mamatayyyy" -> "mamatay"
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Explicit statements of intent to end one's life now -> urgent.
const URGENT_SELF: RegExp[] = [
  /\b(i'?m|im|i am) (going to|gonna|about to) (kill myself|end (it all|my life)|take my (own )?life)\b/,
  /\bi (will|'?ll) (kill myself|end my life|take my (own )?life)\b/,
  /\b(papatayin|patayin) ko (na )?(ang )?(sarili ko|aking sarili)\b/,
  /\bmagpapakamatay (na )?(ako|na ko)\b/,
  /\b(tatalon|tumalon) (na )?(ako )?.{0,20}\b(tulay|bridge|building|gusali|bintana|rooftop)\b/,
];

// Self-harm or suicidal ideation without explicit immediacy -> concern.
const CONCERN_SELF: RegExp[] = [
  /\b(kill|killing|hang|hanging|shoot|shooting|poison|poisoning|hurt|hurting|cut|cutting|harm|harming) myself\b/,
  /\b(end|ending|take|taking) my (own )?life\b/,
  /\bsuicid(e|al)\b/,
  /\bself ?harm(ing)?\b/,
  /\b(want|wanna|wants|wish|going|gonna|ready|plan(ning)?) (to )?die\b(?! (laughing|of (embarrassment|laughter|cringe|boredom)))/,
  /\bi wish i (was|were) (dead|never born)\b/,
  /\b(no|not any) (reason|point) (to|in) (live|living|being alive)\b/,
  /\bbetter off (dead|without me)\b/,
  /\b(don'?t|do not|dont) want to (be alive|live anymore|wake up)\b/,
  /\boverdos(e|ing)\b/,
  /\b(nagpapakamatay|magpakamatay|magpapakamatay|pagpapakamatay|nagpakamatay)\b/,
  /\b(gusto|gustong|sana)( (ko|kong|na|nang|ng|lang|talaga)){0,4} (mamatay|mawala na|maglaho na|magpakamatay)\b/,
  /\b(ayoko|ayaw ko) (na|nang|ng) (mabuhay|gumising)\b/,
  /\bwala (na )?(ng |nang )?(saysay|silbi|kwenta|kuwenta) (ang )?(buhay|mabuhay)( ko)?\b/,
  /\bmas (mabuti|okay|ok) (pa )?(kung )?(wala|patay) na (lang )?ako\b/,
  /\b(sasaktan|saktan|sinasaktan|sinaktan) ko (ang )?(sarili ko|aking sarili)\b/,
  /\b(maglaslas|naglalaslas|naglaslas|maglalaslas|laslas)\b/,
];

// Danger from another person (abuse, violence) -> concern.
const CONCERN_OTHERS: RegExp[] = [
  /\b(sinasaktan|binubugbog|binugbog|sinusuntok|sinuntok|ginahasa|ginagahasa|minolestya|minomolestya|hinahalay|hinalay) (niya |nila )?ako\b/,
  /\b(he|she|they|my (partner|husband|wife|boyfriend|girlfriend|father|mother|dad|mom|stepdad|stepfather)) (hits|beats|hurts|hit|beat|hurt|chokes|choked|raped|rapes|molested|molests) me\b/,
  /\b(being|been|was|am) (abused|raped|molested|assaulted)\b/,
  /\b(threaten(ed|s|ing)? to kill me|papatayin (niya|nila) ako)\b/,
];

// Words that make a concern statement more immediate.
const IMMEDIACY = /\b(tonight|right now|now|today|ngayon|ngayong gabi|mamaya|bukas|goodbye|paalam)\b/;
const MEANS = /\b(pills|rope|lubid|blade|kutsilyo|knife|gun|baril|lason|poison|tulay|bridge)\b/;

export function assessRisk(text: string): RiskAssessment {
  const t = normalize(text);
  const categories = new Set<RiskCategory>();
  let level: RiskLevel = 'none';

  if (URGENT_SELF.some((re) => re.test(t))) {
    categories.add('self_harm');
    level = 'urgent';
  } else if (CONCERN_SELF.some((re) => re.test(t))) {
    categories.add('self_harm');
    level = IMMEDIACY.test(t) || MEANS.test(t) ? 'urgent' : 'concern';
  }
  if (CONCERN_OTHERS.some((re) => re.test(t))) {
    categories.add('harm_from_others');
    if (level === 'none') level = 'concern';
  }
  return { level, categories: [...categories] };
}

// ---------------------------------------------------------------------------
// Resources and safe template responses (no AI involved).
// ---------------------------------------------------------------------------

export interface CrisisPhone {
  label: string;
  labelFil: string;
  number: string;
  tel: string;
}

export interface CrisisResource {
  id: string;
  name: string;
  nameFil: string;
  description: string;
  descriptionFil: string;
  phones: CrisisPhone[];
  hours: string;
  source: string;
}

export interface CrisisResourceFile {
  country: string;
  lastVerified: string;
  verificationNote: string;
  resources: CrisisResource[];
}

let cached: CrisisResourceFile | null = null;

export function crisisResources(): CrisisResourceFile {
  if (!cached) {
    const file = process.env.CRISIS_RESOURCES_FILE ?? path.resolve(process.cwd(), 'web/data/crisis-resources.json');
    cached = JSON.parse(readFileSync(file, 'utf8')) as CrisisResourceFile;
  }
  return cached;
}

const FIL_MARKERS = /\b(ako|ko|ka|mo|ng|nang|ang|sa|hindi|di|wala|gusto|ayoko|kasi|lang|talaga|naman|siya|niya|ba|po|na|yung|kung|pero|parang)\b/g;

export function guessLanguage(text: string): 'fil' | 'en' {
  const hits = normalize(text).match(FIL_MARKERS)?.length ?? 0;
  return hits >= 2 ? 'fil' : 'en';
}

export function safetyReply(level: Exclude<RiskLevel, 'none'>, categories: RiskCategory[], lang: 'fil' | 'en'): string {
  const others = categories.includes('harm_from_others') && !categories.includes('self_harm');
  if (lang === 'fil') {
    if (others) {
      return (
        'Salamat at sinabi mo ito sa akin. Hindi mo kasalanan ang pananakit na nararanasan mo, at karapat-dapat kang maging ligtas. ' +
        'Kung nasa agarang panganib ka, tumawag sa 911. Kung kaya mo, lumapit sa isang taong pinagkakatiwalaan mo o sa isang ligtas na lugar. ' +
        'Hindi ako makakatawag ng tulong para sa iyo, pero nandito ako kung gusto mong magkuwento pa.'
      );
    }
    return level === 'urgent'
      ? 'Salamat at sinabi mo ito sa akin. Mukhang napakabigat ng nararamdaman mo ngayon, at mahalaga ang kaligtasan mo. ' +
          'Hindi ako makakatawag ng tulong para sa iyo, kaya pakiusap: kung nasa agarang panganib ka, tumawag ngayon sa 911, ' +
          'o sa NCMH Crisis Hotline sa 1553. Kung kaya mo, tawagan o puntahan ang isang taong pinagkakatiwalaan mo at huwag kang mag-isa ngayon. ' +
          'Nandito pa rin ako kung gusto mong magpatuloy na magkuwento.'
      : 'Salamat sa pagtitiwala mo na sabihin ito. Mukhang mabigat talaga ang dinadala mo ngayon, at hindi mo kailangang harapin ito nang mag-isa. ' +
          'Kung gusto mong may makausap na tao ngayon, bukas ang NCMH Crisis Hotline (1553) anumang oras. ' +
          'Puwede ka ring lumapit sa isang kaibigan, kapamilya, o taong pinagkakatiwalaan mo. Nandito ako para makinig.';
  }
  if (others) {
    return (
      "Thank you for telling me. What is happening to you is not your fault, and you deserve to be safe. " +
      'If you are in immediate danger, please call 911. If you can, reach out to someone you trust or go to a safe place. ' +
      "I can't contact anyone for you, but I'm here if you want to keep talking."
    );
  }
  return level === 'urgent'
    ? "Thank you for telling me. It sounds like you're carrying something incredibly heavy right now, and your safety matters. " +
        "I can't call for help on your behalf, so please, if you are in immediate danger, call 911 now, or the NCMH Crisis Hotline at 1553. " +
        "If you can, reach out to someone you trust and try not to be alone right now. I'm still here if you want to keep talking."
    : "Thank you for trusting me with this. It sounds like you're carrying a lot right now, and you don't have to face it alone. " +
        "If you'd like to talk to a person, the NCMH Crisis Hotline (1553) is available any time. " +
        "Reaching out to a friend, family member or someone you trust can help too. I'm here to listen.";
}
