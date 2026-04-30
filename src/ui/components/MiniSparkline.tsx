// Tiny inline-SVG sparkline. Heavier sparklines on the Exchange use
// lightweight-charts; for compact info cards we only need a quiet line.

interface MiniSparklineProps {
  points: readonly number[];
  width?: number;
  height?: number;
  className?: string;
}

export function MiniSparkline({ points, width = 84, height = 18, className = "" }: MiniSparklineProps) {
  if (points.length < 2) {
    return (
      <svg
        className={`mini-sparkline ${className}`}
        width={width} height={height} viewBox={`0 0 ${width} ${height}`}
        aria-hidden
      />
    );
  }

  let min = points[0], max = points[0];
  for (const v of points) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  const step = (width - 2) / (points.length - 1);

  let path = "";
  for (let i = 0; i < points.length; i++) {
    const x = 1 + i * step;
    const y = (height - 1) - ((points[i] - min) / range) * (height - 2);
    path += (i === 0 ? "M" : "L") + x.toFixed(2) + "," + y.toFixed(2) + " ";
  }

  // Build a closed area-fill path under the line for a soft tonal wash.
  const area = path
    + `L ${(1 + (points.length - 1) * step).toFixed(2)},${(height - 1).toFixed(2)} `
    + `L 1,${(height - 1).toFixed(2)} Z`;

  const tone = points[points.length - 1] >= points[0] ? "up" : "down";

  return (
    <svg
      className={`mini-sparkline tone-${tone} ${className}`}
      width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <path d={area} className="mini-sparkline-area" />
      <path d={path} className="mini-sparkline-line" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
