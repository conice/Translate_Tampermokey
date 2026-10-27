/**
 * Dictionary Sources: phonetic, audio and meanings for one English word.
 *
 * A Dictionary Source is deliberately separate from a translation Provider
 * (see ADR-0010). Translation must keep working even when a dictionary page
 * changes shape; every parser here returns `undefined` rather than throwing
 * when it cannot recognize the answer.
 *
 * Shapes, as measured on 2026-10-27:
 * - Youdao answers the undocumented `jsonapi` endpoint as JSON.
 * - Microsoft and Eudic have no public JSON endpoint; their web pages are
 *   parsed. Both pages are large and their markup can change without notice.
 */
import { dictionaryDev } from './providers.js';

/** How much of one part-of-speech definition the Popup shows. */
const MEANING_CHARS = 100;

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function codePoint(value) {
  try {
    return String.fromCodePoint(value);
  } catch {
    return '';
  }
}

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#x([0-9a-f]+);/giu, (_full, hex) => codePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_full, decimal) => codePoint(Number(decimal)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gu, (_full, name) => NAMED_ENTITIES[name]);
}

/** HTML fragment -> readable text. Tags are markup here, not content. */
function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<br\s*\/?>/giu, ' ')
      .replace(/<[^>]*>/gu, ''),
  )
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Dictionary sites list every sense of a word in one run. A popup that shows
 * the whole of `run`'s verb entry would cover the screen, so each part of
 * speech keeps whole semicolon-separated senses up to a readable length.
 */
function clipDefinition(text, limit = MEANING_CHARS) {
  const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
  if (clean.length <= limit) return clean;
  const parts = clean.split(/[；;]/u);
  let out = '';
  for (const part of parts) {
    const next = out ? `${out}；${part}` : part;
    if (out && next.length > limit) break;
    out = next;
    if (out.length >= limit) break;
  }
  if (out.length > limit) out = out.slice(0, limit);
  return `${out.replace(/[；;]\s*$/u, '')}…`;
}

function normalizePhonetic(text) {
  const value = stripTags(text);
  if (!value) return undefined;
  return /^[/[].*[/\]]$/u.test(value) ? value : `/${value}/`;
}

function youdaoSpeech(speech) {
  if (typeof speech !== 'string' || !speech.trim()) return undefined;
  const [audio, query = ''] = speech.split('&');
  const type = new URLSearchParams(query).get('type') ?? '2';
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(audio)}&type=${encodeURIComponent(type)}`;
}

/** "v. 跑，奔跑；…" -> `{ pos: 'v.', definition: '跑，奔跑；…' }`. */
function splitYoudaoMeaning(text) {
  const clean = decodeEntities(String(text ?? ''))
    .replace(/\s+/gu, ' ')
    .trim();
  if (!clean) return undefined;
  const cn = /^【([^】]+)】\s*(.*)$/u.exec(clean);
  if (cn) return { pos: cn[1].trim(), definition: cn[2].trim() };
  const latin = /^([A-Za-z][A-Za-z.&/\s]{0,20}?)\s+([\s\S]+)$/u.exec(clean);
  if (latin) return { pos: latin[1].trim(), definition: latin[2].trim() };
  return { pos: '', definition: clean };
}

/**
 * Youdao. `dicts` asks for the English-Chinese and pronunciation sections
 * only: the unrestricted answer for `run` is ~500 KB, this one ~2 KB.
 */
export const youdao = {
  id: 'youdao',
  label: '有道词典',
  request({ word }) {
    const dicts = encodeURIComponent(JSON.stringify({ count: 1, dicts: [['ec'], ['simple']] }));
    return `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}&dicts=${dicts}`;
  },
  parse(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (!data || typeof data !== 'object') return undefined;

    const ecWord = data.ec?.word?.[0];
    const simpleWord = data.simple?.word?.[0];
    if (!ecWord && !simpleWord) return undefined;

    const phonetic = normalizePhonetic(
      ecWord?.usphone ?? simpleWord?.usphone ?? ecWord?.ukphone ?? simpleWord?.ukphone,
    );
    const audio = youdaoSpeech(
      ecWord?.usspeech ?? simpleWord?.usspeech ?? ecWord?.ukspeech ?? simpleWord?.ukspeech,
    );

    const meanings = [];
    outer: for (const group of ecWord?.trs ?? []) {
      for (const tr of group.tr ?? []) {
        const raw = tr.l?.i;
        const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
        for (const item of items) {
          const parsed = splitYoudaoMeaning(item);
          if (!parsed?.definition) continue;
          meanings.push({ pos: parsed.pos, definition: clipDefinition(parsed.definition) });
          if (meanings.length >= 3) break outer;
        }
      }
    }

    const lemma = typeof ecWord?.prototype === 'string' ? ecWord.prototype : undefined;
    if (!phonetic && !audio && meanings.length === 0 && !lemma) return undefined;
    return { phonetic, audio, meanings, lemma };
  },
};

/** `美 [rʌn]` -> `/rʌn/`; an entry with no bracket has no phonetic to show. */
function bingPhonetic(text) {
  const value = stripTags(text);
  if (!value) return undefined;
  const bracket = /\[([^\]]+)\]/u.exec(value);
  if (bracket) return `/${bracket[1].trim()}/`;
  const slashed = /\/([^/]+)\//u.exec(value);
  return slashed ? slashed[0] : undefined;
}

function bingAudio(html) {
  const tag =
    /<a\b[^>]*\bid=["']bigaud_us["'][^>]*>/iu.exec(html)?.[0] ??
    /<a\b[^>]*\bid=["']bigaud_uk["'][^>]*>/iu.exec(html)?.[0];
  if (!tag) return undefined;
  const link = /data-mp3link=["']([^"']+)["']/iu.exec(tag)?.[1];
  if (!link) return undefined;
  const decoded = decodeEntities(link);
  if (decoded.startsWith('//')) return `https:${decoded}`;
  if (decoded.startsWith('/')) return `https://cn.bing.com${decoded}`;
  return decoded;
}

