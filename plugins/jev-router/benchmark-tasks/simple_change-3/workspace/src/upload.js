// Checking and storing an upload.
import { tooLarge, tooMany, wrongType } from './errors.js'
import { ACCEPTED_TYPES, MAX_FILES_PER_PERSON, MAX_UPLOAD_BYTES } from './limits.js'

/**
 * Checks an upload against the limits and stores it, or throws the UploadError that refuses it.
 * @param {ReturnType<import('./store.js').createStore>} store
 * @param {{ person: string, name: string, type: string, size: number }} upload
 */
export function acceptUpload(store, { person, name, type, size }) {
  if (!ACCEPTED_TYPES.includes(type)) throw wrongType(type)
  if (size > MAX_UPLOAD_BYTES) throw tooLarge()
  if (store.count(person) >= MAX_FILES_PER_PERSON) throw tooMany(MAX_FILES_PER_PERSON)
  store.add(person, name)
  return { person, name, size }
}
