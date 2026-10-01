/** Deterministic identicons in the brand palette. Pure functions — safe on server and client. */

// Light ice backgrounds, blue/ink shapes: every background/shape pair stays clearly visible.
const BGS = ["#e3f0ff", "#d6e9fb", "#eaf4fe", "#cfe4f7", "#ddeefb"];
const FGS = ["#2e9bff", "#0e2a3f", "#1468c7", "#5ab0ff", "#1b425e", "#0a7a4f", "#c73439"];

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: string) {
  let s = hash(seed.toLowerCase()) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** 5×5 mirrored grid (address avatars). */
export function identiconSvg(seed: string, size = 64): string {
  const r = rng(seed);
  const bg = BGS[Math.floor(r() * BGS.length)];
  const fg = FGS[Math.floor(r() * 5)];
  const cell = size / 6;
  const pad = cell / 2;
  let rects = "";
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (r() < 0.5) continue;
      for (const xx of x === 2 ? [2] : [x, 4 - x]) {
        rects += `<rect x="${(pad + xx * cell).toFixed(2)}" y="${(pad + y * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${(cell / 4).toFixed(2)}"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${bg}"/><g fill="${fg}">${rects}</g></svg>`;
}

export const svgDataUri = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
