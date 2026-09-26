// Temperature conversions between Celsius, Fahrenheit and Kelvin.
import { assertTemperature } from './check.js'

export function cToF(c) {
  assertTemperature(c)
  return (c * 9) / 5 + 32
}

export function fToC(f) {
  assertTemperature(f)
  return ((f - 32) * 5) / 9
}

export function cToK(c) {
  assertTemperature(c)
  return c + 273.15
}

export function kToC(k) {
  assertTemperature(k)
  return k - 273.15
}
