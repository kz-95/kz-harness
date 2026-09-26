// Where uploads are kept.

/** Uploads are written in chunks of this many bytes. */
export const CHUNK_BYTES = 64 * 1024

/** A store that keeps each person's files in memory. */
export function createStore() {
  const files = new Map() // person -> file names
  return {
    count: (person) => files.get(person)?.length ?? 0,
    add(person, name) {
      files.set(person, [...(files.get(person) ?? []), name])
    },
  }
}
