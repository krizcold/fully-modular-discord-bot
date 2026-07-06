// Dependency-free SVG charts for the Usage tab. Bare global functions
// (Babel 7 classic runtime, global-scope text/babel scripts - no import/export).
// Both take data as [{t, v}] and autoscale to min/max.

function usageChartScale(data, width, height, padding) {
  const pad = padding || 2;
  let min = Infinity;
  let max = -Infinity;
  for (const p of data) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  if (!isFinite(min)) { min = 0; max = 1; }
  if (max === min) { max = min + 1; }
  const t0 = data[0].t;
  const t1 = data[data.length - 1].t;
  const tSpan = t1 - t0 || 1;
  return {
    x: (t) => pad + ((t - t0) / tSpan) * (width - pad * 2),
    y: (v) => height - pad - ((v - min) / (max - min)) * (height - pad * 2),
    min,
    max,
  };
}

function Sparkline({ data, width, height, stroke }) {
  const w = width || 120;
  const h = height || 32;
  if (!data || data.length < 2) {
    return <svg className="usage-sparkline" width={w} height={h} />;
  }
  const scale = usageChartScale(data, w, h);
  const points = data.map((p) => `${scale.x(p.t).toFixed(1)},${scale.y(p.v).toFixed(1)}`).join(' ');
  return (
    <svg className="usage-sparkline" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={points} fill="none" stroke={stroke || '#5865f2'} strokeWidth="1.5" />
    </svg>
  );
}

function AreaChart({ data, width, height, stroke, fill, label, formatValue }) {
  const w = width || 560;
  const h = height || 120;
  const fmt = formatValue || ((v) => String(Math.round(v * 10) / 10));
  if (!data || data.length < 2) {
    return (
      <div className="usage-areachart usage-areachart-empty">
        {label ? <div className="usage-areachart-label">{label}</div> : null}
        <div className="usage-areachart-placeholder">Waiting for samples...</div>
      </div>
    );
  }
  const scale = usageChartScale(data, w, h);
  const line = data.map((p) => `${scale.x(p.t).toFixed(1)},${scale.y(p.v).toFixed(1)}`).join(' L');
  const first = data[0];
  const last = data[data.length - 1];
  const path =
    `M${scale.x(first.t).toFixed(1)},${h - 2} L` +
    line +
    ` L${scale.x(last.t).toFixed(1)},${h - 2} Z`;
  return (
    <div className="usage-areachart">
      {label ? <div className="usage-areachart-label">{label}</div> : null}
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <path d={path} fill={fill || 'rgba(88,101,242,0.25)'} stroke="none" />
        <polyline points={line.split(' L').join(' ')} fill="none" stroke={stroke || '#5865f2'} strokeWidth="1.5" />
      </svg>
      <div className="usage-areachart-range">
        <span>min {fmt(scale.min)}</span>
        <span>max {fmt(scale.max)}</span>
      </div>
    </div>
  );
}
