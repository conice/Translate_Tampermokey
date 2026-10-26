import { cacheKey } from './cache.js';

export class ProviderError extends Error {
  constructor(message, { status, retryable = true } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Google's `dict-chrome-ex` endpoint. Undocumented and not offered for
 * third-party use: it can rate-limit or block at any time with no notice
 * (the sibling `translate_a/single?client=gtx` endpoint already answers 429).
 * It is first in the chain only because it is the one source that translates
 * arbitrary languages *and* batches, which the inline-gloss pass depends on.
 *
 * Batch shape is `q=a&q=b&q=c`; with `sl=auto` each reply is
 * `[translation, detectedSource]`, without it a bare translation string.
 */
export const clients5 = {
  id: 'clients5',
  maxBatch: 50,
  request({ text, source, target }) {
    const params = new URLSearchParams({ client: 'dict-chrome-ex', sl: source, tl: target });
    const items = Array.isArray(text) ? text : [text];
    for (const item of items) params.append('q', item);
    return `https://clients5.google.com/translate_a/t?${params.toString()}`;
  },
  parse(body, { text }) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ProviderError('clients5: response was not JSON');
    }
    const items = Array.isArray(text) ? text : [text];
    if (!Array.isArray(data) || data.length !== items.length) {
      throw new ProviderError('clients5: unexpected response shape');
    }
    return data.map((row) => {
      if (Array.isArray(row)) {
        if (typeof row[0] !== 'string') throw new ProviderError('clients5: malformed item');
        return { translation: row[0], detectedSource: row[1] };
      }
      if (typeof row !== 'string') throw new ProviderError('clients5: malformed item');
      return { translation: row, detectedSource: undefined };
    });
  },
};

/**
 * Lingva, a self-hostable Google Translate front end. Batches by joining with
 * newlines and only accepts two-letter language codes (`zh-CN` is a 400).
 *
 * Operational caveat measured on 2026-10-26: the public instance answers 200
 * for every request but echoes the input back untranslated. It is kept as a
 * fallback because the protocol is right and a self-hosted instance works;
 * `translate()` prefers MyMemory before it for this reason.
 */
export const lingva = {
  id: 'lingva',
  maxBatch: 1,
  request({ text, source, target }) {
    const items = Array.isArray(text) ? text : [text];
    const joined = items.join('\n');
    const targetCode = target.split('-')[0];
    return `https://lingva.ml/api/v1/${source}/${targetCode}/${encodeURIComponent(joined)}`;
  },
  parse(body, { text }) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ProviderError('lingva: response was not JSON');
    }
    if (typeof data?.translation !== 'string') {
      throw new ProviderError(data?.error ? `lingva: ${data.error}` : 'lingva: unexpected response shape');
    }
    const items = Array.isArray(text) ? text : [text];
    const result = { translation: data.translation, detectedSource: data.info?.detectedSource };
    // One request answered several items: split them back apart.
    if (items.length > 1) result.parts = data.translation.split('\n');
    return [result];
  },
};

/**
 * MyMemory. Only reliable for lookup, not for inline-gloss batching: it has no
 * batch parameter and rejects `autodetect`, so every call needs a known source
 * language. Its anonymous quota is small.
 */
export const mymemory = {
  id: 'mymemory',
  maxBatch: 1,
  request({ text, source, target }) {
    const items = Array.isArray(text) ? text : [text];
    const sourceCode = source === 'auto' || !source ? 'en' : source;
    const params = new URLSearchParams({ q: items[0] ?? '', langpair: `${sourceCode}|${target}` });
    return `https://api.mymemory.translated.net/get?${params.toString()}`;
  },
  parse(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ProviderError('mymemory: response was not JSON');
    }
    const status = Number(data?.responseStatus);
    const translated = data?.responseData?.translatedText;
    if (typeof translated !== 'string' || (status && status !== 200)) {
      throw new ProviderError(`mymemory: ${data?.responseDetails || 'unexpected response'}`);
    }
    return [{ translation: translated, detectedSource: undefined }];
  },
};

/**
 * English dictionary: IPA, audio, part of speech, first definition.
 * Lookup only, so it never participates in the failover chain; it is fetched
 * in parallel with the translation and its absence is not an error.
 */
