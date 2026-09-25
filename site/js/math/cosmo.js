// Flat ΛCDM distances (default H0 = 70 km/s/Mpc, Ωm = 0.3, matching the data conventions).
// Comoving distance is tabulated once (cumulative Simpson) and interpolated.

const C_KMS = 299792.458;
const ARCSEC_PER_RAD = 206264.80624709636;
const ZMAX = 3;
const NSTEP = 3000;

let H0 = 70, Om0 = 0.3;
let table = null;   // comoving distance in Mpc at z = i * ZMAX / NSTEP

export function setCosmology({ H0: h = 70, Om0: om = 0.3 } = {}) {
  if (h !== H0 || om !== Om0) {
    H0 = h;
    Om0 = om;
    table = null;
  }
}

export function getCosmology() {
  return { H0, Om0 };
}

function E(z) {
  const a = 1 + z;
  return Math.sqrt(Om0 * a * a * a + (1 - Om0));
}

function build() {
  table = new Float64Array(NSTEP + 1);
  const dz = ZMAX / NSTEP;
  const DH = C_KMS / H0;
  let acc = 0;
  for (let i = 1; i <= NSTEP; i++) {
    const za = (i - 1) * dz, zb = i * dz, zm = 0.5 * (za + zb);
    acc += (dz / 6) * (1 / E(za) + 4 / E(zm) + 1 / E(zb));
    table[i] = DH * acc;
  }
}

/** Line-of-sight comoving distance in Mpc. */
export function comovingDistance(z) {
  if (!table) build();
  if (!(z > 0)) return 0;
  const h = (Math.min(z, ZMAX) / ZMAX) * NSTEP;
  const i = Math.min(NSTEP - 1, Math.floor(h));
  const f = h - i;
  return table[i] + f * (table[i + 1] - table[i]);
}

export function angularDiameterDistance(z) {
  return comovingDistance(z) / (1 + Math.max(0, z));
}

export function luminosityDistance(z) {
  return comovingDistance(z) * (1 + Math.max(0, z));
}

/** Proper transverse scale in kpc per arcsec at redshift z. */
export function kpcPerArcsec(z) {
  return (angularDiameterDistance(z) * 1000) / ARCSEC_PER_RAD;
}
