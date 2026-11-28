// YouTube / YouTube Music playback inside RideLens via YouTube's official IFrame Player API.
// YouTube Music has no public control API, but its playlists, albums and songs are YouTube
// playlists/videos, so their links play through the standard embedded player.
// YouTube's API terms require the player itself to stay visible (min 200x200 px).

// The YouTube link in some copied text ("Check out this playlist https://music.youtube.com/…"),
// or null. Share sheets often copy a sentence around the link.
export function youTubeLinkIn(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  for (const m of t.match(/https?:\/\/\S+|(?:www\.|m\.|music\.)?youtu(?:\.be|be\.com)\/\S+/gi) || [t]) {
    const link = m.replace(/[)\].,!?'"]+$/, '');
    if (parseYouTubeLink(link)) return link;
  }
  return null;
}

// Accepts links from youtube.com, music.youtube.com, m.youtube.com and youtu.be, or a bare
// playlist / video ID. Returns { list, video } (either may be null) or null.
export function parseYouTubeLink(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const ID = /^[A-Za-z0-9_-]{11}$/;
  const LIST = /^(PL|OLAK5uy_|RD|UU|LL|FL|OL|VL)[A-Za-z0-9_-]{8,}$/;
  if (ID.test(s)) return { list: null, video: s };
  if (LIST.test(s)) return { list: s.replace(/^VL/, ''), video: null };
  let url;
  try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (!['youtube.com', 'youtu.be', 'youtube-nocookie.com'].includes(host)) return null;
  let video = url.searchParams.get('v');
  if (host === 'youtu.be') video = url.pathname.slice(1).split('/')[0] || null;
  const m = url.pathname.match(/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
  if (!video && m) video = m[1];
  let list = url.searchParams.get('list') || (url.pathname.match(/^\/browse\/VL([A-Za-z0-9_-]{10,})/) || [])[1] || null;
  if (list) list = list.replace(/^VL/, '');
  if (video && !ID.test(video)) video = null;
  if (list && !/^[A-Za-z0-9_-]{10,}$/.test(list)) list = null;
  return list || video ? { list, video } : null;
}

let apiPromise;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = null; reject(new Error('Could not load the YouTube player (offline?)')); };
    document.head.append(s);
    setTimeout(() => reject(new Error('YouTube player took too long to load')), 15000);
  });
  return apiPromise;
}

export function createYouTubePlayer(elementId, { onChange } = {}) {
  let player = null, ready = null, state = -1, blockedRun = 0, skipTimer = null;
  const emit = () => onChange?.({
    loaded: !!player, playing: state === 1, buffering: state === 3, ended: state === 0,
    title: player?.getVideoData?.().title || '',
    index: player?.getPlaylistIndex?.() ?? -1, count: player?.getPlaylist?.()?.length ?? 0,
  });

  // autoplay false: only cue it, so a later tap on Play starts it at once (iPhone Safari
  // only lets a tap start sound if the player is already there when you tap)
  // One load at a time: a ▶ tap while the player is still being prepared in the background
  // must not build a second player or call one that isn't ready yet.
  let queue = Promise.resolve();
  function load(link, opts) {
    const run = queue.then(() => doLoad(link, opts));
    queue = run.catch(() => {});
    return run;
  }
  async function doLoad(link, { autoplay = true } = {}) {
    const parsed = parseYouTubeLink(link);
    if (!parsed) throw new Error('That is not a YouTube or YouTube Music link');
    const YT = await loadApi();
    if (player) {
      await ready;
      if (parsed.list) player[autoplay ? 'loadPlaylist' : 'cuePlaylist']({ list: parsed.list, listType: 'playlist', index: 0 });
      else player[autoplay ? 'loadVideoById' : 'cueVideoById'](parsed.video);
      return parsed;
    }
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('YouTube player did not start')), 15000);
      player = new YT.Player(elementId, {
        width: '100%', height: '100%',
        // the API rejects an empty videoId key ("Invalid video id"), so only pass it for single tracks
        ...(parsed.list ? {} : { videoId: parsed.video }),
        playerVars: {
          playsinline: 1, rel: 0, modestbranding: 1,
          ...(parsed.list ? { listType: 'playlist', list: parsed.list } : {}),
        },
        events: {
          onReady: () => { clearTimeout(timer); resolve(); emit(); },
          onStateChange: (e) => {
            state = e.data;
            if (state === 1) { blockedRun = 0; onChange?.({ loaded: true, notice: '' }); }
            emit();
          },
          onError: (e) => {
            // 101/150: the owner does not allow embedding; 100: removed/private; 2/5: bad request/HTML5
            const why = { 2: 'invalid link', 5: 'cannot play in this browser', 100: 'video removed or private', 101: 'the owner does not allow playback outside YouTube', 150: 'the owner does not allow playback outside YouTube' }[e.data] || `error ${e.data}`;
            const count = player?.getPlaylist?.()?.length ?? 0;
            blockedRun++;
            // Many label-owned songs block embedded playback; walk past them, but give up on
            // a playlist where nearly everything is blocked instead of skipping forever.
            if (count > 1 && blockedRun < Math.min(count, 25)) {
              onChange?.({ loaded: true, notice: `Skipping a track YouTube won't play outside its own apps (${why}) · ${blockedRun} skipped` });
              clearTimeout(skipTimer);
              skipTimer = setTimeout(() => {
                const i = player.getPlaylistIndex();
                if (i >= count - 1) player.playVideoAt(0); else player.playVideoAt(i + 1);
              }, 600);
            } else {
              onChange?.({ loaded: true, notice: count > 1
                ? `Stopped: ${blockedRun} tracks in a row are blocked from playing outside YouTube by their owners. Try a different playlist (official label songs are often blocked).`
                : `This track can't play here (${why}).` });
            }
          },
        },
      });
    });
    await ready;
    return parsed;
  }

  const call = (fn) => { if (player?.[fn]) player[fn](); };
  return {
    load,
    toggle() { if (!player) return; if (state === 1 || state === 3) player.pauseVideo(); else player.playVideo(); },
    play: () => call('playVideo'),
    pause: () => call('pauseVideo'),
    next: () => call('nextVideo'),
    prev: () => call('previousVideo'),
    get loaded() { return !!player; },
    get playing() { return state === 1 || state === 3; },
  };
}