/**
 * Microsoft's dictionary, served as the Bing dictionary page. There is no
 * public JSON endpoint; `qdef` is the block the page itself calls the
 * definition area.
 */
export const microsoft = {
  id: 'microsoft',
  label: '微软词典',
  request({ word }) {
    return `https://cn.bing.com/dict/search?q=${encodeURIComponent(word)}`;
  },
  parse(html) {
    if (typeof html !== 'string' || !/<div[^>]*class="[^"]*\bqdef\b[^"]*"/iu.test(html)) {
      return undefined;
    }

    const phonetic =
      bingPhonetic(
        /<div[^>]*class="[^"]*\bhd_prUS\b[^"]*"[^>]*>([\s\S]*?)<\/div>/iu.exec(html)?.[1],
      ) ??
      bingPhonetic(
        /<div[^>]*class="[^"]*\bhd_pr\b[^"]*"[^>]*>([\s\S]*?)<\/div>/iu.exec(html)?.[1],
      );
    const audio = bingAudio(html);

    const meanings = [];
    for (const match of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)) {
      const li = match[1];
      const def = /<span[^>]*class="[^"]*\bdef\b[^"]*"[^>]*>([\s\S]*)<\/span>/iu.exec(li)?.[1];
      if (!def) continue;
      const definition = stripTags(def);
      if (!definition) continue;
      const pos = /<span[^>]*class="[^"]*\bpos\b[^"]*"[^>]*>([\s\S]*?)<\/span>/iu.exec(li)?.[1];
      meanings.push({
        pos: pos ? stripTags(pos) : '',
        definition: clipDefinition(definition),
      });
      if (meanings.length >= 3) break;
    }

    if (!phonetic && !audio && meanings.length === 0) return undefined;
    return { phonetic, audio, meanings };
  },
};

function hasClass(attributes, name) {
  const raw = /class\s*=\s*["']([^"']*)["']/iu.exec(attributes)?.[1] ?? '';
  return raw.split(/\s+/u).includes(name);
}

function eudicPhonetic(html) {
  const values = [];
  /*
   * The class must be one whole token: the wrapper is `phonitic-line`, and a
   * substring match would read the wrapper's first child as a phonetic.
   */
  for (const match of html.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/giu)) {
    if (!hasClass(match[1], 'Phonitic')) continue;
    const value = stripTags(match[2]);
    if (value) values.push(value);
  }
  // The page lists British first and American second; an American recording is
  // the same preference the audio picker uses.
  return normalizePhonetic(values[1] ?? values[0] ?? '');
}

function eudicMeanings(child) {
  const list = /<ol\b[^>]*>([\s\S]*?)<\/ol>/iu.exec(child)?.[1];
  if (!list) {
    const text = stripTags(child);
    return text ? [{ pos: '', definition: clipDefinition(text) }] : [];
  }

  const meanings = [];
  let current;
  for (const match of list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)) {
    const li = match[1];
    const text = stripTags(li);
    if (!text) continue;
    const posMarkup = /<i\b[^>]*>([\s\S]*?)<\/i>/iu.exec(li);
    if (posMarkup) {
      current = {
        pos: stripTags(posMarkup[1]),
        definition: stripTags(li.replace(posMarkup[0], '')),
      };
      meanings.push(current);
    } else if (current) {
      current.definition = current.definition
        ? `${current.definition}；${text}`
        : text;
    } else {
      current = { pos: '', definition: text };
      meanings.push(current);
    }
    if (meanings.length >= 3) break;
  }

  return meanings
    .filter((meaning) => meaning.definition)
    .map((meaning) => ({ pos: meaning.pos, definition: clipDefinition(meaning.definition) }));
}

/**
 * Eudic. The English-Chinese entry lives in `#ExpFCchild`: an ordered list
 * whose items change part of speech only where an <i> starts one.
 */
export const eudic = {
  id: 'eudic',
  label: '欧陆词典',
  request({ word }) {
    return `https://dict.eudic.net/dicts/en/${encodeURIComponent(word)}`;
  },
  parse(html) {
    if (typeof html !== 'string') return undefined;
    const child = /<div[^>]*\bid=["']ExpFCchild["'][^>]*>([\s\S]*?)<\/div>/iu.exec(html)?.[1];
    if (!child) return undefined;
    const phonetic = eudicPhonetic(html);
    const meanings = eudicMeanings(child);
    if (!phonetic && meanings.length === 0) return undefined;
    return { phonetic, meanings };
  },
};

/** The existing English-English source, kept as a fourth choice. */
const englishDictionary = { ...dictionaryDev, label: '英英词典' };

export const DICTIONARIES = [youdao, microsoft, eudic, englishDictionary];

export const DEFAULT_DICTIONARY = 'youdao';

export const DICTIONARY_IDS = DICTIONARIES.map((source) => source.id);

/** [id, label] pairs in the order the selectors list them. */
export const DICTIONARY_CHOICES = DICTIONARIES.map(({ id, label }) => [id, label]);

export function dictionaryById(id) {
  return DICTIONARIES.find((source) => source.id === id);
}
