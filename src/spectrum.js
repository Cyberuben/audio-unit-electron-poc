// Draw dBFS vertically and frequency logarithmically, using the same scale for both graphs.
export function drawSpectrum(canvas, data, color, playing) {
  // Scale the backing canvas for Retina/high-DPI displays without changing CSS dimensions.
  const ratio = window.devicePixelRatio || 1,
    width = canvas.clientWidth,
    height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#2b3931';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#687f70';
  ctx.font = '9px monospace';
  for (const db of [0, -25, -50, -75, -100]) {
    const y = 6 + (-db / 100) * (height - 16);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    ctx.fillText(`${db}`, 2, Math.max(12, y - 3));
  }
  if (!data || !playing) return;
  const { bins, sampleRate } = data;
  const points = [];
  // Keep the strongest FFT bin per pixel band so narrow peaks remain visible.
  for (let x = 0; x <= width; x += 2) {
    const hz = 20 * Math.pow(1000, x / width),
      nextHz = 20 * Math.pow(1000, (x + 2) / width);
    if (hz > sampleRate / 2) break;
    const low = Math.max(1, Math.floor((hz / (sampleRate / 2)) * bins.length));
    const high = Math.min(
      bins.length - 1,
      Math.max(low, Math.ceil((nextHz / (sampleRate / 2)) * bins.length)),
    );
    let db = -100;
    for (let i = low; i <= high; i++) db = Math.max(db, bins[i]);
    points.push([x, 6 + (1 - Math.min(1, Math.max(0, (db + 100) / 100))) * (height - 16)]);
  }
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (const point of points) ctx.lineTo(...point);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(points.at(-1)[0], height);
  ctx.lineTo(0, height);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `${color}45`);
  gradient.addColorStop(1, `${color}03`);
  ctx.fillStyle = gradient;
  ctx.fill();
}
