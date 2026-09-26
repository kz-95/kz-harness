// Greets people by name.
import { config } from './config.js'

/** The greeting for `name`, such as Hello, Ana! */
export function greet(name, { greeting = config.greeting } = {}) {
  return `${greeting}, ${name}${config.punctuation}`
}
