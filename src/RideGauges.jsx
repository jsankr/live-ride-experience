import React from 'react';
import { DEFAULTS } from '../public/js/analytics.js';

const number = (value) => Number.isFinite(value) ? String(Math.round(value)) : '—';
const clamp = (value) => Math.max(0, Math.min(1, value));

export function Speedometer({ speed, unit, source, rpm, imperial }) {
  const scaleStep = imperial ? 25 : 40;
  const max = Math.max(scaleStep * 4, Math.ceil((speed ?? 0) / scaleStep) * scaleStep);
  const angle = 252 * clamp((speed ?? 0) / max);

  return <article className="glass gauge-card" aria-label="Speedometer">
    <div className="gauge-copy">
      <h2>Speed</h2>
      <div className="gauge-reading" data-reading="speed">{number(speed)}<small> {unit}</small></div>
      <p>{source || 'GPS / OBD'}</p>
      {Number.isFinite(rpm) && <p>{Math.round(rpm).toLocaleString()} rpm</p>}
    </div>
    <div className="speed-instrument" aria-hidden="true">
      <div className="speed-bezel" style={{ '--gauge-angle': `${angle}deg` }}>
        {Number.isFinite(speed) && <i className="speed-needle" />}
      </div>
      <div className="gauge-scale"><span>0</span><span>{max}</span></div>
    </div>
  </article>;
}

export function CoolantThermometer({ coolant, imperial, obdFresh }) {
  const available = Number.isFinite(coolant) && obdFresh;
  const hot = available && coolant >= DEFAULTS.overheatC;
  const toUnit = (celsius) => imperial ? celsius * 1.8 + 32 : celsius;
  const level = available ? clamp((coolant - 40) / 85) : 0;

  return <article className="glass gauge-card coolant-card" aria-label="Coolant thermometer" data-tone={hot ? 'danger' : undefined}>
    <div className="gauge-copy">
      <h2>Coolant</h2>
      <div className="gauge-reading" data-reading="coolant">{available ? number(toUnit(coolant)) : '—'}<small> {imperial ? '°F' : '°C'}</small></div>
      <p>{hot ? 'Overheat · OBD' : available ? 'OBD coolant' : obdFresh ? 'No coolant data' : 'Needs OBD'}</p>
    </div>
    <div className="thermo-instrument" aria-hidden="true" data-filled={available}>
      <div className="thermo-tube" style={{ '--gauge-level': `${level * 100}%` }}><i /></div>
      <span className="thermo-bulb" />
      <div className="thermo-scale"><span>{number(toUnit(125))}</span><span>{number(toUnit(40))}</span></div>
    </div>
  </article>;
}
