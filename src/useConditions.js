import { useEffect, useRef, useState } from 'react';
import { loadWeather, locationCell, relativeLevel } from './conditions.js';

export function useWeather(fix, liveView) {
  const [weather, setWeather] = useState({ status: 'idle' });
  const saved = useRef(null);
  const request = useRef(null);
  const generation = useRef(0);
  const enabled = weather.status !== 'idle';

  function cancel() {
    generation.current++;
    request.current?.abort();
    request.current = null;
  }

  function refresh(coords) {
    cancel();
    const controller = new AbortController();
    const cell = locationCell(coords);
    request.current = controller;
    setWeather({ status: 'loading', data: saved.current?.data });
    const timeout = setTimeout(() => controller.abort('timeout'), 12000);
    loadWeather(cell, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      saved.current = { cell, data, receivedAt: Date.now() };
      setWeather({ status: 'ready', data });
    }).catch(() => {
      if (request.current !== controller) return;
      setWeather({ status: 'error', data: saved.current?.data, message: 'Forecast unavailable. Retry when online.' });
    }).finally(() => {
      clearTimeout(timeout);
      if (request.current === controller) request.current = null;
    });
  }

  function locate() {
    if (fix) { refresh(fix); return; }
    cancel();
    if (!navigator.geolocation) {
      setWeather({ status: 'error', message: 'Location is unavailable in this browser.' });
      return;
    }
    const id = generation.current;
    setWeather({ status: 'locating', data: saved.current?.data });
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      if (id === generation.current) refresh({ lat: coords.latitude, lon: coords.longitude });
    }, (error) => {
      if (id !== generation.current) return;
      const message = error.code === 1 ? 'Allow location access to load weather.' : 'Location unavailable. Try again outdoors.';
      setWeather({ status: 'error', data: saved.current?.data, message });
    }, { timeout: 12000, maximumAge: 60000 });
  }

  const latestFix = useRef(fix);
  latestFix.current = fix;
  useEffect(() => {
    if (!enabled || !liveView) return;
    const timer = setInterval(() => {
      const last = saved.current;
      const point = latestFix.current;
      if (!last || request.current || !point || document.hidden) return;
      const interval = locationCell(point) === last.cell ? 15 * 60000 : 5 * 60000;
      if (Date.now() - last.receivedAt >= interval) refresh(point);
    }, 60000);
    return () => clearInterval(timer);
  }, [enabled, liveView]);

  useEffect(() => cancel, []);
  return { ...weather, locate, clear: () => { cancel(); saved.current = null; setWeather({ status: 'idle' }); } };
}

export function useNoise(liveView) {
  const [noise, setNoise] = useState({ status: 'idle', history: [] });
  const session = useRef(null);

  function stop() {
    const active = session.current;
    session.current = null;
    if (!active) return;
    clearInterval(active.timer);
    active.stream?.getTracks().forEach((track) => track.stop());
    active.context?.close().catch(() => {});
  }

  function disable() {
    stop();
    setNoise((previous) => previous.status === 'idle' ? previous : { ...previous, status: 'idle' });
  }

  async function start() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio || !navigator.mediaDevices?.getUserMedia) {
      setNoise({ status: 'error', history: [], message: 'Microphone access needs a supported browser and HTTPS.' });
      return;
    }
    stop();
    const active = {};
    session.current = active;
    setNoise({ status: 'pending', history: [] });
    try {
      const context = new Audio();
      active.context = context;
      // Resume during the click gesture for browsers that gate Web Audio.
      const resumed = context.resume().then(() => true, () => false);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (active !== session.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      active.stream = stream;
      if (!await resumed) throw new Error('Audio context unavailable');
      if (active !== session.current) return;
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const measure = () => {
        analyser.getFloatTimeDomainData(samples);
        const level = relativeLevel(samples);
        setNoise((previous) => ({
          status: 'active', level, peak: Math.max(level, previous.peak ?? -90),
          history: [...previous.history.slice(-59), level],
        }));
      };
      stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => {
        if (active === session.current) disable();
      }));
      measure();
      active.timer = setInterval(measure, 500);
    } catch (error) {
      if (active !== session.current) return;
      stop();
      const message = error.name === 'NotAllowedError' ? 'Allow microphone access to start monitoring.' : 'Microphone unavailable. Try again.';
      setNoise({ status: 'error', history: [], message });
    }
  }

  useEffect(() => {
    if (!liveView) disable();
  }, [liveView]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) disable(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); stop(); };
  }, []);

  return { ...noise, start, disable };
}
