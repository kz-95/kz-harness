/** Throws a TypeError unless `t` is a finite number. */
export function assertTemperature(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    throw new TypeError('temperature must be a finite number')
  }
}
