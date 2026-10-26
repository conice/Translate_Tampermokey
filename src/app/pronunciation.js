/**
 * Pronunciation playback.
 *
 * A recording from the Dictionary Source is preferred, because the system voice
 * is a synthesis rather than the word as a person says it. Everything about the
 * recording is best-effort: the download, the page's CSP and the audio decoder
 * can each fail on a given word or site, and none of that deserves an error
 * message when the system voice is already there as a fallback.
 *
 * Cancellation is one counter rather than a set of flags: a second tap has to
 * cancel both a playback in progress and a download still in flight, and an
 * `await` that resumes afterwards must not start playing stale audio. Every
 * handler therefore carries the counter value it was created under.
 *
 * All four effects are injected — the network, the audio element, the object
 * URL and the system voice — so this module runs without a browser.
 */
export function createPronouncer({ fetchBlob, createAudio, objectUrls, speakText }) {
  let token = 0;
  let playing = null;
  let downloading = false;

  function stop() {
    token += 1;
    downloading = false;
    const current = playing;
    playing = null;
    if (!current) return;
    try {
      current.audio?.pause?.();
    } catch {
      /* already torn down */
    }
    try {
      objectUrls.revoke(current.url);
    } catch {
      /* not every engine has it */
    }
  }

  async function play(term, lang, audioUrl) {
    // One voice at a time: a tap while anything is audible stops it instead.
    if (playing || downloading) {
      stop();
      return;
    }
    if (!audioUrl) {
      speakText(term, lang);
      return;
    }

    const mine = (token += 1);
    downloading = true;
    try {
      const blob = await fetchBlob(audioUrl);
      if (mine !== token) return;
      const url = objectUrls.create(blob);
      // Recorded before the element exists, so a constructor that throws still
      // leaves the temporary URL reachable by `stop`.
      playing = { audio: null, url };
      const audio = createAudio(url);
      playing.audio = audio;
      downloading = false;

      audio.onended = () => {
        if (mine === token) stop();
      };
      audio.onerror = () => {
        if (mine !== token) return;
        stop();
        speakText(term, lang);
      };
      await audio.play();
    } catch {
      if (mine !== token) return;
      stop();
      speakText(term, lang);
    }
  }

  return {
    play,
    stop,
    get playing() {
      return Boolean(playing) || downloading;
    },
  };
}