export const dictionaryDev = {
  id: 'dictionaryapi',
  request({ word }) {
    return `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  },
  parse(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return undefined;
    }
    if (!Array.isArray(data) || data.length === 0) return undefined;
    const entry = data[0];
    const phonetic = entry.phonetics?.find((p) => p.text)?.text;
    const audio = entry.phonetics?.find((p) => p.audio)?.audio;
    const meanings = [];
    for (const meaning of entry.meanings ?? []) {
      const definition = meaning.definitions?.[0]?.definition;
      if (meaning.partOfSpeech && definition) {
        meanings.push({ pos: meaning.partOfSpeech, definition });
      }
      if (meanings.length === 3) break;
    }
    return { phonetic, audio, meanings };
  },
};

export const DEFAULT_PROVIDERS = [clients5, mymemory, lingva];

/**
 * Wiktionary-derived dictionary, the only free source that states what word a
 * form belongs to ("simple past of run"). Used only to offer "save the base
 * form instead"; it never rewrites what the user saved.
 */
export const freedictionary = {
  id: 'freedictionary',
  request({ word }) {
    return `https://freedictionaryapi.com/api/v1/entries/en/${encodeURIComponent(word)}`;
  },
  /** Returns the base form when this word is inflected, else undefined. */
  parseLemma(body) {
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return undefined;
    }
    // `data.entries` is a function on an array, hence the explicit check.
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    for (const entry of entries) {
      for (const sense of entry.senses ?? []) {
        if (!(sense.tags ?? []).includes('form of')) continue;
        const match = /^(?:[a-z]+\s+)*of\s+([a-z'-]+)(?:\s+and\s+[a-z'-]+)?$/iu.exec(
          String(sense.definition ?? '').trim(),
        );
        if (match) return match[1].toLowerCase();
      }
    }
    return undefined;
  },
};

/**
 * Translate one or more texts, failing over across providers.
 *
 * The chain is tried in order and the first provider that returns a usable
 * answer wins the whole call: partial results are not mixed between sources,
 * because that would make the cache and the glosses inconsistent. Text
 * already in the cache is not re-requested.
 */
export function createTranslator({
  providers = DEFAULT_PROVIDERS,
  fetchText,
  cache,
  batchSize,
  onProviderError = () => {},
}) {
  return async function translate({ text, source = 'auto', target }) {
    const items = (Array.isArray(text) ? text : [text]).filter((t) => typeof t === 'string' && t.length > 0);
    if (items.length === 0) return [];

    const results = new Array(items.length);
    const missing = [];

    items.forEach((item, index) => {
      if (!cache) {
        missing.push(index);
        return;
      }
      const cached = cache.get(cacheKey({ source, target, text: item }));
      if (cached) results[index] = cached;
      else missing.push(index);
    });

    if (missing.length === 0) return results;

    const texts = missing.map((i) => items[i]);
    let lastError;
    let answer = null;

    for (const provider of providers) {
      const chunks = chunk(texts, Math.min(batchSize ?? provider.maxBatch, provider.maxBatch));
      try {
        const collected = [];
        for (const chunkTexts of chunks) {
          const url = provider.request({ text: chunkTexts, source, target });
          const body = await fetchText(url);
          const parsed = provider.parse(body, { text: chunkTexts });
          for (const chunkItem of expand(parsed, chunkTexts)) {
            collected.push({ ...chunkItem, provider: provider.id });
          }
        }
        answer = collected;
        break;
      } catch (error) {
        lastError = error;
        onProviderError(provider.id, error);
      }
    }

    if (!answer) {
      const failure = lastError ?? new ProviderError('no provider available');
      for (const index of missing) {
        if (cache) cache.set(cacheKey({ source, target, text: items[index] }), { error: failure.message }, { ok: false });
      }
      throw failure;
    }

    answer.forEach((item, i) => {
      const original = texts[i];
      results[missing[i]] = item;
      if (cache && original !== undefined) {
        cache.set(cacheKey({ source, target, text: original }), item, { ok: true });
      }
    });

    return results;
  };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Turn a provider's one-or-many parse output into exactly one item per input. */
function expand(parsed, texts) {
  if (parsed.length === texts.length) return parsed;
  if (parsed.length === 1 && Array.isArray(parsed[0].parts) && parsed[0].parts.length === texts.length) {
    return parsed[0].parts.map((part) => ({
      translation: part,
      detectedSource: parsed[0].detectedSource,
    }));
  }
  if (parsed.length === 1 && texts.length === 1) return parsed;
  throw new ProviderError('provider returned a mismatched number of results');
}