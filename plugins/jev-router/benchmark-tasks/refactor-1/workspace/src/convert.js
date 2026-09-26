// Temperature conversions between Celsius, Fahrenheit and Kelvin.

export function cToF(c) {
  if (typeof c !== 'number' || !Number.isFinite(c)) {
    throw new TypeError('temperature must be a finite number')
  }
  return (c * 9) / 5 + 32
}

export function fToC(f) {
  if (typeof f !== 'number' || !Number.isFinite(f)) {
    throw new TypeError('temperature must be a finite number')
  }
  return ((f - 32) * 5) / 9
}

export function cToK(c) {
  if (typeof c !== 'number' || !Number.isFinite(c)) {
    throw new TypeError('temperature must be a finite number')
  }
  return c + 273.15
}

export function kToC(k) {
  if (typeof k !== 'number' || !Number.isFinite(k)) {
    throw new TypeError('temperature must be a finite number')
  }
  return k - 273.15
}
